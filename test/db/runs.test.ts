// Seam: database integration (docs/test-plan.md, build plan M3.2). Dispatch admission, the model
// route recorded with its decision record (ADR 0114), run ends and the usage-exhausted wait on the
// real Postgres store, as the factory_runner role. The concurrency tests start several dispatches
// at once on separate connections and check that the admission lock lets only the allowed number
// through.
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Clock, IdSource } from "../../src/core/library.ts";
import { ROUTING_SETTINGS } from "../../src/core/routing.ts";
import {
  FIRST_APPROVED_PROVIDERS,
  FIRST_MODEL_CATALOG,
  FIRST_OUTPUT_TOKEN_NEEDS,
  FIRST_ROUTING_POLICY,
  TEST_TASK_TYPES,
} from "../../src/core/routing-testing.ts";
import {
  createRuns,
  REHEARSAL_RUN_LIMITS,
  type DispatchRequest,
  type DispatchResult,
  type Runs,
} from "../../src/core/runs.ts";
import type { AgentRole, Json, Store } from "../../src/core/store.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_runs_test_${process.pid}`;
const HEAD = "d".repeat(40);
const START = Date.UTC(2026, 9, 30, 9, 0, 0);

let now = START;
const clock: Clock = { now: () => new Date(now) };
let counter = 0;
const ids: IdSource = {
  next: () => `40000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
};

const admittedCount = (results: DispatchResult[]): number =>
  results.filter((r) => r.admitted).length;

describe.skipIf(!adminUrl)(
  "runs on Postgres (database integration, build plan M3.2)",
  () => {
    let pool: pg.Pool;
    let store: Store;
    let runs: Runs;

    const setting = (key: string, value: Json) =>
      store.setSetting({ key, value, updatedBy: "test", updatedAt: clock.now() });

    async function project(): Promise<string> {
      const id = ids.next();
      await store.insertProject({
        id,
        slug: `p${counter}`,
        name: "Project",
        repo: "didi-build/rehearsal",
        linearProjectId: null,
        galleryPathOverride: null,
        privilegedPathsExtra: [],
        prodRequiresApproval: false,
        stagingUrl: null,
        createdAt: clock.now(),
      });
      return id;
    }

    async function item(projectId: string): Promise<string> {
      const id = ids.next();
      const at = clock.now();
      await store.insertNode({
        id,
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
      });
      return id;
    }

    const request = (
      nodeId: string,
      role: AgentRole = "developer",
    ): DispatchRequest => ({
      nodeId,
      role,
      runtime: "claude_code",
      botVersion: "v1",
      ...(role === "qa" ? { prNumber: 7, headSha: HEAD } : {}),
    });

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      pool = new pg.Pool({
        connectionString: url,
        max: 10,
        options: "-c role=factory_runner",
      });
      store = createPostgresStore(pool);
      runs = createRuns({
        store,
        clock,
        ids,
        limits: REHEARSAL_RUN_LIMITS,
        taskTypes: TEST_TASK_TYPES,
      });
      await setting("agent_cluster_max_active_runs", 100);
    });

    // The cluster limit counts every active run, so each test leaves none behind.
    afterEach(async () => {
      for (const run of await store.listActiveRuns()) {
        await runs.recordEnd(run.id, {
          outcome: "cancelled",
          turns: null,
          minutes: null,
          costUsd: null,
          tokens: null,
        });
      }
      await setting("agent_cluster_max_active_runs", 100);
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    it("admits exactly one of several simultaneous dispatches for the same item", async () => {
      for (let round = 0; round < 10; round++) {
        // A project per round, so earlier rounds' runs never reach the Developer limit.
        const nodeId = await item(await project());
        const results = await Promise.all(
          Array.from({ length: 6 }, () => runs.dispatch(request(nodeId))),
        );
        expect(admittedCount(results)).toBe(1);
        expect(results.filter((r) => !r.admitted).map((r) => r.reason)).toEqual(
          Array(5).fill("item_has_active_run"),
        );
        expect(await store.listRuns({ nodeId })).toHaveLength(1);
      }
    });

    it("admits only the last Developer slot when several dispatches race for it", async () => {
      for (let round = 0; round < 10; round++) {
        const projectId = await project();
        for (let i = 0; i < 2; i++) {
          expect((await runs.dispatch(request(await item(projectId)))).admitted).toBe(
            true,
          );
        }
        const nodes = await Promise.all(
          Array.from({ length: 6 }, () => item(projectId)),
        );
        const results = await Promise.all(nodes.map((n) => runs.dispatch(request(n))));
        expect(admittedCount(results)).toBe(1);
        const developers = (await store.listActiveRuns()).filter(
          (r) => r.projectId === projectId && r.bot === "developer",
        );
        expect(developers).toHaveLength(3);
      }
    });

    it("admits only the last cluster slot when projects race for it", async () => {
      await setting("agent_cluster_max_active_runs", 1);
      const nodes = await Promise.all(
        Array.from({ length: 4 }, async () => item(await project())),
      );
      const results = await Promise.all(
        nodes.map((n) => runs.dispatch(request(n, "triage"))),
      );
      expect(admittedCount(results)).toBe(1);
      expect(await store.listActiveRuns()).toHaveLength(1);
    });

    it("gives one QA run for duplicate events that arrive together", async () => {
      const nodeId = await item(await project());
      const results = await Promise.all(
        Array.from({ length: 4 }, () => runs.dispatch(request(nodeId, "qa"))),
      );
      expect(admittedCount(results)).toBe(1);
      expect(results.filter((r) => !r.admitted).map((r) => r.reason)).toEqual(
        Array(3).fill("qa_duplicate"),
      );
      const [qa] = await store.listRuns({ nodeId });
      expect(qa).toMatchObject({ prNumber: 7, headSha: HEAD, bot: "qa" });
    });

    it("records a usage_exhausted end with its cause and retry-after, and resumes after the wait", async () => {
      const nodeId = await item(await project());
      const started = await runs.dispatch(request(nodeId));
      if (!started.admitted) throw new Error(started.reason);
      expect(started.run.budget).toEqual({ maxTurns: 100, maxMinutes: 50, maxUsd: 5 });
      expect(
        await runs.recordEnd(started.run.id, {
          outcome: "usage_exhausted",
          usageExhaustedCause: "out_of_credit",
          retryAfterSeconds: 3600,
          turns: 3,
          minutes: 1.25,
          costUsd: 0.07,
          tokens: { uncachedInput: 500, cachedInput: 20000, output: 300 },
        }),
      ).toBe(true);
      expect(await store.getRun(started.run.id)).toMatchObject({
        outcome: "usage_exhausted",
        usageExhaustedCause: "out_of_credit",
        retryAfterSeconds: 3600,
        minutes: 1.25,
        tokens: { uncachedInput: 500, cachedInput: 20000, output: 300 },
      });
      expect(await store.listActiveRuns()).toEqual([]);
      // The seeded wait is 30 minutes; the provider's hour is longer, so it wins.
      now += 59 * 60_000;
      expect(await runs.dispatch(request(nodeId))).toEqual({
        admitted: false,
        reason: "usage_exhausted_wait",
      });
      now += 60_000;
      expect((await runs.dispatch(request(nodeId))).admitted).toBe(true);
    });

    it("seeds the first routing policy, catalog, approved providers and output needs (migration 0005)", async () => {
      const value = async (key: string) => (await store.getSetting(key))?.value;
      expect(await value(ROUTING_SETTINGS.policy)).toEqual(FIRST_ROUTING_POLICY);
      expect(await value(ROUTING_SETTINGS.catalog)).toEqual(FIRST_MODEL_CATALOG);
      expect(await value(ROUTING_SETTINGS.providers)).toEqual(FIRST_APPROVED_PROVIDERS);
      expect(await value(ROUTING_SETTINGS.outputNeeds)).toEqual(
        FIRST_OUTPUT_TOKEN_NEEDS,
      );
    });

    it("records the route on the run and its decision record in the admitting transaction", async () => {
      const nodeId = await item(await project());
      const result = await runs.dispatch(request(nodeId, "qa"));
      if (!result.admitted) throw new Error(result.reason);
      expect(await store.getRun(result.run.id)).toMatchObject({
        model: "claude-opus-5-5",
        taskType: "qa:review",
        provider: "anthropic",
        modelFamily: "claude",
        serviceTierRequested: "standard",
        serviceTierServed: null,
        routingPolicyVersion: "2026-10-31.1",
        modelCatalogVersion: "2026-10-31.1",
        capacityRetries: null,
        reportedCostUsd: null,
      });
      const records = await pool.query(
        `select decider_id, confidence, output, input_hash from factory.decision_point_records
         where node_id = $1 and decision_point = 'model_route'`,
        [nodeId],
      );
      expect(records.rows).toHaveLength(1);
      expect(records.rows[0]).toMatchObject({
        decider_id: "model_route_rule_v1",
        confidence: "1",
        output: { runId: result.run.id, model: "claude-opus-5-5", tier: "standard" },
      });
      expect(records.rows[0].input_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("writes neither the run nor the record when the record cannot be written", async () => {
      const nodeId = await item(await project());
      const first = await runs.dispatch(request(nodeId, "triage"));
      if (!first.admitted) throw new Error(first.reason);
      await runs.recordEnd(first.run.id, {
        outcome: "success",
        turns: 1,
        minutes: 1,
        costUsd: 0,
        tokens: null,
      });
      const existing = await pool.query(
        "select id from factory.decision_point_records where node_id = $1",
        [nodeId],
      );
      // The second dispatch gets a fresh run id, then the existing record's id for its record.
      const runId = ids.next();
      const reused = [runId, existing.rows[0].id as string];
      const clashing = createRuns({
        store,
        clock,
        ids: { next: () => reused.shift() ?? ids.next() },
        limits: REHEARSAL_RUN_LIMITS,
        taskTypes: TEST_TASK_TYPES,
      });
      await expect(clashing.dispatch(request(nodeId, "triage"))).rejects.toThrow();
      expect(await store.getRun(runId)).toBeNull();
      expect(await store.listRuns({ nodeId })).toHaveLength(1);
    });

    it("refuses with no_route and writes nothing when no candidate passes", async () => {
      const nodeId = await item(await project());
      await setting(ROUTING_SETTINGS.providers, { deepinfra: { decision: "D-208" } });
      try {
        expect(await runs.dispatch(request(nodeId))).toMatchObject({
          admitted: false,
          reason: "no_route",
        });
      } finally {
        await setting(ROUTING_SETTINGS.providers, FIRST_APPROVED_PROVIDERS);
      }
      expect(await store.listRuns({ nodeId })).toEqual([]);
      const records = await pool.query(
        "select count(*)::int as n from factory.decision_point_records where node_id = $1",
        [nodeId],
      );
      expect(records.rows[0].n).toBe(0);
    });
  },
);
