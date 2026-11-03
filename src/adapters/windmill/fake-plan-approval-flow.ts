// A fake plan-approval flow starter for tests (D-273 (2)): it records each idea it is asked to
// start the flow for, and can be told to fail, so a test can check the state API calls it once per
// submission and that a failed start leaves the submission standing. No network.
import type { PlanApprovalFlow } from "./plan-approval-flow.ts";

export interface FakePlanApprovalFlow extends PlanApprovalFlow {
  /** The idea ids each start was asked for, in order, failed starts included. */
  readonly started: string[];
  /** Set to an error to make every start fail with it. */
  failWith: Error | null;
}

export function createFakePlanApprovalFlow(): FakePlanApprovalFlow {
  const fake: FakePlanApprovalFlow = {
    started: [],
    failWith: null,
    async start(ideaId) {
      fake.started.push(ideaId);
      if (fake.failWith) throw fake.failWith;
    },
  };
  return fake;
}
