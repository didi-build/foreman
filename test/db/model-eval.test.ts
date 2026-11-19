// Seam: database integration (docs/test-plan.md, D-430, O-156). The weekly model test's records
// on the real Postgres store as the factory_runner role (migration 0027): a Job recorded, listed
// by week and while open, ended once; its results stored and listed in the Job's order with
// numbers as numbers and the week as a plain date whatever the session's time zone; one open Job
// at a time; and the weekly flow's pass over two days on this store with a fake Job port, its rows
// and end written in one transaction.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { weeklyModelTest } from "../../flows/lib/model-eval.ts";
import { SEEDED_MODEL_EVAL } from "../../src/core/routing-testing.ts";
import {
  StoreConflictError,
  type ModelEvalJob,
  type ModelEvalResult,
  type Store,
} from "../../src/core/store.ts";
import { flowDepsFor } from "../flows/flow-fixture.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_model_eval_test_${process.pid}`;
const ID = (n: number) => `8e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const job = (
  id: string,
  week: string,
  overrides: Partial<ModelEvalJob> = {},
): ModelEvalJob => ({
  id,
  weekStart: week,
  startedAt: new Date(`${week}T07:17:00Z`),
  deadlineAt: new Date(`${week}T20:00:00Z`),
  baseline: false,
  capUsd: 10,
  spentBeforeUsd: 0,
  plan: [
    { model: "m", provider: "deepinfra", tier: "flex", roles: ["qa"], baseline: false },
  ],
  recordedBy: "runner:weekly-model-test",
  end: null,
  ...overrides,
});

const result = (
  jobId: string,
  seq: number,
  overrides: Partial<ModelEvalResult> = {},
): ModelEvalResult => ({
  id: ID(500 + seq + (jobId === ID(2) ? 50 : 0)),
  jobId,
  seq,
  caseId: "qa-truncate-pass",
  caseVersion: 1,
  role: "qa",
  model: "deepseek-ai/DeepSeek-V4-Pro-0813",
  provider: "deepinfra",
  tier: "flex",
  baseline: false,
  outcome: "correct",
  reason: "as_expected",
  turns: 4,
  tokens: { uncachedInput: 10, cachedInput: 2, cacheWriteInput: 0, output: 5 },
  costUsd: 0.0123,
  serviceTierServed: "flex",
  minutes: 1.25,
  providerError: null,
  facts: { verdict: "pass", findingPaths: ["src/truncate.ts"] },
  recordedBy: "runner:weekly-model-test",
  recordedAt: new Date("2026-11-23T07:17:00Z"),
  ...overrides,
});

describe.skipIf(!adminUrl)(
  "the weekly model test's records on Postgres (database integration, O-156)",
  () => {
    let url: string;
    let pool: pg.Pool;
    let store: Store;

    beforeAll(async () => {
      url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      pool = new pg.Pool({
        connectionString: url,
        max: 4,
        // A time zone far from UTC: a week read as a Date would shift a day.
        options: "-c role=factory_runner -c timezone=Pacific/Kiritimati",
      });
      store = createPostgresStore(pool);
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    it("records a Job, lists it by week and while open, ends it once, and keeps one open Job at a time", async () => {
      await store.insertModelEvalJob(job(ID(1), "2026-11-15"));
      await expect(
        store.insertModelEvalJob(job(ID(9), "2026-11-15")),
      ).rejects.toBeInstanceOf(StoreConflictError);
      expect(await store.listModelEvalJobs({ sinceWeek: "2026-11-22" })).toEqual([]);
      expect(
        await store.listModelEvalJobs({ sinceWeek: "2026-11-22", open: true }),
      ).toEqual([job(ID(1), "2026-11-15")]);
      const end = {
        endedAt: new Date("2026-11-16T07:17:00Z"),
        outcome: "finished" as const,
        reason: null,
        detail: null,
        spentUsd: 0.0246,
      };
      expect(await store.endModelEvalJob(ID(1), end)).toBe(true);
      expect(await store.endModelEvalJob(ID(1), { ...end, spentUsd: 9 })).toBe(false);
      const [read] = await store.listModelEvalJobs({ sinceWeek: "2026-11-15" });
      expect(read).toEqual({ ...job(ID(1), "2026-11-15"), end });
      expect(read?.weekStart).toBe("2026-11-15");
      // Another may start once the first has ended.
      await store.insertModelEvalJob(job(ID(2), "2026-11-22"));
    });

    it("stores results and lists them in the Jobs' order, then by place, with numbers as numbers", async () => {
      await store.insertModelEvalResult(
        result(ID(2), 2, {
          outcome: "skipped",
          reason: "cap_reached",
          facts: null,
          costUsd: 0,
        }),
      );
      await store.insertModelEvalResult(result(ID(1), 1));
      await store.insertModelEvalResult(
        result(ID(2), 1, {
          outcome: "error",
          reason: "provider_error",
          facts: null,
          providerError: { status: 429, type: "rate_limit" },
        }),
      );
      await expect(
        store.insertModelEvalResult(result(ID(1), 1, { id: ID(999) })),
      ).rejects.toBeInstanceOf(StoreConflictError);
      const rows = await store.listModelEvalResults([ID(2), ID(1)]);
      expect(rows.map((r) => [r.jobId, r.seq, r.outcome])).toEqual([
        [ID(2), 1, "error"],
        [ID(2), 2, "skipped"],
        [ID(1), 1, "correct"],
      ]);
      expect(rows[2]).toEqual(result(ID(1), 1));
      expect(typeof rows[2]?.costUsd).toBe("number");
      expect(await store.listModelEvalResults([])).toEqual([]);
    });

    it("runs the weekly pass on this store: a Job recorded, then its rows and end written together", async () => {
      // A fresh fixture's own project and settings on the same store.
      const t = await createReconcileFixture({
        store,
        idPrefix: "8e100000-0000-4000-8000",
        slug: "eval-pass",
      });
      await t.setting("dry_run", false);
      await t.setting("model_eval", SEEDED_MODEL_EVAL);
      const { deps, modelEval } = flowDepsFor(t.deps);
      // The Job of ID(2) is still open from the test above: end it so the week can start.
      await store.endModelEvalJob(ID(2), {
        endedAt: new Date("2026-11-23T07:17:00Z"),
        outcome: "failed",
        reason: "job_gone",
        detail: null,
        spentUsd: null,
      });
      const first = await weeklyModelTest(deps);
      expect(first.started).toMatchObject({ weekStart: "2026-10-25", baseline: true });
      const jobId = first.started?.jobId as string;
      const spec = modelEval.started[0]?.spec;
      if (!spec) throw new Error("not started");
      const runs = spec.entries.map((e, i) => ({
        caseId: "qa-truncate-pass",
        caseVersion: 1,
        role: (e.roles.includes("qa") ? "qa" : "triage") as "qa" | "triage",
        model: e.model,
        provider: e.provider,
        tier: e.tier,
        outcome: "wrong" as const,
        reason: e.roles.includes("qa") ? "wrong_verdict" : "wrong_item_count",
        turns: i,
        tokens: { uncachedInput: 1, cachedInput: 0, cacheWriteInput: 0, output: 1 },
        costUsd: 0.001,
        serviceTierServed: e.tier,
        minutes: 0.5,
        facts: e.roles.includes("qa")
          ? { verdict: "fail" as const, findingPaths: ["README.md"] }
          : { itemCount: 2 },
      }));
      modelEval.collects.set(jobId, {
        state: "finished",
        result: {
          evalResult: 1,
          runId: jobId,
          capUsd: 10,
          spentBeforeUsd: 0,
          runs,
          totals: {
            spentUsd: 0.005,
            runs: 5,
            skipped: 0,
            models: runs.map((r) => ({
              model: r.model,
              provider: r.provider,
              runs: 1,
              correct: 0,
              costUsd: 0.001,
            })),
          },
        },
      });
      t.advanceMinutes(60);
      const next = await weeklyModelTest(deps);
      expect(next.collected).toMatchObject([
        { jobId, outcome: "finished", runs: 5, removed: true },
      ]);
      const stored = await pool.query(
        "select count(*)::int as n, sum(cost_usd)::text as cost, bool_or(baseline) as baseline from factory.model_eval_results where job_id = $1",
        [jobId],
      );
      expect(stored.rows[0]).toEqual({ n: 5, cost: "0.005", baseline: true });
      const ended = await pool.query(
        "select outcome, spent_usd::text as spent, week_start::text as week from factory.model_eval_jobs where id = $1",
        [jobId],
      );
      expect(ended.rows[0]).toEqual({
        outcome: "finished",
        spent: "0.005",
        week: "2026-10-25",
      });
    });
  },
);
