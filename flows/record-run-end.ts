// The run-end flow (build plan M3.1 and M3.2, ADR 0106 section 6, ADR 0107). It polls one run
// through the agent runtime with the handle kept on the run (`runs.handle`, migration 0006) and,
// once the run has finished, records its end through the runs module, which revokes the run's
// token in the same transaction, then lets the runtime clean up. The store records an end once,
// so a repeated trigger records one end. In dry run it reports what it would record and writes
// nothing. Under the kill switch it refuses: the cancel-runs flow ends those runs. It never
// touches a counter or a transition: those are the P-03 rules and the guards (M3.5).
import { createRuns, type RunReport } from "../src/core/runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { runReport } from "./lib/runs.ts";
import { dryRunOn, killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface RecordRunEndInput {
  runId: string;
}

export type RecordRunEndResult =
  | { outcome: "refused"; reason: "kill_switch" }
  | { outcome: "no_run" | "no_handle" | "already_recorded" | "running" }
  | { outcome: "would_record" | "recorded"; report: RunReport };

export async function run(
  deps: FlowDeps,
  input: RecordRunEndInput,
): Promise<RecordRunEndResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  const known = await deps.store.getRun(input.runId);
  if (!known) return { outcome: "no_run" };
  if (known.endedAt !== null) return { outcome: "already_recorded" };
  const handle = await deps.store.getRunHandle(input.runId);
  if (handle === null) return { outcome: "no_handle" };
  const status = await deps.runtime.poll(handle);
  if (status.state === "running") return { outcome: "running" };
  const report = runReport(status.result);
  if (await dryRunOn(deps.store)) return { outcome: "would_record", report };
  const recorded = await createRuns(deps).recordEnd(input.runId, report);
  await deps.runtime.cleanup?.(handle);
  return recorded ? { outcome: "recorded", report } : { outcome: "already_recorded" };
}

export const main = (input: RecordRunEndInput): Promise<RecordRunEndResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
