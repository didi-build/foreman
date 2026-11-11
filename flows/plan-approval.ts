// The plan-approval flow (D-273 (2), D-274). The state API starts it with its narrow Windmill
// credential right after the planning chat's submission is recorded, so Didi's request opens at
// once, not on the next reconcile pass. It takes one step for the idea (src/core/plans.ts): open
// the request for the latest plan, or nothing if one is already waiting. The step reads the kill
// switch and dry run itself, as in the reconcile flow's plan approval pass, which stays as the
// safety net for a start that failed or never came. When the submission's call is that Didi is
// not needed (D-307), the step is the Council's own acceptance instead, and the Triage pass then
// starts Triage for the idea, as Didi's Approve does in the approval resume step.
import { createPlanApprovals, type PlanApprovalStep } from "../src/core/plans.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { triagePass, type TriagePassStep } from "./lib/triage-runs.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface PlanApprovalInput {
  /** The idea the planning chat's submission was recorded on. */
  ideaId: string;
}

/** The step, and after the Council's own acceptance the Triage pass for the idea (D-307). */
export type PlanApprovalResult = PlanApprovalStep & { triage?: TriagePassStep[] };

export async function run(
  deps: FlowDeps,
  input: PlanApprovalInput,
): Promise<PlanApprovalResult> {
  const step = await createPlanApprovals(deps).step(input.ideaId);
  if (step.step === "council_accepted" && step.move.outcome === "applied") {
    return { ...step, triage: await triagePass(deps, [input.ideaId]) };
  }
  return step;
}

export async function main(input: PlanApprovalInput): Promise<PlanApprovalResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
