// Guards on the ways into Plan accepted (D-266, D-307, src/core/plans.ts). Didi's two read the
// idea's latest plan (the planning chat's latest submission, or the Council's latest planning
// answer on a scanner idea) and the newest request on its plan-approval topic, and pass only when
// that request shows the latest plan and Didi answered it, so an answer to an older plan never
// moves the idea. The Council's (`council_plan_accepted`) passes only when the latest plan
// carries the Council's call that Didi is not needed, and Didi was never asked about a plan for
// the idea: no request was ever opened on its plan-approval topic.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { CurrentDecision } from "../store.ts";
import {
  COUNCIL_ACCEPT_GUARD,
  latestPlan,
  newestPlanRequest,
  requestSubmissionId,
} from "../plans.ts";
import { result } from "./evidence.ts";

/** Didi's answer to the request for the idea's latest submission, or why there is none. */
async function didiAnswer(
  ctx: GuardContext,
): Promise<{ answer: CurrentDecision } | { missing: string }> {
  if (ctx.node.type !== "idea") return { missing: "not an idea" };
  const plan = await latestPlan(ctx.store, ctx.node.id);
  if (!plan) return { missing: "no plan submitted" };
  const request = await newestPlanRequest(ctx.store, ctx.node);
  if (!request || requestSubmissionId(request) !== plan.id) {
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

/**
 * The Council accepted the idea's latest plan itself (D-307): its recorded call is that Didi is
 * not needed, and no plan-approval request was ever opened for the idea. Anything else, `yes`,
 * `unsure`, a plan with no call, or an idea Didi was already asked about, fails, so the plan goes
 * to Didi.
 */
export async function councilPlanAccepted(ctx: GuardContext): Promise<GuardCheck> {
  const fail = (detail: string) => result(COUNCIL_ACCEPT_GUARD, false, [], detail);
  if (ctx.node.type !== "idea") return fail("not an idea");
  const plan = await latestPlan(ctx.store, ctx.node.id);
  if (!plan) return fail("no plan recorded");
  if (plan.needsDidi === null) return fail("the latest plan carries no call on Didi");
  if (plan.needsDidi.needed !== "no") {
    return fail(
      plan.needsDidi.needed === "yes"
        ? "the Council says Didi is needed"
        : "the Council is unsure, so Didi is needed",
    );
  }
  if (await newestPlanRequest(ctx.store, ctx.node)) {
    return fail("Didi was already asked about a plan for this idea");
  }
  return result(
    COUNCIL_ACCEPT_GUARD,
    true,
    [],
    "the Council accepted the latest plan: Didi is not needed",
  );
}
