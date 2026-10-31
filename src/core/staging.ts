// Staging verification (build plan M3.4, D-103, D-104, ADR 0107). After the runner merges an item's
// PR, the item waits in Verifying on staging until main has deployed its merge commit to staging.
// The runner then runs its own staging check, plain code behind the `StagingChecker` port (ADR
// 0107: "the QA model reads; plain code checks"), records the result as `staging_check` evidence
// on the merge commit, and asks the library for the move the result calls for. The guards decide
// (`staging_check_on_merge_commit`, `staging_check_failed`); which moves those are comes from the
// contracts (essential 3). Plain logic over an injected store, contracts, guards, clock, id
// source, GitHub and checker (D-162).
//
// The order, for one item:
// 1. The merge commit: the node's latest `merge_commit`. Only that commit counts; the PR's head
//    and any other commit on main do nothing (docs/guards.md, "The merge commit").
// 2. The deploy (O-34, D-225, O-38): GitHub's `staging` deployments of that commit and the latest
//    ones of any commit. The newest finished one (latest status `success`, `failure` or `error`)
//    whose commit contains the merge commit, by GitHub's compare (`identical` or `ahead`), decides.
//    A success is recorded as `staging_deploy` evidence, a failure as `staging_deploy_failed`; both
//    are facts the runner read itself, also in dry run (like the polling backstop and
//    `merge_check`). A failed deploy takes the fail path of step 4, once per deployment.
// 3. The check (O-35, O-39): in live mode only. A check that finds staging serving the merge
//    commit, or a commit that contains it, gives `staging_check {pass, servedCommitSha,
//    containment}`, once per merge commit under its key. A check that ends without a result, or
//    finds staging serving a commit without it, gives `staging_no_result`: the first is
//    re-dispatched on the next call, the second sends the item to the Council (O-36).
// 4. The move (O-37): a pass moves to Done and resets the counters in the same transaction, then
//    releases the items it blocked. A fail takes the fallback move back to the building state and
//    adds one to `failure` in the same transaction, then asks for the escalation, which the
//    guards allow once `failure` reaches `failure_threshold` (P-03). Each move's trigger id names
//    the check (`staging_check:<evidence id>`) or the failed deploy
//    (`staging_deploy_failed:<evidence id>`), so a repeated call writes one row.
// An item that waits in Verifying on staging with no deploy recorded for longer than
// `staging_deploy_attention_after_minutes` is reported for the attention list (D-225, O-40).
// A failure part way is recovered by the next call: the facts are keyed, the moves are taken once
// per trigger, and the live pass (`verifyReady`) asks again for an escalation or a release that a
// failure left behind.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import type {
  CommitRelation,
  Deployment,
  GitHubCommitReader,
  GitHubDeploymentReader,
} from "./github.ts";
import { latest } from "./guards/evidence.ts";
import { STAGING_CHECK_ATTEMPTS } from "./guards/staging.ts";
import {
  createLibrary,
  type AlsoWrite,
  type Clock,
  type IdSource,
  type TransitionOutcome,
  type Trigger,
} from "./library.ts";
import type { Evidence, Json, Node, Project, Store } from "./store.ts";

export { STAGING_CHECK_ATTEMPTS };

/** The GitHub environment a project's deploy on push to main reports to (O-34). */
export const STAGING_ENVIRONMENT = "staging";
/** The guard that marks the move a passed staging check takes (to Done). */
export const STAGING_PASS_GUARD = "staging_check_on_merge_commit";
/** The guard that marks the fallback move a failed staging check takes. */
export const STAGING_FAIL_GUARD = "staging_check_failed";
/** The guard of the escalation into the Council (escalation.yaml). */
export const ESCALATION_GUARD = "escalation_trigger_met";
/**
 * How many of the latest `staging` deployments of any commit the runner reads for one item (one
 * GitHub page, O-38). The newest finished deploy of main contains every earlier merge commit, so
 * a short window is enough; a deploy older than it is either covered by a newer one or replaced.
 */
export const STAGING_DEPLOY_SCAN_LIMIT = 20;
/** The setting: minutes in Verifying on staging with no deploy before the attention list (D-225). */
export const STAGING_DEPLOY_WAIT_SETTING = "staging_deploy_attention_after_minutes";

