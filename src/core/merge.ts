// The runner's merge (build plan M3.3, D-102, D-218). When QA reports a pass on the head commit,
// the runner asks the library for the contract move on which it merges the PR (In QA review to
// Verifying on staging, on every track), and merges only if every guard of that move passes: the
// merge guard. Plain logic over an injected store, contracts, guards, clock, id source and GitHub
// (D-162); which move merges and what it needs come from the contracts (essential 3).
//
// Order, because a merge on GitHub cannot be undone and transitions are append-only (O-31):
// 1. Check the move's guards. Only the two the runner settles here may still fail: no merge
//    conflict (step 2 records the evidence it reads) and privileged paths (step 3 asks Didi).
// 2. Read the PR and its mergeable state from GitHub, and record that state as `merge_check`
//    evidence on the head commit: a fact the runner read itself (essential 6), recorded even in
//    dry run, like the polling backstop. Then check every guard again.
// 3. A privileged-path PR without Didi's approval for this head opens one `privileged_path` gate
//    request for the head and waits. Nothing is merged.
// 4. Squash-merge with the head the guards checked as GitHub's expected `sha`, so a commit pushed
//    after the check is refused by GitHub and never merged. A refused merge records nothing.
// 5. Only after GitHub merged: record `merge_commit` under the ingest key GitHub ingestion uses,
//    so the webhook and the runner record it once between them, then ask for the move.
// A failure after step 4 leaves a merged PR and a node still in QA review. Every later call (the
// run-end flow again, or the reconcile flow's merge pass) finds the PR merged at the node's head
// and does step 5 only: it never merges twice, and the key and the move's own trigger id
// (`github:merge_commit:<repo>#<pr>`) keep the evidence and the move to one row each.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import type { GitHub, MergeRefusal, PullRequest } from "./github.ts";
import { mergeCommitKey } from "./github-ingest.ts";
import { latest, readCiRun } from "./guards/evidence.ts";
import { privilegedPathsTouched } from "./guards/review.ts";
import {
  createLibrary,
  type Clock,
  type IdSource,
  type TransitionCheck,
  type TransitionOutcome,
  type TransitionRequest,
  type Trigger,
} from "./library.ts";
import type { Evidence, Json, Node, Store } from "./store.ts";

/** The guard that marks the moves on which the runner merges: QA's independent pass (ADR 0112). */
export const MERGE_MOVE_GUARD = "qa_verdict_independent_on_head";
/** The merge guard's checks that the runner settles itself before it merges. */
export const NO_CONFLICT_GUARD = "no_merge_conflict_on_head";
export const PRIVILEGED_GUARD = "privileged_paths_approved";

const ACTOR = { kind: "runner" as const, id: "merge" };

/** The topic of a node's privileged-path gate request. A new head supersedes the old request. */
export const privilegedPathTopic = (nodeId: string): string =>
  `privileged-path:${nodeId}`;

/** The trigger of the move that follows a merge: the merge itself, one per PR. */
export const mergeTrigger = (repo: string, pr: number): Trigger => ({
  kind: "event",
  ref: mergeCommitKey(repo, pr),
});

export interface MergeDeps {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  github: GitHub;
}

export interface MergeResult {
  outcome: TransitionOutcome;
  /** A short fixed reason, never text from GitHub. */
  reason?: string;
  failedGuards: string[];
  transitionId?: string;
  /** Set once the PR is merged on GitHub, by this call or an earlier one. */
  mergeCommitSha?: string;
  /** Why GitHub refused the squash merge, with outcome `refused`. */
  mergeRefusal?: MergeRefusal;
  /** The privileged-path gate request the merge waits on. */
  gateRequestId?: string;
}

/** What the merge works on: the node's move, its PR and the head the guards read. */
interface Target {
  node: Node;
  move: TransitionContract;
  repo: string;
  pr: number;
  headSha: string;
}

/** Either a result to stop with, or the PR as GitHub reports it and the guards after step 2. */
export type Inspection =
  | { stop: MergeResult }
  | { stop: null; target: Target; pull: PullRequest; check: TransitionCheck | null };

const failed = (check: { guardReport: { name: string; pass: boolean }[] }): string[] =>
  check.guardReport.filter((c) => !c.pass).map((c) => c.name);

const stop = (
  outcome: TransitionOutcome,
  reason: string,
  failedGuards: string[] = [],
): { stop: MergeResult } => ({ stop: { outcome, reason, failedGuards } });

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

