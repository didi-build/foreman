// Seam: unit, plain functions (ADR 0117, D-428, D-430, O-156). The weekly model test's summary
// for the daily check: per model correct of total and cost, the changes since the week before,
// the 8-week flag, a running Job and a failed one. Synthetic Jobs and results only.
import { describe, expect, it } from "vitest";

import { modelEvalSummary, REPLACE_AFTER_WEEKS } from "./model-eval-summary.ts";
import type { ModelEvalJob, ModelEvalResult } from "./store.ts";

const PRO = "deepseek-ai/DeepSeek-V4-Pro-0813";
const KIMI = "moonshotai/Kimi-K2.6";
const OPUS = "claude-opus-5-5";

/** The Sunday `n` weeks after 2026-09-06, as `YYYY-MM-DD`. */
const sunday = (n: number): string =>
  new Date(Date.UTC(2026, 8, 6 + 7 * n)).toISOString().slice(0, 10);

function job(n: number, overrides: Partial<ModelEvalJob> = {}): ModelEvalJob {
  const startedAt = new Date(`${sunday(n)}T07:17:00Z`);
  return {
    id: `job-${n}`,
    weekStart: sunday(n),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + 3_600_000),
    baseline: false,
    capUsd: 10,
    spentBeforeUsd: 0,
    plan: [],
    recordedBy: "runner",
    end: {
      endedAt: new Date(startedAt.getTime() + 86_400_000),
      outcome: "finished",
      reason: null,
      detail: null,
      spentUsd: 0.3,
    },
    ...overrides,
  };
}

let seq = 0;
function row(
  jobId: string,
  caseId: string,
  model: string,
  outcome: ModelEvalResult["outcome"],
  overrides: Partial<ModelEvalResult> = {},
): ModelEvalResult {
  seq += 1;
  return {
    id: `row-${seq}`,
    jobId,
    seq,
    caseId,
    caseVersion: 1,
    role: "qa",
    model,
    provider: model === OPUS ? "anthropic" : "deepinfra",
    tier: model === OPUS ? "standard" : "flex",
    baseline: model === OPUS,
    outcome,
    reason:
      outcome === "correct"
        ? "as_expected"
        : outcome === "wrong"
          ? "wrong_verdict"
          : outcome === "skipped"
            ? "cap_reached"
            : "max_turns",
    turns: 3,
    tokens: {},
    costUsd: 0.05,
    serviceTierServed: null,
    minutes: 1,
    providerError: null,
    facts: null,
    recordedBy: "runner",
    recordedAt: new Date(0),
    ...overrides,
  };
}

