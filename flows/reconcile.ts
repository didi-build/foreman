// The reconcile flow (build plan M3.1, architecture section 2.5), on the schedule in
// flows/windmill.yaml (`reconcile_interval_minutes`, D-164). It reads this month's Windmill
// execution count and runs one reconcile pass in dry run, which checks the kill switch and
// `dry_run` itself and computes the execution alert (D-167). On the kill switch it runs the cancel
// pass (D-202); with `dry_run` off, the merge and staging passes (./lib/live-passes.ts), whose
// results it carries, with their staging deploy waits on the attention count (D-225).
import { reconcile, type ExecutionAlert } from "../src/core/reconcile.ts";
import { cancelActiveRuns, type CancelRunsReport } from "./lib/cancel-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { runLivePasses, type LivePasses } from "./lib/live-passes.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

type Planned = "releases" | "dispatches" | "advances" | "merges" | "staging";
export interface ReconcileFlowResult extends Omit<LivePasses, "problems"> {
  stopped: "kill_switch" | "live_mode_not_built" | null;
  planned: Record<Planned, number>;
  attention: number;
  stalls: number;
  gateCleanup: number;
  failedPolls: number;
  executions: ExecutionAlert | null; // null when the count could not be read
  cancelled: CancelRunsReport | null; // the cancel pass, under the kill switch
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
  const live = await runLivePasses(deps, report.stopped);
  return {
    ...live,
    stopped: report.stopped,
    planned: {
      releases: report.releases.length,
      dispatches: report.dispatches.length,
      advances: report.advances.length,
      merges: report.merges.length,
      staging: report.staging.length,
    },
    attention: report.attention.length + (live.stagingWaits?.length ?? 0),
    stalls: report.stalls.length,
    gateCleanup: report.gateCleanup.length,
    failedPolls: report.polls.filter((p) => p.error).length,
    executions: report.executions,
    cancelled,
    problems: [...problems, ...report.problems, ...live.problems],
  };
}

export const main = (): Promise<ReconcileFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps));
