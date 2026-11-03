// Option capture in the flows (N-70 point (3), O-88, src/core/option-capture.ts). The capture
// step records the Designer's exploration options as `screenshot` evidence and opens Didi's
// visual-approval request once CI has rendered them at the PR head. Once the request for the
// head is open, the pass asks again for the move the Designer's report triggers (into Waiting
// for Didi, guarded by `options_attached`), with that report's own trigger, so the move is taken
// once, and the guards decide (src/core/run-reports.ts).
//
// When it runs (D-274). The run-end flow tries it for a Designer run at once, before asking for
// the report's move (./council-runs.ts), so a bundle CI has already made is captured with no
// wait. CI usually finishes after that: the GitHub receiver records CI's end on the head but holds
// no Windmill credential to start a flow (ADR 0113), so the reconcile flow's capture pass, which
// runs every pending item, is what captures it until a caller of the `option_capture` flow on CI's
// end is decided (flows/windmill.yaml).
import {
  createOptionCaptures,
  type CaptureStep,
} from "../../src/core/option-capture.ts";
import { reportedMoveAndFixRound, type AfterReport } from "./builder-runs.ts";
import type { FlowDeps } from "./compose.ts";

export interface OptionCapturePassStep {
  capture: CaptureStep;
  /** With a request open on the head: the Designer report's move, asked for again. */
  move?: AfterReport;
}

/** Captures each item's options: on the given items, or on every item in a capture state. */
export async function optionCapturePass(
  deps: FlowDeps,
  nodeIds?: readonly string[],
): Promise<OptionCapturePassStep[]> {
  const captures = createOptionCaptures(deps);
  const steps: OptionCapturePassStep[] = [];
  for (const nodeId of nodeIds ?? (await captures.pending())) {
    const capture = await captures.capture(nodeId);
    const open =
      capture.step === "opened" ||
      (capture.step === "already_captured" && capture.open);
    steps.push(
      open
        ? { capture, move: await reportedMoveAndFixRound(deps, capture.designerRunId) }
        : { capture },
    );
  }
  return steps;
}
