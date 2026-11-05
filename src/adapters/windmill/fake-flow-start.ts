// A fake Windmill flow start for tests (D-273 (2), O-101): the state API's plan-approval port and
// the GitHub receiver's option capture port both start one flow for one id. It records each id it
// is asked to start the flow for, and can be told to fail, so a test can check a caller starts it
// once per event and that a failed start leaves what the caller recorded standing. No network.
import type { PlanApprovalFlow } from "./plan-approval-flow.ts";
import type { OptionCaptureFlow } from "./receiver-flows.ts";

export interface FakeFlowStart extends PlanApprovalFlow, OptionCaptureFlow {
  /** The ids each start was asked for, in order, failed starts included. */
  readonly started: string[];
  /** Set to an error to make every start fail with it. */
  failWith: Error | null;
}

export function createFakeFlowStart(): FakeFlowStart {
  const fake: FakeFlowStart = {
    started: [],
    failWith: null,
    async start(id: string) {
      fake.started.push(id);
      if (fake.failWith) throw fake.failWith;
    },
  };
  return fake;
}
