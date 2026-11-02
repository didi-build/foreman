// The guard on a Council `redo` verdict (D-229, D-231, ADR 0105): the move that sends a stale
// item back to the start of its track. It reads only the decisions about the node and its
// transitions, so the runner (src/core/council.ts) can ask the same question inside the
// transaction that records a reversal answer.
//
// A Council reversal answer is a `council_decision` whose scope carries `reversedDecisionId` and
// `verdicts` (D-228, O-49). The runner links every item it gives a verdict for to that decision
// (`node_decisions`), so the item's own decisions list it. Its scope also names the items whose
// stale flag the answer cleared (`clearedNodeIds`).
//
// The item's stale episode starts after its last way out of stale: an answer that cleared its
// flag, or an applied redo move (trigger `council_redo:<decision id>`). Inside the episode, every
// decision about the item that was reversed must have a Council answer for the item that is not
// `cannot_decide`; a reversal still open, or one sent to Didi (N-41), leaves the episode unsettled.
// A settled episode with an active `redo` answer for the item is a redo, from the latest such
// answer. The guard then passes only for a stale item with no `merge_commit`: merged code is on
// main, and sending it back is more than a state move (N-43).
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { CurrentDecision, Json, Transition } from "../store.ts";
import { latest, result } from "./evidence.ts";

/** The guard every redo move carries (contracts/machine-2). */
export const REDO_GUARD = "council_redo_recorded";

/** The trigger ref prefix of a redo move, followed by the Council decision id. */
export const REDO_TRIGGER = "council_redo:";

export type Verdict = "still_valid" | "redo" | "cannot_decide";

const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The verdict a Council reversal answer gives the node, or null when it is not one. */
export function verdictFor(decision: CurrentDecision, nodeId: string): Verdict | null {
  if (decision.kind !== "council_decision" || !isObject(decision.scope)) return null;
  const { reversedDecisionId, verdicts } = decision.scope;
  if (typeof reversedDecisionId !== "string" || !Array.isArray(verdicts)) return null;
  for (const v of verdicts) {
    if (!isObject(v) || v.nodeId !== nodeId) continue;
    const verdict = v.verdict;
    if (
      verdict === "still_valid" ||
      verdict === "redo" ||
      verdict === "cannot_decide"
    ) {
      return verdict;
    }
  }
  return null;
}

const reversedIdOf = (decision: CurrentDecision): string | null => {
  const id = isObject(decision.scope) ? decision.scope.reversedDecisionId : undefined;
  return typeof id === "string" ? id : null;
};

const clearedBy = (decision: CurrentDecision, nodeId: string): boolean => {
  const ids = isObject(decision.scope) ? decision.scope.clearedNodeIds : undefined;
  return Array.isArray(ids) && ids.includes(nodeId);
};

/** Where an item's stale episode stands on the Council's verdicts. */
export type RedoState =
  /** A reversal in the episode has no Council answer for the item, or only `cannot_decide`. */
  | { kind: "unsettled"; reversedDecisionId: string }
  /** Every reversal in the episode is answered, and none of the answers is an active `redo`. */
  | { kind: "settled" }
  /** Every reversal in the episode is answered, and this active answer is the latest `redo`. */
  | { kind: "redo"; decision: CurrentDecision };

/**
 * The item's stale episode from the decisions about it (`listDecisionsForNode`, which includes
 * the Council answers linked to it) and its transitions. Pure, so the runner can pass in an
 * answer it is about to record.
 */
export function redoState(
  nodeId: string,
  decisions: readonly CurrentDecision[],
  transitions: readonly Transition[],
): RedoState {
  const answers = decisions.filter((d) => verdictFor(d, nodeId) !== null);
  const ends = [
    ...answers.filter((d) => clearedBy(d, nodeId)).map((d) => d.recordedAt.getTime()),
    ...transitions
      .filter((t) => t.mode === "applied" && t.triggerRef?.startsWith(REDO_TRIGGER))
      .map((t) => t.at.getTime()),
  ];
  const start = ends.length > 0 ? Math.max(...ends) : null;
  const inEpisode = (at: Date) => start === null || at.getTime() > start;
  for (const reversal of decisions) {
    if (reversal.status !== "reversed" || !reversal.statusChangedAt) continue;
    if (!inEpisode(reversal.statusChangedAt)) continue;
    // An answer counts whatever its own status: a reversed answer opens its own question.
    const answered = answers.some(
      (a) =>
        reversedIdOf(a) === reversal.id &&
        a.recordedAt.getTime() >= (reversal.statusChangedAt as Date).getTime() &&
        verdictFor(a, nodeId) !== "cannot_decide",
    );
    if (!answered) return { kind: "unsettled", reversedDecisionId: reversal.id };
  }
  const redo = latest(
    answers.filter(
      (a) =>
        a.status === "active" &&
        inEpisode(a.recordedAt) &&
        !clearedBy(a, nodeId) &&
        verdictFor(a, nodeId) === "redo",
    ),
  );
  return redo ? { kind: "redo", decision: redo } : { kind: "settled" };
}

/** The item's redo state, read through the guard's store or a transaction. */
export async function readRedoState(ctx: GuardContext): Promise<RedoState> {
  return redoState(
    ctx.node.id,
    await ctx.store.listDecisionsForNode(ctx.node.id),
    await ctx.store.listTransitions(ctx.node.id),
  );
}

/** Whether the item has a recorded merge commit: its code is on main. */
export async function isMerged(ctx: GuardContext): Promise<boolean> {
  const merges = await ctx.store.listEvidence({
    nodeId: ctx.node.id,
    kind: "merge_commit",
  });
  return merges.some((e) => e.commitSha !== null);
}

/**
 * The Council's latest `redo` verdict for this stale item stands: every decision about it that
 * was reversed since its last way out of stale has a Council answer for it that is not
 * `cannot_decide`, and the latest active one of those answers that gives `redo` exists. Fails for
 * an item that is not stale, and for a merged item (N-43).
 */
export async function councilRedoRecorded(ctx: GuardContext): Promise<GuardCheck> {
  if (!ctx.node.stale) return result(REDO_GUARD, false, [], "not stale");
  if (await isMerged(ctx)) {
    return result(
      REDO_GUARD,
      false,
      [],
      "merged: its code is on main, so a redo needs Didi (N-43)",
    );
  }
  const state = await readRedoState(ctx);
  if (state.kind === "unsettled") {
    return result(
      REDO_GUARD,
      false,
      [],
      `reversal of decision ${state.reversedDecisionId} has no Council verdict for it yet`,
    );
  }
  if (state.kind === "settled") {
    return result(REDO_GUARD, false, [], "no Council redo verdict for it");
  }
  return result(
    REDO_GUARD,
    true,
    [],
    `Council decision ${state.decision.id} gives redo`,
  );
}
