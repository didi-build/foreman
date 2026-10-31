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
// 2. The deploy (O-34): GitHub's deployments of exactly that commit to the `staging` environment.
//    One whose latest status is `success` is recorded as `staging_deploy` evidence, a fact the
//    runner read itself, also in dry run (like the polling backstop and `merge_check`).
// 3. The check (O-35): in live mode only. A check that names the merge commit as what staging
//    serves gives `staging_check {pass}`, once per merge commit under its key. A check that ends
//    without a result, or finds staging serving another commit, gives `staging_no_result`: the
//    first is re-dispatched on the next call, the second sends the item to the Council (O-36).
// 4. The move (O-37): a pass moves to Done and resets the counters in the same transaction, then
//    releases the items it blocked. A fail takes the fallback move back to the building state and
//    adds one to `failure` in the same transaction, then asks for the escalation, which the
//    guards allow once `failure` reaches `failure_threshold` (P-03). Each move's trigger id names
//    the check (`staging_check:<evidence id>`), so a repeated call writes one row.
// A failure part way is recovered by the next call: the facts are keyed, the moves are taken once
// per trigger, and the live pass (`verifyReady`) asks again for an escalation or a release that a
// failure left behind.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import type { GitHubDeploymentReader } from "./github.ts";
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
  github: GitHubDeploymentReader;
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
  /** GitHub has not reported a successful staging deploy of the merge commit. */
  | "waiting_for_deploy"
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
  checkEvidenceId?: string;
  noResultEvidenceId?: string;
  move?: StagingMove;
  escalation?: StagingMove;
  /** The blocked items asked for after Done. */
  released?: { nodeId: string; move: StagingMove }[];
}

/** The key of a staging deploy: one per GitHub deployment. */
export const stagingDeployKey = (repo: string, deploymentId: number): string =>
  `github:staging_deploy:${repo}:deployment-${deploymentId}`;

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

  /** Step 4: the move a recorded check calls for, with its counter write, then what follows. */
  async function decide(
    node: Node,
    moves: { pass: TransitionContract; fail: TransitionContract | undefined },
    check: Evidence,
    base: StagingResult,
  ): Promise<StagingResult> {
    const passed = field(check.payload, "pass") === true;
    const move = passed ? moves.pass : moves.fail;
    if (!move) return { ...base, step: "checked" };
    const trigger = stagingCheckTrigger(check.id);
    const dryRun = await dryRunOn();
    const at = clock.now();
    // P-03: Done resets both counters; a failed staging check adds one to `failure`. Each commits
    // with its move, so a move taken once counts once. Dry run writes neither.
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
        evidenceIds: [check.id],
        reason: passed
          ? `the staging check passed for merge ${check.commitSha}`
          : `the staging check failed for merge ${check.commitSha}`,
      },
      dryRun ? undefined : counters,
    );
    const checked: StagingResult = {
      ...base,
      step: "checked",
      move: asMove(move.to, result),
    };
    if (dryRun || result.outcome === "rejected" || result.outcome === "refused") {
      return checked;
    }
    if (passed) return { ...checked, released: await releaseDependents(node.id) };
    const escalation = await escalate(
      node.id,
      trigger,
      `the staging check failed for merge ${check.commitSha}, and the failure counter reached its limit`,
    );
    return escalation ? { ...checked, escalation } : checked;
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

    // Step 1.
    const merge = latest(await store.listEvidence({ nodeId, kind: "merge_commit" }));
    const sha = merge?.commitSha;
    if (!sha) return { nodeId, step: "no_merge_commit" };
    const base: StagingResult = { nodeId, step: "checked", mergeCommitSha: sha };

    const check = latest(
      await store.listEvidence({ nodeId, kind: "staging_check", commitSha: sha }),
    );
    if (check) {
      return decide(node, moves, check, { ...base, checkEvidenceId: check.id });
    }

    // Step 2.
    const dispatch = latest(
      await store.listEvidence({ nodeId, kind: "dispatch_record" }),
    );
    const repo = field(dispatch?.payload, "repo");
    if (typeof repo !== "string" || repo === "")
      return { ...base, step: "no_dispatch" };
    let deploy = latest(
      await store.listEvidence({ nodeId, kind: "staging_deploy", commitSha: sha }),
    );
    if (!deploy) {
      let found;
      try {
        found = (await github.listDeployments(repo, STAGING_ENVIRONMENT, sha)).find(
          (d) => d.sha === sha && d.state === "success",
        );
      } catch {
        return { ...base, step: "github_read_failed" };
      }
      if (!found) return { ...base, step: "waiting_for_deploy" };
      const key = stagingDeployKey(repo, found.id);
      deploy =
        (await recordOnce(
          fact(
            node,
            "staging_deploy",
            sha,
            { environment: STAGING_ENVIRONMENT, deploymentId: found.id },
            key,
          ),
          key,
        )) ?? undefined;
      if (!deploy) return { ...base, step: "waiting_for_deploy" };
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
    if (outcome.result !== "no_result" && outcome.servedCommitSha === sha) {
      const key = stagingCheckKey(repo, sha);
      const recorded = await recordOnce(
        fact(node, "staging_check", sha, { pass: outcome.result === "pass" }, key),
        key,
      );
      if (!recorded) return { ...withDeploy, step: "check_error" };
      return decide(node, moves, recorded, {
        ...withDeploy,
        checkEvidenceId: recorded.id,
      });
    }

    // No result: staging did not answer, or serves another commit than the merge commit.
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
     * event). Only the node whose latest merge commit is exactly `sha` is verified; a deploy of
     * any other commit does nothing. The deploy itself is read from GitHub again, never taken
     * from the event.
     */
    async verifyCommit(repo: string, sha: string): Promise<StagingResult[]> {
      const results: StagingResult[] = [];
      for (const dispatch of await store.listDispatches({ repo })) {
        const merge = latest(
          await store.listEvidence({ nodeId: dispatch.nodeId, kind: "merge_commit" }),
        );
        if (merge?.commitSha === sha) results.push(await verify(dispatch.nodeId));
      }
      return results;
    },

    /**
     * The live pass, run by the reconcile flow with `dry_run` off: every node in Verifying on
     * staging, then the recovery of what a failure part way left behind. A node whose latest move
     * was a failed staging check is asked for its escalation again, and every Done node for the
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
        if (
          lastMove?.toState === node.state &&
          lastMove.triggerKind === "event" &&
          lastMove.triggerRef?.startsWith("staging_check:")
        ) {
          const escalation = await escalate(
            node.id,
            { kind: "event", ref: lastMove.triggerRef },
            "the staging check failed, and the failure counter reached its limit",
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
