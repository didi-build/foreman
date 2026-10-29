// A small fixture for guard tests: a memory store with one project and one node, and helpers that
// record evidence, runs and decisions at increasing times. Test support only; no guard imports it.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import { createMemoryStore } from "../memory-store.ts";
import type {
  Decision,
  EvidenceKind,
  GateRequest,
  Json,
  Node,
  Run,
  Store,
} from "../store.ts";
import { GUARDS } from "./index.ts";

export const OLD = "a".repeat(40);
export const HEAD = "b".repeat(40);
export const MERGE = "c".repeat(40);
export const PROJECT = "10000000-0000-4000-8000-000000000001";
export const NODE = "10000000-0000-4000-8000-000000000002";

export interface Fixture {
  store: Store;
  /** Runs a guard by its registry name on the node as it is now. */
  check(name: string, nodeId?: string): Promise<GuardCheck>;
  evidence(
    kind: EvidenceKind,
    commitSha: string | null,
    payload: Json,
    extra?: { runId?: string; nodeId?: string },
  ): Promise<string>;
  run(bot: string, model: string, extra?: Partial<Run>): Promise<string>;
  decision(
    kind: Decision["kind"],
    byActor: string,
    scope: Json,
    textVerbatim?: string,
    nodeId?: string,
  ): Promise<string>;
  reverse(decisionId: string): Promise<void>;
  gate(
    topicKey: string,
    kind: GateRequest["kind"],
    owner: GateRequest["owner"],
  ): Promise<string>;
  node(id: string, patch: Partial<Node>): Promise<void>;
  /** Moves the node's `stateSince` forward, as if it just entered a new state. */
  enterState(state: string): Promise<void>;
  setting(key: string, value: Json): Promise<void>;
  counter(kind: "failure" | "qa_round", count: number): Promise<void>;
  /** CI on a commit; the latest one recorded names the head. */
  ci(commitSha: string, conclusion?: string, changedPaths?: string[]): Promise<string>;
}

export async function fixture(nodePatch: Partial<Node> = {}): Promise<Fixture> {
  const store = createMemoryStore();
  let tick = 0;
  let ids = 100;
  const at = (): Date => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++));
  const id = (): string => `20000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

  await store.insertProject({
    id: PROJECT,
    slug: "rehearsal",
    name: "Rehearsal",
    repo: "didi-build/rehearsal",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: ["config/billing/**"],
    prodRequiresApproval: true,
    stagingUrl: null,
    createdAt: at(),
  });
  const start = at();
  await store.insertNode({
    id: NODE,
    projectId: PROJECT,
    type: "work_item",
    track: "code",
    state: "in_qa_review",
    substate: null,
    ownerRole: "qa",
    title: "An item",
    body: {},
    hold: false,
    agentReady: true,
    stale: false,
    blockedReason: null,
    stateSince: start,
    linearIssueId: null,
    linearStatusSynced: null,
    version: 0,
    createdAt: start,
    updatedAt: start,
    ...nodePatch,
  });
  for (const [key, value] of [
    ["failure_threshold", 3],
    ["qa_round_cap", 3],
    ["designer_identity", "designer-bot"],
  ] as const) {
    await store.setSetting({ key, value, updatedBy: "test", updatedAt: at() });
  }

  const f: Fixture = {
    store,
    async check(name, nodeId = NODE) {
      const node = (await store.getNode(nodeId)) as Node;
      const guard = GUARDS[name];
      if (!guard) throw new Error(`no guard ${name}`);
      return guard({ node, store } as GuardContext);
    },
    async evidence(kind, commitSha, payload, extra = {}) {
      const evidenceId = id();
      await store.insertEvidence({
        id: evidenceId,
        nodeId: extra.nodeId ?? NODE,
        runId: extra.runId ?? null,
        kind,
        ref: kind,
        commitSha,
        payload,
        recordedBy: "runner",
        recordedAt: at(),
        supersedesId: null,
      });
      return evidenceId;
    },
    async run(bot, model, extra = {}) {
      const runId = id();
      await store.insertRun({
        id: runId,
        projectId: PROJECT,
        nodeId: NODE,
        bot,
        agentId: null,
        runtime: "claude_code",
        model,
        headSha: HEAD,
        botVersion: "v1",
        startedAt: at(),
        endedAt: null,
        outcome: null,
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: {},
        parentRunId: null,
        transcriptRef: null,
        ...extra,
      });
      return runId;
    },
    async decision(kind, byActor, scope, textVerbatim = "yes", nodeId = NODE) {
      const decisionId = id();
      await store.insertDecision({
        id: decisionId,
        projectId: PROJECT,
        nodeId,
        kind,
        scope,
        textVerbatim,
        byActor,
        recordedAt: at(),
      });
      return decisionId;
    },
    async reverse(decisionId) {
      await store.insertDecisionEvent({
        id: id(),
        decisionId,
        kind: "reversed",
        byDecisionId: null,
        reason: "test",
        recordedBy: "test",
        recordedAt: at(),
      });
    },
    async gate(topicKey, kind, owner) {
      const gateId = id();
      await store.insertGateRequest({
        id: gateId,
        projectId: PROJECT,
        nodeId: NODE,
        topicKey,
        kind,
        owner,
        blocking: true,
        payload: {},
        approvalUrl: null,
        status: "open",
        decisionId: null,
        supersededBy: null,
        createdAt: at(),
        answeredAt: null,
        lastNotifiedAt: null,
      });
      return gateId;
    },
    async node(nodeId, patch) {
      const now = at();
      await store.insertNode({
        id: nodeId,
        projectId: PROJECT,
        type: "work_item",
        track: "code",
        state: "in_development",
        substate: null,
        ownerRole: "developer",
        title: "Another item",
        body: {},
        hold: false,
        agentReady: true,
        stale: false,
        blockedReason: null,
        stateSince: now,
        linearIssueId: null,
        linearStatusSynced: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        ...patch,
      });
    },
    async enterState(state) {
      const node = (await store.getNode(NODE)) as Node;
      const now = at();
      await store.changeNodeState(NODE, node.version, {
        state,
        substate: null,
        ownerRole: node.ownerRole,
        blockedReason: state.startsWith("escalated") ? "test" : null,
        stateSince: now,
        updatedAt: now,
      });
    },
    async setting(key, value) {
      await store.setSetting({ key, value, updatedBy: "test", updatedAt: at() });
    },
    async counter(kind, count) {
      await store.setCounter(NODE, kind, count, at());
    },
    ci(commitSha, conclusion = "success", changedPaths = ["src/app.ts"]) {
      return f.evidence("ci_run", commitSha, { conclusion, pr: 7, changedPaths });
    },
  };
  return f;
}
