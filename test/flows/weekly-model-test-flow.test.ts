// Seam: the weekly model test flow f/foreman/weekly_model_test (D-432, D-433, O-156) with a fake
// Job port on the memory store. The plan, the baseline rule and the sizes are tested in
// src/core/model-eval.test.ts and the port in src/adapters/agent-runtime/kubernetes/
// eval-jobs.test.ts; this covers what the flow adds: it refuses with no pinned image or under a
// switch and starts nothing, it reads only the keys the week's plan needs and never shows one,
// it records the Job before starting it, it stores one row per run with the Job's end before it
// removes the Job, it starts once a week, and the daily check shows the week. Synthetic data only;
// no cluster, Windmill or model.
import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { evalKeyReader } from "../../flows/lib/compose.ts";
import { IMAGE_NOT_PINNED } from "../../flows/lib/model-eval.ts";
import { run as weeklyModelTest } from "../../flows/weekly-model-test.ts";
import {
  JOB_FAILURE_TEXT,
  MODEL_EVAL_SETTING,
  NOT_STARTED_TEXT,
} from "../../src/core/model-eval.ts";
import type { EvalJobResult } from "../../src/core/model-eval-result.ts";
import { SEEDED_MODEL_EVAL } from "../../src/core/routing-testing.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const DAY = 24 * 60;

async function fixture() {
  const f = await createFlowFixture();
  await f.setting(MODEL_EVAL_SETTING, SEEDED_MODEL_EVAL);
  await f.live();
  return f;
}

/** A finished Job's result: every planned model once on the first QA case, all correct. */
function resultFor(f: FlowFixture, jobId: string): EvalJobResult {
  const started = f.modelEval.started.find((s) => s.spec.jobId === jobId);
  if (!started) throw new Error("the Job was not started");
  const runs = started.spec.entries
    .filter((e) => e.roles.includes("qa"))
    .map((e) => ({
      caseId: "qa-truncate-pass",
      caseVersion: 1,
      role: "qa" as const,
      model: e.model,
      provider: e.provider,
      tier: e.tier,
      outcome: "correct" as const,
      reason: "as_expected",
      turns: 3,
      tokens: { uncachedInput: 100, cachedInput: 0, cacheWriteInput: 0, output: 20 },
      costUsd: 0.01,
      serviceTierServed: e.tier,
      minutes: 1,
      facts: { verdict: "pass" as const, findingPaths: [] },
    }));
  return {
    evalResult: 1,
    runId: jobId,
    capUsd: started.spec.capUsd,
    spentBeforeUsd: started.spec.spentBeforeUsd,
    runs,
    totals: {
      spentUsd: Math.round(runs.length * 0.01 * 100) / 100,
      runs: runs.length,
      skipped: 0,
      models: runs.map((r) => ({
        model: r.model,
        provider: r.provider,
        runs: 1,
        correct: 1,
        costUsd: 0.01,
      })),
    },
  };
}

const jobsOf = (f: FlowFixture) =>
  f.store.listModelEvalJobs({ sinceWeek: "2026-01-01", open: true });

