// Escalation (build plan M3.5, D-169, D-177, ADR 0105): asking for the Council, and taking the
// item out of Escalated to Council and Escalated to Didi once the Council or Didi has answered.
// Plain logic over an injected store, contracts, guards, clock and id source (D-162). Which moves
// these are comes from the escalation contract, never from a list of state names: the escalation
// is the `from: any` move guarded by `escalation_trigger_met`; out of its target state there is a
// `to: return` move (the Council's decision) and a move into the state where Didi answers, which
// has its own `to: return` move. The guards decide every move (essential 3).
//
// Out of Escalated to Council (`resolve`): the Council records a `council_decision` on the node
// (through the state API). When `council_decision_recorded` passes, the item returns to the state
// it was escalated from, and both counters reset in the same transaction (P-03). Otherwise the
// Council could not resolve it (`scope.outcome` `cannot_resolve`), or its decision changes product
// direction or passes a gate: the runner opens one `escalation` gate request owned by Didi on the
// topic `escalation:<node id>` (the question, with the Council's note) and asks for the move to
// Escalated to Didi, which `didi_question_open` allows. Out of Escalated to Didi: Didi's answer
// on the approval page is recorded on that topic (src/core/approvals.ts), `didi_answer_recorded`
// passes, and the item returns with both counters reset in the same transaction (O-46).
//
// Each move's trigger names the decision it acts on (`council_decision:<id>`,
// `didi_answer:<id>`), so a repeated call writes one row and resets once. The gate request is
// opened before its move (the guard reads it); a call cut short between the two finds the open
// request on the next call and asks for the move again. Dry run writes dry-run rows, resets
// nothing and opens no gate request; the kill switch refuses every move.
//
// One cap on Council returns (D-414, O-143): once the Council has returned an item twice with no
// step forward in between, the item's next escalation goes to Didi instead of the Council, with
// one `escalation` question for Didi on its topic, as when the Council gives no usable answer. The
// Council pass asks for it in place of the Council's run (src/core/council.ts `next`,
// flows/lib/council-runs.ts), so it holds whatever escalated the item: refused done reports, stops
// for a decision, failed QA rounds, failed staging checks or deploys, repeated failures. A Council
// return is a move out of Escalated to Council with a `council_decision:` trigger. A step forward
// is a move, other than into an escalated state, into a state the item had never been in: it got
// further than it had ever been. Each of those loops only goes back to states the item has been
// in (both counters reset on every return, so a loop through QA or staging repeats the same
// states), so none counts. Didi's return out of Escalated to Didi neither counts nor ends the row:
// until the item steps forward, each later escalation goes to Didi too. This replaces D-386's
// narrower cap on a builder's stops for a decision; moves it wrote (`builder_stops_again:`) stay
// as they are, and their items leave Escalated to Didi on Didi's answer like any other.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import {
  escalationTopic,
  latestCouncilDecision,
  latestDidiAnswer,
} from "./guards/escalation.ts";
import {
  createLibrary,
  type AlsoWrite,
  type Clock,
  type IdSource,
  type TransitionOutcome,
  type TransitionResult,
  type Trigger,
} from "./library.ts";
import { ESCALATION_GUARD } from "./staging.ts";
import type { Json, Node, Store, Transition } from "./store.ts";

export { ESCALATION_GUARD };

/** The guard of the move from the Council to Didi (escalation.yaml). */
export const DIDI_QUESTION_GUARD = "didi_question_open";

const ACTOR = { kind: "runner" as const, id: "escalation" };

/** The trigger ref prefixes of the moves out of an escalation, followed by the decision id. */
export const COUNCIL_TRIGGER = "council_decision:";
export const DIDI_TRIGGER = "didi_answer:";
/** The trigger ref prefix of the move to Didi when the Council gave no usable answer, then a run id. */
export const COUNCIL_UNANSWERED_TRIGGER = "council_unanswered:";
/**
 * The trigger ref prefix of the move to Didi when the Council has returned the item twice with
 * no step forward in between (D-414), then the id of the move into Escalated to Council it acts on.
 */
