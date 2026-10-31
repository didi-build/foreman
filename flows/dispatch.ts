// The dispatch flow (build plan M3.1 and M3.2, ADR 0106 section 7, ADR 0107). It asks the runs
// module to admit one run and, when admitted, starts it through the agent runtime. Admission is
// one transaction under the admission lock, so a duplicate trigger finds the first run active
// and is refused: one trigger or ten, one run. In dry run it only plans the dispatch and writes
// nothing. The caller names the role, and for QA the pull request and head commit.
import type { NoRoute } from "../src/core/routing.ts";
import type { DispatchRefusal } from "../src/core/runs.ts";
import { createRuns } from "../src/core/runs.ts";
import type { AgentRole, Run } from "../src/core/store.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { dryRunOn, killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface DispatchFlowInput {
  nodeId: string;
  role: AgentRole;
  headSha?: string | null;
  prNumber?: number | null;
}

export type DispatchFlowResult =
  | { outcome: "refused"; reason: "kill_switch" }
  | { outcome: "planned"; run: Run }
  | {
      outcome: "not_admitted";
      reason: DispatchRefusal | "qa_newer_head";
      cancelRunIds?: string[];
      /** With `no_route`: why no candidate passed, for the runner's alert (ADR 0114 section 5). */
      noRoute?: NoRoute;
    }
  | { outcome: "started"; runId: string; handle: unknown };

export async function run(
  deps: FlowDeps,
  input: DispatchFlowInput,
): Promise<DispatchFlowResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  const runs = createRuns(deps);
  const request = { ...input, ...deps.bots[input.role] };
  const dryRun = await dryRunOn(deps.store);
  const result = dryRun
    ? await runs.planDispatch(request)
    : await runs.dispatch(request);
  if (!result.admitted) return { outcome: "not_admitted", ...result };
  if (dryRun) return { outcome: "planned", run: result.run };
  const task = await deps.tasks.taskFor(result.run);
  const handle = await deps.runtime.start(task, deps.limits[input.role]);
  return { outcome: "started", runId: result.run.id, handle };
}

export const main = (input: DispatchFlowInput): Promise<DispatchFlowResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
