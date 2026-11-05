// The advance flow (D-274, D-329 slice 4, O-104). Called with an item's id by the GitHub receiver
// once it records CI's end on the item's PR head and the advance check says an advance from
// evidence is due (src/core/advances.ts, src/github-receiver/flow-starts.ts). It never trusts the
// event: it reads everything again and takes the reconcile pass's own step 4 for this one item,
// planned with the pass's code (`planAdvance`) and acted on as the reconcile flow acts on the
// pass's plan (`advanceSteps`): the move into In QA review through the library with the pass's
// trigger and guards, then QA's run on the head through the dispatch's start path. Under the kill
// switch or in dry run it does nothing and says which switch holds it; the pass's dry-run plan
// covers dry run. A second start, or the pass at the same time, finds the item moved or QA's run
// active and does nothing more. The reconcile pass stays the safety net.
import { planAdvance } from "../src/core/reconcile.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { advanceSteps, type AdvanceStep } from "./lib/reconcile-steps.ts";
import { heldBy } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface AdvanceItemInput {
  /** The item whose PR head CI has just finished on. */
  nodeId: string;
}

export type AdvanceItemResult =
  | { outcome: "refused"; reason: "kill_switch" | "dry_run" }
  | { outcome: "advanced"; advances: AdvanceStep[] };

export async function run(
  deps: FlowDeps,
  input: AdvanceItemInput,
): Promise<AdvanceItemResult> {
  const held = await heldBy(deps.store);
  if (held !== null) return { outcome: "refused", reason: held };
  const plans = await planAdvance(deps, input.nodeId);
  return { outcome: "advanced", advances: await advanceSteps(deps, plans) };
}

export const main = (input: AdvanceItemInput): Promise<AdvanceItemResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