describe("the weekly model test flow (flow: fake Job port, D-432, D-433, O-156)", () => {
  it("refuses with a fixed reason while the image is not pinned, and starts and reads nothing", async () => {
    const f = await fixture();
    f.modelEval.pinned = false;
    const result = await weeklyModelTest(f.deps);
    expect(result).toEqual({
      collected: [],
      started: null,
      notStarted: IMAGE_NOT_PINNED,
      leftOut: [],
    });
    expect(f.modelEval.started).toEqual([]);
    expect(f.modelEval.keyReads).toEqual([]);
    expect(await jobsOf(f)).toEqual([]);
  });

  it.each([
    ["dry run", async (f: FlowFixture) => f.setting("dry_run", true), "dry run is on"],
    ["the kill switch", async (f: FlowFixture) => f.killed(), "the kill switch is on"],
  ])("starts nothing under %s", async (_label, hold, said) => {
    const f = await fixture();
    await hold(f);
    expect((await weeklyModelTest(f.deps)).notStarted).toBe(said);
    expect(f.modelEval.started).toEqual([]);
    expect(f.modelEval.keyReads).toEqual([]);
  });

  it("starts nothing with a setting it cannot use, and names the field only", async () => {
    const f = await fixture();
    await f.setting(MODEL_EVAL_SETTING, { ...SEEDED_MODEL_EVAL, capUsd: -1 });
    const result = await weeklyModelTest(f.deps);
    expect(result.notStarted).toMatch(/model_eval\.capUsd must be a number above 0/);
    expect(f.modelEval.started).toEqual([]);
  });

  it("records the month's first Job with the baseline, reads both keys and hands them only to the port", async () => {
    const f = await fixture();
    const result = await weeklyModelTest(f.deps);
    const [job] = await jobsOf(f);
    if (!job) throw new Error("no Job recorded");
    expect(result.started).toEqual({
      jobId: job.id,
      weekStart: "2026-10-25",
      baseline: true,
      models: [
        "deepseek-ai/DeepSeek-V4-Pro-0813",
        "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "moonshotai/Kimi-K2.6",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
      ],
      runs: 48,
      capUsd: 10,
      spentBeforeUsd: 0,
    });
    expect(job).toMatchObject({
      baseline: true,
      capUsd: 10,
      spentBeforeUsd: 0,
      end: null,
    });
    expect(f.modelEval.keyReads).toEqual([
      "eval/models/deepinfra",
      "eval/models/anthropic",
    ]);
    const [started] = f.modelEval.started;
    expect(started?.keys).toEqual(Object.fromEntries(f.modelEval.keyValues));
    expect(started?.spec.caseIds).toEqual(f.modelEval.caseList.map((c) => c.id));
    // QA's 30 minutes on 28 runs (D-480), the others' 20 on 20, and the start's 10.
    expect(started?.spec.sizing).toMatchObject({ runs: 48, deadlineMinutes: 1250 });
    // No key in the result, the Job's row or anything the flow returns.
    const shown = JSON.stringify({ result, job });
    for (const key of f.modelEval.keyValues.values()) expect(shown).not.toContain(key);
  });

  it("stores one row per run with the Job's end the next day, then removes the Job and starts nothing more that week", async () => {
    const f = await fixture();
    await weeklyModelTest(f.deps);
    const [job] = await jobsOf(f);
    if (!job) throw new Error("no Job recorded");
    f.advanceMinutes(DAY / 2);
    f.modelEval.collects.set(job.id, {
      state: "finished",
      result: resultFor(f, job.id),
    });
    const next = await weeklyModelTest(f.deps);
    expect(next.collected).toEqual([
      {
        jobId: job.id,
        weekStart: "2026-10-25",
        outcome: "finished",
        runs: 4,
        skipped: 0,
        spentUsd: 0.04,
        removed: true,
      },
    ]);
    expect(next.notStarted).toBe(NOT_STARTED_TEXT.week_done);
    expect(f.modelEval.removed).toEqual([job.id]);
    const rows = await f.store.listModelEvalResults([job.id]);
    expect(rows.map((r) => [r.seq, r.model, r.outcome, r.baseline])).toEqual([
      [1, "deepseek-ai/DeepSeek-V4-Pro-0813", "correct", false],
      [2, "deepseek-ai/DeepSeek-V4.1-Flash-1017", "correct", false],
      [3, "moonshotai/Kimi-K2.6", "correct", false],
      [4, "claude-opus-5-5", "correct", true],
    ]);
    expect((await jobsOf(f))[0]?.end).toMatchObject({
      outcome: "finished",
      spentUsd: 0.04,
    });
    // The daily check shows the week.
    const check = (await dailyCheck(f.deps)).render_all[1].json;
    expect(check.check.modelTest.latest?.weekStart).toBe("2026-10-25");
    expect(check.text).toContain("== Weekly model test ==");
    expect(check.text).toContain(
      "deepseek-ai/DeepSeek-V4-Pro-0813 (deepinfra): 1 of 1 correct",
    );
  });

  it("starts the next week's Job on its first day, without Claude once the month's baseline ran, and reads only the deepinfra key", async () => {
    const f = await fixture();
    // A Job in the new month (Sunday 2026-11-01) that ran the baseline.
    f.advanceMinutes(DAY);
    await weeklyModelTest(f.deps);
    const [first] = await jobsOf(f);
    if (!first) throw new Error("no Job recorded");
    f.modelEval.collects.set(first.id, {
      state: "finished",
      result: resultFor(f, first.id),
    });
    f.advanceMinutes(7 * DAY);
    f.modelEval.keyReads.length = 0;
    const next = await weeklyModelTest(f.deps);
    expect(next.started).toMatchObject({
      weekStart: "2026-11-08",
      baseline: false,
      runs: 36,
    });
    expect(f.modelEval.keyReads).toEqual(["eval/models/deepinfra"]);
  });

  it("ends a failed Job with its reason, and then starts nothing more that week, since its spend is unknown", async () => {
    const f = await fixture();
    await weeklyModelTest(f.deps);
    const [job] = await jobsOf(f);
    if (!job) throw new Error("no Job recorded");
    f.modelEval.collects.set(job.id, {
      state: "failed",
      reason: "job_failed",
      detail: "the egress proxy never answered",
    });
    f.advanceMinutes(60);
    const next = await weeklyModelTest(f.deps);
    expect(next.collected).toMatchObject([
      { outcome: "failed", reason: "job_failed", removed: true },
    ]);
    expect(next.notStarted).toBe(NOT_STARTED_TEXT.spend_unknown);
    expect((await jobsOf(f))[0]?.end).toMatchObject({
      outcome: "failed",
      reason: "job_failed",
      detail: "the egress proxy never answered",
      spentUsd: null,
    });
    const text = (await dailyCheck(f.deps)).render_all[1].json.text;
    expect(text).toContain(
      `The week of 2026-10-25's Job did not finish: ${JOB_FAILURE_TEXT.job_failed}. Its error: "the egress proxy never answered".`,
    );
  });

  it("refuses a result that is not the Job's own, and stores no row", async () => {
    const f = await fixture();
    await weeklyModelTest(f.deps);
    const [job] = await jobsOf(f);
    if (!job) throw new Error("no Job recorded");
    f.modelEval.collects.set(job.id, {
      state: "finished",
      result: { ...resultFor(f, job.id), capUsd: 99 },
    });
    const next = await weeklyModelTest(f.deps);
    expect(next.collected).toMatchObject([{ outcome: "failed", reason: "bad_result" }]);
    expect(await f.store.listModelEvalResults([job.id])).toEqual([]);
  });

  it("ends a Job whose objects the cluster refused as never started, and starts again the next day of the week", async () => {
    const f = await fixture();
    f.modelEval.failNext.add("start");
    const first = await weeklyModelTest(f.deps);
    expect(first.notStarted).toBe(
      `the week's Job did not start: ${JOB_FAILURE_TEXT.start_failed}`,
    );
    expect((await jobsOf(f))[0]?.end).toMatchObject({
      outcome: "failed",
      reason: "start_failed",
      spentUsd: 0,
    });
    // Saturday: the same week (Sunday 2026-10-25 to Saturday 2026-10-31).
    f.advanceMinutes(60);
    const again = await weeklyModelTest(f.deps);
    expect(again.started).toMatchObject({ weekStart: "2026-10-25", spentBeforeUsd: 0 });
  });

  it("leaves a Job open when the cluster cannot be read, and starts nothing while it is", async () => {
    const f = await fixture();
    await weeklyModelTest(f.deps);
    f.modelEval.failNext.add("collect");
    const next = await weeklyModelTest(f.deps);
    expect(next.collected).toMatchObject([{ outcome: "unread" }]);
    expect(next.notStarted).toBe(NOT_STARTED_TEXT.job_running);
    expect((await jobsOf(f))[0]?.end).toBeNull();
  });

  it("stops reading a key at any path but the weekly test's own (D-433)", async () => {
    const read: string[] = [];
    const key = evalKeyReader({
      secret: async (path) => {
        read.push(path);
        return "made-up";
      },
    });
    await expect(key("projects/rehearsal/models/deepinfra")).rejects.toThrow(
      /only its own keys/,
    );
    await expect(key("platform/github/runner-app-private-key")).rejects.toThrow();
    expect(await key("eval/models/deepinfra")).toBe("made-up");
    expect(read).toEqual(["eval/models/deepinfra"]);
  });
});
