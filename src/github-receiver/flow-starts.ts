// The flows the receiver starts on the events it records (D-274, D-291, D-327, D-329, O-101).
// Today one: after a delivery records CI's end on a PR head (a new final `ci_run`), the receiver
// starts `f/foreman/option_capture` for that item, but only when a capture is due. The due check
// is the read part of capture itself (`createCaptureReads`, src/core/option-capture.ts), so the
// two cannot drift, and it reads the kill switch and dry run first, so under either nothing is
// started. Each start uses one of the Windmill free plan's 1,000 runs a month (D-164): a replay,
// or a CI end another delivery already recorded, names no head (`finishedCi`) and starts nothing.
//
// A start that fails, or a check that cannot be read, is logged with the error's type and the
// client's step and status, never an id, a token or a text, and changes nothing else: the
// evidence is already committed and the webhook is still answered as before. The reconcile pass's
// capture pass and the run-end flow's capture stay the backstops.
import type { OptionCaptureFlow } from "../adapters/windmill/receiver-flows.ts";
import { startErrorFields } from "../adapters/windmill/client.ts";
import type { Contracts } from "../core/contracts.ts";
import type { IngestResult } from "../core/github-ingest.ts";
import { createCaptureReads, type CaptureReadOps } from "../core/option-capture.ts";
import type { Logger } from "../service-kit/logger.ts";

export interface FlowStartOptions {
  /** The store as the receiver's role reads it: settings' two switches, nodes, runs, evidence. */
  store: CaptureReadOps;
  /** The contracts, for the states capture works in. */
  contracts: Contracts;
  optionCapture: OptionCaptureFlow;
  logger: Logger;
}

/** Starts what one recorded delivery makes due. Never throws. */
export type FlowStarts = (deliveryId: string, result: IngestResult) => Promise<void>;

export const OPTION_CAPTURE_STARTED = "option capture flow started";
export const OPTION_CAPTURE_NOT_STARTED =
  "option capture flow not started; the reconcile pass captures later";

export function createFlowStarts(options: FlowStartOptions): FlowStarts {
  const { store, optionCapture, logger } = options;
  const reads = createCaptureReads(options.contracts);

  return async (deliveryId, result) => {
    const nodeIds = [...new Set(result.finishedCi.map((ci) => ci.nodeId))];
    for (const nodeId of nodeIds) {
      try {
        const due = await reads.due(store, nodeId);
        if (!due.due) continue;
        await optionCapture.start(nodeId);
        logger.info(OPTION_CAPTURE_STARTED, { deliveryId });
      } catch (error) {
        logger.warn(OPTION_CAPTURE_NOT_STARTED, {
          deliveryId,
          ...startErrorFields(error),
        });
      }
    }
  };
}
