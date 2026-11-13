// The ingest flow (D-381, O-128, ADR 0113 sections 5 and 6). The GitHub receiver, which holds no
// GitHub token, starts it with `{"input": {...}}` for each delivery it has just recorded whose
// evidence needs a GitHub read: a pull request's new commits or merge, or CI's end on a commit that
// names pull requests. The input is the delivery id, the event and action, the repository, the
// pull request numbers and the head commit, and nothing else (`HandedOnDelivery`,
// src/core/github-ingest.ts); anything else is refused. The flow reads GitHub again with the runner
// App's narrow tokens, records the evidence under the same keys as the polling backstop, and then
// takes the steps CI's end made due, option capture (O-101) and the advance into In QA review
// (O-104), in this run (./lib/ingest-delivery.ts). The reconcile pass stays the safety net.
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { ingestDelivery, type IngestDeliveryResult } from "./lib/ingest-delivery.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

/** The handed-on delivery, read strictly by `readHandedOnDelivery` (src/core/github-ingest.ts). */
export interface IngestDeliveryInput {
  deliveryId: string;
  /** `pull_request`, `check_suite` or `workflow_run`. */
  event: string;
  action: string;
  /** `owner/name`. */
  repo: string;
  pullRequests: number[];
  /** The head commit the event names; null for a merged pull request. */
  headSha: string | null;
}

export type { IngestDeliveryResult };

export function run(
  deps: FlowDeps,
  input: IngestDeliveryInput,
): Promise<IngestDeliveryResult> {
  return ingestDelivery(deps, input);
}

export async function main(input: IngestDeliveryInput): Promise<IngestDeliveryResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
