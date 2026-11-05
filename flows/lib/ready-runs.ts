// The first run of a ready item, started by the flow whose move made it ready (D-274, D-329 slice
// 3, O-103). A move into Ready for dev or Ready for design exploration, or a change that lets an
// item there start (its hold cleared, its stale flag cleared, its last blocker Done, its gate
// request answered), is followed in the same flow by the item's first run, as the fix-round
// starts follow a fail move (./builder-runs.ts). The reconcile pass stays the safety net: its
// dispatch step decides each ready item with the same check (src/core/ready-runs.ts).
//
// Under the kill switch or in dry run it starts and plans nothing: the switches are read as every
// flow reads them (./switches.ts), and the pass takes the item on once both are off. Otherwise
// each start goes through the dispatch (./start-run.ts), so admission decides under its lock as
// for every run: the kill switch again, one active run per item, the Developer and cluster
// limits, the usage-exhausted wait and the route. The start records the dispatch move with its
// `dispatch_record`. Two triggers at once therefore give one run, and a trigger after the run
// started finds the item moved on and starts nothing. A refusal is reported in the result, never
// thrown, and the next trigger or pass tries again. No Windmill run is added: the start runs
// inside the flow that took the move.
//
// Two more starts follow the same rules (D-329 slice 4, O-104). QA's run on an item in review
// (`startQaRuns`, settles N-80): the run-end flow asks QA's check (src/core/ready-runs.ts) once a
// builder's run ends and its report moved the item into In QA review, or a QA run ends with the
// item still there, and starts the run it names on the pull request and head commit the newest
// `ci_run` gives (the evidence the move's `ci_green_on_head` guard read), never what the agent
// reported: QA's review, then on the design track the visual comparison once the review passed.
// The freed slot (`startFreedSlots`, settles N-81): once a run's end is recorded, the slot it held
// is free, so the run-end flow starts the first runs of the run's project's ready items, in the
// pass's order (the store's node order), each through admission, so as many start as now fit.
import { createReadyRuns } from "../../src/core/ready-runs.ts";
import type { StagingResult } from "../../src/core/staging.ts";
import type { AgentRole } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import { startRun, type StartRunResult } from "./start-run.ts";
import { heldBy } from "./switches.ts";

export interface ReadyRunStart {
  nodeId: string;
  role: AgentRole;
  /** The dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result: StartRunResult | { outcome: "start_failed" };
}

/**
 * Starts the first run of each given node whose first run is due now (once per node, in the
 * given order). Nodes with nothing due are left out of the result, and so is everything while a
 * switch holds the runner.
 */
export async function startReadyRuns(
  deps: FlowDeps,
  nodeIds: readonly string[],
): Promise<ReadyRunStart[]> {
  if (nodeIds.length === 0 || (await heldBy(deps.store)) !== null) return [];
  const ready = createReadyRuns(deps);
  const started: ReadyRunStart[] = [];
  for (const nodeId of new Set(nodeIds)) {
    const check = await ready.check(nodeId);
    if (!check.due) continue;
    let result: ReadyRunStart["result"];
    try {
      result = await startRun(deps, { nodeId, role: check.role });
    } catch {
      // A start that threw has already ended its run `fail` and counted a repeated failure
      // (./start-run.ts). The item stays ready, so the next trigger or pass tries again.
      result = { outcome: "start_failed" };
    }
    started.push({ nodeId, role: check.role, result });
  }
  return started;
}

/**
 * After the staging step (src/core/staging.ts): the first runs of the items each node that reached
 * Done blocks. A released item is now in Ready for dev; a design item waits in Ready for design
 * exploration with no Blocked state (D-268), and its blocker's Done is what lets it start. An item
 * with another blocker still open is not due, so nothing starts for it.
 */
export async function firstRunsAfterStaging(
  deps: FlowDeps,
  results: readonly StagingResult[],
): Promise<ReadyRunStart[]> {
  const freed: string[] = [];
  for (const result of results) {
    if (!result.released) continue;
    for (const edge of await deps.store.listEdges({
      fromNode: result.nodeId,
      type: "blocks",
    }))
      freed.push(edge.toNode);
  }
  return freed.length > 0 ? startReadyRuns(deps, freed) : [];
}

/** QA's run on an item in review, started once its check said it is due (N-80, O-104). */
export interface QaRunStart {
  nodeId: string;
  /** Null for the review, `qa:visual` for the visual comparison. */
  taskType: string | null;
  prNumber: number;
  headSha: string;
  /** The dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result: StartRunResult | { outcome: "start_failed" };
}

/**
 * Starts QA's next run on each given node in review whose run is due now (once per node, in the
 * given order). Nodes with nothing due are left out, and so is everything while a switch holds the
 * runner.
 */
export async function startQaRuns(
  deps: FlowDeps,
  nodeIds: readonly string[],
): Promise<QaRunStart[]> {
  if (nodeIds.length === 0 || (await heldBy(deps.store)) !== null) return [];
  const ready = createReadyRuns(deps);
  const started: QaRunStart[] = [];
  for (const nodeId of new Set(nodeIds)) {
    const check = await ready.qaCheck(nodeId);
    if (!check.due) continue;
    const { prNumber, headSha, taskType } = check;
    let result: QaRunStart["result"];
    try {
      result = await startRun(deps, {
        nodeId,
        role: "qa",
        prNumber,
        headSha,
        ...(taskType ? { taskType } : {}),
      });
    } catch {
      // The run ended `fail` before it started (./start-run.ts), which QA's check does not count
      // as QA having run, so the next trigger or pass tries again.
      result = { outcome: "start_failed" };
    }
    started.push({ nodeId, taskType, prNumber, headSha, result });
  }
  return started;
}

/**
 * After a run's end is recorded (N-81): the first runs of the project's ready items, in the pass's
 * order, as many as admission now lets start. Items with nothing due are left out.
 */
export async function startFreedSlots(
  deps: FlowDeps,
  projectId: string,
): Promise<ReadyRunStart[]> {
  const nodes = await deps.store.listNodes({ projectId });
  return startReadyRuns(
    deps,
    nodes.map((n) => n.id),
  );
}
