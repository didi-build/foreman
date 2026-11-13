// The ingest flow's steps (D-381, O-128). The GitHub receiver holds no GitHub token: for a
// delivery whose evidence needs a GitHub read it records the delivery and starts this flow with
// the identifiers the core names (`HandedOnDelivery`, src/core/github-ingest.ts), and nothing from
// the payload beyond them. The flow reads the input strictly, reads each pull request's live
// state, its changed files, the check runs on the head and CI's preview check job from GitHub
// with the runner's own client (each call with its own token for one repository and one
// permission, O-127), and records what it finds through the same functions and ingest keys as the
// reconcile pass's polling backstop, so a delivery and a poll record each fact once.
//
// Then, in the same run and so with no Windmill run added, the steps CI's end makes due, which
// the receiver used to start as their own flows after it recorded the evidence (O-101, O-104):
// for each item whose final `ci_run` this delivery newly recorded (`finishedCi`, never a pending
// result or a fact recorded before), option capture when capture's own due check says a capture
// is due (`createCaptureReads`, ./option-capture.ts), and the advance into In QA review when the
// advance check says its guards pass now (`createAdvances`, `advanceItem` in
// ./reconcile-steps.ts). They are the same checks and steps, in the same order, and each reads
// the kill switch and dry run first, so under either nothing is taken. The evidence is recorded
// in dry run and under the kill switch, as the receiver recorded it.
//
// A check or a step that throws is reported as `failed`, with nothing kept from the error, and
// changes nothing else: the evidence is already committed and the other steps still run, as a
// failed start in the receiver did. The reconcile pass's capture and advance steps stay the
// backstops. A GitHub read that throws fails the run before anything is recorded, and the polling
// backstop records the same facts later.
import { createAdvances } from "../../src/core/advances.ts";
import {
  ingestHandedOn,
  readHandedOnDelivery,
  type FinishedCi,
  type HandedOnIngest,
} from "../../src/core/github-ingest.ts";
import { createCaptureReads } from "../../src/core/option-capture.ts";
import type { FlowDeps } from "./compose.ts";
import { optionCapturePass, type OptionCapturePassStep } from "./option-capture.ts";
import { advanceItem, type AdvanceItemResult } from "./reconcile-steps.ts";

/** What followed CI's end on one item's head. A step not due is left out. */
export interface AfterCiEnd {
  nodeId: string;
  /** Option capture's steps when a capture was due (O-101), or `failed` when it threw. */
  optionCapture?: OptionCapturePassStep[] | "failed";
  /** The advance when it was due (O-104), or `failed` when it threw. */
  advance?: AdvanceItemResult | "failed";
}

export type IngestDeliveryResult =
  | { outcome: "refused"; reason: "invalid_input" }
  | (HandedOnIngest & { deliveryId: string; afterCi: AfterCiEnd[] });

/** Runs one due check and, when due, its step. A throw is `failed`; not due is undefined. */
async function attempt<T>(
  due: () => Promise<boolean>,
  step: () => Promise<T>,
): Promise<T | "failed" | undefined> {
  try {
    return (await due()) ? await step() : undefined;
  } catch {
    return "failed";
  }
}

/** The steps CI's end makes due, for each item once, in the order the receiver started them. */
async function afterCiEnds(
  deps: FlowDeps,
  finished: readonly FinishedCi[],
): Promise<AfterCiEnd[]> {
  const captures = createCaptureReads(deps.contracts);
  const advances = createAdvances(deps);
  const steps: AfterCiEnd[] = [];
  for (const nodeId of new Set(finished.map((ci) => ci.nodeId))) {
    const step: AfterCiEnd = { nodeId };
    const capture = await attempt(
      async () => (await captures.due(deps.store, nodeId)).due,
      () => optionCapturePass(deps, [nodeId]),
    );
    if (capture !== undefined) step.optionCapture = capture;
    const advance = await attempt(
      async () => (await advances.due(nodeId)).due,
      () => advanceItem(deps, nodeId),
    );
    if (advance !== undefined) step.advance = advance;
    steps.push(step);
  }
  return steps;
}

/** Records one handed-on delivery's evidence, then the steps its CI end made due. */
export async function ingestDelivery(
  deps: FlowDeps,
  input: unknown,
): Promise<IngestDeliveryResult> {
  const delivery = readHandedOnDelivery(input);
  if (delivery === null) return { outcome: "refused", reason: "invalid_input" };
  const ingested = await ingestHandedOn(deps, delivery);
  return {
    deliveryId: delivery.deliveryId,
    ...ingested,
    afterCi: await afterCiEnds(deps, ingested.finishedCi),
  };
}