export function createMerges(deps: MergeDeps) {
  const { store, contracts, github, clock, ids } = deps;
  const library = createLibrary(deps);

  /** The move out of the node's state on which the runner merges, for its track, if any. */
  function mergeMoveFor(node: Node): TransitionContract | undefined {
    return contracts.transitions.find(
      (move) =>
        !move.escalation &&
        !move.fallbackMove &&
        move.from === node.state &&
        move.guards.includes(MERGE_MOVE_GUARD) &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  }

  const request = (
    target: Target,
    trigger: Trigger,
    reason: string,
  ): TransitionRequest => ({
    nodeId: target.node.id,
    toState: target.move.to,
    trigger,
    actor: ACTOR,
    reason,
  });

  /** Steps 1 and 2: the guards, the PR on GitHub and its mergeable state. Writes facts only. */
  async function inspect(nodeId: string): Promise<Inspection> {
    const node = await store.getNode(nodeId);
    if (!node) return stop("rejected", "no_node");
    const move = mergeMoveFor(node);
    if (!move) return stop("rejected", "no_merge_move");
    const ciRun = latest(await store.listEvidence({ nodeId, kind: "ci_run" }));
    const ci = ciRun ? readCiRun(ciRun.payload) : null;
    if (!ciRun?.commitSha || !ci) return stop("rejected", "no_head");
    const dispatch = latest(
      await store.listEvidence({ nodeId, kind: "dispatch_record" }),
    );
    const repo = field(dispatch?.payload, "repo");
    if (typeof repo !== "string" || repo === "") return stop("rejected", "no_dispatch");
    const target: Target = { node, move, repo, pr: ci.pr, headSha: ciRun.commitSha };

    const probe = request(target, { kind: "reconcile", ref: null }, "merge check");
    const pre = await library.checkTransition(probe);
    if (pre.outcome === "noop") return stop("noop", "already_moved");
    if (pre.outcome === "rejected" && pre.reason !== "guard_failed") {
      return stop("rejected", pre.reason ?? "rejected");
    }
    const blocking = failed(pre).filter(
      (name) => name !== NO_CONFLICT_GUARD && name !== PRIVILEGED_GUARD,
    );
    if (blocking.length > 0) return stop("rejected", "guard_failed", failed(pre));

    const pull = await github.getPullRequest(repo, target.pr);
    if (!pull) return stop("rejected", "pull_request_not_found");
    // Merged already: by an earlier call whose move was not written, or by someone else.
    if (pull.merged) return { stop: null, target, pull, check: null };
    if (pull.state !== "open") return stop("rejected", "pull_request_closed");
    // A newer commit that ingestion has not recorded yet: its CI and QA come first.
    if (pull.headSha !== target.headSha) return stop("rejected", "head_not_recorded");

    const mergeability = await github.getMergeability(repo, target.pr);
    if (!mergeability) return stop("rejected", "pull_request_not_found");
    if (mergeability.headSha !== target.headSha)
      return stop("rejected", "head_not_recorded");
    await store.insertEvidence({
      id: ids.next(),
      nodeId,
      runId: null,
      kind: "merge_check",
      ref: `github:merge_check:${repo}#${target.pr}:${target.headSha}`,
      commitSha: target.headSha,
      payload: { pr: target.pr, mergeable: mergeability.mergeable },
      recordedBy: "runner",
      recordedAt: clock.now(),
      supersedesId: null,
    });
    return { stop: null, target, pull, check: await library.checkTransition(probe) };
  }

  /** Step 3: one open gate request per head; a request for an older head is superseded. */
  async function askForPrivilegedPaths(target: Target): Promise<string> {
    const topicKey = privilegedPathTopic(target.node.id);
    const open = await store.findOpenGateRequest(target.node.projectId, topicKey);
    if (open && field(open.payload, "commitSha") === target.headSha) return open.id;
    const touched = await privilegedPathsTouched({
      node: target.node,
      store,
    });
    const gate = await library.openGateRequest({
      projectId: target.node.projectId,
      nodeId: target.node.id,
      topicKey,
      kind: "privileged_path",
      owner: "didi",
      blocking: true,
      payload: {
        commitSha: target.headSha,
        repo: target.repo,
        pr: target.pr,
        paths: touched?.paths ?? [],
      },
    });
    return gate.id;
  }

  /** The `merge_commit` row for the PR, recorded now or found under its ingest key. */
  async function recordMergeCommit(
    target: Target,
    mergeCommitSha: string,
  ): Promise<string | null> {
    const key = mergeCommitKey(target.repo, target.pr);
    const evidence: Evidence = {
      id: ids.next(),
      nodeId: target.node.id,
      runId: null,
      kind: "merge_commit",
      ref: key,
      commitSha: mergeCommitSha,
      payload: { pr: target.pr },
      recordedBy: "runner",
      recordedAt: clock.now(),
      supersedesId: null,
    };
    if (await store.insertEvidenceOnce(evidence, key)) return evidence.id;
    const existing = (
      await store.listEvidence({ nodeId: target.node.id, kind: "merge_commit" })
    ).find((e) => e.ref === key);
    return existing?.id ?? null;
  }

  /** Step 5: the merge commit, then the move, each written once. */
  async function complete(
    target: Target,
    mergeCommitSha: string,
  ): Promise<MergeResult> {
    const evidenceId = await recordMergeCommit(target, mergeCommitSha);
    if (!evidenceId) {
      return {
        outcome: "rejected",
        reason: "merge_commit_recorded_elsewhere",
        failedGuards: [],
        mergeCommitSha,
      };
    }
    const result = await library.requestTransitionOnce({
      ...request(
        target,
        mergeTrigger(target.repo, target.pr),
        `the runner squash-merged PR #${target.pr} at head ${target.headSha}`,
      ),
      evidenceIds: [evidenceId],
    });
    const failedGuards = failed(result);
    return {
      outcome: result.outcome,
      ...(result.outcome === "rejected"
        ? { reason: "merged_move_rejected" }
        : result.reason
          ? { reason: result.reason }
          : {}),
      failedGuards,
      ...(result.transitionId ? { transitionId: result.transitionId } : {}),
      mergeCommitSha,
    };
  }

  /**
   * Merges the node's PR if the merge guard passes, then records the merge commit and the move
   * (steps 1 to 5 above). `trigger` is what asked for it: QA's report, or the reconcile flow. In
   * dry run nothing is merged and the move is written as a dry-run row under that trigger.
   */
  async function mergeOnPass(nodeId: string, trigger: Trigger): Promise<MergeResult> {
    if ((await store.getSetting("kill_switch"))?.value === true) {
      return { outcome: "refused", reason: "kill_switch", failedGuards: [] };
    }
    const inspected = await inspect(nodeId);
    if (inspected.stop) return inspected.stop;
    const { target, pull, check } = inspected;
    const dryRun = (await store.getSetting("dry_run"))?.value !== false;

    if (check === null) {
      // The PR is merged already. Complete the move only for the head the guards read: anything
      // else merged content the runner did not check, and needs a person.
      if (pull.headSha !== target.headSha || pull.mergeCommitSha === null) {
        return {
          outcome: "rejected",
          reason: "merged_at_another_head",
          failedGuards: [],
        };
      }
      if (dryRun) {
        return planned(target, trigger, pull.mergeCommitSha);
      }
      return complete(target, pull.mergeCommitSha);
    }

    if (check.outcome !== "allowed") {
      const names = failed(check);
      if (names.length === 1 && names[0] === PRIVILEGED_GUARD && !dryRun) {
        return {
          outcome: "rejected",
          reason: "waiting_for_privileged_path_approval",
          failedGuards: names,
          gateRequestId: await askForPrivilegedPaths(target),
        };
      }
      return {
        outcome: check.outcome === "noop" ? "noop" : "rejected",
        reason: check.reason ?? "guard_failed",
        failedGuards: names,
      };
    }
    if (dryRun) return planned(target, trigger);

    const merge = await github.squashMerge(target.repo, target.pr, target.headSha);
    if (!merge.merged) {
      return {
        outcome: "refused",
        reason: "merge_refused",
        mergeRefusal: merge.reason,
        failedGuards: [],
      };
    }
    return complete(target, merge.mergeCommitSha);
  }

  /** Dry run: the move as a dry-run row under the caller's trigger. Nothing is merged. */
  async function planned(
    target: Target,
    trigger: Trigger,
    mergeCommitSha?: string,
  ): Promise<MergeResult> {
    const result = await library.requestTransitionOnce(
      request(
        target,
        trigger,
        `would squash-merge PR #${target.pr} at head ${target.headSha}`,
      ),
    );
    return {
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      failedGuards: failed(result),
      ...(result.transitionId ? { transitionId: result.transitionId } : {}),
      ...(mergeCommitSha ? { mergeCommitSha } : {}),
    };
  }

  return {
    mergeMoveFor,
    inspect,
    mergeOnPass,

    /**
     * The reconcile flow's merge pass in live mode: every node in a state with a merge move. It
     * merges a PR QA passed whose report did not lead to the merge, and completes a merge whose
     * move was not written. The trigger names the node, so a dry-run row is written once.
     */
    async mergeReady(): Promise<{ nodeId: string; result: MergeResult }[]> {
      const results: { nodeId: string; result: MergeResult }[] = [];
      for (const node of await store.listNodes({})) {
        if (!mergeMoveFor(node)) continue;
        const result = await mergeOnPass(node.id, {
          kind: "reconcile",
          ref: `merge:${node.id}`,
        });
        results.push({ nodeId: node.id, result });
      }
      return results;
    },
  };
}

export type Merges = ReturnType<typeof createMerges>;
