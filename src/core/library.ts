// The state library (build plan M1.3, architecture section 2.1). Plain logic over an injected
// store, contracts, guards, clock and id source (D-162). It holds the mechanics only: which moves
// are legal and what each one needs come from the contracts and guard functions (essential 3).
import type {
  Contracts,
  GuardCheck,
  GuardContext,
  GuardRegistry,
  StateContract,
} from "./contracts.ts";
import type {
  CounterKind,
  Decision,
  Edge,
  EdgeType,
  Evidence,
  GateClose,
  GateRequest,
  Json,
  Node,
  Store,
  StoreOps,
  Transition,
} from "./store.ts";

export interface Clock {
  now(): Date;
}

export interface IdSource {
  next(): string;
}

export interface Actor {
  kind: Transition["actorKind"];
  id: string;
}

export interface Trigger {
  kind: Transition["triggerKind"];
  ref: string | null;
}

export interface TransitionRequest {
  nodeId: string;
  toState: string;
  toSubstate?: string | null;
  ownerRole?: string;
  blockedReason?: string | null;
  evidenceIds?: string[];
  reason?: string | null;
  trigger: Trigger;
  actor: Actor;
}

export type TransitionOutcome = "applied" | "planned" | "noop" | "rejected" | "refused";

export interface TransitionResult {
  outcome: TransitionOutcome;
  reason?: string;
  guardReport: GuardCheck[];
  transitionId?: string;
}

/** A request the library refused before writing anything (a broken invariant, not a race). */
export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

/** Thrown inside a transaction when another writer moved the node first; the write rolls back. */
class LostRace extends Error {}

const MAX_ATTEMPTS = 3;

export interface LibraryOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

export type NewNode = Pick<
  Node,
  "projectId" | "type" | "track" | "state" | "ownerRole" | "title"
> &
  Partial<Pick<Node, "substate" | "body" | "hold" | "agentReady" | "blockedReason">>;

export type NewGateRequest = Pick<
  GateRequest,
  "projectId" | "topicKey" | "kind" | "owner" | "blocking"
> &
  Partial<Pick<GateRequest, "nodeId" | "payload" | "approvalUrl">>;

