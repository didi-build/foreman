// Didi's form to submit a plan by hand (D-383, O-129), until the planning chat has a front end of
// its own: Didi drafts the plan in a Claude project and copies its fields into the boxes of
// `f/foreman/submit_plan` (../submit-plan.ts), once per plan. It does what `POST /plans` does and
// what the state API does after it (src/api/routes.ts), with the same core code:
//
// 1. The boxes become the body the planning chat sends: `needsDidi` and `needsDidiReason` as its
//    one `needsDidi` object, and an empty `ideaId` left out, which means a new idea. A body over
//    the state API's 64 KiB cap as compact JSON is refused, as the API refuses it before reading
//    it. Then `readPlanSubmission` checks it, so the form takes exactly what `POST /plans` takes
//    and refuses with the same fixed sentences, which name a field and never quote a value.
// 2. `createPlanSubmissions` records it in one transaction that only inserts, by `planning`, as
//    the planning chat's submission is recorded (O-78): a new idea in Submitted, or a
//    resubmission on an idea of the project in Submitted or Council planning. A refusal there
//    (no such project, no such idea, an idea past planning) records nothing.
// 3. Then the plan approval step, as the plan-approval flow the state API starts would take it,
//    in this same run (./plan-approval.ts), so no other Windmill run starts. Under the kill
//    switch or dry run the submission is still recorded and the step is not taken, as the API
//    starts no flow then (D-333); the reconcile pass's plan approval step takes it once both are
//    off. A step that throws is `failed`, with nothing kept from the error: the submission stands
//    and the reconcile pass takes the step later, as after a failed start (D-274).
//
// The result names the idea, whether it is new, and what the step did. It echoes none of the
// submission's texts (title, plan, direction, answers, reason). Nothing here logs.
import {
  createPlanSubmissions,
  readPlanSubmission,
  SUBMIT_REFUSAL_MESSAGES,
  type SubmitRefusal,
} from "../../src/core/plans.ts";
import type { FlowDeps } from "./compose.ts";
import { planApprovalStep, type PlanApprovalResult } from "./plan-approval.ts";
import { heldBy } from "./switches.ts";

/** One of Didi's answers from the planning chat, as one item of the form's list. */
export interface AnswerBox {
  question: string;
  answer: string;
}

/** The form's boxes (D-376), one per field of the planning chat's submission. */
export interface SubmitPlanFields {
  projectSlug: string;
  title: string;
  plan: string;
  productDirection: string;
  /** The Council's call on whether Didi is needed: exactly `yes`, `no` or `unsure` (D-307). */
  needsDidi: string;
  /** Why, in the Council's words. */
  needsDidiReason: string;
  /** Didi's answers from the planning chat; empty or left out, none. */
  answers?: readonly AnswerBox[] | null;
  /** The idea whose plan this resubmits; empty or left out, a new idea. */
  ideaId?: string | null;
}

/**
 * The state API's cap on a request body, `MAX_BODY_BYTES` in src/api/routes.ts, which bounds a
 * whole submission (O-78). Kept equal to it by test/flows/submit-plan-flows.test.ts.
 */
export const PLANS_BODY_MAX_BYTES = 64 * 1024;

/** The form's own fixed sentences, beside the API's (`readPlanSubmission`'s and the core's). */
export const SUBMIT_PLAN_MESSAGES = {
  too_large: `the submission is too large: POST /plans takes at most ${PLANS_BODY_MAX_BYTES} bytes of JSON`,
  kill_switch:
    "The kill switch is on: the submission is recorded and the plan approval was not taken. The reconcile pass takes it once both switches are off.",
  dry_run:
    "Dry run is on: the submission is recorded and the plan approval was not taken. The reconcile pass takes it once both switches are off.",
  failed:
    "The plan approval did not finish: the submission is recorded, and the reconcile pass takes the plan approval later.",
} as const;

/** Why the form recorded nothing. */
export type SubmitPlanRefusal = "too_large" | "invalid_submission" | SubmitRefusal;

/** What the plan approval did after the submission was recorded. */
export type FormPlanApproval =
  | { outcome: "held"; heldBy: "kill_switch" | "dry_run"; message: string }
  | { outcome: "taken"; step: PlanApprovalResult }
  | { outcome: "failed"; message: string };

export type SubmitPlanResult =
  | { outcome: "refused"; reason: SubmitPlanRefusal; message: string }
  | {
      outcome: "recorded";
      ideaId: string;
      /** True for a new idea, false for a resubmission on `ideaId` (as `POST /plans` answers). */
      created: boolean;
      planApproval: FormPlanApproval;
    };

/** The body the planning chat would send to `POST /plans` with these boxes. */
export function submissionBody(fields: SubmitPlanFields): Record<string, unknown> {
  const { ideaId } = fields;
  return {
    projectSlug: fields.projectSlug,
    ...(ideaId === undefined || ideaId === null || ideaId === "" ? {} : { ideaId }),
    title: fields.title,
    plan: fields.plan,
    productDirection: fields.productDirection,
    answers: fields.answers ?? [],
    needsDidi: { needed: fields.needsDidi, reason: fields.needsDidiReason },
  };
}

const refused = (reason: SubmitPlanRefusal, message: string): SubmitPlanResult => ({
  outcome: "refused",
  reason,
  message,
});

/** Checks and records one submission, then takes its plan approval step unless a switch holds. */
export async function submitPlan(
  deps: FlowDeps,
  fields: SubmitPlanFields,
): Promise<SubmitPlanResult> {
  const body = submissionBody(fields);
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (bytes > PLANS_BODY_MAX_BYTES) {
    return refused("too_large", SUBMIT_PLAN_MESSAGES.too_large);
  }
  const read = readPlanSubmission(body);
  if ("problem" in read) return refused("invalid_submission", read.problem);
  const recorded = await createPlanSubmissions(deps).submit(read.submission);
  if (!recorded.recorded) {
    return refused(recorded.reason, SUBMIT_REFUSAL_MESSAGES[recorded.reason]);
  }
  return {
    outcome: "recorded",
    ideaId: recorded.ideaId,
    created: recorded.created,
    planApproval: await approve(deps, recorded.ideaId),
  };
}

/** The plan approval step, skipped under either switch as the API skips its start (D-333). */
async function approve(deps: FlowDeps, ideaId: string): Promise<FormPlanApproval> {
  try {
    const held = await heldBy(deps.store);
    if (held) {
      return { outcome: "held", heldBy: held, message: SUBMIT_PLAN_MESSAGES[held] };
    }
    return { outcome: "taken", step: await planApprovalStep(deps, ideaId) };
  } catch {
    return { outcome: "failed", message: SUBMIT_PLAN_MESSAGES.failed };
  }
}
