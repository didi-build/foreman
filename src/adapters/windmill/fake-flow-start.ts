// A fake Windmill flow start for tests (D-273 (2), O-101, O-102, O-104): the state API's
// plan-approval port, the GitHub receiver's option capture, advance and staging ports and the run
// watcher's run-end port each start one flow for one id (the staging port for one repository and
// commit). It records each start it is asked for, and can be told to fail, so a test can check a
// caller starts it once per event and that a failed start leaves what the caller recorded
// standing. No network.
import type { PlanApprovalFlow } from "./plan-approval-flow.ts";
import type {
  AdvanceItemFlow,
  OptionCaptureFlow,
  VerifyStagingFlow,
} from "./receiver-flows.ts";
import type { RunEndFlow } from "./run-watcher-flows.ts";

/** One fake for every port: `start(id)`, or the staging port's `start(repo, sha)`. */
export type FakeFlowStart = PlanApprovalFlow &
  OptionCaptureFlow &
  AdvanceItemFlow &
  VerifyStagingFlow &
  RunEndFlow & {
    /**
     * What each start was asked for, in order, failed starts included: the id, or for the staging
     * port `<repo>@<sha>`.
     */
    readonly started: string[];
    /** Set to an error to make every start fail with it. */
    failWith: Error | null;
  };

export function createFakeFlowStart(): FakeFlowStart {
  const fake: FakeFlowStart = {
    started: [],
    failWith: null,
    async start(id: string, sha?: string) {
      fake.started.push(sha === undefined ? id : `${id}@${sha}`);
      if (fake.failWith) throw fake.failWith;
    },
  };
  return fake;
}
