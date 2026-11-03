// The option capture flow (N-70 point (3), O-88, D-274). Called with a design item's id when CI
// has finished on its PR head: it captures the Designer's exploration options from CI's
// `options` bundle, opens Didi's visual-approval request, and asks again for the Designer
// report's move into Waiting for Didi (./lib/option-capture.ts). The step reads the kill switch
// and dry run itself. The run-end flow tries the same capture at a Designer run's end, and the
// reconcile flow's capture pass stays as the safety net.
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

export const main = (input: OptionCaptureInput): Promise<OptionCapturePassStep[]> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
