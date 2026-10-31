// Guards on escalation: when to escalate, and the Council's and Didi's answers (ADR 0105, D-177).
// Topic key convention: the question for Didi about a node is `escalation:<node id>`.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { CurrentDecision, Json } from "../store.ts";
import { latest, readAgentReport, result } from "./evidence.ts";
import { STAGING_CHECK_ATTEMPTS, stagingNoResults } from "./staging.ts";

export const escalationTopic = (nodeId: string): string => `escalation:${nodeId}`;

const scopeOf = (decision: CurrentDecision): { [key: string]: Json } =>
  typeof decision.scope === "object" &&
  decision.scope !== null &&
  !Array.isArray(decision.scope)
    ? decision.scope
    : {};

/** Recorded since the node entered its current state. */
const sinceState = (ctx: GuardContext, at: Date): boolean =>
  at.getTime() >= ctx.node.stateSince.getTime();

async function numberSetting(ctx: GuardContext, key: string): Promise<number | null> {
  const value = (await ctx.store.getSetting(key))?.value;
  return typeof value === "number" ? value : null;
}

/**
 * The failure counter or the QA round count reached its limit, a run went over budget in the
 * current state, the staging check ended without a result on its first try and its one
 * re-dispatch in the current state (M3.4), or a bot asked to escalate with a written reason in
 * the current state.
 */
export async function escalationTriggerMet(ctx: GuardContext): Promise<GuardCheck> {
  const reasons: string[] = [];
  const ids: string[] = [];
  const failureThreshold = await numberSetting(ctx, "failure_threshold");
  const failures = await ctx.store.getCounter(ctx.node.id, "failure");
  if (failureThreshold !== null && failures >= failureThreshold) {
    reasons.push(`${failures} failures`);
  }
  const roundCap = await numberSetting(ctx, "qa_round_cap");
  const rounds = await ctx.store.getCounter(ctx.node.id, "qa_round");
  if (roundCap !== null && rounds >= roundCap)
    reasons.push(`${rounds} failed QA rounds`);
  const overBudget = (await ctx.store.listRuns({ nodeId: ctx.node.id })).filter(
    (r) => r.outcome === "budget_exceeded" && sinceState(ctx, r.startedAt),
  );
  if (overBudget.length > 0) reasons.push("a run went over budget");
  const noResults = await stagingNoResults(ctx);
  if (noResults.rows.length >= STAGING_CHECK_ATTEMPTS) {
    reasons.push(
      `the staging check ended without a result ${noResults.rows.length} times for merge ${noResults.mergeSha}`,
    );
    ids.push(...noResults.rows.map((e) => e.id));
  }
  for (const report of await ctx.store.listEvidence({
    nodeId: ctx.node.id,
    kind: "agent_report",
  })) {
    if (!sinceState(ctx, report.recordedAt)) continue;
    const payload = readAgentReport(report.payload);
    if (payload?.escalate === true && (payload.reason ?? "").trim() !== "") {
      reasons.push(`a bot asked: ${payload.reason}`);
      ids.push(report.id);
    }
  }
  if (reasons.length === 0)
    return result("escalation_trigger_met", false, [], "no escalation trigger");
  return result("escalation_trigger_met", true, ids, reasons.join("; "));
}

/**
 * The Council recorded a decision for this escalation, and it states it changes no product
 * direction and passes no gate (both flags present and false). Otherwise it goes to Didi.
 */
export async function councilDecisionRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const name = "council_decision_recorded";
  const decision = latest(
    (await ctx.store.listDecisionsForNode(ctx.node.id)).filter(
      (d) =>
        d.status === "active" &&
        d.kind === "council_decision" &&
        sinceState(ctx, d.recordedAt),
    ),
  );
  if (!decision)
    return result(name, false, [], "no Council decision since the escalation");
  const scope = scopeOf(decision);
  if (scope.changesProductDirection !== false || scope.passesGate !== false) {
    return result(
      name,
      false,
      [],
      "the decision does not state it keeps product direction and gates: it goes to Didi",
    );
  }
  return result(name, true, [], `Council decision ${decision.id}`);
}

/** The question for Didi is an open gate request owned by Didi, with the node's topic key. */
export async function didiQuestionOpen(ctx: GuardContext): Promise<GuardCheck> {
  const request = await ctx.store.findOpenGateRequest(
    ctx.node.projectId,
    escalationTopic(ctx.node.id),
  );
  if (request?.owner !== "didi") {
    return result("didi_question_open", false, [], "no open question for Didi");
  }
  return result("didi_question_open", true, [], `question ${request.id} is open`);
}

/** Didi's answer is saved verbatim, on the escalation topic, since the node was escalated to him. */
export async function didiAnswerRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const topic = escalationTopic(ctx.node.id);
  const answer = latest(
    (await ctx.store.listDecisionsForNode(ctx.node.id)).filter(
      (d) =>
        d.status === "active" &&
        d.byActor === "didi" &&
        scopeOf(d).topicKey === topic &&
        sinceState(ctx, d.recordedAt),
    ),
  );
  if (!answer)
    return result("didi_answer_recorded", false, [], "no answer from Didi yet");
  if (answer.textVerbatim.trim() === "") {
    return result("didi_answer_recorded", false, [], "the answer has no verbatim text");
  }
  return result(
    "didi_answer_recorded",
    true,
    [],
    `answered by Didi (decision ${answer.id})`,
  );
}
