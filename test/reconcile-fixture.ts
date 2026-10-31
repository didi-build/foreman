// Test support for the reconcile pass (build plan M2.4): the real machine-2 contracts and guards,
// a store with one rehearsal project, a clock the test moves by hand, sequential ids, a fake
// GitHub, and builders for nodes, edges, runs, evidence and gate requests. Fake data only.
import { createFakeGitHub, type FakeGitHub } from "../src/adapters/github/fake.ts";
import { loadContractFiles } from "../src/adapters/contracts-file/load.ts";
import { validateContracts, type Contracts } from "../src/core/contracts.ts";
import { GUARD_NAMES, GUARDS } from "../src/core/guards/index.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import {
  reconcile,
  type BotProfile,
  type ReconcileDeps,
  type ReconcileInput,
} from "../src/core/reconcile.ts";
import {
  seedRoutingSettings,
  TEST_TASK_TYPES,
  testRouteColumns,
} from "../src/core/routing-testing.ts";
import { REHEARSAL_RUN_LIMITS } from "../src/core/runs.ts";
import type {
  AgentRole,
  EvidenceKind,
  GateRequest,
  Json,
  Node,
  Run,
  Store,
  Track,
} from "../src/core/store.ts";

export const REPO = "didi-build/rehearsal";
export const DEVELOPER_APP = "foreman-developer[bot]";
export const RUNNER_APP = "foreman-runner";
export const HEAD = "b".repeat(40);
export const START = Date.UTC(2026, 9, 31, 8, 0, 0);
export const MINUTE = 60_000;

const BOT: BotProfile = { runtime: "claude_code", botVersion: "v1" };
const BOTS: Record<AgentRole, BotProfile> = {
  developer: BOT,
  designer: BOT,
  qa: BOT,
  council: BOT,
  triage: BOT,
};

export function machine2(): Contracts {
  const { contracts, problems } = validateContracts(
    loadContractFiles("e".repeat(40)).raw,
    GUARD_NAMES,
  );
  if (!contracts) throw new Error(problems.join("\n"));
  return contracts;
}

export type ReconcileFixture = Awaited<ReturnType<typeof createReconcileFixture>>;

