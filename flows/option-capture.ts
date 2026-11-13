// The option capture flow (N-70 point (3), O-88, D-274). Called with a design item's id: it
// captures the Designer's exploration options from CI's `options` bundle, opens Didi's
// visual-approval request (linking CI's run on any repository, O-89, D-348), and asks again for
// the Designer report's move into Waiting for Didi, or, after a refusal the Designer caused,
// counts it once per head and Designer run (D-293) and starts the fix round
// (./lib/option-capture.ts). The step reads the kill switch and dry run itself. The run-end flow
// tries the same capture at a Designer run's end, and the reconcile flow's capture pass stays as
// the safety net.
//
// No service starts it any more (D-381, O-128): the ingest flow (./ingest-delivery.ts) records
// CI's end on a PR head and then takes the same capture in its own run, when capture's own due
// check says a capture is due (D-291, O-101), so the receiver's token no longer runs this flow. It
// stays for a start by hand from its Windmill page, as the dispatch flow does.
import { optionCapturePass, type OptionCapturePassStep } from "./lib/option-capture.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface OptionCaptureInput {
  /** The design item whose PR head CI has rendered. */
  nodeId: string;
}

export async function run(
  deps: FlowDeps,
  input: OptionCaptureInput,
): Promise<OptionCapturePassStep[]> {
  return optionCapturePass(deps, [input.nodeId]);
}

export async function main(
  input: OptionCaptureInput,
): Promise<OptionCapturePassStep[]> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
