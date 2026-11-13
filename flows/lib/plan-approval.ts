// One plan approval step for one idea (D-273 (2), D-307), shared by the plan-approval flow the
// state API starts after a submission (../plan-approval.ts) and Didi's form to submit a plan by
// hand, which takes it in its own run (./submit-plan.ts, D-383). The step (src/core/plans.ts)
// opens Didi's request for the idea's latest plan, or nothing if one is already waiting, and
// reads the kill switch and dry run itself. When the plan's call is that Didi is not needed
// (D-307), the step is the Council's own acceptance instead, and the Triage pass then starts
// Triage for the idea, as Didi's Approve does in the approval resume step.
import { createPlanApprovals, type PlanApprovalStep } from "../../src/core/plans.ts";
import type { FlowDeps } from "./compose.ts";
import { triagePass, type TriagePassStep } from "./triage-runs.ts";

/** The step, and after the Council's own acceptance the Triage pass for the idea (D-307). */
export type PlanApprovalResult = PlanApprovalStep & { triage?: TriagePassStep[] };

export async function planApprovalStep(
  deps: FlowDeps,
  ideaId: string,
): Promise<PlanApprovalResult> {
  const step = await createPlanApprovals(deps).step(ideaId);
  if (step.step === "council_accepted" && step.move.outcome === "applied") {
    return { ...step, triage: await triagePass(deps, [ideaId]) };
  }
  return step;
}
