// The cancel-runs flow (D-202, build plan M3.2). Called when the kill switch is turned on, and run
// again by the reconcile flow on every pass the kill switch stops: it stops every active agent run
// through the runtime adapter and records each one's end as `cancelled`, with its token revoked
// (./lib/cancel-runs.ts). With the kill switch off it does nothing. It acts in dry run too: dry run
// starts no run, and stopping spend is what the kill switch is for.
import { cancelActiveRuns, type CancelRunsReport } from "./lib/cancel-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export type CancelRunsResult =
  { outcome: "kill_switch_off" } | ({ outcome: "cancelled" } & CancelRunsReport);

export async function run(deps: FlowDeps): Promise<CancelRunsResult> {
  if (!(await killSwitchOn(deps.store))) return { outcome: "kill_switch_off" };
  return { outcome: "cancelled", ...(await cancelActiveRuns(deps)) };
}

export const main = (): Promise<CancelRunsResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps));
