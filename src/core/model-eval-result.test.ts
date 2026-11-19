// Seam: unit, plain functions (ADR 0117, D-430, D-432, O-155, O-156). The runner's check of the
// test job's result, its check against the Job it came from, and the results rows it makes.
// test/model-eval-contract.test.ts holds this check to the image's own. Synthetic data only.
import { describe, expect, it } from "vitest";

import {
  EVAL_RESULT_BOUNDS,
  EvalJobResultError,
  checkResultOfJob,
  readEvalJobResult,
  resultRows,
  type EvalJobResult,
} from "./model-eval-result.ts";

const JOB = "70000000-0000-4000-8000-000000000001";
const tokens = { uncachedInput: 100, cachedInput: 20, cacheWriteInput: 0, output: 30 };

/** A valid result: a correct QA run, a wrong Triage run, an error and a skipped run. */
function validResult(): EvalJobResult {
  return {
    evalResult: 1,
    runId: JOB,
    capUsd: 10,
    spentBeforeUsd: 0,
    runs: [
      {
        caseId: "qa-truncate-pass",
        caseVersion: 1,
        role: "qa",
        model: "deepseek-ai/DeepSeek-V4-Pro-0813",
        provider: "deepinfra",
        tier: "flex",
        outcome: "correct",
        reason: "as_expected",
        turns: 4,
        tokens,
        costUsd: 0.01,
        serviceTierServed: "flex",
        minutes: 1.2,
        facts: { verdict: "pass", findingPaths: [] },
      },
      {
        caseId: "triage-truncate-plan",
        caseVersion: 1,
        role: "triage",
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        tier: "standard",
        outcome: "wrong",
        reason: "wrong_item_count",
        turns: 2,
        tokens,
        costUsd: 0.05,
        serviceTierServed: "standard",
        minutes: 0.5,
        facts: { itemCount: 2 },
      },
      {
        caseId: "council-answer-in-plan",
        caseVersion: 2,
        role: "council",
        model: "deepseek-ai/DeepSeek-V4-Pro-0813",
        provider: "deepinfra",
        tier: "flex",
        outcome: "error",
        reason: "provider_error",
        turns: 1,
        tokens,
        costUsd: 0,
        serviceTierServed: null,
        minutes: 0.1,
        providerError: { status: 503, type: "overloaded_error" },
      },
      {
        caseId: "council-product-decision",
        caseVersion: 1,
        role: "council",
        model: "deepseek-ai/DeepSeek-V4-Pro-0813",
        provider: "deepinfra",
        tier: "flex",
        outcome: "skipped",
        reason: "cap_reached",
        turns: 0,
        tokens: { uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 },
        costUsd: 0,
        serviceTierServed: null,
        minutes: 0,
      },
    ],
    totals: {
      spentUsd: 0.06,
      runs: 3,
      skipped: 1,
      models: [
        {
          model: "deepseek-ai/DeepSeek-V4-Pro-0813",
          provider: "deepinfra",
          runs: 2,
          correct: 1,
          costUsd: 0.01,
        },
        {
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          runs: 1,
          correct: 0,
          costUsd: 0.05,
        },
      ],
    },
  };
}

const entries = [
  {
    model: "deepseek-ai/DeepSeek-V4-Pro-0813",
    provider: "deepinfra",
    tier: "flex" as const,
    roles: ["qa" as const, "triage" as const, "council" as const],
    baseline: false,
  },
  {
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    tier: "standard" as const,
    roles: ["triage" as const, "council" as const],
    baseline: true,
  },
];

/** A copy of the valid result with one change. */
function changed(edit: (r: Record<string, unknown>) => void): unknown {
  const r = structuredClone(validResult()) as unknown as Record<string, unknown>;
  edit(r);
  return r;
}
const run = (r: Record<string, unknown>, i = 0) =>
  (r.runs as Record<string, unknown>[])[i] as Record<string, unknown>;

