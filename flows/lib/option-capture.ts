// Option capture in the flows (N-70 point (3), O-88, src/core/option-capture.ts). The capture
// step records the Designer's exploration options as `screenshot` evidence and opens Didi's
// visual-approval request once CI has rendered them at the PR head. Once the request for the
// head is open, the pass asks again for the move the Designer's report triggers (into Waiting
// for Didi, guarded by `options_attached`), with that report's own trigger, so the move is taken
// once, and the guards decide (src/core/run-reports.ts).
//
// A refusal the Designer caused (O-89) is counted toward `failure` by the capture itself, once per
// head, and the pass then starts the item's fix round on the same branch (./builder-runs.ts),
// whose input shows the refusal's fixed text; the escalation check there bounds it, and a count
// that reaches the limit has already asked for the Council. A repeat on the same head counts
// nothing and starts nothing, since the fix round's own run is not the one the count names.
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
import {
  reportedMoveAndFixRound,
  startBuilderRuns,
  type AfterReport,
  type BuilderRunStart,
} from "./builder-runs.ts";
import type { FlowDeps } from "./compose.ts";

export interface OptionCapturePassStep {
  capture: CaptureStep;
  /** With a request open on the head: the Designer report's move, asked for again. */
  move?: AfterReport;
  /** After a counted refusal the Designer caused: the fix round's start, if one is due (O-89). */
  builderRuns?: BuilderRunStart[];
}

/** Whether a capture step is a refusal the Designer caused that counted toward `failure`. */
export const countedRefusal = (capture: CaptureStep): boolean =>
  capture.step === "refused" &&
  capture.failureCount !== undefined &&
  capture.failureCount.counted !== false;

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
    if (open) {
      steps.push({
        capture,
        move: await reportedMoveAndFixRound(deps, capture.designerRunId),
      });
    } else if (countedRefusal(capture)) {
      steps.push({ capture, builderRuns: await startBuilderRuns(deps, [nodeId]) });
    } else {
      steps.push({ capture });
    }
  }
  return steps;
}
