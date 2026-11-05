// The first run of a ready item (architecture section 2.5 step 3, D-274, D-329 slice 3). A node is
// ready for an agent when its state has a move guarded by `agent_ready_not_on_hold` for its track
// (the dispatch move, contracts/machine-2): Ready for dev and Ready for design exploration. Its
// first run is due when the state's owner is an agent role, the node may be dispatched (not
// escalated, on hold, not agent-ready or stale: schema invariant 6, O-45), no run on it is active,
// the wait after a `usage_exhausted` end has passed, and the dispatch move's guards pass now.
// The runner then starts the run through the dispatch (flows/lib/start-run.ts): admission decides
// under its lock (the kill switch, dry run, one active run per item, the limits and the route),
// and the start records the dispatch move with the run's `dispatch_record`.
//
// One check, so nothing can drift: the reconcile pass's dispatch step (./reconcile.ts) decides
// each ready node with it, in dry run and in live mode, and each flow whose move makes an item
// ready asks it right after the move (flows/lib/ready-runs.ts). Plain logic over an injected
// store, contracts, guards, clock and id source (D-162). It reads only.
//
// QA's run on an item in review (`qaCheck`, D-329 slice 4, O-104, settles N-80) is the same check
// for the state QA owns (In QA review), which has no dispatch move: QA's run starts with no move.
// It is due when no run on the item is active, the newest `ci_run` names the head and says CI is
// green there (the head every guard reads, D-178), QA has not yet run on that pull request and
// head, the item may be dispatched, and the wait after a `usage_exhausted` end has passed. QA's
// runs on a head come in a fixed order, one at a time since admission allows one active run per
// item: the review first (task type `qa:review`), then on the design track, once the review's
// verdict on the head is a pass, the visual comparison (`qa:visual`, D-242). A run counts as QA
// having run unless it never started (it ended `fail` with no handle, ./failures.ts) or it is the
// node's latest run, queued after `usage_exhausted`, which goes on once its wait has passed. A run
// the kill switch cancelled counts, as for a builder run: nothing restarts on its own. The second
// visual run after a `cannot_tell` stays `visualRerunCheck`'s (./visual-comparison.ts). The run-end
// flow asks it after a builder's or QA's run ends, and the pass's dispatch step plans it as the
// safety net, in both modes.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import { failedStart } from "./failures.ts";
import { latest, readCiRun, readQaVerdict } from "./guards/evidence.ts";
import { createLibrary, type Clock, type IdSource } from "./library.ts";
import { DISPATCH_GUARD } from "./run-start.ts";
import { createRuns, type RoleRunLimits, type RunLimits } from "./runs.ts";
import type { AgentRole, Node, Store, UsageExhaustedCause } from "./store.ts";
import type { TaskTypes } from "./task-types.ts";
import { VISUAL_TASK_TYPE } from "./visual-comparison.ts";

const AGENT_ROLES: readonly AgentRole[] = [
  "developer",
  "qa",
  "designer",
  "council",
  "triage",
];

const ACTOR = { kind: "runner" as const, id: "reconcile" };
const TRIGGER = { kind: "reconcile" as const, ref: null };

export interface ReadyRunsOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  limits: RoleRunLimits;
  taskLimits?: Readonly<Record<string, RunLimits>>;
  taskTypes: TaskTypes;
}

/** Whether the node's first run is due now, and if not, why. */
export type ReadyRunCheck =
  | {
      due: true;
      nodeId: string;
      /** The state's owner, which the run is for. */
      role: AgentRole;
      /** Where the dispatch move takes the node once the run's start is recorded. */
      toState: string;
    }
  | {
      due: false;
      nodeId: string;
      role: AgentRole | null;
      reason:
        | "no_node"
        /** The state has no dispatch move for the node's track: not a ready state. */
        | "not_ready"
        /** The state's owner is not an agent role. */
        | "no_role"
        /** On hold, not agent-ready, stale or escalated (schema invariant 6). */
        | "not_dispatchable"
        /** A run on the node is active: its first run has started. */
        | "active_run";
    }
  | {
      due: false;
      nodeId: string;
      role: AgentRole;
      reason: "waiting";
      /** Queued after `usage_exhausted`: its cause, and when it may resume. */
      cause: UsageExhaustedCause;
      resumeAt: Date | null;
    }
  | {
      due: false;
      nodeId: string;
      role: AgentRole;
      reason: "guard_failed";
      /** The dispatch move's guards that fail, by name. */
      failedGuards: string[];
    };

/** Whether QA's next run on an item in review is due now, and if not, why. */
export type QaRunCheck =
  | {
      due: true;
      nodeId: string;
      role: "qa";
      /** The pull request and head commit, from the newest `ci_run`. */
      prNumber: number;
      headSha: string;
      /** Null for the review (`qa:review`), or `qa:visual` for the visual comparison. */
      taskType: string | null;
    }
  | {
      due: false;
      nodeId: string;
      reason:
        | "no_node"
        /** The state's owner is not QA: not in review. */
        | "not_review"
        /** A run on the node is active. */
        | "active_run"
        /** No `ci_run` names a head. */
        | "no_head"
        /** CI on the head is pending or failed. */
        | "ci_not_green"
        /** QA's runs on the head have run, or the next one waits for the review to pass. */
        | "ran"
        /** On hold, not agent-ready or stale (schema invariant 6). */
        | "not_dispatchable";
    }
  | {
      due: false;
      nodeId: string;
      reason: "waiting";
      cause: UsageExhaustedCause;
      resumeAt: Date | null;
    };