/** Deployment states that end a deployment: a success, or a failure (D-225). */
const FINISHED: ReadonlySet<Deployment["state"]> = new Set([
  "success",
  "failure",
  "error",
]);
/** A commit that contains the merge commit, by GitHub's compare from the merge commit to it. */
export type Containment = "identical" | "ahead";
const containmentOf = (relation: CommitRelation): Containment | null =>
  relation === "identical" || relation === "ahead" ? relation : null;
const MINUTE = 60_000;

const ACTOR = { kind: "runner" as const, id: "staging" };

/** What the runner asks the staging check to confirm: staging serves this commit and works. */
export interface StagingCheckRequest {
  project: Project;
  /** The merge commit on main. */
  commitSha: string;
}

/**
 * What a staging check found. `servedCommitSha` is the commit staging reports it runs; a result
 * counts only when that is the merge commit. `no_result`: the check could not reach staging or
 * ran out of time, so it says nothing about the change.
 */
export type StagingCheckResult =
  | { result: "pass" | "fail"; servedCommitSha: string }
  | { result: "no_result"; reason: "unreachable" | "timed_out" };

/**
 * The runner's staging smoke check (ADR 0107), implemented by the deploy adapter, which owns
 * what staging is and where it answers (ADR 0111, build plan M3.7). It maps every failure to
 * reach staging to `no_result`; a thrown error records nothing.
 */
export interface StagingChecker {
  check(request: StagingCheckRequest): Promise<StagingCheckResult>;
}

export interface StagingDeps {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  github: GitHubDeploymentReader & GitHubCommitReader;
  /** Null where no check is run: the reconcile pass in dry run. */
  checker: StagingChecker | null;
}

export interface StagingMove {
  toState: string;
  outcome: TransitionOutcome;
  reason?: string;
  transitionId?: string;
  failedGuards: string[];
}

export type StagingStep =
  /** The kill switch is on. Nothing was read or written. */
  | "refused"
  | "no_node"
  /** The node is not in a state a staging check moves out of. */
  | "not_verifying"
  | "no_merge_commit"
  | "no_dispatch"
  /** GitHub has not reported a finished staging deploy of a commit that contains the merge commit. */
  | "waiting_for_deploy"
  /** A staging deploy covering the merge commit failed, and led to the fail move (D-225). */
  | "deploy_failed"
  | "github_read_failed"
  /** Dry run: the deploy is there, and the live pass would run the check. */
  | "would_check"
  /** No checker is configured for this call. */
  | "no_checker"
  /** The checker threw. Nothing was recorded; the next call tries again. */
  | "check_error"
  /** The check ended without a result, and one re-dispatch is left. */
  | "no_result"
  /** A recorded check led to the move (`move`), and possibly the escalation. */
  | "checked"
  /** Two checks ended without a result, and the item was sent to the Council. */
  | "timed_out";

export interface StagingResult {
  nodeId: string;
  step: StagingStep;
  mergeCommitSha?: string;
  deployEvidenceId?: string;
  deployFailedEvidenceId?: string;
  checkEvidenceId?: string;
  noResultEvidenceId?: string;
  move?: StagingMove;
  escalation?: StagingMove;
  /** The blocked items asked for after Done. */
  released?: { nodeId: string; move: StagingMove }[];
  /** Set when no deploy is recorded for the item: when it entered Verifying on staging. */
  waitingSince?: Date;
}

/** An item in Verifying on staging with no deploy recorded past the setting (D-225, O-40). */
export interface StagingDeployWait {
  nodeId: string;
  waitingSince: Date;
  waitedMinutes: number;
  limitMinutes: number;
}

/**
 * The key of a staging deploy: one per GitHub deployment of the merge commit itself, and one per
 * deployment and merge commit it covers for a deployment of a later commit (`coveredSha`), which
 * may cover several items (D-225).
 */
export const stagingDeployKey = (
  repo: string,
  deploymentId: number,
  coveredSha?: string,
): string =>
  `github:staging_deploy:${repo}:deployment-${deploymentId}` +
  (coveredSha ? `:covers-${coveredSha}` : "");

/** The key of a failed staging deploy: one per GitHub deployment and merge commit it covers. */
export const stagingDeployFailedKey = (
  repo: string,
  deploymentId: number,
  coveredSha: string,
): string =>
  `github:staging_deploy_failed:${repo}:deployment-${deploymentId}:covers-${coveredSha}`;

