// A fake Windmill flow start for tests (D-273 (2), O-101, O-102, O-104, O-114, O-116): the state
// API's plan-approval port, the GitHub receiver's option capture, advance, staging deploy and
// access removal ports and the run watcher's run-end port each start one flow for one id (the
// staging deploy port for one repository and CI run, the removal port for one repository). It
// records each start it is asked for, and can be told to fail, so a test can check a caller starts
// it once per event and that a failed start leaves what the caller recorded standing. No network.
import type { PlanApprovalFlow } from "./plan-approval-flow.ts";
import type {
  AdvanceItemFlow,
  OptionCaptureFlow,
  DeployStagingFlow,
  RemoveBootstrapAccessFlow,
} from "./receiver-flows.ts";
import type { RunEndFlow } from "./run-watcher-flows.ts";

/** One fake for every port: `start(id)`, or the staging deploy port's `start(repo, runId)`. */
export type FakeFlowStart = PlanApprovalFlow &
  OptionCaptureFlow &
  AdvanceItemFlow &
  DeployStagingFlow &
  RemoveBootstrapAccessFlow &
  RunEndFlow & {
    /**
     * What each start was asked for, in order, failed starts included: the id, or for the staging
     * deploy port `<repo>#<run id>`.
     */
    readonly started: string[];
    /** Set to an error to make every start fail with it. */
    failWith: Error | null;
  };

export function createFakeFlowStart(): FakeFlowStart {
  const fake: FakeFlowStart = {
    started: [],
    failWith: null,
    async start(id: string, runId?: number) {
      fake.started.push(runId === undefined ? id : `${id}#${runId}`);
      if (fake.failWith) throw fake.failWith;
    },
  };
  return fake;
}
