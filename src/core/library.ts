// The state library (build plan M1.3, architecture section 2.1). Plain logic over an injected
// store, contracts, guards, clock and id source (D-162). It holds the mechanics only: which moves
// are legal and what each one needs come from the contracts and guard functions (essential 3).
import type {
  Contracts,
  GuardCheck,
  GuardContext,
  GuardRegistry,
  StateContract,
  TransitionContract,
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

/** A transition checked without writing (`checkTransition`). */
export interface TransitionCheck {
  outcome: "allowed" | "noop" | "rejected";
  reason?: string;
  guardReport: GuardCheck[];
  /** The evidence ids the transition row would carry, in the same order. */
  evidenceIds: string[];
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

/** Thrown inside a transaction when the writes that go with a move refuse; it all rolls back. */
class WritesRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Writes that commit with a transition or not at all (`requestTransitionWith`). Returns null when
 * done, or a reason to refuse, which rolls back the transition and these writes together.
 */
export type AlsoWrite = (tx: StoreOps) => Promise<string | null>;

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
  /** Own keys only, so `toString` or `__proto__` is never a state. */
  const stateOf = (name: string): StateContract | undefined =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;

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
    listRuns: (filter) => store.listRuns(filter),
    listOpenGateRequests: (projectId) => store.listOpenGateRequests(projectId),
    listDecisionsForNode: (nodeId) => store.listDecisionsForNode(nodeId),
    getProject: (id) => store.getProject(id),
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

  /**
   * A move with tracks applies only to nodes on one of them. A move without tracks applies to
   * every node, which also covers ideas: their track is null, so only untracked moves match.
   */
  const trackMatches = (move: TransitionContract, node: Node): boolean =>
    !move.tracks || (node.track !== null && move.tracks.includes(node.track));

  /**
   * The state the node was in when it entered the escalation: the `from` of the last applied
   * transition that led from a non-escalated state into an escalated one (ADR 0105 `return`).
   */
  async function resolveReturnState(nodeId: string): Promise<string | null> {
    const history = await store.listTransitions(nodeId);
    for (let i = history.length - 1; i >= 0; i--) {
      const past = history[i] as Transition;
      if (past.mode !== "applied") continue;
      if (stateOf(past.toState)?.escalated && !stateOf(past.fromState)?.escalated) {
        return past.fromState;
      }
    }
    return null;
  }

  /**
   * The contract transition that legalizes this move, if any: an exact match first, then the
   * escalation forms (`from: any` into an escalated state, `to: return` back out, ADR 0105).
   */
  async function findMove(
    node: Node,
    toState: string,
  ): Promise<TransitionContract | undefined> {
    // `any` and `return` are keywords, never states: a request for them is illegal.
    if (!stateOf(toState)) return undefined;
    const candidates = contracts.transitions.filter((move) => trackMatches(move, node));
    const exact = candidates.find(
      (move) =>
        move.from !== "any" &&
        move.to !== "return" &&
        move.from === node.state &&
        move.to === toState,
    );
    if (exact) return exact;
    const fromAny = candidates.find(
      (move) =>
        move.escalation &&
        move.from === "any" &&
        move.to === toState &&
        !stateOf(node.state)?.escalated,
    );
    if (fromAny) return fromAny;
    const toReturn = candidates.find(
      (move) => move.escalation && move.from === node.state && move.to === "return",
    );
    if (toReturn && (await resolveReturnState(node.id)) === toState) return toReturn;
    return undefined;
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

  /**
   * Everything a transition checks before it writes: the node, the legal move, the blocked
   * reason and every guard. Reads only.
   */
  async function checkMove(
    request: TransitionRequest,
  ): Promise<{ node: Node; guardReport: GuardCheck[] } | TransitionResult> {
    const node = await store.getNode(request.nodeId);
    if (!node) throw new LibraryError(`No node ${request.nodeId}`);
    if (node.state === request.toState) return { outcome: "noop", guardReport: [] };

    const move = await findMove(node, request.toState);
    if (!move) {
      return { outcome: "rejected", reason: "illegal_move", guardReport: [] };
    }
    const target = stateOf(request.toState);
    if (target?.requiresBlockedReason && !request.blockedReason) {
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
    return { node, guardReport };
  }

  async function attemptTransition(
    request: TransitionRequest,
    alsoWrite?: AlsoWrite,
  ): Promise<TransitionResult | LostRace> {
    const checked = await checkMove(request);
    if ("outcome" in checked) return checked;
    const { node, guardReport } = checked;
    const blockedReason = request.blockedReason ?? null;

    const dryRun = await dryRunIsOn();
    // Writes that go with the move are acts, and dry run never acts.
    if (alsoWrite && dryRun) {
      return { outcome: "refused", reason: "dry_run", guardReport };
    }
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
        const refusal = alsoWrite ? await alsoWrite(tx) : null;
        if (refusal) throw new WritesRefused(refusal);
      });
    } catch (error) {
      if (error instanceof LostRace) return error;
      if (error instanceof WritesRefused) {
        return { outcome: "refused", reason: error.reason, guardReport };
      }
      throw error;
    }
    return {
      outcome: dryRun ? "planned" : "applied",
      guardReport,
      transitionId: transition.id,
    };
  }

  /**
   * Moves a node if the contracts allow it and every guard passes, writing the transition and
   * the node change in one transaction with the version check (schema invariants 1 and 3).
   * A lost race rolls back and retries from a fresh read.
   */
  async function requestTransition(
    request: TransitionRequest,
    alsoWrite?: AlsoWrite,
  ): Promise<TransitionResult> {
    if (await settingIsOn("kill_switch")) {
      return { outcome: "refused", reason: "kill_switch", guardReport: [] };
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await attemptTransition(request, alsoWrite);
      if (!(result instanceof LostRace)) return result;
    }
    return { outcome: "refused", reason: "too_much_contention", guardReport: [] };
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
      // A work item starts only where its own track has a way forward, not in another track's
      // entry state with no legal move out (escalation's `from: any` does not count).
      const track = input.track;
      if (
        track !== null &&
        !contracts.transitions.some(
          (move) =>
            move.from === input.state && (!move.tracks || move.tracks.includes(track)),
        )
      ) {
        throw new LibraryError(`${input.state} has no move for the ${track} track`);
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
     * What `requestTransition` would decide now, writing nothing: `allowed` with the guard
     * report and the evidence ids the transition row would carry, or the same `noop` or
     * `rejected` result. The kill switch is not read here; `requestTransition` still refuses.
     * The reconcile pass uses it to skip a dry-run row it already wrote (M2.4).
     */
    async checkTransition(request: TransitionRequest): Promise<TransitionCheck> {
      const checked = await checkMove(request);
      if ("outcome" in checked) {
        return {
          outcome: checked.outcome === "noop" ? "noop" : "rejected",
          reason: checked.reason,
          guardReport: checked.guardReport,
          evidenceIds: [],
        };
      }
      return {
        outcome: "allowed",
        guardReport: checked.guardReport,
        evidenceIds: [
          ...(request.evidenceIds ?? []),
          ...checked.guardReport.flatMap((c) => c.evidenceIds),
        ],
      };
    },

    requestTransition: (request: TransitionRequest) => requestTransition(request),

    /**
     * `requestTransition` with more writes in the same transaction: the move, the node change
     * and `alsoWrite` commit together or not at all. The dispatch uses it to record the run's
     * handle and `dispatch_record` with its move (build plan M3.2). These are acts, so in dry run
     * it refuses with `dry_run` and writes nothing; the kill switch refuses as always. A lost race
     * retries the whole of it from a fresh read.
     */
    requestTransitionWith: (request: TransitionRequest, alsoWrite: AlsoWrite) =>
      requestTransition(request, alsoWrite),

    /**
     * `requestTransition` for a trigger that carries its own id, such as an event or a bot
     * report (a flow's trigger, M3.1). If the node already has a transition row, applied or dry
     * run, with this trigger kind, trigger id and target state, nothing is written and that row
     * is returned with `noop` and `duplicate_trigger`. A repeated event or a retried flow run
     * therefore writes one row in either mode (architecture section 2.4). In applied mode a
     * duplicate is also a `noop` without this check, because the node is already in the target
     * state; in dry run the node never moves, so only this check holds it to one row.
     */
    async requestTransitionOnce(request: TransitionRequest): Promise<TransitionResult> {
      if (!request.trigger.ref) {
        throw new LibraryError("A trigger needs its id to be taken only once");
      }
      if (await settingIsOn("kill_switch")) {
        return { outcome: "refused", reason: "kill_switch", guardReport: [] };
      }
      const earlier = (await store.listTransitions(request.nodeId)).find(
        (past) =>
          past.triggerKind === request.trigger.kind &&
          past.triggerRef === request.trigger.ref &&
          past.toState === request.toState,
      );
      if (earlier) {
        return {
          outcome: "noop",
          reason: "duplicate_trigger",
          guardReport: [],
          transitionId: earlier.id,
        };
      }
      return requestTransition(request);
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