/** The key of a staging check result: one per merge commit. */
export const stagingCheckKey = (repo: string, sha: string): string =>
  `runner:staging_check:${repo}@${sha}`;

/**
 * The key of a check without a result: one per attempt while the node is in its state, so a
 * return to the state after the Council starts the attempts again.
 */
export const stagingNoResultKey = (
  repo: string,
  sha: string,
  stateSince: Date,
  attempt: number,
): string =>
  `runner:staging_no_result:${repo}@${sha}:${stateSince.toISOString()}:${attempt}`;

/** The trigger of the moves a recorded check leads to. */
export const stagingCheckTrigger = (checkEvidenceId: string): Trigger => ({
  kind: "event",
  ref: `staging_check:${checkEvidenceId}`,
});

/** The trigger of the moves a recorded failed staging deploy leads to (D-225). */
export const stagingDeployFailedTrigger = (
  failedDeployEvidenceId: string,
): Trigger => ({
  kind: "event",
  ref: `staging_deploy_failed:${failedDeployEvidenceId}`,
});

/** The trigger refs of the fail moves, for the recovery of an escalation cut short. */
const FAIL_TRIGGER_PREFIXES = ["staging_check:", "staging_deploy_failed:"];

/** The trigger of the escalation after the last check without a result. */
export const stagingTimeoutTrigger = (noResultEvidenceId: string): Trigger => ({
  kind: "timeout",
  ref: `staging_no_result:${noResultEvidenceId}`,
});

/** The trigger of the release of the items a Done node blocked. */
export const releaseTrigger = (doneNodeId: string): Trigger => ({
  kind: "event",
  ref: `done:${doneNodeId}`,
});

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

const failedNames = (report: { name: string; pass: boolean }[]): string[] =>
  report.filter((c) => !c.pass).map((c) => c.name);