describe("the runner's check of the test job's result (unit: D-432, O-155)", () => {
  it("takes a valid result as it is", () => {
    expect(readEvalJobResult(validResult())).toEqual(validResult());
  });

  it.each([
    ["no runs field", (r: Record<string, unknown>) => delete r.runs, /has no runs/],
    [
      "an unknown field",
      (r: Record<string, unknown>) => (r.text = "model words"),
      /unknown field/,
    ],
    [
      "another version",
      (r: Record<string, unknown>) => (r.evalResult = 2),
      /evalResult/,
    ],
    [
      "a run id out of its form",
      (r: Record<string, unknown>) => (r.runId = "Run 1"),
      /runId/,
    ],
    ["a cap of 0", (r: Record<string, unknown>) => (r.capUsd = 0), /capUsd/],
    [
      "a reason of another outcome",
      (r: Record<string, unknown>) => (run(r).reason = "wrong_verdict"),
      /reason is not a reason of its outcome/,
    ],
    [
      "an unknown reason",
      (r: Record<string, unknown>) => (run(r).reason = "made_up"),
      /reason is not a reason of its outcome/,
    ],
    [
      "facts on an error",
      (r: Record<string, unknown>) =>
        (run(r, 2).facts = { verdict: "pass", findingPaths: [] }),
      /facts/,
    ],
    [
      "no facts on a usable answer",
      (r: Record<string, unknown>) => delete run(r).facts,
      /facts/,
    ],
    [
      "a finding path that climbs out",
      (r: Record<string, unknown>) =>
        (run(r).facts = { verdict: "fail", findingPaths: ["../secrets"] }),
      /findingPaths\[0\]/,
    ],
    [
      "too many finding paths",
      (r: Record<string, unknown>) =>
        (run(r).facts = {
          verdict: "fail",
          findingPaths: ["a", "b", "c", "d", "e", "f"],
        }),
      /findingPaths/,
    ],
    [
      "a provider error's message",
      (r: Record<string, unknown>) =>
        (run(r, 2).providerError = { status: 503, type: "x", message: "text" }),
      /providerError/,
    ],
    [
      "a provider error on another reason",
      (r: Record<string, unknown>) =>
        (run(r).providerError = { status: 500, type: "x" }),
      /providerError/,
    ],
    [
      "a negative cost",
      (r: Record<string, unknown>) => (run(r).costUsd = -1),
      /costUsd/,
    ],
    [
      "a version 0",
      (r: Record<string, unknown>) => (run(r).caseVersion = 0),
      /caseVersion/,
    ],
    [
      "totals that do not count the runs",
      (r: Record<string, unknown>) =>
        ((r.totals as Record<string, unknown>).skipped = 0),
      /totals do not count the runs/,
    ],
    [
      "more correct than runs",
      (r: Record<string, unknown>) =>
        ((
          (r.totals as Record<string, unknown>).models as Record<string, unknown>[]
        )[1] = {
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          runs: 1,
          correct: 2,
          costUsd: 0,
        }),
      /correct is more than its runs/,
    ],
    [
      "more runs than the bound",
      (r: Record<string, unknown>) =>
        (r.runs = Array.from({ length: EVAL_RESULT_BOUNDS.maxRuns + 1 }, () => run(r))),
      /at most 300/,
    ],
  ])("refuses %s, naming the field", (_label, edit, pattern) => {
    let message = "";
    try {
      readEvalJobResult(changed(edit));
    } catch (error) {
      expect(error).toBeInstanceOf(EvalJobResultError);
      message = (error as Error).message;
    }
    expect(message).toMatch(pattern);
    expect(message).not.toContain("model words");
  });
});

describe("the result against its Job, and its rows (unit: D-430, O-156)", () => {
  const job = { id: JOB, capUsd: 10, spentBeforeUsd: 0 };

  it("takes a result of the Job's own id, cap, spend and plan", () => {
    expect(() => checkResultOfJob(validResult(), job, entries)).not.toThrow();
  });

  it.each([
    [
      "another Job's id",
      { ...job, id: "70000000-0000-4000-8000-000000000002" },
      entries,
      /runId/,
    ],
    ["another cap", { ...job, capUsd: 20 }, entries, /capUsd/],
    ["another spend so far", { ...job, spentBeforeUsd: 1 }, entries, /spentBeforeUsd/],
    [
      "a model not in the plan",
      job,
      entries.slice(0, 1),
      /runs\[1\] is not on a model/,
    ],
    [
      "a role the entry does not cover",
      job,
      [entries[0], { ...entries[1], roles: ["council" as const] }],
      /runs\[1\]/,
    ],
  ])("refuses %s", (_label, ownJob, ownEntries, pattern) => {
    expect(() => checkResultOfJob(validResult(), ownJob, ownEntries)).toThrow(pattern);
  });

  it("makes one row per run in the Job's order, with the baseline flag and no text", () => {
    let n = 0;
    const at = new Date("2026-11-23T07:17:00Z");
    const rows = resultRows(
      { id: JOB },
      validResult(),
      entries,
      { next: () => `id-${++n}` },
      at,
      "runner:weekly-model-test",
    );
    expect(rows.map((r) => [r.seq, r.caseId, r.outcome, r.baseline])).toEqual([
      [1, "qa-truncate-pass", "correct", false],
      [2, "triage-truncate-plan", "wrong", true],
      [3, "council-answer-in-plan", "error", false],
      [4, "council-product-decision", "skipped", false],
    ]);
    expect(rows[0]).toMatchObject({
      id: "id-1",
      jobId: JOB,
      facts: { verdict: "pass", findingPaths: [] },
      providerError: null,
      recordedAt: at,
      recordedBy: "runner:weekly-model-test",
    });
    expect(rows[1]?.facts).toEqual({ itemCount: 2 });
    expect(rows[2]?.providerError).toEqual({ status: 503, type: "overloaded_error" });
    expect(rows[3]?.facts).toBeNull();
  });
});
