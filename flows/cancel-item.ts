// Didi's own cancel of a work item (D-308 (2), O-97). Called with one work item's id and Didi's
// reason, only when Didi starts it from its page in the Windmill workspace, signed in, as the
// fresh release request flow is (O-90, D-295); never from a public or signed-token link. No
// schedule, pass or other flow starts it.
//
// By default it cancels: it records Didi's reason as Didi's cancel of the item and takes the
// cancel step at once (src/core/cancel.ts), so the item is cancelled once no run is active on it
// and its idea moves to Rejected once all its items are finished. A merged item in Verifying on
// staging finishes normally. With `askCouncil` it records nothing of Didi's and opens the item's
// "is this still needed?" question for the Council instead, with Didi's words as data
// (src/core/still-needed.ts), and starts its run; the Council's answer then follows the approver
// rule like any other. Then the item's close run starts if due (D-318, ./lib/close-runs.ts). The
// kill switch and dry run write nothing; dry run says what would happen.
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

export async function main(input: CancelItemInput): Promise<CancelItemResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
