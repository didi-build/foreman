// Seam: unit, on the in-memory store. Dispatch admission, run budgets, the model route recorded at
// admission, run ends and the usage-exhausted wait (ADR 0106 sections 6 and 7, ADR 0114 sections 2
// and 5, build plan M3.2). The same rules under real concurrency on Postgres are in
// test/db/runs.test.ts; the route choice itself is in routing.test.ts.
import { describe, expect, it } from "vitest";

import { LibraryError } from "./library.ts";
import { createMemoryStore } from "./memory-store.ts";
import { routeInputHash } from "./routing.ts";
import { hashRunToken, RUN_TOKEN_MARGIN_MINUTES } from "./run-tokens.ts";
import {
  FIRST_APPROVED_PROVIDERS,
  FIRST_MODEL_CATALOG,
  FIRST_OUTPUT_TOKEN_NEEDS,
  FIRST_ROUTING_POLICY,
  firstRunPrice,
  seedRoutingSettings,
  TEST_TASK_TYPES,
} from "./routing-testing.ts";
import {
  createRuns,
  plannedRunId,
  REHEARSAL_RUN_LIMITS,
  runCapacityLimits,
  type DispatchRequest,
  type RunReport,
} from "./runs.ts";
import type {
  AgentRole,
  DecisionPointRecord,
  Json,
  Node,
  Store,
  StoreOps,
} from "./store.ts";

const PROJECT = "30000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "30000000-0000-4000-8000-000000000002";
const HEAD = "b".repeat(40);
const NEWER = "c".repeat(40);
const START = Date.UTC(2026, 9, 30, 9, 0, 0);

let tokenCount = 0;
/** A fresh token hash for each dispatch. The token itself is generated here and never kept. */
const credential = () => ({ tokenHash: hashRunToken(`test-token-${++tokenCount}`) });

/**
 * A memory store that also keeps every decision-point record a committed transaction wrote. The
 * store has no read for them, since only the daily jobs read them.
 */
function recordingStore(): { store: Store; records: DecisionPointRecord[] } {
  const base = createMemoryStore();
  const records: DecisionPointRecord[] = [];
  const store: Store = {
    ...base,
    async transaction(work) {
      const staged: DecisionPointRecord[] = [];
      const result = await base.transaction((tx) =>
        work({
          ...tx,
          async insertDecisionPointRecord(record) {
            await tx.insertDecisionPointRecord(record);
            staged.push(record);
          },
        } satisfies StoreOps),
      );
      records.push(...staged);
      return result;
    },
  };
  return { store, records };
}

