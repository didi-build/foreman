// The run-end flow (build plan M3.1 and M3.2, ADR 0106 section 6, ADR 0107). It polls one run
// through the agent runtime and, once the run has finished, records its end through the runs
// module, then lets the runtime clean up. The store records an end once, so a repeated trigger
// records one end. In dry run it reports what it would record and writes nothing. It never
// touches a counter or a transition: those are the P-03 rules and the guards (M3.5).
import { createRuns, type RunReport } from "../src/core/runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { runReport } from "./lib/runs.ts";
import { dryRunOn, killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface RecordRunEndInput {
  runId: string;
  /** The handle `start` returned, kept by the dispatch flow's caller. */
  handle: unknown;
}

export type RecordRunEndResult =
  | { outcome: "refused"; reason: "kill_switch" }
  | { outcome: "no_run" | "already_recorded" | "running" }
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
  const status = await deps.runtime.poll(input.handle);
  if (status.state === "running") return { outcome: "running" };
  const report = runReport(status.result);
  if (await dryRunOn(deps.store)) return { outcome: "would_record", report };
  const recorded = await createRuns(deps).recordEnd(input.runId, report);
  await deps.runtime.cleanup?.(input.handle);
  return recorded ? { outcome: "recorded", report } : { outcome: "already_recorded" };
}

export const main = (input: RecordRunEndInput): Promise<RecordRunEndResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