export function createReadyRuns(options: ReadyRunsOptions) {
  const { store, contracts } = options;
  const library = createLibrary(options);
  const runs = createRuns(options);

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;

  /** The dispatch move out of the node's state for its track, when the state has one. */
  function dispatchMoveOf(node: Node): TransitionContract | undefined {
    return contracts.transitions.find(
      (move) =>
        !move.escalation &&
        move.from === node.state &&
        move.guards.includes(DISPATCH_GUARD) &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  }

  /** The agent role that owns the node's state, or null when the owner is not one. */
  function ownerRole(node: Node): AgentRole | null {
    const owner = stateOf(node.state)?.owner?.toLowerCase();
    return AGENT_ROLES.find((role) => role === owner) ?? null;
  }

  /** The check for a node already read. Reads only. */
  async function checkNode(node: Node): Promise<ReadyRunCheck> {
    const nodeId = node.id;
    const move = dispatchMoveOf(node);
    const role = ownerRole(node);
    if (!move) return { due: false, nodeId, role, reason: "not_ready" };
    if (role === null) return { due: false, nodeId, role, reason: "no_role" };
    if (!library.canDispatch(node)) {
      return { due: false, nodeId, role, reason: "not_dispatchable" };
    }
    if ((await store.listRuns({ nodeId })).some((r) => r.endedAt === null)) {
      return { due: false, nodeId, role, reason: "active_run" };
    }
    const queued = await runs.queuedDispatch(nodeId);
    if (queued && !queued.ready) {
      return {
        due: false,
        nodeId,
        role,
        reason: "waiting",
        cause: queued.cause,
        resumeAt: queued.resumeAt,
      };
    }
    const check = await library.checkTransition({
      nodeId,
      toState: move.to,
      trigger: TRIGGER,
      actor: ACTOR,
    });
    if (check.outcome !== "allowed") {
      return {
        due: false,
        nodeId,
        role,
        reason: "guard_failed",
        failedGuards: check.guardReport.filter((c) => !c.pass).map((c) => c.name),
      };
    }
    return { due: true, nodeId, role, toState: move.to };
  }

  /** QA's check for a node already read. Reads only. */
  async function qaCheckNode(node: Node): Promise<QaRunCheck> {
    const nodeId = node.id;
    if (ownerRole(node) !== "qa") return { due: false, nodeId, reason: "not_review" };
    const nodeRuns = await store.listRuns({ nodeId });
    if (nodeRuns.some((r) => r.endedAt === null)) {
      return { due: false, nodeId, reason: "active_run" };
    }
    const ciRun = latest(await store.listEvidence({ nodeId, kind: "ci_run" }));
    const ci = ciRun ? readCiRun(ciRun.payload) : null;
    const headSha = ciRun?.commitSha;
    if (!headSha || !ci) return { due: false, nodeId, reason: "no_head" };
    if (ci.conclusion !== "success") {
      return { due: false, nodeId, reason: "ci_not_green" };
    }
    const queued = await runs.queuedDispatch(nodeId);
    const ran = [];
    for (const run of nodeRuns) {
      if (run.bot !== "qa" || run.headSha !== headSha || run.prNumber !== ci.pr)
        continue;
      if (run.id === queued?.runId || (await failedStart(store, run))) continue;
      ran.push(run);
    }
    let taskType: string | null | undefined;
    if (!ran.some((r) => r.taskType !== VISUAL_TASK_TYPE)) {
      taskType = null;
    } else if (
      node.track === "design" &&
      !ran.some((r) => r.taskType === VISUAL_TASK_TYPE)
    ) {
      const verdict = latest(
        await store.listEvidence({ nodeId, kind: "qa_verdict", commitSha: headSha }),
      );
      if (verdict && readQaVerdict(verdict.payload)?.verdict === "pass") {
        taskType = VISUAL_TASK_TYPE;
      }
    }
    if (taskType === undefined) return { due: false, nodeId, reason: "ran" };
    if (!library.canDispatch(node)) {
      return { due: false, nodeId, reason: "not_dispatchable" };
    }
    if (queued && !queued.ready) {
      return {
        due: false,
        nodeId,
        reason: "waiting",
        cause: queued.cause,
        resumeAt: queued.resumeAt,
      };
    }
    return { due: true, nodeId, role: "qa", prNumber: ci.pr, headSha, taskType };
  }

  return {
    dispatchMoveOf,
    ownerRole,
    checkNode,
    qaCheckNode,

    /** Whether QA's next run on the node in review is due now. Reads only. */
    async qaCheck(nodeId: string): Promise<QaRunCheck> {
      const node = await store.getNode(nodeId);
      if (!node) return { due: false, nodeId, reason: "no_node" };
      return qaCheckNode(node);
    },

    /** Whether the node's first run is due now. Reads only. */
    async check(nodeId: string): Promise<ReadyRunCheck> {
      const node = await store.getNode(nodeId);
      if (!node) return { due: false, nodeId, role: null, reason: "no_node" };
      return checkNode(node);
    },
  };
}

export type ReadyRuns = ReturnType<typeof createReadyRuns>;