describe("the weekly model test's summary (unit: D-428, D-430, O-156)", () => {
  it("says nothing has run before the first Job", () => {
    expect(modelEvalSummary([], [])).toEqual({
      latest: null,
      previousWeekStart: null,
      newlyWrong: [],
      newlyRight: [],
      replaceCandidates: [],
      running: null,
      failed: null,
    });
  });

  it("gives each model's correct of total and cost for the latest week, with the baseline", () => {
    const j = job(1, { baseline: true, end: { ...job(1).end!, spentUsd: 0.27 } });
    const s = modelEvalSummary(
      [j],
      [
        row(j.id, "qa-a", PRO, "correct"),
        row(j.id, "qa-b", PRO, "wrong"),
        row(j.id, "qa-a", KIMI, "error"),
        row(j.id, "qa-b", KIMI, "skipped", { costUsd: 0 }),
        row(j.id, "qa-a", OPUS, "correct", { costUsd: 0.12 }),
      ],
    );
    expect(s.latest).toEqual({
      weekStart: sunday(1),
      baseline: true,
      capUsd: 10,
      costUsd: 0.27,
      runs: 4,
      skipped: 1,
      models: [
        {
          model: PRO,
          provider: "deepinfra",
          baseline: false,
          correct: 1,
          total: 2,
          costUsd: 0.1,
        },
        {
          model: KIMI,
          provider: "deepinfra",
          baseline: false,
          correct: 0,
          total: 1,
          costUsd: 0.05,
        },
        {
          model: OPUS,
          provider: "anthropic",
          baseline: true,
          correct: 1,
          total: 1,
          costUsd: 0.12,
        },
      ],
    });
    expect(s.previousWeekStart).toBeNull();
  });

  it("names the cases newly wrong and newly right since the week before, at the same version only", () => {
    const before = job(1);
    const now = job(2);
    const s = modelEvalSummary(
      [before, now],
      [
        row(before.id, "qa-a", PRO, "correct"),
        row(before.id, "qa-b", PRO, "wrong"),
        row(before.id, "qa-c", KIMI, "correct"),
        row(before.id, "qa-d", KIMI, "correct"),
        row(now.id, "qa-a", PRO, "wrong"),
        row(now.id, "qa-b", PRO, "correct"),
        row(now.id, "qa-c", KIMI, "correct"),
        // Its case changed version: not compared.
        row(now.id, "qa-d", KIMI, "wrong", { caseVersion: 2 }),
      ],
    );
    expect(s.previousWeekStart).toBe(sunday(1));
    expect(s.newlyWrong).toEqual([
      { caseId: "qa-a", model: PRO, provider: "deepinfra" },
    ]);
    expect(s.newlyRight).toEqual([
      { caseId: "qa-b", model: PRO, provider: "deepinfra" },
    ]);
  });

  it("counts a case's latest started run when a week has two Jobs", () => {
    const first = job(1, { end: { ...job(1).end!, spentUsd: 0.1 } });
    const second = job(1, {
      id: "job-1b",
      startedAt: new Date(`${sunday(1)}T09:00:00Z`),
      end: { ...job(1).end!, spentUsd: 0.2 },
    });
    const s = modelEvalSummary(
      [first, second],
      [
        row(first.id, "qa-a", PRO, "wrong"),
        row(second.id, "qa-a", PRO, "correct"),
        row(second.id, "qa-b", PRO, "skipped"),
      ],
    );
    expect(s.latest?.models).toEqual([
      expect.objectContaining({ model: PRO, correct: 1, total: 1 }),
    ]);
    expect(s.latest?.costUsd).toBe(0.3);
  });

  it("flags a case every tested model got right in each of the last 8 weeks with results (D-428)", () => {
    const jobs = Array.from({ length: REPLACE_AFTER_WEEKS }, (_, i) => job(i + 1));
    const always = jobs.flatMap((j) => [
      row(j.id, "qa-easy", PRO, "correct"),
      row(j.id, "qa-easy", KIMI, "correct"),
    ]);
    // Missed once by one model in the oldest week.
    const once = jobs.flatMap((j, i) => [
      row(j.id, "qa-hard", PRO, "correct"),
      row(j.id, "qa-hard", KIMI, i === 0 ? "wrong" : "correct"),
    ]);
    // Changed version in the third week.
    const edited = jobs.map((j, i) =>
      row(j.id, "qa-new", PRO, "correct", { caseVersion: i < 2 ? 1 : 2 }),
    );
    const s = modelEvalSummary(jobs, [...always, ...once, ...edited]);
    expect(s.replaceCandidates).toEqual(["qa-easy"]);
    // Seven weeks are not enough.
    expect(
      modelEvalSummary(
        jobs.slice(1),
        always.filter((r) => r.jobId !== jobs[0]?.id),
      ).replaceCandidates,
    ).toEqual([]);
  });

  it("says a Job is still running, and a newest Job that failed, after the last finished week", () => {
    const done = job(1);
    const running = job(2, { end: null });
    const s = modelEvalSummary([done, running], [row(done.id, "qa-a", PRO, "correct")]);
    expect(s.running).toEqual({ weekStart: sunday(2), startedAt: running.startedAt });
    expect(s.latest?.weekStart).toBe(sunday(1));
    const lost = job(2, {
      end: {
        endedAt: new Date("2026-09-21T07:17:00Z"),
        outcome: "failed",
        reason: "job_failed",
        detail: "the proxy never answered",
        spentUsd: null,
      },
    });
    expect(modelEvalSummary([done, lost], []).failed).toEqual({
      weekStart: sunday(2),
      startedAt: lost.startedAt,
      reason: "job_failed",
      detail: "the proxy never answered",
    });
    // A failure older than the latest finished week is not shown.
    expect(modelEvalSummary([job(0, { end: lost.end }), done], []).failed).toBeNull();
  });
});
