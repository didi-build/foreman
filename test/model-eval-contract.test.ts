// Seam: unit, a repo guard across the boundary ADR 0101 draws (O-155, O-156). The core cannot
// import the test job's image code, so the runner's check of the job's result
// (src/core/model-eval-result.ts) is the image's contract written again. This holds the two to
// the same reason codes, bounds and answers, field by field; it holds the runner's plan to what
// the image's plan reader and its bot files accept; the runner's run count to the image's own
// order; and the runner's case list, read the way a flow reads it, to the image's case loader.
import { describe, expect, it } from "vitest";

import { readBotFiles } from "../src/adapters/contracts-file/bot-files.ts";
import {
  EVAL_CASE_FILE,
  EVAL_CASE_ID,
  EVAL_CASES_DIR,
  readEvalCaseList,
} from "../src/adapters/contracts-file/eval-case-list.ts";
import { checkPlan, parsePlan } from "../src/agent-images/eval/plan.ts";
import {
  EVAL_RESULT_LOG_BYTES as IMAGE_LOG_BYTES,
  FACT_PATH,
  MAX_FINDING_PATHS,
  MAX_PLAN_ENTRIES as IMAGE_MAX_PLAN_ENTRIES,
  MAX_RUNS,
  OUTCOMES,
  REASONS,
  checkEvalResult,
} from "../src/agent-images/eval/result.ts";
import { RUNS_PER_CASE, plannedRuns } from "../src/agent-images/eval/week.ts";
import { MODEL_ID, RUN_ID } from "../src/agent-images/shared/settings.ts";
import {
  CASE_FILE,
  CASE_ID,
  CASES_DIR,
  TASK_TYPE_OF,
  loadCases,
} from "../src/eval/cases.ts";
import {
  EVAL_MAX_RUNS,
  EVAL_RUNS_PER_CASE,
  EVAL_TASK_TYPES,
  MAX_PLAN_ENTRIES,
  evalSizing,
  jobPlan,
  parseModelEvalSettings,
  weekPlan,
} from "../src/core/model-eval.ts";
import {
  EVAL_OUTCOMES,
  EVAL_REASONS,
  EVAL_RESULT_BOUNDS,
  EVAL_RESULT_LOG_BYTES,
  readEvalJobResult,
} from "../src/core/model-eval-result.ts";
import { parseModelCatalog } from "../src/core/routing.ts";
import {
  SEEDED_MODEL_CATALOG,
  SEEDED_MODEL_EVAL,
} from "../src/core/routing-testing.ts";
import { REHEARSAL_RUN_LIMITS } from "../src/core/runs.ts";

const tokens = () => ({
  uncachedInput: 10,
  cachedInput: 0,
  cacheWriteInput: 0,
  output: 5,
});

/** A valid result line's `structured` of every outcome and role. */
function valid(): Record<string, unknown> {
  return structuredClone({
    evalResult: 1,
    runId: "70000000-0000-4000-8000-000000000001",
    capUsd: 10,
    spentBeforeUsd: 0.5,
    runs: [
      {
        caseId: "qa-truncate-off-by-one",
        caseVersion: 1,
        role: "qa",
        model: "moonshotai/Kimi-K2.6",
        provider: "deepinfra",
        tier: "flex",
        outcome: "correct",
        reason: "as_expected",
        turns: 7,
        tokens: tokens(),
        costUsd: 0.02,
        serviceTierServed: "mixed",
        minutes: 2.5,
        facts: {
          verdict: "fail",
          findingPaths: ["src/truncate.ts", "test/truncate.test.ts"],
        },
      },
      {
        caseId: "triage-helper-then-page",
        caseVersion: 1,
        role: "triage",
        model: "moonshotai/Kimi-K2.6",
        provider: "deepinfra",
        tier: "flex",
        outcome: "wrong",
        reason: "wrong_blocked_by",
        turns: 2,
        tokens: tokens(),
        costUsd: 0.01,
        serviceTierServed: "flex",
        minutes: 1,
        facts: { itemCount: 2 },
      },
      {
        caseId: "council-product-decision",
        caseVersion: 1,
        role: "council",
        model: "moonshotai/Kimi-K2.6",
        provider: "deepinfra",
        tier: "flex",
        outcome: "correct",
        reason: "as_expected",
        turns: 1,
        tokens: tokens(),
        costUsd: 0.01,
        serviceTierServed: "flex",
        minutes: 0.5,
        facts: {
          outcome: "cannot_resolve",
          changesProductDirection: true,
          passesGate: false,
        },
      },
      {
        caseId: "council-answer-in-plan",
        caseVersion: 1,
        role: "council",
        model: "moonshotai/Kimi-K2.6",
        provider: "deepinfra",
        tier: "flex",
        outcome: "unusable",
        reason: "answer_rejected",
        turns: 1,
        tokens: tokens(),
        costUsd: 0,
        serviceTierServed: null,
        minutes: 0.2,
      },
      {
        caseId: "qa-slugify-pass",
        caseVersion: 1,
        role: "qa",
        model: "moonshotai/Kimi-K2.6",
        provider: "deepinfra",
        tier: "flex",
        outcome: "error",
        reason: "provider_error",
        turns: 0,
        tokens: tokens(),
        costUsd: 0,
        serviceTierServed: null,
        minutes: 0,
        providerError: { status: null, type: "" },
      },
    ],
    totals: {
      spentUsd: 0.04,
      runs: 5,
      skipped: 0,
      models: [
        {
          model: "moonshotai/Kimi-K2.6",
          provider: "deepinfra",
          runs: 5,
          correct: 2,
          costUsd: 0.04,
        },
      ],
    },
  });
}

