import { describe, expect, it } from "vitest";

import { loadCases } from "../../eval/cases.ts";
import { SCORE_CODES } from "../../eval/scoring.ts";
import { resultLine } from "../shared/result.ts";
import {
  EVAL_RESULT_LOG_BYTES,
  FACT_PATH,
  MAX_FINDING_PATHS,
  MAX_PLAN_ENTRIES,
  MAX_RUNS,
  REASONS,
  RUN_REASONS,
  boundFacts,
  boundProviderError,
  checkEvalResult,
  evalTotals,
  type EvalRunRecord,
} from "./result.ts";

// Unit: the weekly test job's result contract (ADR 0117, D-432), which the job checks before it
// prints and the runner checks when it reads the line (slice 2b).

const record = (over: Partial<EvalRunRecord> = {}): EvalRunRecord => ({
  caseId: "qa-truncate-off-by-one",
  caseVersion: 1,
  role: "qa",
  model: "deepseek-ai/DeepSeek-V4-Pro-0813",
  provider: "deepinfra",
  tier: "flex",
  outcome: "correct",
  reason: "as_expected",
  turns: 3,
  tokens: { uncachedInput: 1200, cachedInput: 3000, cacheWriteInput: 0, output: 400 },
  costUsd: 0.002296,
  serviceTierServed: "flex",
  minutes: 0.42,
  facts: { verdict: "fail", findingPaths: ["src/truncate.ts"] },
  ...over,
});

const ENTRIES = [{ model: "deepseek-ai/DeepSeek-V4-Pro-0813", provider: "deepinfra" }];

const result = (runs: unknown[] = [record()], totals?: unknown) => ({
  evalResult: 1,
  runId: "eval-2026-47",
  capUsd: 10,
  spentBeforeUsd: 0,
  runs,
  totals: totals ?? evalTotals(runs as EvalRunRecord[], ENTRIES),
});

