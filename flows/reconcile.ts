// The reconcile flow (build plan M3.1, architecture section 2.5), on the schedule in
// flows/windmill.yaml (`reconcile_interval_minutes`, D-164). It reads this month's Windmill
// execution count and runs one reconcile pass in dry run, which checks the kill switch and
// `dry_run` itself and computes the execution alert (D-167). On the kill switch it runs the cancel
// pass (D-202); with `dry_run` off it runs the merge pass, which also recovers a merge (O-31).
import { createMerges, type MergeResult } from "../src/core/merge.ts";
import { reconcile, type ExecutionAlert } from "../src/core/reconcile.ts";
import { cancelActiveRuns, type CancelRunsReport } from "./lib/cancel-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface ReconcileFlowResult {
  stopped: "kill_switch" | "live_mode_not_built" | null;
  planned: { releases: number; dispatches: number; advances: number; merges: number };
  attention: number;
  stalls: number;
  gateCleanup: number;
  failedPolls: number;
  executions: ExecutionAlert | null; // null when the count could not be read
  /** The cancel pass under the kill switch; the merge pass with `dry_run` off. */
  cancelled: CancelRunsReport | null;
  merged: { nodeId: string; result: MergeResult }[] | null;
  problems: string[];
}

export async function run(deps: FlowDeps): Promise<ReconcileFlowResult> {
  const problems: string[] = [];
  let count: number | undefined;
  try {
    count = await deps.executionsThisMonth();
  } catch {
    problems.push("the Windmill execution count could not be read: no alert check");
  }
  const report = await reconcile(deps, { windmillExecutionsThisMonth: count });
  const cancelled =
    report.stopped === "kill_switch" ? await cancelActiveRuns(deps) : null;
  const live = report.stopped === "live_mode_not_built";
  const merged = live ? await createMerges(deps).mergeReady() : null;
  return {
    stopped: report.stopped,
    planned: {
      releases: report.releases.length,
      dispatches: report.dispatches.length,
      advances: report.advances.length,
      merges: report.merges.length,
    },
    merged,
    attention: report.attention.length,
    stalls: report.stalls.length,
    gateCleanup: report.gateCleanup.length,
    failedPolls: report.polls.filter((p) => p.error).length,
    executions: report.executions,
    cancelled,
    problems: [...problems, ...report.problems],
  };
}

export const main = (): Promise<ReconcileFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps));
