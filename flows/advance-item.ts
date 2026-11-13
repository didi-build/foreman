// The advance flow (D-274, D-329 slice 4, O-104). Called with an item's id, it takes the reconcile
// pass's own step 4 for that one item (`advanceItem`, ./lib/reconcile-steps.ts): planned with the
// pass's code (`planAdvance`) and acted on as the reconcile flow acts on the pass's plan
// (`advanceSteps`): the move into In QA review through the library with the pass's trigger and
// guards, then QA's run on the head through the dispatch's start path. It never trusts its input:
// it reads everything again. Under the kill switch or in dry run it does nothing and says which
// switch holds it; the pass's dry-run plan covers dry run. A second start, or the pass at the same
// time, finds the item moved or QA's run active and does nothing more. The reconcile pass stays the
// safety net.
//
// No service starts it any more (D-381, O-128): the ingest flow (./ingest-delivery.ts) records
// CI's end on a PR head and then takes the same step in its own run, when the same advance check
// (src/core/advances.ts) says it is due, so the receiver's token no longer runs this flow. It stays
// for a start by hand from its Windmill page, as the dispatch flow does.
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { advanceItem, type AdvanceItemResult } from "./lib/reconcile-steps.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface AdvanceItemInput {
  /** The item whose PR head CI has finished on. */
  nodeId: string;
}

export type { AdvanceItemResult };

export function run(
  deps: FlowDeps,
  input: AdvanceItemInput,
): Promise<AdvanceItemResult> {
  return advanceItem(deps, input.nodeId);
}

export async function main(input: AdvanceItemInput): Promise<AdvanceItemResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