export const COUNCIL_RETURNS_TRIGGER = "council_returns_capped:";
/**
 * D-386's trigger ref prefix of the move to Didi when a builder stopped for a decision again,
 * then the stopping run's id. D-414 replaced that cap and nothing writes it now; it names the
 * moves already written with it.
 */
export const BUILDER_STOPS_TRIGGER = "builder_stops_again:";

/** The Council's returns with no step forward in between after which it is not asked again (D-414). */
export const COUNCIL_RETURNS_BEFORE_DIDI = 2;

/**
 * The Council's returns of an item since its last step forward (D-414), oldest first, from its
 * transitions in the order they were written. A Council return is an applied move out of
 * `councilState` with a `council_decision:` trigger. A step forward is an applied move into a
 * state the item had never been in (its first move's start state counts as one it has been in),
 * unless that state is an escalated one; it ends the row. Pure, so the rule is tested alone.
 */
export function councilReturnsSinceStepForward(
  contracts: Pick<Contracts, "states">,
  councilState: string,
  transitions: readonly Transition[],
): Transition[] {
  const escalated = (state: string): boolean =>
    Object.hasOwn(contracts.states, state) &&
    contracts.states[state]?.escalated === true;
  const applied = transitions.filter((t) => t.mode === "applied");
  const seen = new Set<string>(applied[0] ? [applied[0].fromState] : []);
  let returns: Transition[] = [];
  for (const t of applied) {
    if (t.fromState === councilState && t.triggerRef?.startsWith(COUNCIL_TRIGGER)) {
      returns.push(t);
    } else if (!seen.has(t.toState) && !escalated(t.toState)) {
      returns = [];
    }
    seen.add(t.toState);
  }
  return returns;
}

export interface EscalationsOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/** What the library decided for one escalation move. */
export interface EscalationMove {
  outcome: TransitionOutcome;
  toState: string;
  reason?: string;
  transitionId?: string;
  failedGuards: string[];
}

/** What `resolve` did for one node. */
export type EscalationStep =
  | { nodeId: string; step: "no_node" | "not_escalated" }
  /** No Council decision, or no answer from Didi, since the item entered the state. */
  | { nodeId: string; step: "waiting"; on: "council" | "didi" }
  /** The move back to the state the item was escalated from (counters reset). */
  | { nodeId: string; step: "returned"; move: EscalationMove }
  /** The question for Didi, and the move to the state where he answers. */
  | {
      nodeId: string;
      step: "to_didi";
      gateRequestId: string | null;
      move: EscalationMove;
    };

/** Both P-03 counters back to 0, in the transaction of the move that resolves the escalation. */
export const resetCounters =
  (nodeId: string, clock: Clock): AlsoWrite =>
  async (tx) => {
    const at = clock.now();
    await tx.setCounter(nodeId, "failure", 0, at);
    await tx.setCounter(nodeId, "qa_round", 0, at);
    return null;
  };

const asMove = (toState: string, result: TransitionResult): EscalationMove => ({
  outcome: result.outcome,
  toState,
  ...(result.reason ? { reason: result.reason } : {}),
  ...(result.transitionId ? { transitionId: result.transitionId } : {}),
  failedGuards: result.guardReport.filter((c) => !c.pass).map((c) => c.name),
});