type Edit = (r: Record<string, unknown>) => void;
const runAt = (r: Record<string, unknown>, i: number) =>
  (r.runs as Record<string, unknown>[])[i] as Record<string, unknown>;

/** Changes the two checks must refuse alike, or take alike. */
const EDITS: [string, Edit][] = [
  ["nothing", () => undefined],
  ["no totals", (r) => delete r.totals],
  ["an extra field", (r) => (r.note = "x")],
  ["evalResult 2", (r) => (r.evalResult = 2)],
  ["a run id with capitals", (r) => (r.runId = "Run-1")],
  ["a run id of 41 characters", (r) => (r.runId = "a".repeat(41))],
  ["cap 0", (r) => (r.capUsd = 0)],
  ["spent before -1", (r) => (r.spentBeforeUsd = -1)],
  ["runs not a list", (r) => (r.runs = {})],
  ["a role of developer", (r) => (runAt(r, 0).role = "developer")],
  ["an unknown outcome", (r) => (runAt(r, 0).outcome = "great")],
  ["a reason of another outcome", (r) => (runAt(r, 0).reason = "answer_rejected")],
  ["a reason with a capital", (r) => (runAt(r, 0).reason = "As_expected")],
  ["a case id with a slash", (r) => (runAt(r, 0).caseId = "qa/x")],
  ["a case version 0", (r) => (runAt(r, 0).caseVersion = 0)],
  ["a model with a space", (r) => (runAt(r, 0).model = "a model")],
  ["a provider with capitals", (r) => (runAt(r, 0).provider = "DeepInfra")],
  ["a tier of cheap", (r) => (runAt(r, 0).tier = "cheap")],
  ["turns 1.5", (r) => (runAt(r, 0).turns = 1.5)],
  [
    "a token count missing",
    (r) => delete (runAt(r, 0).tokens as Record<string, unknown>).output,
  ],
  ["a served tier of fast", (r) => (runAt(r, 0).serviceTierServed = "fast")],
  ["minutes NaN", (r) => (runAt(r, 0).minutes = Number.NaN)],
  ["facts on an unusable answer", (r) => (runAt(r, 3).facts = { itemCount: 1 })],
  ["no facts on a correct answer", (r) => delete runAt(r, 0).facts],
  [
    "QA facts with a dot path",
    (r) => (runAt(r, 0).facts = { verdict: "fail", findingPaths: ["./a"] }),
  ],
  [
    "QA facts with six paths",
    (r) =>
      (runAt(r, 0).facts = {
        verdict: "fail",
        findingPaths: ["a", "b", "c", "d", "e", "f"],
      }),
  ],
  [
    "QA facts with an extra field",
    (r) => (runAt(r, 0).facts = { verdict: "fail", findingPaths: [], note: "x" }),
  ],
  ["Triage facts of 1001 items", (r) => (runAt(r, 1).facts = { itemCount: 1001 })],
  [
    "Council facts with a flag that is a string",
    (r) =>
      (runAt(r, 2).facts = {
        outcome: "resolve",
        changesProductDirection: "no",
        passesGate: false,
      }),
  ],
  [
    "a provider error with a message",
    (r) => (runAt(r, 4).providerError = { status: 500, type: "x", message: "m" }),
  ],
  [
    "a provider error type with a dash",
    (r) => (runAt(r, 4).providerError = { status: 500, type: "rate-limit" }),
  ],
  [
    "a provider error status 600",
    (r) => (runAt(r, 4).providerError = { status: 600, type: "x" }),
  ],
  ["no provider error on one", (r) => delete runAt(r, 4).providerError],
  [
    "totals' skipped off by one",
    (r) => ((r.totals as Record<string, unknown>).skipped = 1),
  ],
  [
    "nine model totals",
    (r) =>
      ((r.totals as Record<string, unknown>).models = Array.from(
        { length: 9 },
        () => ((r.totals as Record<string, unknown>).models as unknown[])[0],
      )),
  ],
  ["301 runs", (r) => (r.runs = Array.from({ length: 301 }, () => runAt(r, 3)))],
];