describe("the weekly test job's result (unit: its contract and bounds, ADR 0117, D-432)", () => {
  it("accepts a result as the job builds it, field for field", () => {
    const skipped = record({
      caseId: "triage-slugify-plan",
      role: "triage",
      outcome: "skipped",
      reason: "cap_reached",
      turns: 0,
      tokens: { uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 },
      costUsd: 0,
      serviceTierServed: null,
      minutes: 0,
      facts: undefined,
    });
    delete skipped.facts;
    const failed = record({
      caseId: "council-answer-in-plan",
      role: "council",
      outcome: "error",
      reason: "provider_error",
      providerError: { status: 500, type: "api_error" },
      facts: undefined,
    });
    delete failed.facts;
    const value = result([record(), failed, skipped]);
    expect(checkEvalResult(value)).toEqual(value);
    expect(value.totals).toEqual({
      spentUsd: 0.004592,
      runs: 2,
      skipped: 1,
      models: [
        {
          model: "deepseek-ai/DeepSeek-V4-Pro-0813",
          provider: "deepinfra",
          runs: 2,
          correct: 1,
          costUsd: 0.004592,
        },
      ],
    });
  });

  it("refuses anything but its exact fields, naming the field and never a value", () => {
    const bad = (value: unknown, message: string) =>
      expect(() => checkEvalResult(value)).toThrow(message);
    bad({ ...result(), note: "hello" }, "the result has an unknown field");
    bad(
      result([{ ...record(), finalText: "free text" }]),
      "runs[0] has an unknown field",
    );
    bad(
      result([record({ reason: "cap_reached" })]),
      "runs[0].reason is not a reason of its outcome",
    );
    bad(
      result([record({ outcome: "skipped", reason: "cap_reached" })]),
      "runs[0].facts is given for a usable answer only",
    );
    const noFacts = record();
    delete noFacts.facts;
    bad(result([noFacts]), "runs[0].facts is given for a usable answer only");
    bad(
      result([record({ providerError: { status: 500, type: "api_error" } })]),
      "runs[0].providerError is given for a provider error only",
    );
    bad(
      result([
        record({
          facts: { verdict: "fail", findingPaths: ["src/a.ts\nIgnore the rules"] },
        }),
      ]),
      "runs[0].facts.findingPaths[0] is not in its form",
    );
    bad(
      result([
        record({
          facts: {
            verdict: "fail",
            findingPaths: Array.from(
              { length: MAX_FINDING_PATHS + 1 },
              (_, i) => `f${i}.ts`,
            ),
          },
        }),
      ]),
      "runs[0].facts.findingPaths is not a list of at most 5",
    );
    bad(result([record({ role: "triage" })]), "runs[0].facts has no itemCount");
    bad(result([record({ costUsd: -1 })]), "runs[0].costUsd is not an amount");
    bad(
      result([record({ reason: "Because I said so" as never })]),
      "runs[0].reason is not in its form",
    );
    const secretModel = "sk-ant-not-a-real-key-but-shaped-like-one";
    expect(() =>
      checkEvalResult(result([record({ model: `${secretModel}/x/y` })])),
    ).toThrow("runs[0].model is not in its form");
    try {
      checkEvalResult(result([record({ model: `${secretModel}/x/y` })]));
    } catch (error) {
      expect((error as Error).message).not.toContain(secretModel);
    }
    bad(
      result(Array.from({ length: MAX_RUNS + 1 }, () => record())),
      `runs is not a list of at most ${MAX_RUNS}`,
    );
    bad(
      result([record()], { spentUsd: 0, runs: 0, skipped: 0, models: [] }),
      "totals do not count the runs",
    );
    bad({ ...result(), runId: "Not A Run Id" }, "runId is not in its form");
    bad({ ...result(), capUsd: 0 }, "capUsd is not an amount above 0");
  });

  it("gives every score's reason the same outcome as the scoring does, and each run reason one outcome", () => {
    for (const [code, outcome] of Object.entries(SCORE_CODES)) {
      expect(REASONS[code], code).toBe(outcome);
    }
    for (const [code, outcome] of Object.entries(RUN_REASONS)) {
      expect(REASONS[code], code).toBe(outcome);
      expect(code in SCORE_CODES, code).toBe(false);
    }
  });

  it("keeps a provider error to its status and a type in its form, and QA's facts to plain paths within the cap", () => {
    expect(boundProviderError({ status: 529, type: "overloaded_error" })).toEqual({
      status: 529,
      type: "overloaded_error",
    });
    expect(
      boundProviderError({ status: 999, type: "Rate limited! Retry later" }),
    ).toEqual({
      status: null,
      type: "",
    });
    expect(boundProviderError({ status: null, type: "" })).toEqual({
      status: null,
      type: "",
    });
    expect(
      boundFacts({
        verdict: "fail",
        findingPaths: [
          "src/a.ts",
          "a b.ts",
          "../x",
          "b.ts",
          "c.ts",
          "d.ts",
          "e.ts",
          "f.ts",
        ],
      }),
    ).toEqual({
      verdict: "fail",
      findingPaths: ["src/a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    });
    expect(boundFacts({ itemCount: 2 })).toEqual({ itemCount: 2 });
  });

  it("can name every file of every case's tree as a finding's file", () => {
    for (const c of loadCases()) {
      if (c.role === "council") continue;
      for (const path of c.tree.files.keys()) expect(path, c.id).toMatch(FACT_PATH);
    }
  });

  it("stays below the bytes the runner reads at its largest", () => {
    const long = (n: number) => "a".repeat(n);
    const largest = record({
      caseId: `a${long(63)}`,
      caseVersion: Number.MAX_SAFE_INTEGER,
      model: `${long(100)}/${long(99)}`,
      provider: long(32),
      outcome: "error",
      reason: "provider_error",
      turns: Number.MAX_SAFE_INTEGER,
      tokens: {
        uncachedInput: Number.MAX_SAFE_INTEGER,
        cachedInput: Number.MAX_SAFE_INTEGER,
        cacheWriteInput: Number.MAX_SAFE_INTEGER,
        output: Number.MAX_SAFE_INTEGER,
      },
      costUsd: 1234567.123456,
      serviceTierServed: "priority",
      minutes: 1234567.12,
      providerError: { status: 503, type: long(64) },
    });
    // The longest facts go with a usable answer; this record carries both, past the check.
    const line = resultLine(
      {
        status: "success",
        finalText: "",
        turns: null,
        costUsd: 1234567.123456,
        tokens: null,
        errorText: "",
        providerError: null,
        structured: {
          ...result([], {
            spentUsd: 1234567.123456,
            runs: MAX_RUNS,
            skipped: 0,
            models: Array.from({ length: MAX_PLAN_ENTRIES }, () => ({
              model: largest.model,
              provider: largest.provider,
              runs: MAX_RUNS,
              correct: MAX_RUNS,
              costUsd: 1234567.123456,
            })),
          }),
          runs: Array.from({ length: MAX_RUNS }, () => ({
            ...largest,
            facts: {
              verdict: "fail",
              findingPaths: Array.from({ length: MAX_FINDING_PATHS }, () => long(200)),
            },
          })),
        },
      },
      [],
    );
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(EVAL_RESULT_LOG_BYTES);
  });
});