export function createEscalations(options: EscalationsOptions) {
  const { store, contracts, clock } = options;
  const library = createLibrary(options);

  const escalationMove: TransitionContract | undefined = contracts.transitions.find(
    (m) => m.escalation && m.from === "any" && m.guards.includes(ESCALATION_GUARD),
  );
  const councilState = escalationMove?.to;
  const toDidiMove = contracts.transitions.find(
    (m) =>
      m.escalation && m.from === councilState && m.guards.includes(DIDI_QUESTION_GUARD),
  );
  const didiState = toDidiMove?.to;
  const dryRunOn = async () => (await store.getSetting("dry_run"))?.value !== false;

  /**
   * Asks for the Council with the caller's trigger; the guards decide. `alsoWrite` commits with
   * the move (a count that goes with it). Undefined when the contracts have no escalation.
   */
  async function escalate(
    nodeId: string,
    trigger: Trigger,
    reason: string,
    alsoWrite?: AlsoWrite,
  ): Promise<EscalationMove | undefined> {
    if (!escalationMove) return undefined;
    const result = await library.requestTransitionOnce(
      {
        nodeId,
        toState: escalationMove.to,
        blockedReason: reason,
        trigger,
        actor: ACTOR,
        reason,
      },
      alsoWrite,
    );
    return asMove(escalationMove.to, result);
  }

  /** The move back to where the item was escalated from, with both counters reset (P-03). */
  async function returnWithReset(
    node: Node,
    toState: string,
    trigger: Trigger,
    reason: string,
  ): Promise<EscalationMove> {
    // Dry run writes a dry-run row and no counter, as for every count (P-03).
    const reset = (await dryRunOn()) ? undefined : resetCounters(node.id, clock);
    const result = await library.requestTransitionOnce(
      { nodeId: node.id, toState, trigger, actor: ACTOR, reason, runnerOnly: true },
      reset,
    );
    return asMove(toState, result);
  }

  /** Whether the guards allow the move back now. */
  async function returnAllowed(node: Node, toState: string): Promise<boolean> {
    const check = await library.checkTransition({
      nodeId: node.id,
      toState,
      trigger: { kind: "event", ref: null },
      actor: ACTOR,
      runnerOnly: true,
    });
    return check.outcome === "allowed";
  }

  /** One open question for Didi on the node's topic, opened in live mode only. */
  async function askDidi(
    node: Node,
    payload: { [key: string]: Json },
  ): Promise<string | null> {
    const topicKey = escalationTopic(node.id);
    const open = await store.findOpenGateRequest(node.projectId, topicKey);
    if (open?.owner === "didi") return open.id;
    if (await dryRunOn()) return null;
    const gate = await library.openGateRequest({
      projectId: node.projectId,
      nodeId: node.id,
      topicKey,
      kind: "escalation",
      owner: "didi",
      blocking: true,
      payload,
    });
    return gate.id;
  }

  async function resolveCouncil(node: Node): Promise<EscalationStep> {
    const decision = await latestCouncilDecision({ node, store });
    if (!decision) return { nodeId: node.id, step: "waiting", on: "council" };
    const trigger: Trigger = { kind: "event", ref: `${COUNCIL_TRIGGER}${decision.id}` };
    const back = await library.returnState(node.id);
    if (back && (await returnAllowed(node, back))) {
      return {
        nodeId: node.id,
        step: "returned",
        move: await returnWithReset(node, back, trigger, "the Council resolved it"),
      };
    }
    if (!didiState) return { nodeId: node.id, step: "waiting", on: "council" };
    return toDidi(
      node,
      {
        question:
          "The Council could not resolve this item, or its decision needs Didi.",
        councilDecisionId: decision.id,
        councilNote: decision.textVerbatim,
        returnState: back ?? "",
      },
      trigger,
      "the Council could not resolve it, or its decision needs Didi",
    );
  }

  /** The question for Didi, then the move to the state where he answers (`didi_question_open`). */
  async function toDidi(
    node: Node,
    payload: { [key: string]: Json },
    trigger: Trigger,
    reason: string,
  ): Promise<EscalationStep> {
    const state = didiState as string;
    const gateRequestId = await askDidi(node, payload);
    const result = await library.requestTransitionOnce({
      nodeId: node.id,
      toState: state,
      blockedReason:
        "Waiting on Didi: the Council could not resolve it, or it needs Didi",
      trigger,
      actor: ACTOR,
      reason,
    });
    return {
      nodeId: node.id,
      step: "to_didi",
      gateRequestId,
      move: asMove(state, result),
    };
  }

  async function resolveDidi(node: Node): Promise<EscalationStep> {
    const answer = await latestDidiAnswer({ node, store });
    const back = await library.returnState(node.id);
    if (!answer || !back || !(await returnAllowed(node, back))) {
      return { nodeId: node.id, step: "waiting", on: "didi" };
    }
    return {
      nodeId: node.id,
      step: "returned",
      move: await returnWithReset(
        node,
        back,
        { kind: "event", ref: `${DIDI_TRIGGER}${answer.id}` },
        "Didi answered",
      ),
    };
  }

  /** Takes the item out of its escalated state when the Council or Didi has answered. */
  async function resolve(nodeId: string): Promise<EscalationStep> {
    const node = await store.getNode(nodeId);
    if (!node) return { nodeId, step: "no_node" };
    if (councilState && node.state === councilState) return resolveCouncil(node);
    if (didiState && node.state === didiState) return resolveDidi(node);
    return { nodeId, step: "not_escalated" };
  }

  /**
   * The Council's runs gave no usable answer for the item (D-228: one run and one re-run, see
   * src/core/council.ts): one `escalation` gate request for Didi on the item's topic, with the
   * reason, and the move to Escalated to Didi (trigger `council_unanswered:<last run id>`).
   */
  async function councilUnanswered(
    nodeId: string,
    lastRunId: string,
    why: string,
  ): Promise<EscalationStep> {
    const node = await store.getNode(nodeId);
    if (!node) return { nodeId, step: "no_node" };
    if (!councilState || node.state !== councilState || !didiState) {
      return { nodeId, step: "not_escalated" };
    }
    return toDidi(
      node,
      {
        question: "The Council gave no usable answer for this item.",
        reason: why,
        lastCouncilRunId: lastRunId,
        returnState: (await library.returnState(node.id)) ?? "",
      },
      { kind: "event", ref: `${COUNCIL_UNANSWERED_TRIGGER}${lastRunId}` },
      "the Council gave no usable answer",
    );
  }

  /** The Council's returns of the item since its last step forward (D-414), oldest first. */
  async function councilReturns(nodeId: string): Promise<Transition[]> {
    if (!councilState) return [];
    return councilReturnsSinceStepForward(
      contracts,
      councilState,
      await store.listTransitions(nodeId),
    );
  }

  /**
   * D-414: the item waits in Escalated to Council, and the Council has returned it
   * `COUNCIL_RETURNS_BEFORE_DIDI` times since its last step forward. It goes on to Didi with one
   * `escalation` gate request on its topic and the move to Escalated to Didi (trigger
   * `council_returns_capped:<id of the move into Escalated to Council>`), so the Council is not
   * asked again. `waiting` on the Council while the cap is not reached.
   */
  async function councilReturnsCapped(nodeId: string): Promise<EscalationStep> {
    const node = await store.getNode(nodeId);
    if (!node) return { nodeId, step: "no_node" };
    if (!councilState || node.state !== councilState || !didiState) {
      return { nodeId, step: "not_escalated" };
    }
    const history = await store.listTransitions(node.id);
    const returns = councilReturnsSinceStepForward(contracts, councilState, history);
    const entered = history
      .filter((t) => t.mode === "applied" && t.toState === councilState)
      .at(-1);
    if (returns.length < COUNCIL_RETURNS_BEFORE_DIDI || !entered) {
      return { nodeId, step: "waiting", on: "council" };
    }
    return toDidi(
      node,
      {
        question:
          "The Council has returned this item twice with no step forward in between.",
        reason: `the Council returned it ${returns.length} times since it last reached a state it had not been in; this escalation's reason is on the item`,
        councilDecisionIds: returns.map((t) =>
          (t.triggerRef ?? "").slice(COUNCIL_TRIGGER.length),
        ),
        returnState: (await library.returnState(node.id)) ?? "",
      },
      { kind: "event", ref: `${COUNCIL_RETURNS_TRIGGER}${entered.id}` },
      "the Council has returned the item twice with no step forward in between",
    );
  }

  return {
    escalate,
    resolve,
    councilUnanswered,
    councilReturns,
    councilReturnsCapped,
    /** The state an item waits in for the Council, from the contracts. */
    councilState,

    /** `resolve` for every node in an escalated state, in the store's node order. */
    async resolveAll(): Promise<EscalationStep[]> {
      const steps: EscalationStep[] = [];
      for (const state of [councilState, didiState]) {
        if (!state) continue;
        for (const node of await store.listNodes({ state })) {
          steps.push(await resolve(node.id));
        }
      }
      return steps;
    },
  };
}

export type Escalations = ReturnType<typeof createEscalations>;
