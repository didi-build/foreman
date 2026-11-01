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
import type { Json, Node, Store } from "./store.ts";

export { ESCALATION_GUARD };

/** The guard of the move from the Council to Didi (escalation.yaml). */
export const DIDI_QUESTION_GUARD = "didi_question_open";

const ACTOR = { kind: "runner" as const, id: "escalation" };

/** The trigger ref prefixes of the moves out of an escalation, followed by the decision id. */
export const COUNCIL_TRIGGER = "council_decision:";
export const DIDI_TRIGGER = "didi_answer:";

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
      { nodeId: node.id, toState, trigger, actor: ACTOR, reason },
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
    });
    return check.outcome === "allowed";
  }

  /** One open question for Didi on the node's topic, opened in live mode only. */
  async function askDidi(
    node: Node,
    decision: { id: string; textVerbatim: string },
    returnState: string,
  ): Promise<string | null> {
    const topicKey = escalationTopic(node.id);
    const open = await store.findOpenGateRequest(node.projectId, topicKey);
    if (open?.owner === "didi") return open.id;
    if (await dryRunOn()) return null;
    const payload: { [key: string]: Json } = {
      question: "The Council could not resolve this item, or its decision needs Didi.",
      councilDecisionId: decision.id,
      councilNote: decision.textVerbatim,
      returnState,
    };
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
    const gateRequestId = await askDidi(node, decision, back ?? "");
    const result = await library.requestTransitionOnce({
      nodeId: node.id,
      toState: didiState,
      blockedReason:
        "Waiting on Didi: the Council could not resolve it, or it needs him",
      trigger,
      actor: ACTOR,
      reason: "the Council could not resolve it, or its decision needs Didi",
    });
    return {
      nodeId: node.id,
      step: "to_didi",
      gateRequestId,
      move: asMove(didiState, result),
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

  return {
    escalate,
    resolve,

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
