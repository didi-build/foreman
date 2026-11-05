// The reconcile flow (M3.1, section 2.5) on its schedule (D-164), the safety net for missed events
// (D-274). It checks the month's Windmill runs (D-167), lists held and stalled work (D-272, D-302)
// and runs one pass; the kill switch runs the cancel pass, and live mode acts (O-103, live-passes).
import { reconcile, type ExecutionAlert } from "../src/core/reconcile.ts";
import { cancelActiveRuns, type CancelRunsReport } from "./lib/cancel-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { dailyCheckLists, type DailyCheck } from "./lib/held-items.ts";
import { runLivePasses, type LivePasses } from "./lib/live-passes.ts";
import { windmillEnvironment } from "./lib/windmill.ts";
type Planned = "releases" | "dispatches" | "advances" | "merges" | "staging";
export interface ReconcileFlowResult extends Omit<LivePasses, "problems">, DailyCheck {
  mode: "dry_run" | "live"; // live: the flow acted on the plan
  stopped: "kill_switch" | null;
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
  const live = await runLivePasses(deps, report);
  return {
    ...live,
    mode: report.mode,
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
    ...(await dailyCheckLists(deps, problems)),
    problems: [...problems, ...report.problems, ...live.problems],
  };
}

export const main = (): Promise<ReconcileFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps));