export function createStaging(deps: StagingDeps) {
  const { store, contracts, clock, ids, github, checker } = deps;
  const library = createLibrary(deps);

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;
  const trackMatches = (move: TransitionContract, node: Node): boolean =>
    !move.tracks || (node.track !== null && move.tracks.includes(node.track));

  /** The moves a staging check result takes out of the node's state, for its track. */
  function stagingMovesFor(
    node: Node,
  ): { pass: TransitionContract; fail: TransitionContract | undefined } | null {
    const out = contracts.transitions.filter(
      (m) => !m.escalation && m.from === node.state && trackMatches(m, node),
    );
    const pass = out.find(
      (m) => !m.fallbackMove && m.guards.includes(STAGING_PASS_GUARD),
    );
    if (!pass) return null;
    return { pass, fail: out.find((m) => m.guards.includes(STAGING_FAIL_GUARD)) };
  }

  /** States a passed staging check leads to (Done). */
  const doneStates = new Set(
    contracts.transitions
      .filter((m) => !m.fallbackMove && m.guards.includes(STAGING_PASS_GUARD))
      .map((m) => m.to),
  );
  /** States a failed staging check leads back to (In development, Building components). */
  const fallbackStates = new Set(
    contracts.transitions
      .filter((m) => m.fallbackMove && m.guards.includes(STAGING_FAIL_GUARD))
      .map((m) => m.to),
  );
  const escalationMove = contracts.transitions.find(
    (m) => m.escalation && m.from === "any" && m.guards.includes(ESCALATION_GUARD),
  );

  const asMove = (
    toState: string,
    result: {
      outcome: TransitionOutcome;
      reason?: string;
      transitionId?: string;
      guardReport: { name: string; pass: boolean }[];
    },
  ): StagingMove => ({
    toState,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.transitionId ? { transitionId: result.transitionId } : {}),
    failedGuards: failedNames(result.guardReport),
  });

  const dryRunOn = async () => (await store.getSetting("dry_run"))?.value !== false;

  /** Inserts a fact under its key, or returns the row that took the key first. */
  async function recordOnce(evidence: Evidence, key: string): Promise<Evidence | null> {
    if (await store.insertEvidenceOnce(evidence, key)) return evidence;
    const existing = await store.listEvidence({
      nodeId: evidence.nodeId,
      kind: evidence.kind,
      ...(evidence.commitSha ? { commitSha: evidence.commitSha } : {}),
    });
    return existing.find((e) => e.ref === key) ?? null;
  }

  const fact = (
    node: Node,
    kind: Evidence["kind"],
    commitSha: string,
    payload: Json,
    key: string,
  ): Evidence => ({
    id: ids.next(),
    nodeId: node.id,
    runId: null,
    kind,
    ref: key,
    commitSha,
    payload,
    recordedBy: "runner",
    recordedAt: clock.now(),
    supersedesId: null,
  });

  /** Asks for the Council. The guards decide; a request they refuse writes nothing. */
  async function escalate(
    nodeId: string,
    trigger: Trigger,
    reason: string,
  ): Promise<StagingMove | undefined> {
    if (!escalationMove) return undefined;
    const result = await library.requestTransitionOnce({
      nodeId,
      toState: escalationMove.to,
      blockedReason: reason,
      trigger,
      actor: ACTOR,
      reason,
    });
    return asMove(escalationMove.to, result);
  }

  /**
   * Asks for the move out of Blocked of every item the Done node blocks, once per Done node. The
   * guards (`blockers_done`, `design_spec_merged`) decide, so an item with another open blocker
   * stays Blocked.
   */
  async function releaseDependents(
    doneNodeId: string,
  ): Promise<{ nodeId: string; move: StagingMove }[]> {
    const released: { nodeId: string; move: StagingMove }[] = [];
    for (const edge of await store.listEdges({
      fromNode: doneNodeId,
      type: "blocks",
    })) {
      const dependent = await store.getNode(edge.toNode);
      if (!dependent) continue;
      const state = stateOf(dependent.state);
      if (!state?.requiresBlockedReason || state.escalated) continue;
      for (const move of contracts.transitions.filter(
        (m) =>
          !m.escalation &&
          !m.fallbackMove &&
          m.from === dependent.state &&
          trackMatches(m, dependent),
      )) {
        const result = await library.requestTransitionOnce({
          nodeId: dependent.id,
          toState: move.to,
          trigger: releaseTrigger(doneNodeId),
          actor: ACTOR,
          reason: `blocker ${doneNodeId} reached Done`,
        });
        released.push({ nodeId: dependent.id, move: asMove(move.to, result) });
        if (result.outcome !== "rejected") break;
      }
    }
    return released;
  }

  /**
   * What a recorded result calls for: a staging check (pass or fail), or a failed staging deploy
   * that covers the merge commit (a fail, D-225). `what` says it in the move's reason.
   */
  interface Outcome {
    evidence: Evidence;
    passed: boolean;
    trigger: Trigger;
    what: string;
  }

  const checkOutcome = (check: Evidence): Outcome => {
    const passed = field(check.payload, "pass") === true;
    return {
      evidence: check,
      passed,
      trigger: stagingCheckTrigger(check.id),
      what: `the staging check ${passed ? "passed" : "failed"} for merge ${check.commitSha}`,
    };
  };

  const deployFailedOutcome = (failed: Evidence): Outcome => {
    const deployed = field(failed.payload, "deployedSha");
    return {
      evidence: failed,
      passed: false,
      trigger: stagingDeployFailedTrigger(failed.id),
      what: `the staging deploy of ${typeof deployed === "string" ? deployed : failed.commitSha} failed for merge ${failed.commitSha}`,
    };
  };

  /** Step 4: the move a recorded result calls for, with its counter write, then what follows. */
  async function decide(
    node: Node,
    moves: { pass: TransitionContract; fail: TransitionContract | undefined },
    outcome: Outcome,
    base: StagingResult,
  ): Promise<StagingResult> {
    const { passed, trigger } = outcome;
    const move = passed ? moves.pass : moves.fail;
    if (!move) return base;
    const dryRun = await dryRunOn();
    const at = clock.now();
    // P-03: Done resets both counters; a failed staging check or deploy adds one to `failure`.
    // Each commits with its move, so a move taken once counts once. Dry run writes neither.
    const counters: AlsoWrite = passed
      ? async (tx) => {
          await tx.setCounter(node.id, "failure", 0, at);
          await tx.setCounter(node.id, "qa_round", 0, at);
          return null;
        }
      : async (tx) => {
          const next = (await tx.getCounter(node.id, "failure")) + 1;
          await tx.setCounter(node.id, "failure", next, at);
          return null;
        };
    const result = await library.requestTransitionOnce(
      {
        nodeId: node.id,
        toState: move.to,
        trigger,
        actor: ACTOR,
        evidenceIds: [outcome.evidence.id],
        reason: outcome.what,
      },
      dryRun ? undefined : counters,
    );
    const checked: StagingResult = { ...base, move: asMove(move.to, result) };
    if (dryRun || result.outcome === "rejected" || result.outcome === "refused") {
      return checked;
    }
    if (passed) return { ...checked, released: await releaseDependents(node.id) };
    const escalation = await escalate(
      node.id,
      trigger,
      `${outcome.what}, and the failure counter reached its limit`,
    );
    return escalation ? { ...checked, escalation } : checked;
  }

  /**
   * Step 2's read (D-225, O-38): the newest finished `staging` deployment whose commit contains
   * the merge commit, from GitHub's deployments of the merge commit and its latest deployments of
   * any commit, by deployment id (GitHub's ids grow with time). Each other commit is compared
   * once. A deployment of a commit that is `behind` or `diverged` from the merge commit is
   * skipped. GitHub's errors are thrown.
   */
  async function coveringDeploy(
    repo: string,
    sha: string,
  ): Promise<{ deployment: Deployment; containment: Containment } | null> {
    const byId = new Map<number, Deployment>();
    for (const d of [
      ...(await github.listDeployments(repo, STAGING_ENVIRONMENT, sha)).filter(
        (d) => d.sha === sha,
      ),
      ...(await github.listRecentDeployments(
        repo,
        STAGING_ENVIRONMENT,
        STAGING_DEPLOY_SCAN_LIMIT,
      )),
    ]) {
      if (d.environment === STAGING_ENVIRONMENT && FINISHED.has(d.state))
        byId.set(d.id, d);
    }
    const relations = new Map<string, CommitRelation>();
    for (const deployment of [...byId.values()].sort((a, b) => b.id - a.id)) {
      let relation =
        deployment.sha === sha ? "identical" : relations.get(deployment.sha);
      if (relation === undefined) {
        relation = await github.compareCommits(repo, sha, deployment.sha);
        relations.set(deployment.sha, relation);
      }
      const containment = containmentOf(relation);
      if (containment) return { deployment, containment };
    }
    return null;
  }

  /** Steps 1 to 4 for one node. `null` checker: no check is run, as in dry run. */
  async function verify(nodeId: string): Promise<StagingResult> {
    if ((await store.getSetting("kill_switch"))?.value === true) {
      return { nodeId, step: "refused" };
    }
    const node = await store.getNode(nodeId);
    if (!node) return { nodeId, step: "no_node" };
    const moves = stagingMovesFor(node);
    if (!moves) return { nodeId, step: "not_verifying" };
    // Until a deploy is recorded, the result says how long the item has waited (D-225, O-40).
    const waiting = { waitingSince: node.stateSince };

    // Step 1.
    const merge = latest(await store.listEvidence({ nodeId, kind: "merge_commit" }));
    const sha = merge?.commitSha;
    if (!sha) return { nodeId, step: "no_merge_commit", ...waiting };
    const base: StagingResult = { nodeId, step: "checked", mergeCommitSha: sha };

    // A result already recorded: a failed deploy covering the merge commit, else a check.
    const failed = latest(
      await store.listEvidence({
        nodeId,
        kind: "staging_deploy_failed",
        commitSha: sha,
      }),
    );
    if (failed) {
      return decide(node, moves, deployFailedOutcome(failed), {
        ...base,
        step: "deploy_failed",
        deployFailedEvidenceId: failed.id,
      });
    }
    const check = latest(
      await store.listEvidence({ nodeId, kind: "staging_check", commitSha: sha }),
    );
    if (check) {
      return decide(node, moves, checkOutcome(check), {
        ...base,
        checkEvidenceId: check.id,
      });
    }

    // Step 2.
    const dispatch = latest(
      await store.listEvidence({ nodeId, kind: "dispatch_record" }),
    );
    const repo = field(dispatch?.payload, "repo");
    if (typeof repo !== "string" || repo === "")
      return { ...base, step: "no_dispatch", ...waiting };
    let deploy = latest(
      await store.listEvidence({ nodeId, kind: "staging_deploy", commitSha: sha }),
    );
    if (!deploy) {
      let found;
      try {
        found = await coveringDeploy(repo, sha);
      } catch {
        return { ...base, step: "github_read_failed", ...waiting };
      }
      if (!found) return { ...base, step: "waiting_for_deploy", ...waiting };
      const { deployment, containment } = found;
      const covered = deployment.sha === sha ? undefined : sha;
      const facts = {
        environment: STAGING_ENVIRONMENT,
        deploymentId: deployment.id,
        deployedSha: deployment.sha,
        containment,
      };
      if (deployment.state !== "success") {
        const key = stagingDeployFailedKey(repo, deployment.id, sha);
        const recorded = await recordOnce(
          fact(
            node,
            "staging_deploy_failed",
            sha,
            { ...facts, state: deployment.state },
            key,
          ),
          key,
        );
        if (!recorded) return { ...base, step: "waiting_for_deploy", ...waiting };
        return decide(node, moves, deployFailedOutcome(recorded), {
          ...base,
          step: "deploy_failed",
          deployFailedEvidenceId: recorded.id,
        });
      }
      const key = stagingDeployKey(repo, deployment.id, covered);
      deploy =
        (await recordOnce(fact(node, "staging_deploy", sha, facts, key), key)) ??
        undefined;
      if (!deploy) return { ...base, step: "waiting_for_deploy", ...waiting };
    }
    const withDeploy = { ...base, deployEvidenceId: deploy.id };

    // Step 3. Two checks without a result already: the Council (the guard counts them).
    const noResults = (
      await store.listEvidence({ nodeId, kind: "staging_no_result", commitSha: sha })
    ).filter((e) => e.recordedAt.getTime() >= node.stateSince.getTime());
    const last = latest(noResults);
    if (last && noResults.length >= STAGING_CHECK_ATTEMPTS) {
      return timedOut(node, last, withDeploy);
    }
    if (await dryRunOn()) return { ...withDeploy, step: "would_check" };
    if (!checker) return { ...withDeploy, step: "no_checker" };
    const project = await store.getProject(node.projectId);
    if (!project) return { ...withDeploy, step: "no_checker" };

    let outcome: StagingCheckResult;
    try {
      outcome = await checker.check({ project, commitSha: sha });
    } catch {
      return { ...withDeploy, step: "check_error" };
    }
    let containment: Containment | null = null;
    if (outcome.result !== "no_result") {
      // O-39: the served commit counts when it is the merge commit, or GitHub's compare shows it
      // contains it: the compare recorded with the deploy when staging serves the deployed commit,
      // else a new one.
      const served = outcome.servedCommitSha;
      if (served === sha) containment = "identical";
      else if (served === field(deploy.payload, "deployedSha")) {
        const recorded = field(deploy.payload, "containment");
        containment =
          recorded === "identical" || recorded === "ahead" ? recorded : null;
      } else {
        try {
          containment = containmentOf(await github.compareCommits(repo, sha, served));
        } catch {
          return { ...withDeploy, step: "github_read_failed" };
        }
      }
    }
    if (outcome.result !== "no_result" && containment) {
      const key = stagingCheckKey(repo, sha);
      const recorded = await recordOnce(
        fact(
          node,
          "staging_check",
          sha,
          {
            pass: outcome.result === "pass",
            servedCommitSha: outcome.servedCommitSha,
            containment,
          },
          key,
        ),
        key,
      );
      if (!recorded) return { ...withDeploy, step: "check_error" };
      return decide(node, moves, checkOutcome(recorded), {
        ...withDeploy,
        checkEvidenceId: recorded.id,
      });
    }

    // No result: staging did not answer, or serves a commit without the merge commit.
    const attempt = noResults.length + 1;
    const key = stagingNoResultKey(repo, sha, node.stateSince, attempt);
    const reason = outcome.result === "no_result" ? outcome.reason : "another_commit";
    const noResult = await recordOnce(
      fact(node, "staging_no_result", sha, { reason, attempt }, key),
      key,
    );
    if (!noResult) return { ...withDeploy, step: "check_error" };
    const result = { ...withDeploy, noResultEvidenceId: noResult.id };
    if (attempt >= STAGING_CHECK_ATTEMPTS) return timedOut(node, noResult, result);
    return { ...result, step: "no_result" };
  }

  /** The contract's timeout: the re-dispatch also ended without a result, so the Council. */
  async function timedOut(
    node: Node,
    lastNoResult: Evidence,
    base: StagingResult,
  ): Promise<StagingResult> {
    const escalation = await escalate(
      node.id,
      stagingTimeoutTrigger(lastNoResult.id),
      `the staging check ended without a result ${STAGING_CHECK_ATTEMPTS} times for merge ${lastNoResult.commitSha}`,
    );
    return {
      ...base,
      step: "timed_out",
      noResultEvidenceId: lastNoResult.id,
      ...(escalation ? { escalation } : {}),
    };
  }

  return {
    stagingMovesFor,
    verify,
    releaseDependents,

    /**
     * The event path: GitHub reported a deploy of `sha` in `repo` (a `deployment_status`
     * event). Every item of the repository in Verifying on staging is verified, since a deploy of
     * a later commit may cover its merge commit (D-225), and so is the item whose latest merge
     * commit is exactly `sha`. Each reads the deploy from GitHub again, never from the event.
     */
    async verifyCommit(repo: string, sha: string): Promise<StagingResult[]> {
      const results: StagingResult[] = [];
      for (const dispatch of await store.listDispatches({ repo })) {
        const node = await store.getNode(dispatch.nodeId);
        if (!node) continue;
        const merge = latest(
          await store.listEvidence({ nodeId: node.id, kind: "merge_commit" }),
        );
        if (merge?.commitSha === sha || stagingMovesFor(node)) {
          results.push(await verify(node.id));
        }
      }
      return results;
    },

    /**
     * The items among `results` that have waited in Verifying on staging with no deploy recorded
     * for longer than `staging_deploy_attention_after_minutes` (D-225, O-40), for the attention
     * list. A missing or invalid setting reports nothing and says so in `problem`.
     */
    async deployWaits(
      results: readonly StagingResult[],
    ): Promise<{ waits: StagingDeployWait[]; problem: string | null }> {
      const value = (await store.getSetting(STAGING_DEPLOY_WAIT_SETTING))?.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return {
          waits: [],
          problem: `${STAGING_DEPLOY_WAIT_SETTING} is missing or invalid: no staging deploy wait on the attention list`,
        };
      }
      const now = clock.now().getTime();
      const waits: StagingDeployWait[] = [];
      for (const r of results) {
        if (!r.waitingSince) continue;
        const waitedMinutes = (now - r.waitingSince.getTime()) / MINUTE;
        if (waitedMinutes > value) {
          waits.push({
            nodeId: r.nodeId,
            waitingSince: r.waitingSince,
            waitedMinutes,
            limitMinutes: value,
          });
        }
      }
      return { waits, problem: null };
    },

    /**
     * The live pass, run by the reconcile flow with `dry_run` off: every node in Verifying on
     * staging, then the recovery of what a failure part way left behind. A node whose latest move
     * was a failed staging check or deploy is asked for its escalation again, and every Done node for the
     * release of the items it blocked. Both are taken once per trigger, and the guards decide.
     */
    async verifyReady(): Promise<StagingResult[]> {
      if ((await store.getSetting("kill_switch"))?.value === true) return [];
      const results: StagingResult[] = [];
      for (const node of await store.listNodes({})) {
        if (stagingMovesFor(node)) {
          results.push(await verify(node.id));
          continue;
        }
        if (stateOf(node.state)?.escalated) continue;
        if (doneStates.has(node.state)) {
          const released = await releaseDependents(node.id);
          if (released.some((r) => r.move.outcome !== "noop")) {
            results.push({ nodeId: node.id, step: "checked", released });
          }
          continue;
        }
        if (!fallbackStates.has(node.state)) continue;
        const lastMove = (await store.listTransitions(node.id))
          .filter((t) => t.mode === "applied")
          .at(-1);
        const ref = lastMove?.triggerRef;
        if (
          lastMove?.toState === node.state &&
          lastMove.triggerKind === "event" &&
          ref &&
          FAIL_TRIGGER_PREFIXES.some((prefix) => ref.startsWith(prefix))
        ) {
          const escalation = await escalate(
            node.id,
            { kind: "event", ref },
            ref.startsWith("staging_check:")
              ? "the staging check failed, and the failure counter reached its limit"
              : "the staging deploy failed, and the failure counter reached its limit",
          );
          if (escalation && escalation.outcome !== "rejected") {
            results.push({ nodeId: node.id, step: "checked", escalation });
          }
        }
      }
      return results;
    },
  };
}

export type Staging = ReturnType<typeof createStaging>;
