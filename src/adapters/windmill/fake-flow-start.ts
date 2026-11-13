// A fake Windmill flow start for tests (D-273 (2), O-101, O-102, O-114, O-116, O-128): the state
// API's plan-approval port, the GitHub receiver's staging deploy and access removal ports and the
// run watcher's run-end port each start one flow for one id (the staging deploy port for one
// repository and CI run, the removal port for one repository), and the receiver's ingest port
// (`createFakeIngestStart`) one flow for one handed-on delivery. Each records the starts it is
// asked for, and can be told to fail, so a test can check a caller starts it once per event and
// that a failed start leaves what the caller recorded standing. No network.
import type { HandedOnDelivery } from "../../core/github-ingest.ts";
import type { Json } from "../../core/store.ts";
import type { PlanApprovalFlow } from "./plan-approval-flow.ts";
import {
  ingestDeliveryInput,
  type DeployStagingFlow,
  type IngestDeliveryFlow,
  type RemoveBootstrapAccessFlow,
} from "./receiver-flows.ts";
import type { RunEndFlow } from "./run-watcher-flows.ts";

/** One fake for every id port: `start(id)`, or the staging deploy port's `start(repo, runId)`. */
export type FakeFlowStart = PlanApprovalFlow &
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

/** The receiver's ingest port: records the input each start would send Windmill. */
export type FakeIngestStart = IngestDeliveryFlow & {
  /**
   * The flow input of each start, in order, failed starts included, exactly as the Windmill
   * binding would send it (`ingestDeliveryInput`).
   */
  readonly started: Record<string, Json>[];
  /** Set to an error to make every start fail with it. */
  failWith: Error | null;
};

export function createFakeIngestStart(): FakeIngestStart {
  const fake: FakeIngestStart = {
    started: [],
    failWith: null,
    async start(delivery: HandedOnDelivery) {
      fake.started.push(ingestDeliveryInput(delivery));
      if (fake.failWith) throw fake.failWith;
    },
  };
  return fake;
}
