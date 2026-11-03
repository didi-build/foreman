// The plan-approval flow (D-273 (2), D-274). The state API starts it with its narrow Windmill
// credential right after the planning chat's submission is recorded, so Didi's request opens at
// once, not on the next reconcile pass. It takes one step for the idea (src/core/plans.ts): open
// the request for the latest plan, or nothing if one is already waiting. The step reads the kill
// switch and dry run itself, as in the reconcile flow's plan approval pass, which stays as the
// safety net for a start that failed or never came.
import { createPlanApprovals, type PlanApprovalStep } from "../src/core/plans.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface PlanApprovalInput {
  /** The idea the planning chat's submission was recorded on. */
  ideaId: string;
}

export async function run(
  deps: FlowDeps,
  input: PlanApprovalInput,
): Promise<PlanApprovalStep> {
  return createPlanApprovals(deps).step(input.ideaId);
}

export const main = (input: PlanApprovalInput): Promise<PlanApprovalStep> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
