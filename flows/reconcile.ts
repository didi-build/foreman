// The reconcile flow (build plan M3.1, architecture section 2.5), on the schedule in
// flows/windmill.yaml (`reconcile_interval_minutes`, 120 until Kubernetes, D-164). It reads this
// month's Windmill execution count and runs one reconcile pass in dry run, which checks the kill
// switch and `dry_run` itself and computes the execution alert from the count (D-167).
import { reconcile, type ExecutionAlert } from "../src/core/reconcile.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface ReconcileFlowResult {
  stopped: "kill_switch" | "live_mode_not_built" | null;
  planned: { releases: number; dispatches: number; advances: number };
  attention: number;
  stalls: number;
  gateCleanup: number;
  failedPolls: number;
  /** Null when the count could not be read. */
  executions: ExecutionAlert | null;
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
  return {
    stopped: report.stopped,
    planned: {
      releases: report.releases.length,
      dispatches: report.dispatches.length,
      advances: report.advances.length,
    },
    attention: report.attention.length,
    stalls: report.stalls.length,
    gateCleanup: report.gateCleanup.length,
    failedPolls: report.polls.filter((p) => p.error).length,
    executions: report.executions,
    problems: [...problems, ...report.problems],
  };
}

export const main = (): Promise<ReconcileFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps));
