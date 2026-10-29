// An in-memory Store with the same uniqueness rules and version check as the factory schema
// (ADR 0104). For unit tests now and the dry run later (M2.5). Every operation, and every
// transaction as a whole, runs one at a time; a transaction works on a copy and commits it only
// if it finishes, so rollback and the version check behave like Postgres.
import {
  StoreConflictError,
  type CounterKind,
  type CurrentDecision,
  type Decision,
  type DecisionEvent,
  type DecisionPointOutcome,
  type DecisionPointRecord,
  type Edge,
  type Evidence,
  type GateRequest,
  type Node,
  type Project,
  type Run,
  type RunToken,
  type Setting,
  type SpecVersion,
  type Store,
  type StoreOps,
  type Transition,
} from "./store.ts";

interface State {
  projects: Map<string, Project>;
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  specVersions: Map<string, SpecVersion>;
  transitions: Map<string, Transition>;
  evidence: Map<string, Evidence>;
  decisions: Map<string, Decision>;
  decisionEvents: Map<string, DecisionEvent>;
  nodeDecisions: Set<string>;
  gateRequests: Map<string, GateRequest>;
  runs: Map<string, Run>;
  runTokens: Map<string, RunToken>;
  counters: Map<string, number>;
  settings: Map<string, Setting>;
  decisionPointRecords: Map<string, DecisionPointRecord>;
  decisionPointOutcomes: Map<string, DecisionPointOutcome>;
}

const emptyState = (): State => ({
  projects: new Map(),
  nodes: new Map(),
  edges: new Map(),
  specVersions: new Map(),
  transitions: new Map(),
  evidence: new Map(),
  decisions: new Map(),
  decisionEvents: new Map(),
  nodeDecisions: new Set(),
  gateRequests: new Map(),
  runs: new Map(),
  runTokens: new Map(),
  counters: new Map(),
  settings: new Map(),
  decisionPointRecords: new Map(),
  decisionPointOutcomes: new Map(),
});

/** Copies on the way in and out, so callers can never change stored rows by reference. */
const copy = <T>(value: T): T => structuredClone(value);

function insertUnique<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  constraint: string,
): void {
  if (map.has(key))
    throw new StoreConflictError(constraint, `Duplicate key (${constraint})`);
  map.set(key, copy(value));
}

const byTimeThenId =
  <T extends { id: string }>(time: (row: T) => Date) =>
  (a: T, b: T): number =>
    time(a).getTime() - time(b).getTime() || a.id.localeCompare(b.id);

