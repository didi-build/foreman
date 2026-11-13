// The close pass (D-318, O-98, src/core/pr-close.ts): for each cancelled work item whose recorded
// pull request has had no close run, start the item's own bot's close-only run, task type
// `developer:close` or `designer:close`, which closes that one pull request with a fixed comment
// and starts no model. Each start goes through the dispatch (./start-run.ts), so admission decides
// under its lock as for every run: the kill switch, dry run (it plans and writes nothing), one
// active run per item, the cluster limit, the route for the close task type, and one close run per
// pull request on the item whatever its end (`close_already_run`). A start that is refused is
// tried again by the next pass; a run that was started is never started again.
//
// The cancel pass runs it for the items it has just cancelled (./council-runs.ts), the called flow
// `f/foreman/cancel_item` for Didi's item, and the reconcile flow's live passes for every
// cancelled item still due, so a refused start, or a pass cut short, is taken on later. A close
// run's end is recorded by the run-end flow (`runEndSteps`), which records its outcome on the item.
import type { CloseRunStart } from "../../src/core/pr-close.ts";
import { createPullRequestCloses } from "../../src/core/pr-close.ts";
import type { FlowDeps } from "./compose.ts";
import { startError } from "./start-failure.ts";
import { startRun } from "./start-run.ts";

/**
 * Starts the close run of each given item (or of every cancelled item) whose close is due. Items
 * with nothing due are left out of the result.
 */
export async function closePass(
  deps: FlowDeps,
  nodeIds?: readonly string[],
): Promise<CloseRunStart[]> {
  const closes = createPullRequestCloses(deps);
  const steps: CloseRunStart[] = [];
  for (const nodeId of nodeIds ?? (await closes.pending())) {
    const target = await closes.target(nodeId);
    if ("why" in target) continue;
    const step: CloseRunStart = {
      nodeId,
      pullRequest: target.pullRequest.number,
      outcome: "start_failed",
    };
    try {
      const started = await startRun(deps, {
        nodeId,
        role: target.role,
        taskType: target.taskType,
        prNumber: target.pullRequest.number,
      });
      step.outcome = started.outcome;
      if (started.outcome === "started" || started.outcome === "cancelled")
        step.runId = started.runId;
      if ("reason" in started) step.reason = started.reason;
    } catch (error) {
      // The run ended `fail` before it started (./start-run.ts); its error's kind and step are
      // kept (D-384).
      step.error = startError(error);
    }
    steps.push(step);
  }
  return steps;
}
