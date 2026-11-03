// Guards on Didi's answer to the planning chat's plan (D-266, src/core/plans.ts). Both read the
// idea's latest submission and the newest request on its plan-approval topic, and pass only when
// that request shows the latest submission and Didi answered it, so an answer to an older plan
// never moves the idea.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { CurrentDecision } from "../store.ts";
import { latestSubmission, newestPlanRequest, requestSubmissionId } from "../plans.ts";
import { result } from "./evidence.ts";

/** Didi's answer to the request for the idea's latest submission, or why there is none. */
async function didiAnswer(
  ctx: GuardContext,
): Promise<{ answer: CurrentDecision } | { missing: string }> {
  if (ctx.node.type !== "idea") return { missing: "not an idea" };
  const submission = await latestSubmission(ctx.store, ctx.node.id);
  if (!submission) return { missing: "no plan submitted" };
  const request = await newestPlanRequest(ctx.store, ctx.node);
  if (!request || requestSubmissionId(request) !== submission.id) {
    return { missing: "no approval request for the latest plan yet" };
  }
  if (request.status !== "answered" || !request.decisionId) {
    return { missing: `the plan-approval request is ${request.status}` };
  }
  const answer = await ctx.store.getDecision(request.decisionId);
  if (
    !answer ||
    answer.status !== "active" ||
    answer.byActor !== "didi" ||
    answer.nodeId !== ctx.node.id
  ) {
    return { missing: "no active answer by Didi on the plan-approval request" };
  }
  return { answer };
}

/** Didi approved the latest plan the planning chat submitted for the idea (D-266). */
export async function planApprovalRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const found = await didiAnswer(ctx);
  if ("missing" in found) {
    return result("plan_approval_recorded", false, [], found.missing);
  }
  if (found.answer.kind !== "approval") {
    return result(
      "plan_approval_recorded",
      false,
      [],
      "Didi did not approve the latest plan",
    );
  }
  return result("plan_approval_recorded", true, [], "Didi approved the latest plan");
}

const scopeOutcome = (decision: CurrentDecision): unknown =>
  typeof decision.scope === "object" &&
  decision.scope !== null &&
  !Array.isArray(decision.scope)
    ? decision.scope.outcome
    : undefined;

/**
 * Didi rejected the latest plan or asked for changes, with feedback (D-254), so the idea goes back
 * to Council planning for the planning chat to resubmit (D-266).
 */
export async function planReturnRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const found = await didiAnswer(ctx);
  if ("missing" in found)
    return result("plan_return_recorded", false, [], found.missing);
  const outcome = scopeOutcome(found.answer);
  if (
    found.answer.kind !== "answer" ||
    (outcome !== "rejected" && outcome !== "changes_requested") ||
    found.answer.textVerbatim.trim() === ""
  ) {
    return result(
      "plan_return_recorded",
      false,
      [],
      "Didi did not reject the latest plan or ask for changes with feedback",
    );
  }
  return result(
    "plan_return_recorded",
    true,
    [],
    outcome === "rejected" ? "Didi rejected the plan" : "Didi asked for changes",
  );
}
