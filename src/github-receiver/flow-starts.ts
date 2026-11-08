// The flows the receiver starts on CI's end on a PR head (D-274, D-291, D-327, D-329, O-101,
// O-104). Each start is decided by the flow's own due check, which reads the kill switch and dry
// run first, so under either nothing is started, and which reads only what the receiver's role
// reads: nodes, runs, evidence and those two settings rows.
// - CI's end on a PR head (a new final `ci_run`, success or failure): `f/foreman/option_capture`
//   for the item when a capture is due (`createCaptureReads`, src/core/option-capture.ts), and
//   `f/foreman/advance_item` when an advance from evidence is due (`createAdvances`,
//   src/core/advances.ts): the move into In QA review whose guards pass now, so in practice a green
//   result. The flow then plans and acts with the reconcile pass's own step 4.
// A `deployment_status` delivery starts nothing any more: the runner deploys staging itself and
// records that deploy (D-356, O-116), and the deploy flow starts on CI's build on main
// (./staging-starts.ts).
// Each start uses one of the Windmill free plan's 1,000 runs a month (D-164): a replay, or a fact
// another delivery already recorded, names no head (`finishedCi`) and starts nothing, and neither
// does a pending result.
//
// A start that fails, or a check that cannot be read, is logged with the error's type and the
// client's step and status, never an id, a token or a text, and changes nothing else: the
// evidence is already committed and the webhook is still answered as before. The reconcile pass
// (its capture and advance steps) and the run-end flow's capture stay the backstops.
import type {
  AdvanceItemFlow,
  OptionCaptureFlow,
} from "../adapters/windmill/receiver-flows.ts";
import { startErrorFields } from "../adapters/windmill/client.ts";
import { createAdvances } from "../core/advances.ts";
import type { Contracts, GuardRegistry } from "../core/contracts.ts";
import type { IngestResult } from "../core/github-ingest.ts";
import type { Clock, IdSource } from "../core/library.ts";
import { createCaptureReads } from "../core/option-capture.ts";
import type { Store } from "../core/store.ts";
import type { Logger } from "../service-kit/logger.ts";

export interface FlowStartOptions {
  /**
   * The store as the receiver's role reads it: settings' two switches, nodes, runs, evidence.
   * A read beyond them is refused by the database, and that check starts nothing.
   */
  store: Store;
  /** The contracts and guards, for the states and moves the checks look at. Nothing is moved. */
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  optionCapture: OptionCaptureFlow;
  advanceItem: AdvanceItemFlow;
  logger: Logger;
}

/** Starts what one recorded delivery makes due. Never throws. */
export type FlowStarts = (deliveryId: string, result: IngestResult) => Promise<void>;

export const OPTION_CAPTURE_STARTED = "option capture flow started";
export const OPTION_CAPTURE_NOT_STARTED =
  "option capture flow not started; the reconcile pass captures later";
export const ADVANCE_STARTED = "advance flow started";
export const ADVANCE_NOT_STARTED =
  "advance flow not started; the reconcile pass advances later";

export function createFlowStarts(options: FlowStartOptions): FlowStarts {
  const { store, optionCapture, advanceItem, logger } = options;
  const captures = createCaptureReads(options.contracts);
  const advances = createAdvances(options);

  /** Runs one check and its start; logs the outcome, never throws. */
  async function attempt(
    deliveryId: string,
    messages: { started: string; notStarted: string },
    due: () => Promise<boolean>,
    start: () => Promise<void>,
  ): Promise<void> {
    try {
      if (!(await due())) return;
      await start();
      logger.info(messages.started, { deliveryId });
    } catch (error) {
      logger.warn(messages.notStarted, { deliveryId, ...startErrorFields(error) });
    }
  }

  return async (deliveryId, result) => {
    const nodeIds = [...new Set(result.finishedCi.map((ci) => ci.nodeId))];
    for (const nodeId of nodeIds) {
      await attempt(
        deliveryId,
        { started: OPTION_CAPTURE_STARTED, notStarted: OPTION_CAPTURE_NOT_STARTED },
        async () => (await captures.due(store, nodeId)).due,
        () => optionCapture.start(nodeId),
      );
      await attempt(
        deliveryId,
        { started: ADVANCE_STARTED, notStarted: ADVANCE_NOT_STARTED },
        async () => (await advances.due(nodeId)).due,
        () => advanceItem.start(nodeId),
      );
    }
  };
}