/** What a check said: taken, or its message. */
function verdict(check: (value: unknown) => unknown, value: unknown): string {
  try {
    check(value);
    return "taken";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("the runner's check and the image's check of the test job's result (unit: O-155, O-156)", () => {
  it("have the same outcomes, reason codes with their outcomes, bounds and log size", () => {
    expect([...EVAL_OUTCOMES]).toEqual([...OUTCOMES]);
    expect(EVAL_REASONS).toEqual(REASONS);
    expect(EVAL_RESULT_BOUNDS.maxRuns).toBe(MAX_RUNS);
    expect(EVAL_RESULT_BOUNDS.maxPlanEntries).toBe(IMAGE_MAX_PLAN_ENTRIES);
    expect(EVAL_RESULT_BOUNDS.maxFindingPaths).toBe(MAX_FINDING_PATHS);
    expect(EVAL_RESULT_LOG_BYTES).toBe(IMAGE_LOG_BYTES);
    expect(EVAL_MAX_RUNS).toBe(MAX_RUNS);
    expect(MAX_PLAN_ENTRIES).toBe(IMAGE_MAX_PLAN_ENTRIES);
    expect(EVAL_RUNS_PER_CASE).toBe(RUNS_PER_CASE);
    expect(EVAL_TASK_TYPES).toEqual(TASK_TYPE_OF);
  });

  it.each(EDITS)("give the same answer for %s", (_label, edit) => {
    const value = valid();
    edit(value);
    const image = verdict(checkEvalResult, structuredClone(value));
    const runner = verdict(readEvalJobResult, structuredClone(value));
    expect(runner).toBe(image);
    if (_label === "nothing") expect(runner).toBe("taken");
    else expect(runner).not.toBe("taken");
  });

  it("read a valid result into the same value", () => {
    expect(readEvalJobResult(valid())).toEqual(checkEvalResult(valid()));
  });

  it("use the same forms for ids, models and finding paths", () => {
    expect(EVAL_CASE_ID.source).toBe(CASE_ID.source);
    for (const id of [
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "claude-opus-5-5",
      "a b",
      "x/y/z",
    ]) {
      const value = valid();
      runAt(value, 0).model = id;
      expect(verdict(readEvalJobResult, value) === "taken").toBe(MODEL_ID.test(id));
    }
    expect(RUN_ID.test("70000000-0000-4000-8000-000000000001")).toBe(true);
    expect(FACT_PATH.test("src/truncate.ts")).toBe(true);
  });
});

describe("the runner's plan, sizes and cases against the image's (unit: O-155, O-156)", () => {
  const problems: string[] = [];
  const settings = parseModelEvalSettings(SEEDED_MODEL_EVAL, problems);
  const catalog = parseModelCatalog(SEEDED_MODEL_CATALOG, problems);
  if (!settings || !catalog) throw new Error(problems.join("; "));
  const bots = readBotFiles();
  const baseUrls = {
    deepinfra: "http://10.245.0.10:8080/deepinfra",
    anthropic: "http://10.245.0.10:8080/anthropic",
  };

  it("hands the job a plan its reader and the bot files take, Claude's baseline included", () => {
    for (const baseline of [false, true]) {
      const { entries } = weekPlan(settings, catalog, baseline);
      const plan = parsePlan(JSON.stringify(jobPlan(entries)));
      expect(() => checkPlan(plan, bots, baseUrls)).not.toThrow();
      expect(plan.map((e) => e.model)).toEqual(entries.map((e) => e.model));
    }
  });

  it("counts the runs the job makes, over the set's real cases", () => {
    const cases = loadCases();
    const refs = readEvalCaseList();
    expect(refs).toEqual(cases.map((c) => ({ id: c.id, role: c.role })));
    for (const baseline of [false, true]) {
      const { entries } = weekPlan(settings, catalog, baseline);
      const plan = parsePlan(JSON.stringify(jobPlan(entries)));
      const sizing = evalSizing(refs, entries, (role) => REHEARSAL_RUN_LIMITS[role], {
        flexCapacityRetries: 3,
        maxRejectedModelRequests: 6,
      });
      expect(sizing?.runs).toBe(plannedRuns(cases, plan).length);
    }
  });

  it("reads the cases where the loader does", () => {
    expect(EVAL_CASES_DIR).toBe(CASES_DIR);
    expect(EVAL_CASE_FILE).toBe(CASE_FILE);
  });
});
