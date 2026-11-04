// The fresh release request flow (D-272, O-90). Called with one held item's id when Didi asks
// for a fresh release request from the held-items list in the daily check (./lib/held-items.ts),
// and only then: no schedule, pass or timer starts it, so nothing re-asks Didi on its own. It
// opens the same request the Triage handoff opens (src/core/hold-release.ts), and refuses an
// item that is not held, one that already has an open request, and one whose release is due. The
// step reads the kill switch and dry run itself; either writes nothing.
import {
  createHoldReleaseRequests,
  type HoldReleaseRequestStep,
} from "../src/core/hold-release.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface HoldReleaseRequestInput {
  /** The held item, as its entry in the daily check's held-items list names it. */
  nodeId: string;
}

export async function run(
  deps: FlowDeps,
  input: HoldReleaseRequestInput,
): Promise<HoldReleaseRequestStep> {
  return createHoldReleaseRequests(deps).requestAgain(input.nodeId);
}

export const main = (input: HoldReleaseRequestInput): Promise<HoldReleaseRequestStep> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