export async function createReconcileFixture(
  options: {
    store?: Store;
    idPrefix?: string;
    slug?: string;
    /** The project check's answer for `prod_env_protected` (false unless given). */
    prodRequiresApproval?: boolean;
  } = {},
) {
  const store = options.store ?? createMemoryStore();
  const prefix = options.idPrefix ?? "50000000-0000-4000-8000";
  let n = 0;
  const nextId = (): string => `${prefix}-${String(++n).padStart(12, "0")}`;
  let now = START;
  const clock = { now: () => new Date(now) };
  const advanceMinutes = (minutes: number) => {
    now += minutes * MINUTE;
  };
  const github: FakeGitHub = createFakeGitHub({ webhookSecret: "test-only" });
  const contracts = machine2();
  const deps: ReconcileDeps = {
    store,
    contracts,
    guards: GUARDS,
    clock,
    ids: { next: nextId },
    github,
    appLogins: [DEVELOPER_APP],
    runnerAppSlug: RUNNER_APP,
    limits: REHEARSAL_RUN_LIMITS,
    bots: BOTS,
    taskTypes: TEST_TASK_TYPES,
  };

  const projectId = nextId();
  await store.insertProject({
    id: projectId,
    slug: options.slug ?? "rehearsal",
    name: "Rehearsal",
    repo: REPO,
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: options.prodRequiresApproval ?? false,
    stagingUrl: null,
    createdAt: clock.now(),
  });

  const setting = (key: string, value: Json) =>
    store.setSetting({ key, value, updatedBy: "test", updatedAt: clock.now() });
  for (const [key, value] of [
    ["kill_switch", false],
    ["dry_run", true],
    ["reconcile_interval_minutes", 120],
    ["failure_threshold", 3],
    ["qa_round_cap", 3],
    ["usage_exhausted_wait_minutes", 30],
    ["agent_cluster_max_active_runs", 10],
    // Migration 0007, and 0009 for the rejected-request ceiling (D-223).
    ["flex_capacity_retries", 3],
    ["max_rejected_model_requests", 6],
    ["windmill_monthly_execution_limit", 1000],
    ["windmill_alert_percent", 80],
  ] as const) {
    await setting(key, value);
  }
  await seedRoutingSettings(store, clock.now());

  async function node(
    state: string,
    extra: Partial<Node> & { track?: Track } = {},
  ): Promise<Node> {
    const at = clock.now();
    const created: Node = {
      id: nextId(),
      projectId,
      type: "work_item",
      track: "code",
      state,
      substate: null,
      ownerRole: "developer",
      title: `Item in ${state}`,
      body: {},
      hold: false,
      agentReady: true,
      stale: false,
      blockedReason: state === "blocked" ? "waits on another item" : null,
      stateSince: at,
      linearIssueId: null,
      linearStatusSynced: null,
      version: 0,
      createdAt: at,
      updatedAt: at,
      ...extra,
    };
    await store.insertNode(created);
    return created;
  }

  const blocks = (from: string, to: string) =>
    store.insertEdge({
      id: nextId(),
      fromNode: from,
      toNode: to,
      type: "blocks",
      createdAt: clock.now(),
    });

  async function evidence(
    nodeId: string,
    kind: EvidenceKind,
    payload: Json,
    extra: { commitSha?: string | null; runId?: string | null } = {},
  ): Promise<string> {
    const id = nextId();
    await store.insertEvidence({
      id,
      nodeId,
      runId: extra.runId ?? null,
      kind,
      ref: `${kind}/${id}`,
      commitSha: extra.commitSha ?? null,
      payload,
      recordedBy: "runner",
      recordedAt: clock.now(),
      supersedesId: null,
    });
    return id;
  }

  /** A run as the runner records it; `minutesAgo` sets its start. */
  async function run(
    nodeId: string,
    role: AgentRole,
    minutesAgo = 0,
    extra: Partial<Run> = {},
  ): Promise<Run> {
    const created: Run = {
      id: nextId(),
      projectId,
      nodeId,
      bot: role,
      agentId: null,
      runtime: "claude_code",
      model: "claude-sonnet-5-5",
      headSha: null,
      prNumber: null,
      botVersion: "v1",
      startedAt: new Date(now - minutesAgo * MINUTE),
      endedAt: null,
      outcome: null,
      turns: null,
      minutes: null,
      costUsd: null,
      tokens: null,
      budget: { ...REHEARSAL_RUN_LIMITS[role] },
      parentRunId: null,
      transcriptRef: null,
      usageExhaustedCause: null,
      retryAfterSeconds: null,
      ...testRouteColumns(role),
      ...extra,
    };
    await store.insertRun(created);
    return created;
  }

  async function openGate(
    nodeId: string,
    topicKey: string,
    extra: Partial<GateRequest> = {},
  ): Promise<GateRequest> {
    const gate: GateRequest = {
      id: nextId(),
      projectId,
      nodeId,
      topicKey,
      kind: "council_question",
      owner: "council",
      blocking: true,
      payload: {},
      approvalUrl: null,
      status: "open",
      decisionId: null,
      supersededBy: null,
      createdAt: clock.now(),
      answeredAt: null,
      lastNotifiedAt: null,
      ...extra,
    };
    await store.insertGateRequest(gate);
    return gate;
  }

  /** Every transition row in the store, across the given nodes. */
  async function transitions(...nodeIds: string[]) {
    return (await Promise.all(nodeIds.map((id) => store.listTransitions(id)))).flat();
  }

  return {
    store,
    github,
    deps,
    contracts,
    projectId,
    clock,
    advanceMinutes,
    setting,
    node,
    blocks,
    evidence,
    run,
    openGate,
    transitions,
    pass: (input?: ReconcileInput) => reconcile(deps, input),
  };
}
