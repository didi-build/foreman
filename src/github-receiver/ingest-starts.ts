// The receiver's start of the ingest flow (D-381, O-128). The receiver holds no GitHub token, so a
// delivery whose evidence needs a GitHub read (a pull request's new commits or merge, CI's end on a
// commit that names pull requests) is recorded as `recorded` with the reason "handed to the ingest
// flow", and then `f/foreman/ingest_delivery` is started with the identifiers the core named
// (`HandedOnDelivery`, src/core/github-ingest.ts): the delivery id, the event and action, the
// repository, the pull request numbers and the head commit, and nothing else. The flow reads
// GitHub with the runner App's narrow tokens, records the evidence under the same keys as the
// polling backstop, and then, in the same run, takes the steps CI's end made due: option capture
// (O-101) and the advance into In QA review (O-104), with the same due checks the receiver ran
// before.
//
// Only a delivery recorded now is handed on: a replay, a delivery decided from its payload alone
// and one ingestion rejects start nothing. The switches are not read here: evidence is recorded
// in dry run and under the kill switch, as before, and the flow's steps read them. Each start is
// one Windmill run (D-164).
//
// A start that fails (Windmill or its proxy down, the token missing) is logged with the delivery
// id, the error's type and the client's step and status, never the repository, another id or a
// token, and is not tried again: the delivery row stays, the webhook is answered as before, and
// the reconcile pass's polling backstop (ADR 0113 section 6) records the same facts with the same
// keys within one interval. The reconcile pass's capture and advance steps stay the backstops for
// the steps that follow.
import type { IngestDeliveryFlow } from "../adapters/windmill/receiver-flows.ts";
import { startErrorFields } from "../adapters/windmill/client.ts";
import type { ReceiveResult } from "../core/github-ingest.ts";
import type { Logger } from "../service-kit/logger.ts";

export interface IngestStartOptions {
  ingestDelivery: IngestDeliveryFlow;
  logger: Logger;
}

/** Starts the ingest flow for one recorded delivery that needs GitHub. Never throws. */
export type IngestStarts = (deliveryId: string, result: ReceiveResult) => Promise<void>;

export const INGEST_STARTED = "ingest flow started";
export const INGEST_NOT_STARTED =
  "ingest flow not started; the reconcile pass records the evidence later";

export function createIngestStarts(options: IngestStartOptions): IngestStarts {
  const { ingestDelivery, logger } = options;
  return async (deliveryId, result) => {
    if (result.handedOn === null) return;
    try {
      await ingestDelivery.start(result.handedOn);
      logger.info(INGEST_STARTED, { deliveryId });
    } catch (error) {
      logger.warn(INGEST_NOT_STARTED, { deliveryId, ...startErrorFields(error) });
    }
  };
}
