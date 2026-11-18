// Starts the builder runs that are due with no move (O-41): an item a failed QA round or staging
// check sent back to In development or Building components, with no builder run since, an item
// whose builder run ended `usage_exhausted`, and an item whose builder run ended `fail`, `timeout`
// or `cancelled` (D-413, O-142; src/core/builder-runs.ts finds them). Each goes through the
// dispatch (./start-run.ts), so admission decides under its lock: the kill switch, the Developer
// and cluster limits, one active run per item and the usage-exhausted wait. Two triggers at once
// therefore give one run, and a trigger after the run started finds it and starts nothing. Run by
// the reconcile flow's live passes and right after a fail move is written (the run-end flow for
// QA's fail, the staging flow for a staging fail), and by the run-end flow right after a builder
// run ended without success.
//
// A run that failed or timed out counts one toward `failure` first (`runFailed`, ./failures.ts),
// once per run under its key, which asks for the escalation; the check then decides again, so the
// third failure goes to the Council and starts nothing. A cancelled run counts nothing.
import {
  createBuilderRuns,
  type BuilderRunCause,
} from "../../src/core/builder-runs.ts";
import { createFailures, type FailureCount } from "../../src/core/failures.ts";
import { createRunReports, type ReportedMove } from "../../src/core/run-reports.ts";
import type { AgentRole } from "../../src/core/store.ts";
import { PUSHING_ROLES } from "../../src/core/task-input.ts";
import type { FlowDeps } from "./compose.ts";
import { startRun, type StartRunResult } from "./start-run.ts";
import { startFailed, type StartFailed } from "./start-failure.ts";

export interface BuilderRunStart {
  nodeId: string;
  role: AgentRole;
  cause: BuilderRunCause;
  /** With `failed`: the failed run's count toward `failure`, taken before the start (D-413). */
  failureCount?: FailureCount;
  /**
   * The dispatch's result, or `start_failed` when it threw, with its error's kind and step
   * (D-384). `not_started` with the check's reason when the count escalated the item (D-413).
   */
  result: StartRunResult | StartFailed;
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
  for (const { nodeId, role, cause, runId } of due) {
    let failureCount: FailureCount | undefined;
    if (cause === "failed" && runId) {
      // D-413: the failed run counts once before the next one starts. At the threshold the count
      // escalates the item, and the check, asked again, then finds nothing due.
      failureCount = await createFailures(deps).runFailed(runId);
      const again = await builderRuns.check(nodeId);
      if (!again.due) {
        started.push({
          nodeId,
          role,
          cause,
          failureCount,
          result: { outcome: "not_started", reason: again.reason, failedGuards: [] },
        });
        continue;
      }
    }
    let result: BuilderRunStart["result"];
    try {
      result = await startRun(deps, { nodeId, role });
    } catch (error) {
      // A start that threw has already ended its run `fail` and counted a repeated failure
      // (./start-run.ts). That run never started, so the item stays due and the next trigger
      // tries again, until the escalation is due.
      result = startFailed(error);
    }
    started.push({
      nodeId,
      role,
      cause,
      ...(failureCount ? { failureCount } : {}),
      result,
    });
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
 * check in src/core/builder-runs.ts bounds it. A Developer or Designer run that ended without
 * success starts the item's next run the same way (D-413), counted first when it failed or timed
 * out. Any other move, or none, starts nothing.
 */
export async function reportedMoveAndFixRound(
  deps: FlowDeps,
  runId: string,
): Promise<AfterReport> {
  const move = await createRunReports(deps).requestReportedMove(runId);
  const run = await deps.store.getRun(runId);
  const nodeId = run?.nodeId;
  const applied = move.requested && move.outcome === "applied";
  const refused =
    move.requested &&
    move.failureCount !== undefined &&
    move.failureCount.counted !== false;
  const unsuccessful =
    !move.requested &&
    move.reason === "not_success" &&
    PUSHING_ROLES.includes(run?.bot as AgentRole);
  return {
    move,
    builderRuns:
      (applied || refused || unsuccessful) && nodeId
        ? await startBuilderRuns(deps, [nodeId])
        : [],
  };
}
