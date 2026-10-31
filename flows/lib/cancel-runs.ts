// The kill switch's cancel pass (D-202, ADR 0106 section 6). With the kill switch on, every
// active run is stopped through the agent runtime adapter with the handle kept on the run, and
// only then ends `cancelled`, which revokes its token in the same transaction. Nothing here writes
// a transition, so none can be half-written: agents never write transitions, and the runner
// writes each one as a single transaction (essential 3).
//
// A run with no handle yet is one the dispatch flow admitted and has not finished starting. It is
// ended first, which stops the dispatch flow from keeping a handle for it (`setRunHandle` writes
// only while the run has not ended); then the handle is read once more, and if the dispatch flow
// kept one just before, that run is stopped too. A run whose cancel fails is left active and
// named in the result, so the next pass tries again.
import { createRuns } from "../../src/core/runs.ts";
import type { FlowDeps } from "./compose.ts";

export interface CancelRunsReport {
  cancelled: string[];
  /** The runtime could not stop these; they stay active for the next pass. */
  failed: string[];
}

export async function cancelActiveRuns(deps: FlowDeps): Promise<CancelRunsReport> {
  const runs = createRuns(deps);
  const report: CancelRunsReport = { cancelled: [], failed: [] };
  for (const run of await deps.store.listActiveRuns()) {
    let handle = await deps.store.getRunHandle(run.id);
    if (handle === null) {
      await runs.recordRunnerEnd(run.id, "cancelled");
      handle = await deps.store.getRunHandle(run.id);
    }
    if (handle !== null) {
      try {
        await deps.runtime.cancel(handle);
      } catch {
        report.failed.push(run.id);
        continue;
      }
      await runs.recordRunnerEnd(run.id, "cancelled");
      // The end is recorded; removing the run's objects is housekeeping a later pass can redo.
      await deps.runtime.cleanup?.(handle).catch(() => undefined);
    }
    report.cancelled.push(run.id);
  }
  return report;
}
