// Didi's form to submit a plan by hand (D-383, O-129), until the planning chat has a front end of
// its own: Didi drafts the plan in a Claude project and copies its fields into this form's boxes,
// once per plan. Called only when Didi starts it from its page in the Windmill workspace, signed
// in, as Didi's other forms (D-295, D-376); never from a public or signed-token link, and no
// service, schedule, pass or other flow starts it.
//
// It checks the boxes exactly as `POST /plans` checks the planning chat's body, records the
// submission with the same core code and the planning chat's identity, and then takes the plan
// approval step in its own run, as the plan-approval flow the state API starts would. Under the
// kill switch or dry run it records the submission and takes no step, as the API starts no flow
// then (D-333). The steps are in ./lib/submit-plan.ts.
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import {
  submitPlan,
  type SubmitPlanFields,
  type SubmitPlanResult,
} from "./lib/submit-plan.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export type { SubmitPlanFields, SubmitPlanResult };

export function run(
  deps: FlowDeps,
  fields: SubmitPlanFields,
): Promise<SubmitPlanResult> {
  return submitPlan(deps, fields);
}

/**
 * Didi's form: one plain field per value, each its own box (D-376). The answers' item type is
 * written out here, not imported: Windmill reads a type from another file as a resource picker
 * (O-121). `needsDidi` is a choice of its three words, which Windmill shows as a dropdown; the
 * check still refuses any other word sent. `answers` and `ideaId` may be left empty: no answers,
 * and a new idea.
 */
export async function main(
  projectSlug: string,
  title: string,
  plan: string,
  productDirection: string,
  needsDidi: "yes" | "no" | "unsure",
  needsDidiReason: string,
  answers: { question: string; answer: string }[] = [],
  ideaId: string = "",
): Promise<SubmitPlanResult> {
  const fields = {
    projectSlug,
    title,
    plan,
    productDirection,
    needsDidi,
    needsDidiReason,
    answers,
    ideaId,
  };
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, fields));
}
