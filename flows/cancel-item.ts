// Didi's own cancel of a work item (D-308 (2), O-97), or withdrawal of an idea with no work items
// (D-412, O-141), with Didi's reason, started only by Didi from its Windmill page, signed in
// (O-90, D-295): never from a public or signed-token link, and no schedule, pass or other flow
// starts it. By default it records the reason as Didi's cancel and takes the cancel step at once
// (src/core/cancel.ts): an item is cancelled once no run is active on it, its idea moves to
// Rejected once all its items are finished, a merged item finishes normally, and a withdrawn idea
// moves to Rejected; an idea with work items is refused with fixed text. `askCouncil` asks the
// Council instead, Didi's words as data (src/core/still-needed.ts), and starts its run. The close
// run starts if due (D-318). The kill switch and dry run write nothing; dry run says what it does.
import { createCancels, type DidiCancel } from "../src/core/cancel.ts";
import { stillNeededTopic } from "../src/core/cancel.ts";
import { createStillNeeded, type StillNeededOpen } from "../src/core/still-needed.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { closePass } from "./lib/close-runs.ts";
import { councilPass, type CouncilPassStep } from "./lib/council-runs.ts";
import type { CloseRunStart } from "../src/core/pr-close.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface CancelItemInput {
  /** The work item, as the daily check names it. */
  nodeId: string;
  /** Didi's reason, kept verbatim as data. */
  reason: string;
  /** Ask the Council whether the item is still needed instead of cancelling it now. */
  askCouncil?: boolean;
}

export type CancelItemResult =
  | { mode: "cancel"; cancel: DidiCancel; closeRuns: CloseRunStart[] }
  | { mode: "ask_council"; question: StillNeededOpen; council: CouncilPassStep[] };

export async function run(
  deps: FlowDeps,
  input: CancelItemInput,
): Promise<CancelItemResult> {
  if (input.askCouncil === true) {
    const question = await createStillNeeded(deps).askByDidi(
      input.nodeId,
      input.reason,
    );
    return {
      mode: "ask_council",
      question,
      council: question.opened
        ? await councilPass(deps, [stillNeededTopic(input.nodeId)])
        : [],
    };
  }
  const cancel = await createCancels(deps).cancelByDidi(input.nodeId, input.reason);
  return { mode: "cancel", cancel, closeRuns: await closePass(deps, [input.nodeId]) };
}

export async function main(
  nodeId: string,
  reason: string,
  askCouncil: boolean = false,
): Promise<CancelItemResult> {
  const input = { nodeId, reason, askCouncil };
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
