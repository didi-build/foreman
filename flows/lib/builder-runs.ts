// Starts the builder runs that are due with no move (O-41): an item a failed QA round or staging
// check sent back to In development or Building components, with no builder run since, and an
// item whose builder run ended `usage_exhausted` (src/core/builder-runs.ts finds them). Each goes
// through the dispatch (./start-run.ts), so admission decides under its lock: the kill switch, the
// Developer and cluster limits, one active run per item and the usage-exhausted wait. Two
// triggers at once therefore give one run, and a trigger after the run started finds it and
// starts nothing. Run by the reconcile flow's live passes and right after a fail move is written
// (the run-end flow for QA's fail, the staging flow for a staging fail).
import {
  createBuilderRuns,
  type BuilderRunCause,
} from "../../src/core/builder-runs.ts";
import { createRunReports, type ReportedMove } from "../../src/core/run-reports.ts";
import type { AgentRole } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import { startRun, type StartRunResult } from "./start-run.ts";

export interface BuilderRunStart {
  nodeId: string;
  role: AgentRole;
  cause: BuilderRunCause;
  /** The dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result: StartRunResult | { outcome: "start_failed" };
}

/** Starts each due builder run: on the given nodes, or on every node when none are given. */
export async function startBuilderRuns(
  deps: FlowDeps,
  nodeIds?: readonly string[],
): Promise<BuilderRunStart[]> {
  const builderRuns = createBuilderRuns(deps);
  const due = nodeIds
    ? (await Promise.all(nodeIds.map((id) => builderRuns.check(id)))).filter(
        (c) => c.due,
      )
    : await builderRuns.listDue();
  const started: BuilderRunStart[] = [];
  for (const { nodeId, role, cause } of due) {
    let result: BuilderRunStart["result"];
    try {
      result = await startRun(deps, { nodeId, role });
    } catch {
      // A start that threw has already ended its run `fail` and counted a repeated failure
      // (./start-run.ts). That run never started, so the item stays due and the next trigger
      // tries again, until the escalation is due.
      result = { outcome: "start_failed" };
    }
    started.push({ nodeId, role, cause, result });
  }
  return started;
}

/** What follows a run's recorded end: its reported move, and the fix round that move calls for. */
export interface AfterReport {
  move: ReportedMove;
  builderRuns: BuilderRunStart[];
}

/**
 * Asks for the move the run's report triggers (src/core/run-reports.ts). When that move was
 * applied (QA's fail sends the item back), or the builder's done report was refused and counted
 * toward `failure` (P-03, O-43), it starts the item's fix round, if one is due; the escalation
 * check in src/core/builder-runs.ts bounds it. Any other move, or none, starts nothing.
 */
export async function reportedMoveAndFixRound(
  deps: FlowDeps,
  runId: string,
): Promise<AfterReport> {
  const move = await createRunReports(deps).requestReportedMove(runId);
  const nodeId = (await deps.store.getRun(runId))?.nodeId;
  const applied = move.requested && move.outcome === "applied";
  const refused =
    move.requested &&
    move.failureCount !== undefined &&
    move.failureCount.counted !== false;
  return {
    move,
    builderRuns:
      (applied || refused) && nodeId ? await startBuilderRuns(deps, [nodeId]) : [],
  };
}