function ops(state: State): StoreOps {
  return {
    async insertProject(p) {
      for (const existing of state.projects.values()) {
        if (existing.slug === p.slug)
          throw new StoreConflictError("projects_slug_key", "Duplicate slug");
      }
      insertUnique(state.projects, p.id, p, "projects_pkey");
    },
    async getProject(id) {
      return copy(state.projects.get(id) ?? null);
    },

    async insertNode(n) {
      insertUnique(state.nodes, n.id, n, "nodes_pkey");
    },
    async getNode(id) {
      return copy(state.nodes.get(id) ?? null);
    },
    async getNodeForUpdate(id) {
      return copy(state.nodes.get(id) ?? null);
    },
    async listNodes(filter) {
      return [...state.nodes.values()]
        .filter(
          (n) =>
            (filter.projectId === undefined || n.projectId === filter.projectId) &&
            (filter.state === undefined || n.state === filter.state),
        )
        .sort(byTimeThenId<Node>((n) => n.createdAt))
        .map(copy);
    },
    async changeNodeState(id, expectedVersion, change) {
      const node = state.nodes.get(id);
      if (!node || node.version !== expectedVersion) return false;
      state.nodes.set(id, { ...node, ...copy(change), version: node.version + 1 });
      return true;
    },
    async setNodeFlags(id, flags, updatedAt) {
      const node = state.nodes.get(id);
      if (node) state.nodes.set(id, { ...node, ...flags, updatedAt });
    },

    async insertEdge(e) {
      for (const existing of state.edges.values()) {
        if (
          existing.fromNode === e.fromNode &&
          existing.toNode === e.toNode &&
          existing.type === e.type
        ) {
          throw new StoreConflictError(
            "edges_from_node_to_node_type_key",
            "Duplicate edge",
          );
        }
      }
      insertUnique(state.edges, e.id, e, "edges_pkey");
    },
    async listEdges(filter) {
      return [...state.edges.values()]
        .filter(
          (e) =>
            (filter.fromNode === undefined || e.fromNode === filter.fromNode) &&
            (filter.toNode === undefined || e.toNode === filter.toNode) &&
            (filter.type === undefined || e.type === filter.type),
        )
        .sort(byTimeThenId<Edge>((e) => e.createdAt))
        .map(copy);
    },

    async insertSpecVersion(s) {
      if (!state.specVersions.has(s.version))
        state.specVersions.set(s.version, copy(s));
    },
    async getSpecVersion(version) {
      return copy(state.specVersions.get(version) ?? null);
    },

    async insertTransition(t) {
      insertUnique(state.transitions, t.id, t, "transitions_pkey");
    },
    async listTransitions(nodeId) {
      return [...state.transitions.values()]
        .filter((t) => t.nodeId === nodeId)
        .sort(byTimeThenId<Transition>((t) => t.at))
        .map(copy);
    },

    async insertEvidence(e) {
      if (e.kind === "qa_verdict") {
        for (const existing of state.evidence.values()) {
          if (existing.kind === "qa_verdict" && existing.runId === e.runId) {
            throw new StoreConflictError(
              "evidence_one_verdict_per_run",
              "One QA verdict per run",
            );
          }
        }
      }
      insertUnique(state.evidence, e.id, e, "evidence_pkey");
    },
    async listEvidence(filter) {
      return [...state.evidence.values()]
        .filter(
          (e) =>
            e.nodeId === filter.nodeId &&
            (filter.commitSha === undefined || e.commitSha === filter.commitSha) &&
            (filter.kind === undefined || e.kind === filter.kind),
        )
        .sort(byTimeThenId<Evidence>((e) => e.recordedAt))
        .map(copy);
    },

    async insertDecision(d) {
      insertUnique(state.decisions, d.id, d, "decisions_pkey");
    },
    async insertDecisionEvent(e) {
      for (const existing of state.decisionEvents.values()) {
        if (existing.decisionId === e.decisionId) {
          throw new StoreConflictError(
            "decision_events_decision_id_key",
            "One event per decision",
          );
        }
      }
      insertUnique(state.decisionEvents, e.id, e, "decision_events_pkey");
    },
    async getDecision(id) {
      const decision = state.decisions.get(id);
      if (!decision) return null;
      const event = [...state.decisionEvents.values()].find((e) => e.decisionId === id);
      const current: CurrentDecision = {
        ...copy(decision),
        status: event?.kind ?? "active",
        replacedById: event?.byDecisionId ?? null,
        statusChangedAt: event ? copy(event.recordedAt) : null,
      };
      return current;
    },
    async linkNodeToDecision(nodeId, decisionId) {
      state.nodeDecisions.add(`${nodeId}|${decisionId}`);
    },
    async listDecisionsForNode(nodeId) {
      const linked = new Set(
        [...state.nodeDecisions]
          .map((key) => key.split("|") as [string, string])
          .filter(([n]) => n === nodeId)
          .map(([, d]) => d),
      );
      const ids = [...state.decisions.values()]
        .filter((d) => d.nodeId === nodeId || linked.has(d.id))
        .sort(byTimeThenId<Decision>((d) => d.recordedAt))
        .map((d) => d.id);
      return ids.map((id) => {
        const decision = state.decisions.get(id) as Decision;
        const event = [...state.decisionEvents.values()].find(
          (e) => e.decisionId === id,
        );
        const current: CurrentDecision = {
          ...copy(decision),
          status: event?.kind ?? "active",
          replacedById: event?.byDecisionId ?? null,
          statusChangedAt: event ? copy(event.recordedAt) : null,
        };
        return current;
      });
    },
    async listNodesForDecision(decisionId) {
      return [...state.nodeDecisions]
        .map((key) => key.split("|") as [string, string])
        .filter(([, d]) => d === decisionId)
        .map(([n]) => n)
        .sort();
    },

    async insertGateRequest(g) {
      if (g.status === "open") {
        for (const existing of state.gateRequests.values()) {
          if (
            existing.status === "open" &&
            existing.projectId === g.projectId &&
            existing.topicKey === g.topicKey
          ) {
            throw new StoreConflictError(
              "gate_requests_one_open_per_topic",
              "One open request per topic",
            );
          }
        }
      }
      insertUnique(state.gateRequests, g.id, g, "gate_requests_pkey");
    },
    async getGateRequest(id) {
      return copy(state.gateRequests.get(id) ?? null);
    },
    async findOpenGateRequest(projectId, topicKey) {
      const found = [...state.gateRequests.values()].find(
        (g) =>
          g.status === "open" && g.projectId === projectId && g.topicKey === topicKey,
      );
      return copy(found ?? null);
    },
    async listOpenGateRequests(projectId) {
      return [...state.gateRequests.values()]
        .filter((g) => g.status === "open" && g.projectId === projectId)
        .sort(byTimeThenId<GateRequest>((g) => g.createdAt))
        .map(copy);
    },
    async closeGateRequest(id, close) {
      const request = state.gateRequests.get(id);
      if (!request || request.status !== "open") return false;
      state.gateRequests.set(id, {
        ...request,
        status: close.status,
        decisionId: close.status === "answered" ? close.decisionId : null,
        supersededBy: close.status === "superseded" ? close.supersededBy : null,
        answeredAt: close.status === "answered" ? copy(close.at) : request.answeredAt,
      });
      return true;
    },

    async insertRun(r) {
      insertUnique(state.runs, r.id, r, "runs_pkey");
    },
    async getRun(id) {
      return copy(state.runs.get(id) ?? null);
    },
    async listRuns(filter) {
      return [...state.runs.values()]
        .filter((r) => r.nodeId === filter.nodeId)
        .sort(byTimeThenId<Run>((r) => r.startedAt))
        .map(copy);
    },
    async insertRunToken(t) {
      for (const existing of state.runTokens.values()) {
        if (existing.runId === t.runId)
          throw new StoreConflictError("run_tokens_run_id_key", "One token per run");
      }
      insertUnique(state.runTokens, t.tokenHash, t, "run_tokens_pkey");
    },
    async getRunToken(tokenHash) {
      return copy(state.runTokens.get(tokenHash) ?? null);
    },
    async endRun(id, end) {
      const run = state.runs.get(id);
      if (!run || run.endedAt !== null) return false;
      state.runs.set(id, { ...run, ...copy(end) });
      return true;
    },

    async getCounter(nodeId, kind: CounterKind) {
      return state.counters.get(`${nodeId}|${kind}`) ?? 0;
    },
    async setCounter(nodeId, kind, count) {
      if (count < 0) throw new Error("A counter never goes below 0");
      state.counters.set(`${nodeId}|${kind}`, count);
    },

    async getSetting(key) {
      return copy(state.settings.get(key) ?? null);
    },
    async setSetting(s) {
      state.settings.set(s.key, copy(s));
    },

    async insertDecisionPointRecord(r) {
      insertUnique(state.decisionPointRecords, r.id, r, "decision_point_records_pkey");
    },
    async insertDecisionPointOutcome(o) {
      for (const existing of state.decisionPointOutcomes.values()) {
        if (existing.recordId === o.recordId) {
          throw new StoreConflictError(
            "decision_point_outcomes_record_id_key",
            "One outcome per record",
          );
        }
      }
      insertUnique(
        state.decisionPointOutcomes,
        o.id,
        o,
        "decision_point_outcomes_pkey",
      );
    },
  };
}

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    nodes: new Map(state.nodes),
    edges: new Map(state.edges),
    specVersions: new Map(state.specVersions),
    transitions: new Map(state.transitions),
    evidence: new Map(state.evidence),
    decisions: new Map(state.decisions),
    decisionEvents: new Map(state.decisionEvents),
    nodeDecisions: new Set(state.nodeDecisions),
    gateRequests: new Map(state.gateRequests),
    runs: new Map(state.runs),
    runTokens: new Map(state.runTokens),
    counters: new Map(state.counters),
    settings: new Map(state.settings),
    decisionPointRecords: new Map(state.decisionPointRecords),
    decisionPointOutcomes: new Map(state.decisionPointOutcomes),
  };
}

/** A Store held in memory. Rows are never changed in place, so a shallow map copy is a snapshot. */
export function createMemoryStore(): Store {
  let state = emptyState();
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs one unit of work after every earlier one has finished. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }

  // Each operation outside a transaction is its own serial unit, like an autocommit statement.
  const names = Object.keys(ops(state)) as (keyof StoreOps)[];
  const direct = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) =>
        serial(() =>
          (ops(state)[name] as (...a: unknown[]) => Promise<unknown>)(...args),
        ),
    ]),
  ) as unknown as StoreOps;

  return {
    ...direct,
    transaction<T>(work: (tx: StoreOps) => Promise<T>): Promise<T> {
      return serial(async () => {
        const staged = cloneState(state);
        const result = await work(ops(staged));
        state = staged;
        return result;
      });
    },
  };
}
