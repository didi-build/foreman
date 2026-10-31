// The dispatch flow (build plan M3.1 and M3.2, ADR 0106 sections 5 to 7, ADR 0107). It admits one
// run, starts it through the agent runtime with its task, route and state API token, and records
// the start with its `dispatch_record` and move (./lib/start-run.ts says in what order, and what
// happens when a step fails). Admission is one transaction under the admission lock, so a
// duplicate trigger finds the first run active and is refused: one trigger or ten, one run. In
// dry run it only plans the dispatch and writes nothing. The caller names the role, and for QA
// the pull request and head commit.
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { startRun, type StartRunInput, type StartRunResult } from "./lib/start-run.ts";
import { killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export type DispatchFlowInput = StartRunInput;

export type DispatchFlowResult =
  { outcome: "refused"; reason: "kill_switch" } | StartRunResult;

export async function run(
  deps: FlowDeps,
  input: DispatchFlowInput,
): Promise<DispatchFlowResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  return startRun(deps, input);
}

export const main = (input: DispatchFlowInput): Promise<DispatchFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