async function setup(clusterLimit: number | null = 10) {
  const { store, records } = recordingStore();
  let now = START;
  const clock = { now: () => new Date(now) };
  let counter = 100;
  const nextId = () => `30000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const runs = createRuns({
    store,
    clock,
    ids: { next: nextId },
    limits: REHEARSAL_RUN_LIMITS,
    taskTypes: TEST_TASK_TYPES,
  });

  for (const [id, slug] of [
    [PROJECT, "rehearsal"],
    [OTHER_PROJECT, "other"],
  ] as const) {
    await store.insertProject({
      id,
      slug,
      name: slug,
      repo: `didi-build/${slug}`,
      linearProjectId: null,
      galleryPathOverride: null,
      privilegedPathsExtra: [],
      prodRequiresApproval: false,
      stagingUrl: null,
      createdAt: clock.now(),
    });
  }
  const setting = (key: string, value: Json) =>
    store.setSetting({ key, value, updatedBy: "test", updatedAt: clock.now() });
  if (clusterLimit !== null)
    await setting("agent_cluster_max_active_runs", clusterLimit);
  await setting("usage_exhausted_wait_minutes", 30);
  await seedRoutingSettings(store, clock.now());

  async function item(projectId = PROJECT): Promise<string> {
    const at = clock.now();
    const node: Node = {
      id: nextId(),
      projectId,
      type: "work_item",
      track: "code",
      state: "in_development",
      substate: null,
      ownerRole: "developer",
      title: "Item",
      body: {},
      hold: false,
      agentReady: true,
      stale: false,
      blockedReason: null,
      stateSince: at,
      linearIssueId: null,
      linearStatusSynced: null,
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    await store.insertNode(node);
    return node.id;
  }

  const request = (
    nodeId: string,
    role: AgentRole = "developer",
    extra: Partial<DispatchRequest> = {},
  ): DispatchRequest => ({
    nodeId,
    role,
    runtime: "claude_code",
    botVersion: "v1",
    ...(role === "qa" ? { prNumber: 7, headSha: HEAD } : {}),
    ...extra,
  });

  /** Dispatches and returns the new run's id, failing the test if it was refused. */
  async function started(req: DispatchRequest): Promise<string> {
    const result = await runs.dispatch(req, credential());
    if (!result.admitted) throw new Error(`refused: ${result.reason}`);
    return result.run.id;
  }

  const report = (extra: Partial<RunReport> = {}): RunReport => ({
    outcome: "success",
    turns: 12,
    minutes: 4.5,
    tokens: {
      uncachedInput: 1200,
      cachedInput: 48000,
      cacheWriteInput: 3000,
      output: 900,
    },
    ...extra,
  });

  const advanceMinutes = (minutes: number) => {
    now += minutes * 60_000;
  };

  return {
    store,
    records,
    runs,
    item,
    request,
    started,
    report,
    setting,
    advanceMinutes,
  };
}

describe("dispatch admission (ADR 0106 section 7)", () => {
  it("admits a dispatch and records the role's rehearsal limits in the run's budget (D-185)", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const result = await t.runs.dispatch(t.request(nodeId), credential());
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    const saved = await t.store.getRun(result.run.id);
    expect(saved).toMatchObject({
      projectId: PROJECT,
      nodeId,
      bot: "developer",
      endedAt: null,
      budget: { maxTurns: 100, maxMinutes: 50, maxUsd: 5 },
    });
  });

  it.each([
    ["developer", { maxTurns: 100, maxMinutes: 50, maxUsd: 5 }],
    ["designer", { maxTurns: 100, maxMinutes: 50, maxUsd: 5 }],
    ["qa", { maxTurns: 50, maxMinutes: 20, maxUsd: 2 }],
    ["council", { maxTurns: 40, maxMinutes: 20, maxUsd: 3 }],
    ["triage", { maxTurns: 40, maxMinutes: 20, maxUsd: 3 }],
  ] as const)("records the %s budget", async (role, budget) => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item(), role));
    expect((await t.store.getRun(runId))?.budget).toEqual(budget);
  });

  it("records the limits the caller passes, not a copy of its own", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const limits = {
      ...REHEARSAL_RUN_LIMITS,
      developer: { maxTurns: 7, maxMinutes: 8, maxUsd: 9 },
    };
    const runs = createRuns({
      store: t.store,
      clock: { now: () => new Date(START) },
      ids: { next: () => "30000000-0000-4000-8000-000000000999" },
      limits,
      taskTypes: TEST_TASK_TYPES,
    });
    const result = await runs.dispatch(t.request(nodeId), credential());
    expect(result.admitted && result.run.budget).toEqual({
      maxTurns: 7,
      maxMinutes: 8,
      maxUsd: 9,
    });
  });

  it("allows one active run per item, and another once that run has ended", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const first = await t.started(t.request(nodeId));
    expect(await t.runs.dispatch(t.request(nodeId, "designer"), credential())).toEqual({
      admitted: false,
      reason: "item_has_active_run",
    });
    expect(await t.runs.recordEnd(first, t.report())).toBe(true);
    expect((await t.runs.dispatch(t.request(nodeId), credential())).admitted).toBe(
      true,
    );
  });

  it("allows at most 3 active Developer runs per project", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) await t.started(t.request(await t.item()));
    const before = (await t.store.listActiveRuns()).length;
    expect(await t.runs.dispatch(t.request(await t.item()), credential())).toEqual({
      admitted: false,
      reason: "developer_limit",
    });
    expect((await t.store.listActiveRuns()).length).toBe(before);
    // Other roles and other projects are not held back by it.
    await t.started(t.request(await t.item(), "designer"));
    await t.started(t.request(await t.item(OTHER_PROJECT)));
  });

  it("refuses a duplicate QA event for the same pull request and head commit", async () => {
    const t = await setup();
    const nodeId = await t.item();
    await t.started(t.request(nodeId, "qa"));
    expect(await t.runs.dispatch(t.request(nodeId, "qa"), credential())).toEqual({
      admitted: false,
      reason: "qa_duplicate",
    });
  });

  it("names the older QA run to cancel when the pull request has a newer head commit", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const older = await t.started(t.request(nodeId, "qa"));
    const newer = t.request(nodeId, "qa", { headSha: NEWER });
    expect(await t.runs.dispatch(newer, credential())).toEqual({
      admitted: false,
      reason: "qa_newer_head",
      cancelRunIds: [older],
    });
    // Nothing was cancelled or written: the runner cancels, records the end, then dispatches.
    expect((await t.store.getRun(older))?.endedAt).toBeNull();
    expect(await t.store.listRuns({ nodeId })).toHaveLength(1);
    await t.runs.recordEnd(older, t.report({ outcome: "cancelled" }));
    const result = await t.runs.dispatch(newer, credential());
    expect(result.admitted && result.run.headSha).toBe(NEWER);
  });

  it("keeps QA runs for different pull requests apart", async () => {
    const t = await setup();
    await t.started(t.request(await t.item(), "qa"));
    await t.started(t.request(await t.item(), "qa", { prNumber: 8 }));
  });

  it("refuses a QA dispatch without its pull request and head commit", async () => {
    const t = await setup();
    const nodeId = await t.item();
    await expect(
      t.runs.dispatch(t.request(nodeId, "qa", { prNumber: null }), credential()),
    ).rejects.toThrow(LibraryError);
    await expect(
      t.runs.dispatch(t.request(nodeId, "qa", { headSha: null }), credential()),
    ).rejects.toThrow(LibraryError);
  });

  it("allows at most agent_cluster_max_active_runs active runs across all projects", async () => {
    const t = await setup(2);
    await t.started(t.request(await t.item()));
    await t.started(t.request(await t.item(OTHER_PROJECT), "triage"));
    expect(
      await t.runs.dispatch(t.request(await t.item(), "council"), credential()),
    ).toEqual({
      admitted: false,
      reason: "cluster_full",
    });
  });

  it("refuses every dispatch while the cluster limit is not set", async () => {
    const t = await setup(null);
    expect(await t.runs.dispatch(t.request(await t.item()), credential())).toEqual({
      admitted: false,
      reason: "cluster_limit_unset",
    });
  });

  it("refuses every dispatch while the kill switch is on", async () => {
    const t = await setup();
    await t.setting("kill_switch", true);
    expect(await t.runs.dispatch(t.request(await t.item()), credential())).toEqual({
      admitted: false,
      reason: "kill_switch",
    });
  });
});

describe("the run's state API token (ADR 0102, ADR 0106 section 5)", () => {
  it("stores only the token's hash, linked to the run, its role and project, with its expiry", async () => {
    const t = await setup();
    const token = `generated-${"x".repeat(40)}`;
    const result = await t.runs.dispatch(t.request(await t.item(), "qa"), {
      tokenHash: hashRunToken(token),
    });
    if (!result.admitted) throw new Error(result.reason);
    const stored = await t.store.getRunToken(hashRunToken(token));
    // The QA limit is 20 minutes; the token lives 20 minutes plus the margin.
    expect(stored).toEqual({
      tokenHash: hashRunToken(token),
      runId: result.run.id,
      role: "qa",
      projectId: PROJECT,
      expiresAt: new Date(START + (20 + RUN_TOKEN_MARGIN_MINUTES) * 60_000),
      revokedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("refuses a value that is not a SHA-256 hash, before anything is written", async () => {
    const t = await setup();
    const nodeId = await t.item();
    await expect(
      t.runs.dispatch(t.request(nodeId), { tokenHash: "not-a-hash" }),
    ).rejects.toThrow(new LibraryError("tokenHash must be a hex SHA-256"));
    expect(await t.store.listRuns({ nodeId })).toEqual([]);
  });

  it("stores no token for a refused dispatch", async () => {
    const t = await setup();
    await t.setting("kill_switch", true);
    const tokenHash = hashRunToken("refused-token-value-that-is-long-enough");
    expect(
      (await t.runs.dispatch(t.request(await t.item()), { tokenHash })).admitted,
    ).toBe(false);
    expect(await t.store.getRunToken(tokenHash)).toBeNull();
  });

  it("revokes the token when the run ends, and only once", async () => {
    const t = await setup();
    const { tokenHash } = credential();
    const result = await t.runs.dispatch(t.request(await t.item()), { tokenHash });
    if (!result.admitted) throw new Error(result.reason);
    t.advanceMinutes(5);
    expect(await t.runs.recordRunnerEnd(result.run.id, "cancelled")).toBe(true);
    const revokedAt = (await t.store.getRunToken(tokenHash))?.revokedAt;
    expect(revokedAt).toEqual(new Date(START + 5 * 60_000));
    expect(await t.store.getRun(result.run.id)).toMatchObject({
      outcome: "cancelled",
      turns: null,
      costUsd: null,
    });
    t.advanceMinutes(5);
    expect(await t.runs.recordEnd(result.run.id, t.report())).toBe(false);
    expect((await t.store.getRunToken(tokenHash))?.revokedAt).toEqual(revokedAt);
  });
});

describe("dry-run dispatch evaluation (build plan M2.4)", () => {
  it("applies the same admission rules as dispatch and inserts no run", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const plan = await t.runs.planDispatch(t.request(nodeId));
    expect(plan.admitted).toBe(true);
    if (!plan.admitted) return;
    expect(plan.run).toMatchObject({
      id: plannedRunId(nodeId, "developer"),
      nodeId,
      bot: "developer",
      budget: { maxTurns: 100, maxMinutes: 50, maxUsd: 5 },
    });
    expect(await t.store.listActiveRuns()).toEqual([]);
    expect(await t.store.getRun(plan.run.id)).toBeNull();
  });

  it("counts the runs already planned in the pass toward the Developer limit", async () => {
    const t = await setup();
    await t.started(t.request(await t.item()));
    const planned = [];
    for (let i = 0; i < 2; i++) {
      const plan = await t.runs.planDispatch(t.request(await t.item()), planned);
      if (!plan.admitted) throw new Error(plan.reason);
      planned.push(plan.run);
    }
    expect(await t.runs.planDispatch(t.request(await t.item()), planned)).toEqual({
      admitted: false,
      reason: "developer_limit",
    });
    expect(await t.store.listActiveRuns()).toHaveLength(1);
  });

  it("refuses while the kill switch is on or the usage-exhausted wait runs", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const runId = await t.started(t.request(nodeId));
    await t.runs.recordEnd(
      runId,
      t.report({ outcome: "usage_exhausted", usageExhaustedCause: "capacity" }),
    );
    expect(await t.runs.planDispatch(t.request(nodeId))).toEqual({
      admitted: false,
      reason: "usage_exhausted_wait",
    });
    await t.setting("kill_switch", true);
    expect(await t.runs.planDispatch(t.request(await t.item()))).toEqual({
      admitted: false,
      reason: "kill_switch",
    });
  });
});

describe("the model route at admission (ADR 0114 sections 2 and 5)", () => {
  it.each([
    ["developer", "developer:code", "claude-sonnet-5-5"],
    ["designer", "designer", "claude-sonnet-5-5"],
    ["qa", "qa:review", "claude-opus-5-5"],
    ["council", "council", "claude-sonnet-5-5"],
    ["triage", "triage", "claude-sonnet-5-5"],
  ] as const)(
    "records the first policy's route on a %s run: today's model (D-185, D-186)",
    async (role, taskType, model) => {
      const t = await setup();
      const runId = await t.started(t.request(await t.item(), role));
      expect(await t.store.getRun(runId)).toMatchObject({
        model,
        taskType,
        provider: "anthropic",
        modelFamily: "claude",
        serviceTierRequested: "standard",
        serviceTierServed: null,
        routingPolicyVersion: FIRST_ROUTING_POLICY.version,
        modelCatalogVersion: FIRST_MODEL_CATALOG.version,
        capacityRetries: null,
        capacityWaitSeconds: null,
        firstTokenMs: null,
        reportedCostUsd: null,
        modelPrice: firstRunPrice(model),
      });
    },
  );

  it("records the route as a decision-point record in the same transaction (P-11)", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const runId = await t.started(t.request(nodeId));
    expect(t.records).toHaveLength(1);
    const [record] = t.records;
    expect(record).toMatchObject({
      projectId: PROJECT,
      nodeId,
      decisionPoint: "model_route",
      deciderId: "model_route_rule_v1",
      confidence: 1,
      recordedAt: new Date(START),
      output: {
        runId,
        taskType: "developer:code",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        family: "claude",
        tier: "standard",
        policyVersion: FIRST_ROUTING_POLICY.version,
        catalogVersion: FIRST_MODEL_CATALOG.version,
      },
    });
    // The hash covers what the rule read: the role, the task type and the settings.
    expect(record?.inputHash).toBe(
      routeInputHash({
        role: "developer",
        taskType: "developer:code",
        earlierRuns: [],
        settings: {
          policy: FIRST_ROUTING_POLICY,
          catalog: FIRST_MODEL_CATALOG,
          providers: FIRST_APPROVED_PROVIDERS,
          outputNeeds: FIRST_OUTPUT_TOKEN_NEEDS,
        },
      }),
    );
  });

  it("refuses with no_route and writes nothing when no candidate passes the hard rules", async () => {
    const t = await setup();
    await t.setting("model_providers_approved", {
      deepinfra: { decision: "D-208", covers: "self_hosted" },
    });
    const nodeId = await t.item();
    const result = await t.runs.dispatch(t.request(nodeId), credential());
    expect(result).toMatchObject({
      admitted: false,
      reason: "no_route",
      noRoute: {
        settingsProblems: [],
        rejected: [
          {
            index: 0,
            provider: "anthropic",
            model: "claude-sonnet-5-5",
            failed: [{ rule: "approved_provider" }],
          },
        ],
      },
    });
    expect(await t.store.listRuns({ nodeId })).toEqual([]);
    expect(t.records).toEqual([]);
  });

  it("refuses with no_route while a routing setting is missing or malformed", async () => {
    const t = await setup();
    await t.setting("model_catalog", { version: "x", models: { m: { provider: 7 } } });
    const nodeId = await t.item();
    const result = await t.runs.dispatch(t.request(nodeId), credential());
    expect(result.admitted).toBe(false);
    if (result.admitted || result.reason !== "no_route")
      throw new Error("expected no_route");
    expect(result.noRoute.settingsProblems).toContain(
      "model_catalog.models.m.provider must be a provider name",
    );
    expect(await t.store.listRuns({ nodeId })).toEqual([]);
    expect(t.records).toEqual([]);
  });

  it("refuses a QA run whose only candidate is a Developer run's model id, and admits another", async () => {
    const t = await setup();
    const nodeId = await t.item();
    // The Developer ran on Sonnet; a policy that puts QA on Sonnet too has no route.
    await t.runs.recordEnd(await t.started(t.request(nodeId)), t.report());
    const sonnetQa = {
      ...FIRST_ROUTING_POLICY,
      taskTypes: {
        ...FIRST_ROUTING_POLICY.taskTypes,
        "qa:review": FIRST_ROUTING_POLICY.taskTypes["developer:code"],
      },
    };
    await t.setting("model_routing_policy", sonnetQa);
    expect(await t.runs.dispatch(t.request(nodeId, "qa"), credential())).toMatchObject({
      admitted: false,
      reason: "no_route",
      noRoute: { rejected: [{ failed: [{ rule: "qa_independence" }] }] },
    });
    await t.setting("model_routing_policy", FIRST_ROUTING_POLICY);
    const result = await t.runs.dispatch(t.request(nodeId, "qa"), credential());
    expect(result.admitted && result.run.model).toBe("claude-opus-5-5");
  });

  it("checks the other admission rules before the route", async () => {
    const t = await setup(null);
    await t.setting("model_routing_policy", null);
    expect(await t.runs.dispatch(t.request(await t.item()), credential())).toEqual({
      admitted: false,
      reason: "cluster_limit_unset",
    });
  });

  it("plans the same route in a dry run and writes no run and no record", async () => {
    const t = await setup();
    const nodeId = await t.item();
    const plan = await t.runs.planDispatch(t.request(nodeId, "qa"));
    expect(plan.admitted && plan.run).toMatchObject({
      id: plannedRunId(nodeId, "qa"),
      model: "claude-opus-5-5",
      taskType: "qa:review",
      provider: "anthropic",
      serviceTierRequested: "standard",
    });
    await t.setting("model_providers_approved", {});
    expect(await t.runs.planDispatch(t.request(nodeId))).toMatchObject({
      admitted: false,
      reason: "no_route",
    });
    expect(await t.store.listRuns({ nodeId })).toEqual([]);
    expect(t.records).toEqual([]);
  });
});

describe("run ends (ADR 0107 outcomes)", () => {
  it("records turns, minutes, cost, cached and uncached tokens and the outcome", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    t.advanceMinutes(5);
    expect(
      await t.runs.recordEnd(runId, t.report({ transcriptRef: "pod-log-1" })),
    ).toBe(true);
    expect(await t.store.getRun(runId)).toMatchObject({
      endedAt: new Date(START + 5 * 60_000),
      outcome: "success",
      turns: 12,
      minutes: 4.5,
      // Worked out by the core at Sonnet 5.5's Standard price: 1200 x 2 + 48000 x 0.2 +
      // 3000 x 2.5 + 900 x 10, per million.
      costUsd: 0.0285,
      tokens: {
        uncachedInput: 1200,
        cachedInput: 48000,
        cacheWriteInput: 3000,
        output: 900,
      },
      transcriptRef: "pod-log-1",
      usageExhaustedCause: null,
      retryAfterSeconds: null,
    });
  });

  it.each(["success", "fail", "timeout", "cancelled", "budget_exceeded"] as const)(
    "records the %s outcome",
    async (outcome) => {
      const t = await setup();
      const runId = await t.started(t.request(await t.item()));
      await t.runs.recordEnd(runId, t.report({ outcome }));
      expect((await t.store.getRun(runId))?.outcome).toBe(outcome);
    },
  );

  it("changes nothing when the run has already ended", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    await t.runs.recordEnd(runId, t.report());
    const first = await t.store.getRun(runId);
    t.advanceMinutes(1);
    expect(
      await t.runs.recordEnd(runId, t.report({ outcome: "fail", turns: 99 })),
    ).toBe(false);
    expect(await t.store.getRun(runId)).toEqual(first);
  });

  it("refuses a usage_exhausted end without a cause, and a cause or retry-after on any other", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    for (const bad of [
      t.report({ outcome: "usage_exhausted" }),
      t.report({ usageExhaustedCause: "rate_limit" }),
      t.report({ retryAfterSeconds: 60 }),
      t.report({ turns: -1 }),
      t.report({ minutes: Number.NaN }),
      t.report({ tokens: { uncachedInput: 1.5, cachedInput: 0, output: 0 } }),
    ]) {
      await expect(t.runs.recordEnd(runId, bad)).rejects.toThrow(LibraryError);
    }
    expect((await t.store.getRun(runId))?.endedAt).toBeNull();
  });

  it("does not move the failure counter on a usage_exhausted end (FR-11)", async () => {
    const t = await setup();
    const nodeId = await t.item();
    await t.store.setCounter(nodeId, "failure", 2, new Date(START));
    const runId = await t.started(t.request(nodeId));
    await t.runs.recordEnd(
      runId,
      t.report({ outcome: "usage_exhausted", usageExhaustedCause: "rate_limit" }),
    );
    expect(await t.store.getCounter(nodeId, "failure")).toBe(2);
  });
});

describe("usage exhausted queue (ADR 0106 section 6)", () => {
  async function exhausted(extra: Partial<RunReport> = {}) {
    const t = await setup();
    const nodeId = await t.item();
    const runId = await t.started(t.request(nodeId));
    await t.runs.recordEnd(
      runId,
      t.report({
        outcome: "usage_exhausted",
        usageExhaustedCause: "rate_limit",
        ...extra,
      }),
    );
    return { ...t, nodeId, runId };
  }

  it("does not queue a node whose latest run ended any other way", async () => {
    const t = await setup();
    const nodeId = await t.item();
    expect(await t.runs.queuedDispatch(nodeId)).toBeNull();
    await t.runs.recordEnd(
      await t.started(t.request(nodeId)),
      t.report({ outcome: "fail" }),
    );
    expect(await t.runs.queuedDispatch(nodeId)).toBeNull();
  });

  it("holds the dispatch for usage_exhausted_wait_minutes, then lets it go", async () => {
    const t = await exhausted();
    const resumeAt = new Date(START + 30 * 60_000);
    expect(await t.runs.queuedDispatch(t.nodeId)).toEqual({
      runId: t.runId,
      cause: "rate_limit",
      resumeAt,
      ready: false,
      nextCandidate: false,
    });
    t.advanceMinutes(29);
    expect(await t.runs.dispatch(t.request(t.nodeId), credential())).toEqual({
      admitted: false,
      reason: "usage_exhausted_wait",
    });
    t.advanceMinutes(1);
    expect((await t.runs.queuedDispatch(t.nodeId))?.ready).toBe(true);
    expect((await t.runs.dispatch(t.request(t.nodeId), credential())).admitted).toBe(
      true,
    );
    expect(await t.runs.queuedDispatch(t.nodeId)).toBeNull();
  });

  it("waits for the provider's retry-after when it is longer than the setting", async () => {
    const t = await exhausted({ retryAfterSeconds: 45 * 60 });
    t.advanceMinutes(30);
    expect((await t.runs.queuedDispatch(t.nodeId))?.ready).toBe(false);
    t.advanceMinutes(15);
    expect((await t.runs.queuedDispatch(t.nodeId))?.ready).toBe(true);
  });

  it("uses the setting when the provider's retry-after is shorter", async () => {
    const t = await exhausted({ retryAfterSeconds: 60 });
    t.advanceMinutes(10);
    expect((await t.runs.queuedDispatch(t.nodeId))?.ready).toBe(false);
  });

  it("keeps an out-of-credit end apart, so a later milestone can alert Didi", async () => {
    const t = await exhausted({ usageExhaustedCause: "out_of_credit" });
    expect((await t.runs.queuedDispatch(t.nodeId))?.cause).toBe("out_of_credit");
    expect((await t.store.getRun(t.runId))?.usageExhaustedCause).toBe("out_of_credit");
  });

  it("stays queued while the wait setting is missing", async () => {
    const t = await exhausted();
    await t.setting("usage_exhausted_wait_minutes", false);
    t.advanceMinutes(600);
    expect(await t.runs.queuedDispatch(t.nodeId)).toMatchObject({
      resumeAt: null,
      ready: false,
    });
  });
});

describe("onCapacity after a capacity end (ADR 0114 section 5, D-221)", () => {
  const SONNET = "claude-sonnet-5-5";
  const OPUS = "claude-opus-5-5";
  const candidate = (model: string, provider = "anthropic") => ({
    provider,
    model,
    tier: "standard",
  });

  /** A Developer item whose run on the first candidate ended with a capacity end. */
  async function capacityEnded(
    onCapacity: "wait" | "next_candidate",
    candidates: Json[],
    cause: "capacity" | "rate_limit" = "capacity",
  ) {
    const t = await setup();
    await t.setting("model_routing_policy", {
      ...FIRST_ROUTING_POLICY,
      taskTypes: {
        ...FIRST_ROUTING_POLICY.taskTypes,
        "developer:code": { candidates, onCapacity },
      },
    });
    const nodeId = await t.item();
    const runId = await t.started(t.request(nodeId));
    await t.runs.recordEnd(
      runId,
      t.report({ outcome: "usage_exhausted", usageExhaustedCause: cause }),
    );
    return { ...t, nodeId, runId };
  }

  it("takes the next candidate at once with next_candidate, and records why", async () => {
    const t = await capacityEnded("next_candidate", [
      candidate(SONNET),
      candidate(OPUS),
    ]);
    expect(await t.runs.queuedDispatch(t.nodeId)).toMatchObject({
      cause: "capacity",
      ready: true,
      nextCandidate: true,
    });
    const result = await t.runs.dispatch(t.request(t.nodeId), credential());
    if (!result.admitted) throw new Error(result.reason);
    expect(result.run.model).toBe(OPUS);
    const record = t.records.at(-1);
    expect(record?.output).toMatchObject({
      model: OPUS,
      afterCapacity: "next_candidate",
    });
  });

  it("goes on from the candidate that ran, not from the first", async () => {
    const t = await capacityEnded("next_candidate", [
      candidate(SONNET),
      candidate(OPUS),
      candidate("claude-haiku-5-5"),
    ]);
    // The second run, on Opus, also ends with a capacity end: the third candidate is next, but
    // it has no catalog price, so no later candidate passes and the dispatch waits (D-221).
    const second = await t.started(t.request(t.nodeId));
    expect((await t.store.getRun(second))?.model).toBe(OPUS);
    await t.runs.recordEnd(
      second,
      t.report({ outcome: "usage_exhausted", usageExhaustedCause: "capacity" }),
    );
    expect(await t.runs.dispatch(t.request(t.nodeId), credential())).toEqual({
      admitted: false,
      reason: "usage_exhausted_wait",
    });
  });

  it("waits as for wait when no later candidate passes, then takes the first candidate (D-221)", async () => {
    const t = await capacityEnded("next_candidate", [
      candidate(SONNET),
      // Not on the approved list, and not in the catalog: it fails the hard rules.
      candidate("qwen3-coder", "together"),
    ]);
    expect(await t.runs.queuedDispatch(t.nodeId)).toMatchObject({
      ready: false,
      nextCandidate: false,
    });
    t.advanceMinutes(29);
    expect(await t.runs.dispatch(t.request(t.nodeId), credential())).toEqual({
      admitted: false,
      reason: "usage_exhausted_wait",
    });
    t.advanceMinutes(1);
    const result = await t.runs.dispatch(t.request(t.nodeId), credential());
    if (!result.admitted) throw new Error(result.reason);
    expect(result.run.model).toBe(SONNET);
    expect(t.records.at(-1)?.output).toMatchObject({
      model: SONNET,
      afterCapacity: "no_later_candidate",
    });
  });

  it("keeps today's wait with onCapacity wait, even when a later candidate would pass", async () => {
    const t = await capacityEnded("wait", [candidate(SONNET), candidate(OPUS)]);
    expect(await t.runs.dispatch(t.request(t.nodeId), credential())).toEqual({
      admitted: false,
      reason: "usage_exhausted_wait",
    });
    t.advanceMinutes(30);
    const result = await t.runs.dispatch(t.request(t.nodeId), credential());
    if (!result.admitted) throw new Error(result.reason);
    expect(result.run.model).toBe(SONNET);
    expect(t.records.at(-1)?.output).toMatchObject({ afterCapacity: "wait" });
  });

  it("does not take the next candidate after a rate limit, which is not a capacity end", async () => {
    const t = await capacityEnded(
      "next_candidate",
      [candidate(SONNET), candidate(OPUS)],
      "rate_limit",
    );
    expect(await t.runs.dispatch(t.request(t.nodeId), credential())).toEqual({
      admitted: false,
      reason: "usage_exhausted_wait",
    });
    t.advanceMinutes(30);
    const result = await t.runs.dispatch(t.request(t.nodeId), credential());
    expect(result.admitted && result.run.model).toBe(SONNET);
    expect(t.records.at(-1)?.output).not.toHaveProperty("afterCapacity");
  });
});

describe("what the runtime measured about the route (ADR 0114 sections 2, 8 and 9)", () => {
  it("records the served tier, capacity retries and wait, first token time and reported cost", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    await t.runs.recordEnd(
      runId,
      t.report({
        outcome: "usage_exhausted",
        usageExhaustedCause: "capacity",
        serviceTierServed: "flex",
        capacityRetries: 3,
        capacityWaitSeconds: 210,
        firstTokenMs: 850,
        reportedCostUsd: 0.42,
      }),
    );
    expect(await t.store.getRun(runId)).toMatchObject({
      serviceTierServed: "flex",
      capacityRetries: 3,
      capacityWaitSeconds: 210,
      firstTokenMs: 850,
      reportedCostUsd: 0.42,
    });
  });

  it("leaves each one null when the runtime did not report it", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    await t.runs.recordEnd(runId, t.report());
    expect(await t.store.getRun(runId)).toMatchObject({
      serviceTierServed: null,
      capacityRetries: null,
      capacityWaitSeconds: null,
      firstTokenMs: null,
      reportedCostUsd: null,
    });
  });

  it("refuses a bad value, naming the field", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    for (const [bad, field] of [
      [{ capacityRetries: -1 }, "capacityRetries"],
      [{ capacityWaitSeconds: 1.5 }, "capacityWaitSeconds"],
      [{ firstTokenMs: -3 }, "firstTokenMs"],
      [{ reportedCostUsd: Number.NaN }, "reportedCostUsd"],
      [{ serviceTierServed: "batch" as never }, "serviceTierServed"],
    ] as const) {
      await expect(t.runs.recordEnd(runId, t.report(bad))).rejects.toThrow(field);
    }
    expect((await t.store.getRun(runId))?.endedAt).toBeNull();
  });
});

describe("cost_usd from the run's recorded price (ADR 0114 sections 2, 5 and 8, O-25)", () => {
  /** An open model of another family on DeepInfra, for the tests only. Not a real catalog entry. */
  const OPEN_MODEL = "test/qwen-coder";
  const openCatalog = (version: string, standardInput: number): Json => ({
    version,
    models: {
      ...FIRST_MODEL_CATALOG.models,
      [OPEN_MODEL]: {
        provider: "deepinfra",
        family: "qwen",
        tiers: ["standard", "flex"],
        // No cache-write price: DeepInfra lists none (docs/costs.md section 2).
        pricePerMTok: {
          standard: { input: standardInput, cachedInput: 0.1, output: 1 },
          flex: { input: 0.24, cachedInput: 0.08, output: 0.8 },
        },
        maxOutputTokens: 16384,
        resold: false,
        priceSource: "test",
        priceReadOn: "2026-10-31",
      },
    },
  });
  const ONE_MILLION_EACH = {
    uncachedInput: 1_000_000,
    cachedInput: 1_000_000,
    cacheWriteInput: 1_000_000,
    output: 1_000_000,
  };

  /** A Developer run routed to the open model on Flex, ended with one million of each token. */
  async function openRun() {
    const t = await setup();
    await t.setting("model_catalog", openCatalog("test.1", 0.3));
    await t.setting("model_routing_policy", {
      version: "test.1",
      qaIndependence: "model_id",
      taskTypes: {
        "developer:code": {
          candidates: [{ provider: "deepinfra", model: OPEN_MODEL, tier: "flex" }],
          onCapacity: "wait",
        },
      },
    });
    const runId = await t.started(t.request(await t.item()));
    return { t, runId };
  }

  async function costAt(served: RunReport["serviceTierServed"]) {
    const { t, runId } = await openRun();
    await t.runs.recordEnd(
      runId,
      t.report({
        tokens: ONE_MILLION_EACH,
        serviceTierServed: served,
        reportedCostUsd: 9,
      }),
    );
    return t.store.getRun(runId);
  }

  it("records the route's catalog entry on the run at admission", async () => {
    const { t, runId } = await openRun();
    expect((await t.store.getRun(runId))?.modelPrice).toEqual({
      tiers: ["standard", "flex"],
      pricePerMTok: {
        standard: { input: 0.3, cachedInput: 0.1, output: 1 },
        flex: { input: 0.24, cachedInput: 0.08, output: 0.8 },
      },
    });
  });

  it.each([
    // Cache writes at the uncached input rate, since the catalog lists no cache-write price.
    ["flex", 0.24 + 0.08 + 0.24 + 0.8],
    ["standard", 0.3 + 0.1 + 0.3 + 1],
    // Not a tier the provider supports for the model: billed at Standard.
    ["priority", 0.3 + 0.1 + 0.3 + 1],
    // ADR 0114 section 8: a mixed or unknown run is priced at Standard.
    ["mixed", 0.3 + 0.1 + 0.3 + 1],
    [null, 0.3 + 0.1 + 0.3 + 1],
  ] as const)("prices a run served at %s", async (served, expected) => {
    const run = await costAt(served);
    expect(run?.costUsd).toBeCloseTo(expected, 9);
    // The runtime's own figure is kept apart.
    expect(run?.reportedCostUsd).toBe(9);
  });

  it("prices today's Claude routes at the catalog's Standard price, cache writes included", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item(), "qa"));
    await t.runs.recordEnd(
      runId,
      t.report({ tokens: ONE_MILLION_EACH, serviceTierServed: "standard" }),
    );
    // Opus 5.5: 4 + 0.2 + 5 + 20.
    expect((await t.store.getRun(runId))?.costUsd).toBeCloseTo(29.2, 9);
  });

  it("is reproducible: a later catalog change does not change how a recorded run is priced", async () => {
    const { t, runId } = await openRun();
    // The catalog moves on after admission, with a new version and a new Standard price.
    await t.setting("model_catalog", openCatalog("test.2", 3));
    await t.runs.recordEnd(
      runId,
      t.report({ tokens: ONE_MILLION_EACH, serviceTierServed: "standard" }),
    );
    const run = await t.store.getRun(runId);
    expect(run?.modelCatalogVersion).toBe("test.1");
    expect(run?.costUsd).toBeCloseTo(1.7, 9);
    // A run admitted under the new catalog records and pays the new price.
    const later = await t.started(t.request(await t.item()));
    await t.runs.recordEnd(
      later,
      t.report({ tokens: ONE_MILLION_EACH, serviceTierServed: "standard" }),
    );
    expect((await t.store.getRun(later))?.costUsd).toBeCloseTo(3 + 0.1 + 3 + 1, 9);
  });

  it("records no cost without tokens, or for a run with no recorded price", async () => {
    const t = await setup();
    const runId = await t.started(t.request(await t.item()));
    expect(await t.runs.recordRunnerEnd(runId, "cancelled")).toBe(true);
    expect((await t.store.getRun(runId))?.costUsd).toBeNull();

    const nodeId = await t.item();
    const unpriced = await t.started(t.request(nodeId));
    const stored = await t.store.getRun(unpriced);
    if (!stored) throw new Error("no run");
    // A run without a price (none is admitted so; this stands in for a row written by hand).
    const runs = createRuns({
      store: {
        ...t.store,
        transaction: (work) =>
          t.store.transaction((tx) =>
            work({
              ...tx,
              getRun: async (id) =>
                id === unpriced ? { ...stored, modelPrice: null } : tx.getRun(id),
            }),
          ),
      },
      clock: { now: () => new Date(START) },
      ids: { next: () => "unused" },
      limits: REHEARSAL_RUN_LIMITS,
      taskTypes: TEST_TASK_TYPES,
    });
    expect(await runs.recordEnd(unpriced, t.report())).toBe(true);
    expect(await t.store.getRun(unpriced)).toMatchObject({
      outcome: "success",
      costUsd: null,
    });
  });
});

describe("run capacity limits (ADR 0114 section 9, migration 0007)", () => {
  it("reads flex_capacity_retries and max_rejected_model_requests", async () => {
    const t = await setup();
    await t.setting("flex_capacity_retries", 3);
    await t.setting("max_rejected_model_requests", 6);
    expect(await runCapacityLimits(t.store)).toEqual({
      flexCapacityRetries: 3,
      maxRejectedModelRequests: 6,
    });
    await t.setting("flex_capacity_retries", 0);
    expect((await runCapacityLimits(t.store)).flexCapacityRetries).toBe(0);
  });

  it("refuses a missing or bad setting, naming the setting and never its value", async () => {
    const t = await setup();
    await expect(runCapacityLimits(t.store)).rejects.toThrow("flex_capacity_retries");
    await t.setting("flex_capacity_retries", 3);
    await t.setting("max_rejected_model_requests", 0);
    await expect(runCapacityLimits(t.store)).rejects.toThrow(
      /^max_rejected_model_requests must be a whole number above 0$/,
    );
  });
});