export function createLibrary({
  store,
  contracts,
  guards,
  clock,
  ids,
}: LibraryOptions) {
  const stateOf = (name: string): StateContract | undefined => contracts.states[name];

  async function settingIsOn(key: string): Promise<boolean> {
    return (await store.getSetting(key))?.value === true;
  }

  /** Dry run unless the setting says otherwise: a missing setting must not act for real. */
  async function dryRunIsOn(): Promise<boolean> {
    return (await store.getSetting("dry_run"))?.value !== false;
  }

  // Guards get read calls only, as an object of their own, so a guard cannot write even by casting.
  const guardStore: GuardContext["store"] = {
    getNode: (id) => store.getNode(id),
    listEdges: (filter) => store.listEdges(filter),
    listEvidence: (filter) => store.listEvidence(filter),
    listTransitions: (nodeId) => store.listTransitions(nodeId),
    getDecision: (id) => store.getDecision(id),
    getCounter: (nodeId, kind) => store.getCounter(nodeId, kind),
    getSetting: (key) => store.getSetting(key),
    getRun: (id) => store.getRun(id),
    findOpenGateRequest: (projectId, topicKey) =>
      store.findOpenGateRequest(projectId, topicKey),
  };

  async function evaluateGuards(node: Node, names: string[]): Promise<GuardCheck[]> {
    const report: GuardCheck[] = [];
    for (const name of names) {
      const guard = guards[name];
      if (!guard) {
        report.push({
          name,
          pass: false,
          evidenceIds: [],
          detail: "guard is not registered",
        });
        continue;
      }
      report.push({ ...(await guard({ node, store: guardStore })), name });
    }
    return report;
  }

  /** True when adding from -> to would close a loop of `blocks` edges. */
  async function createsBlocksCycle(from: string, to: string): Promise<boolean> {
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === from) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of await store.listEdges({ fromNode: current, type: "blocks" })) {
        stack.push(edge.toNode);
      }
    }
    return false;
  }

  async function insertGateRequest(
    tx: StoreOps,
    request: NewGateRequest,
    at: Date,
  ): Promise<GateRequest> {
    const created: GateRequest = {
      id: ids.next(),
      nodeId: null,
      payload: {},
      approvalUrl: null,
      ...request,
      status: "open",
      decisionId: null,
      supersededBy: null,
      createdAt: at,
      answeredAt: null,
      lastNotifiedAt: null,
    };
    // One open request per topic (schema invariant 5): a newer request replaces the older one.
    const open = await tx.findOpenGateRequest(request.projectId, request.topicKey);
    if (open) {
      await tx.closeGateRequest(open.id, {
        status: "superseded",
        supersededBy: created.id,
        at,
      });
    }
    await tx.insertGateRequest(created);
    return created;
  }

  async function attemptTransition(
    request: TransitionRequest,
  ): Promise<TransitionResult | LostRace> {
    const node = await store.getNode(request.nodeId);
    if (!node) throw new LibraryError(`No node ${request.nodeId}`);
    if (node.state === request.toState) return { outcome: "noop", guardReport: [] };

    const move = contracts.transitions.find(
      (t) => t.from === node.state && t.to === request.toState,
    );
    if (!move) {
      return { outcome: "rejected", reason: "illegal_move", guardReport: [] };
    }
    const target = stateOf(request.toState);
    const blockedReason = request.blockedReason ?? null;
    if (target?.requiresBlockedReason && !blockedReason) {
      return {
        outcome: "rejected",
        reason: "blocked_reason_required",
        guardReport: [],
      };
    }
    const guardReport = await evaluateGuards(node, move.guards);
    if (guardReport.some((check) => !check.pass)) {
      return { outcome: "rejected", reason: "guard_failed", guardReport };
    }

    const dryRun = await dryRunIsOn();
    const at = clock.now();
    const transition: Transition = {
      id: ids.next(),
      nodeId: node.id,
      fromState: node.state,
      toState: request.toState,
      fromSubstate: node.substate,
      toSubstate: request.toSubstate ?? null,
      triggerKind: request.trigger.kind,
      triggerRef: request.trigger.ref,
      actorKind: request.actor.kind,
      actorId: request.actor.id,
      guardResult: guardReport as unknown as Json,
      evidenceIds: [
        ...(request.evidenceIds ?? []),
        ...guardReport.flatMap((c) => c.evidenceIds),
      ],
      specVersion: contracts.version,
      mode: dryRun ? "dry_run" : "applied",
      reason: request.reason ?? null,
      at,
    };
    try {
      await store.transaction(async (tx) => {
        await tx.insertSpecVersion({
          version: contracts.version,
          contentHash: contracts.contentHash,
          loadedAt: at,
        });
        await tx.insertTransition(transition);
        if (dryRun) return;
        const changed = await tx.changeNodeState(node.id, node.version, {
          state: request.toState,
          substate: request.toSubstate ?? null,
          ownerRole: request.ownerRole ?? node.ownerRole,
          blockedReason,
          stateSince: at,
          updatedAt: at,
        });
        // Another writer moved the node since it was read: undo the transition row too.
        if (!changed) throw new LostRace();
      });
    } catch (error) {
      if (error instanceof LostRace) return error;
      throw error;
    }
    return {
      outcome: dryRun ? "planned" : "applied",
      guardReport,
      transitionId: transition.id,
    };
  }

  return {
    async createNode(input: NewNode): Promise<Node> {
      // Every node has a project (schema invariant 7).
      if (!(await store.getProject(input.projectId))) {
        throw new LibraryError(`No project ${input.projectId}`);
      }
      const state = stateOf(input.state);
      if (!state?.initial)
        throw new LibraryError(`${input.state} is not a state a node can start in`);
      if (state.requiresBlockedReason && !input.blockedReason) {
        throw new LibraryError(`${input.state} needs a blocked reason`);
      }
      const at = clock.now();
      const node: Node = {
        id: ids.next(),
        substate: null,
        body: {},
        hold: false,
        agentReady: false,
        blockedReason: null,
        ...input,
        stale: false,
        stateSince: at,
        linearIssueId: null,
        linearStatusSynced: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      };
      await store.insertNode(node);
      return node;
    },

    async addEdge(fromNode: string, toNode: string, type: EdgeType): Promise<Edge> {
      if (fromNode === toNode) throw new LibraryError("A node cannot link to itself");
      if (type === "blocks" && (await createsBlocksCycle(fromNode, toNode))) {
        throw new LibraryError("That blocks edge would create a cycle");
      }
      const edge: Edge = {
        id: ids.next(),
        fromNode,
        toNode,
        type,
        createdAt: clock.now(),
      };
      await store.insertEdge(edge);
      return edge;
    },

    async recordEvidence(
      input: Omit<Evidence, "id" | "recordedAt" | "supersedesId"> & {
        supersedesId?: string | null;
      },
    ): Promise<Evidence> {
      const evidence: Evidence = {
        supersedesId: null,
        ...input,
        id: ids.next(),
        recordedAt: clock.now(),
      };
      await store.insertEvidence(evidence);
      return evidence;
    },

    async recordDecision(
      input: Omit<Decision, "id" | "recordedAt">,
      dependentNodeIds: string[] = [],
    ): Promise<Decision> {
      const decision: Decision = { ...input, id: ids.next(), recordedAt: clock.now() };
      await store.transaction(async (tx) => {
        await tx.insertDecision(decision);
        for (const nodeId of dependentNodeIds)
          await tx.linkNodeToDecision(nodeId, decision.id);
      });
      return decision;
    },

    /**
     * Reverses a decision without editing it: an event row, every dependent node marked stale,
     * and one Council question (test plan, state library item 5).
     */
    async reverseDecision(
      decisionId: string,
      by: string,
      reason: string,
    ): Promise<GateRequest> {
      const decision = await store.getDecision(decisionId);
      if (!decision) throw new LibraryError(`No decision ${decisionId}`);
      const at = clock.now();
      return store.transaction(async (tx) => {
        await tx.insertDecisionEvent({
          id: ids.next(),
          decisionId,
          kind: "reversed",
          byDecisionId: null,
          reason,
          recordedBy: by,
          recordedAt: at,
        });
        const nodeIds = await tx.listNodesForDecision(decisionId);
        for (const nodeId of nodeIds)
          await tx.setNodeFlags(nodeId, { stale: true }, at);
        return insertGateRequest(
          tx,
          {
            projectId: decision.projectId,
            nodeId: decision.nodeId,
            topicKey: `decision-reversed:${decisionId}`,
            kind: "council_question",
            owner: "council",
            blocking: true,
            payload: { decisionId, reason, staleNodeIds: nodeIds },
          },
          at,
        );
      });
    },

    /** Opens a gate request; an open one on the same topic is superseded (schema invariant 5). */
    async openGateRequest(request: NewGateRequest): Promise<GateRequest> {
      const at = clock.now();
      return store.transaction((tx) => insertGateRequest(tx, request, at));
    },

    async answerGateRequest(
      requestId: string,
      answer: Omit<Decision, "id" | "recordedAt" | "projectId">,
    ): Promise<Decision> {
      const request = await store.getGateRequest(requestId);
      if (!request) throw new LibraryError(`No gate request ${requestId}`);
      const at = clock.now();
      const decision: Decision = {
        ...answer,
        projectId: request.projectId,
        id: ids.next(),
        recordedAt: at,
      };
      const close: GateClose = { status: "answered", decisionId: decision.id, at };
      await store.transaction(async (tx) => {
        await tx.insertDecision(decision);
        if (!(await tx.closeGateRequest(requestId, close))) {
          throw new LibraryError(`Gate request ${requestId} is no longer open`);
        }
      });
      return decision;
    },

    /** Adds one to a counter and returns the new count (the P-03 rules decide when to call it). */
    async incrementCounter(nodeId: string, kind: CounterKind): Promise<number> {
      return store.transaction(async (tx) => {
        const next = (await tx.getCounter(nodeId, kind)) + 1;
        await tx.setCounter(nodeId, kind, next, clock.now());
        return next;
      });
    },

    async resetCounters(nodeId: string): Promise<void> {
      const at = clock.now();
      await store.transaction(async (tx) => {
        await tx.setCounter(nodeId, "failure", 0, at);
        await tx.setCounter(nodeId, "qa_round", 0, at);
      });
    },

    /** The threshold for a counter, from settings (`failure_threshold`, `qa_round_cap`). */
    async counterLimit(kind: CounterKind): Promise<number | null> {
      const key = kind === "failure" ? "failure_threshold" : "qa_round_cap";
      const value = (await store.getSetting(key))?.value;
      return typeof value === "number" ? value : null;
    },

    /** Nothing in an escalated state, on hold, or not agent-ready is dispatched (invariant 6). */
    canDispatch(node: Node): boolean {
      return !stateOf(node.state)?.escalated && !node.hold && node.agentReady;
    },

    /**
     * Moves a node if the contracts allow it and every guard passes, writing the transition and
     * the node change in one transaction with the version check (schema invariants 1 and 3).
     * A lost race rolls back and retries from a fresh read.
     */
    async requestTransition(request: TransitionRequest): Promise<TransitionResult> {
      if (await settingIsOn("kill_switch")) {
        return { outcome: "refused", reason: "kill_switch", guardReport: [] };
      }
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const result = await attemptTransition(request);
        if (!(result instanceof LostRace)) return result;
      }
      return { outcome: "refused", reason: "too_much_contention", guardReport: [] };
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
