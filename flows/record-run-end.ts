// The run-end flow (build plan M3.1 and M3.2, ADR 0106 section 6, ADR 0107). It polls one run
// through the agent runtime with the handle kept on the run (`runs.handle`, migration 0006) and,
// once the run has finished, records its end through the runs module, which revokes the run's
// token in the same transaction, then lets the runtime clean up. Once the end is recorded, the
// move a successful run's report triggers is asked for through the library, so the contract's
// guards decide (src/core/run-reports.ts); a retried trigger asks again and writes one move. The
// store records an end once, so a repeated trigger records one end. A move that sends the item
// back to be fixed (QA's fail) then starts the builder's fix round (O-41). In dry run it reports
// what it would record and writes nothing. Under the kill switch it refuses: the cancel-runs flow
// ends those runs. It never touches a counter: those are the P-03 rules (M3.5).
import { createRuns, type RunReport } from "../src/core/runs.ts";
import { reportedMoveAndFixRound, type AfterReport } from "./lib/builder-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { runReport } from "./lib/runs.ts";
import { dryRunOn, killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface RecordRunEndInput {
  runId: string;
}

export type RecordRunEndResult =
  | { outcome: "refused"; reason: "kill_switch" }
  | { outcome: "no_run" | "no_handle" | "running" }
  | ({ outcome: "already_recorded" } & AfterReport)
  | { outcome: "would_record"; report: RunReport }
  | ({ outcome: "recorded"; report: RunReport } & AfterReport);

export async function run(
  deps: FlowDeps,
  input: RecordRunEndInput,
): Promise<RecordRunEndResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  const reported = () => reportedMoveAndFixRound(deps, input.runId);
  const known = await deps.store.getRun(input.runId);
  if (!known) return { outcome: "no_run" };
  if (known.endedAt !== null)
    return { outcome: "already_recorded", ...(await reported()) };
  const handle = await deps.store.getRunHandle(input.runId);
  if (handle === null) return { outcome: "no_handle" };
  const status = await deps.runtime.poll(handle);
  if (status.state === "running") return { outcome: "running" };
  const report = runReport(status.result);
  if (await dryRunOn(deps.store)) return { outcome: "would_record", report };
  const recorded = await createRuns(deps).recordEnd(input.runId, report);
  await deps.runtime.cleanup?.(handle);
  const after = await reported();
  return recorded
    ? { outcome: "recorded", report, ...after }
    : { outcome: "already_recorded", ...after };
}

export const main = (input: RecordRunEndInput): Promise<RecordRunEndResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
