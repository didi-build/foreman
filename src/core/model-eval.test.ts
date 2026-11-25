// Seam: unit, plain functions (ADR 0117, D-204, D-429, D-433, O-156). The weekly model test's
// setting reader, the week's plan with the monthly baseline rule and missing prices, the week's
// spend so far, the Job's sizes and whether this week starts a Job. Synthetic data only.
import { describe, expect, it } from "vitest";

import {
  baselineDue,
  EVAL_MAX_DEADLINE_MINUTES,
  evalSizing,
  jobPlan,
  parseModelEvalSettings,
  planWeekStart,
  storedPlan,
  storedPlanEntries,
  weekPlan,
  weekSpentUsd,
  weekStartOf,
  weeksBefore,
  type EvalCaseRef,
  type ModelEvalSettings,
  type WeekStartInput,
} from "./model-eval.ts";
import { parseModelCatalog, type ModelCatalog } from "./routing.ts";
import {
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  KIMI,
  SEEDED_MODEL_CATALOG,
  SEEDED_MODEL_EVAL,
} from "./routing-testing.ts";
import { REHEARSAL_RUN_LIMITS } from "./runs.ts";
import type { Json, ModelEvalJob, ModelEvalResult } from "./store.ts";

const settingsOf = (value: Json = SEEDED_MODEL_EVAL): ModelEvalSettings => {
  const problems: string[] = [];
  const read = parseModelEvalSettings(value, problems);
  if (!read) throw new Error(problems.join("; "));
  return read;
};
const catalogOf = (value: Json = SEEDED_MODEL_CATALOG): ModelCatalog => {
  const problems: string[] = [];
  const read = parseModelCatalog(value, problems);
  if (!read) throw new Error(problems.join("; "));
  return read;
};
const problemsOf = (value: Json): string[] => {
  const problems: string[] = [];
  expect(parseModelEvalSettings(value, problems)).toBeNull();
  return problems;
};

/** The set's twelve cases as the bundle holds them: 7 QA, 3 Triage, 2 Council. */
const CASES: EvalCaseRef[] = [
  ...["a", "b", "c", "d", "e", "f", "g"].map((x) => ({
    id: `qa-${x}`,
    role: "qa" as const,
  })),
  ...["a", "b", "c"].map((x) => ({ id: `triage-${x}`, role: "triage" as const })),
  ...["a", "b"].map((x) => ({ id: `council-${x}`, role: "council" as const })),
];
const CAPACITY = { flexCapacityRetries: 3, maxRejectedModelRequests: 6 };
const limits = (role: "qa" | "triage" | "council") => REHEARSAL_RUN_LIMITS[role];

/** Sunday 2026-11-22, 07:17 UTC: the first fire of its week. */
const SUNDAY = new Date("2026-11-22T07:17:00Z");

const job = (overrides: Partial<ModelEvalJob> = {}): ModelEvalJob => ({
  id: "70000000-0000-4000-8000-000000000001",
  weekStart: "2026-11-22",
  startedAt: SUNDAY,
  deadlineAt: new Date(SUNDAY.getTime() + 3_600_000),
  baseline: false,
  capUsd: 10,
  spentBeforeUsd: 0,
  plan: [],
  recordedBy: "runner:weekly-model-test",
  end: null,
  ...overrides,
});
const finished = (spentUsd: number) => ({
  endedAt: SUNDAY,
  outcome: "finished" as const,
  reason: null,
  detail: null,
  spentUsd,
});
const failed = (reason: string, spentUsd: number | null = null) => ({
  endedAt: SUNDAY,
  outcome: "failed" as const,
  reason,
  detail: null,
  spentUsd,
});
const result = (
  jobId: string,
  overrides: Partial<ModelEvalResult> = {},
): ModelEvalResult => ({
  id: `${jobId}-r`,
  jobId,
  seq: 1,
  caseId: "qa-a",
  caseVersion: 1,
  role: "qa",
  model: "claude-opus-5-5",
  provider: "anthropic",
  tier: "standard",
  baseline: true,
  outcome: "correct",
  reason: "as_expected",
  turns: 3,
  tokens: {},
  costUsd: 0.2,
  serviceTierServed: "standard",
  minutes: 1,
  providerError: null,
  facts: { verdict: "pass", findingPaths: [] },
  recordedBy: "runner",
  recordedAt: SUNDAY,
  ...overrides,
});

const input = (overrides: Partial<WeekStartInput> = {}): WeekStartInput => ({
  now: SUNDAY,
  settings: settingsOf(),
  catalog: catalogOf(),
  cases: CASES,
  limits,
  capacity: CAPACITY,
  jobs: [],
  results: [],
  ...overrides,
});

describe("the model_eval setting (unit: D-204, D-429, D-433)", () => {
  it("reads the seeded setting: the cap, the weekly models, the baseline and the key paths", () => {
    const s = settingsOf();
    expect(s.capUsd).toBe(10);
    expect(s.weekly.map((e) => [e.model, e.provider, e.tier])).toEqual([
      [DEEPSEEK_PRO, "deepinfra", "flex"],
      [DEEPSEEK_FLASH, "deepinfra", "flex"],
      [KIMI, "deepinfra", "flex"],
    ]);
    expect(s.baseline.map((e) => [e.model, e.roles])).toEqual([
      ["claude-opus-5-5", ["qa"]],
      ["claude-sonnet-5-5", ["triage", "council"]],
    ]);
    expect(s.baselineCadence).toBe("first_run_of_month");
    expect(s.keyPaths).toEqual({
      deepinfra: "eval/models/deepinfra",
      anthropic: "eval/models/anthropic",
    });
  });

  it.each([
    ["not an object", [], /must be an object/],
    ["an unknown field", { ...SEEDED_MODEL_EVAL, extra: 1 }, /unknown field extra/],
    ["a missing field", { ...SEEDED_MODEL_EVAL, capUsd: undefined }, /capUsd/],
    [
      "a cap of 0",
      { ...SEEDED_MODEL_EVAL, capUsd: 0 },
      /capUsd must be a number above 0/,
    ],
    ["no weekly model", { ...SEEDED_MODEL_EVAL, weekly: [] }, /at least one model/],
    [
      "a bad tier",
      {
        ...SEEDED_MODEL_EVAL,
        weekly: [{ ...SEEDED_MODEL_EVAL.weekly[0], tier: "cheap" }],
      },
      /weekly\[0\]\.tier/,
    ],
    [
      "an unknown role",
      {
        ...SEEDED_MODEL_EVAL,
        weekly: [{ ...SEEDED_MODEL_EVAL.weekly[0], roles: ["developer"] }],
      },
      /weekly\[0\]\.roles/,
    ],
    [
      "a model twice on one provider",
      {
        ...SEEDED_MODEL_EVAL,
        weekly: [SEEDED_MODEL_EVAL.weekly[0], SEEDED_MODEL_EVAL.weekly[0]],
      },
      /names a model twice/,
    ],
    [
      "another cadence",
      { ...SEEDED_MODEL_EVAL, baselineCadence: "weekly" },
      /baselineCadence/,
    ],
    [
      "a project's key path (D-433)",
      {
        ...SEEDED_MODEL_EVAL,
        keyPaths: {
          ...SEEDED_MODEL_EVAL.keyPaths,
          deepinfra: "projects/rehearsal/models/deepinfra",
        },
      },
      /keyPaths\.deepinfra must be eval\/models\/<provider>/,
    ],
    [
      "a platform secret as a key path",
      {
        ...SEEDED_MODEL_EVAL,
        keyPaths: {
          ...SEEDED_MODEL_EVAL.keyPaths,
          anthropic: "platform/github/runner-app-private-key",
        },
      },
      /keyPaths\.anthropic must be eval\/models\/<provider>/,
    ],
    [
      "no key path for a provider it uses",
      { ...SEEDED_MODEL_EVAL, keyPaths: { deepinfra: "eval/models/deepinfra" } },
      /no key path for anthropic/,
    ],
  ])("refuses %s, naming the field", (_label, value, pattern) => {
    const problems = problemsOf(value as Json);
    expect(problems.join("; ")).toMatch(pattern);
    expect(problems.join("; ")).not.toContain("platform/github");
  });

  it("refuses more than eight models in all, as the test job takes them", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...SEEDED_MODEL_EVAL.weekly[0],
      model: `org/model-${i}`,
    }));
    expect(problemsOf({ ...SEEDED_MODEL_EVAL, weekly: many }).join()).toMatch(
      /at most 8 models/,
    );
  });
});

describe("the week's plan (unit: D-429, ADR 0114 hard rule 2)", () => {
  it("gives the weekly models at Flex with the catalog's prices, and the baseline only when asked", () => {
    const weekly = weekPlan(settingsOf(), catalogOf(), false);
    expect(weekly.leftOut).toEqual([]);
    expect(weekly.entries.map((e) => [e.model, e.tier, e.baseline])).toEqual([
      [DEEPSEEK_PRO, "flex", false],
      [DEEPSEEK_FLASH, "flex", false],
      [KIMI, "flex", false],
    ]);
    expect(weekly.entries[1]?.price).toEqual({
      tiers: ["standard", "flex"],
      pricePerMTok: {
        standard: { input: 0.2, cachedInput: 0.006, output: 0.6 },
        flex: { input: 0.16, cachedInput: 0.0048, output: 0.48 },
      },
    });
    const withBaseline = weekPlan(settingsOf(), catalogOf(), true);
    expect(withBaseline.entries.map((e) => [e.model, e.provider, e.baseline])).toEqual([
      [DEEPSEEK_PRO, "deepinfra", false],
      [DEEPSEEK_FLASH, "deepinfra", false],
      [KIMI, "deepinfra", false],
      ["claude-opus-5-5", "anthropic", true],
      ["claude-sonnet-5-5", "anthropic", true],
    ]);
    expect(withBaseline.entries[3]?.price).toEqual({
      tiers: ["standard"],
      pricePerMTok: {
        standard: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
      },
    });
  });

  it("leaves out a model with no catalog entry, one under another provider, and one without a price for its tier", () => {
    const models = { ...SEEDED_MODEL_CATALOG.models } as Record<string, Json>;
    delete models[KIMI];
    models[DEEPSEEK_FLASH] = {
      ...(models[DEEPSEEK_FLASH] as object),
      provider: "other",
    };
    models[DEEPSEEK_PRO] = {
      ...(models[DEEPSEEK_PRO] as object),
      tiers: ["standard"],
    };
    const plan = weekPlan(
      settingsOf(),
      catalogOf({ ...SEEDED_MODEL_CATALOG, models } as Json),
      false,
    );
    expect(plan.entries).toEqual([]);
    expect(plan.leftOut).toEqual([
      { model: DEEPSEEK_PRO, provider: "deepinfra", reason: "no_price_for_tier" },
      { model: DEEPSEEK_FLASH, provider: "deepinfra", reason: "other_provider" },
      { model: KIMI, provider: "deepinfra", reason: "not_in_catalog" },
    ]);
  });

  it("hands the job its plan without the baseline flag, and keeps the flag on the Job's row", () => {
    const { entries } = weekPlan(settingsOf(), catalogOf(), true);
    const forJob = jobPlan(entries) as Record<string, Json>[];
    expect(Object.keys(forJob[0] ?? {})).toEqual([
      "model",
      "provider",
      "tier",
      "price",
      "roles",
    ]);
    expect(storedPlanEntries(storedPlan(entries))).toEqual(
      entries.map((e) => ({
        model: e.model,
        provider: e.provider,
        tier: e.tier,
        roles: e.roles,
        baseline: e.baseline,
      })),
    );
    expect(() => storedPlanEntries([{ model: "m" }])).toThrow(/entry 1/);
  });
});

describe("weeks, months and the baseline (unit: D-429, O-156)", () => {
  it("starts a week on Sunday, UTC", () => {
    expect(weekStartOf(SUNDAY)).toBe("2026-11-22");
    expect(weekStartOf(new Date("2026-11-22T00:00:00Z"))).toBe("2026-11-22");
    expect(weekStartOf(new Date("2026-11-21T23:59:59Z"))).toBe("2026-11-15");
    expect(weekStartOf(new Date("2026-11-28T23:00:00Z"))).toBe("2026-11-22");
    expect(weeksBefore(SUNDAY, 9)).toBe("2026-09-20");
  });

  it("runs the baseline in the first Job of each calendar month whose Claude runs started", () => {
    const october = job({
      startedAt: new Date("2026-10-25T07:17:00Z"),
      weekStart: "2026-10-25",
    });
    const november = job({
      id: "70000000-0000-4000-8000-000000000002",
      startedAt: new Date("2026-11-01T07:17:00Z"),
      weekStart: "2026-11-01",
    });
    // Nothing yet this month: due.
    expect(baselineDue(SUNDAY, [october], [result(october.id)])).toBe(true);
    // A started Claude run in a November Job: not due again in November.
    expect(baselineDue(SUNDAY, [october, november], [result(november.id)])).toBe(false);
    // Only skipped Claude runs (the cap reached first): due again.
    expect(
      baselineDue(
        SUNDAY,
        [november],
        [
          result(november.id, {
            outcome: "skipped",
            reason: "cap_reached",
            facts: null,
          }),
        ],
      ),
    ).toBe(true);
    // A weekly model's run does not count.
    expect(
      baselineDue(SUNDAY, [november], [result(november.id, { baseline: false })]),
    ).toBe(true);
    // In December it is due again.
    expect(
      baselineDue(new Date("2026-12-06T07:17:00Z"), [november], [result(november.id)]),
    ).toBe(true);
  });

  it("adds up this week's spend, known only when every Job's is", () => {
    expect(weekSpentUsd([])).toBe(0);
    expect(
      weekSpentUsd([job({ end: finished(0.1) }), job({ end: finished(0.2) })]),
    ).toBe(0.3);
    expect(weekSpentUsd([job({ end: failed("start_failed", 0) })])).toBe(0);
    expect(weekSpentUsd([job({ end: failed("job_gone") })])).toBeNull();
    expect(weekSpentUsd([job()])).toBeNull();
  });
});

describe("the Job's sizes (unit: D-432, O-156)", () => {
  const plan = (baseline: boolean) =>
    weekPlan(settingsOf(), catalogOf(), baseline).entries;

  it("covers every planned run's turns and Flex retries, each run's 429 allowance and every minute limit", () => {
    // 12 cases on 3 models: 36 runs. QA 7 x 3 x (80 + 3), Triage 3 x 3 x (40 + 3), Council 2 x 3 x 43.
    // Minutes: QA's 30 (D-480) on 21 runs, the others' 20 on 15.
    expect(evalSizing(CASES, plan(false), limits, CAPACITY)).toEqual({
      runs: 36,
      maxModelRequests: 1743 + 387 + 258,
      maxRejectedModelRequests: 36 * 6,
      deadlineMinutes: 21 * 30 + 15 * 20 + 10,
    });
    // With the baseline: Opus on 7 QA cases, Sonnet on 5 Triage and Council cases.
    expect(evalSizing(CASES, plan(true), limits, CAPACITY)).toEqual({
      runs: 48,
      maxModelRequests: 2388 + 7 * 83 + 5 * 43,
      maxRejectedModelRequests: 48 * 6,
      deadlineMinutes: 28 * 30 + 20 * 20 + 10,
    });
  });

  it("holds the ceilings to their bounds, and refuses no run, too many runs or more than a day", () => {
    const wide = { flexCapacityRetries: 500, maxRejectedModelRequests: 500 };
    const sized = evalSizing(CASES, plan(false), limits, wide);
    expect(sized?.maxModelRequests).toBe(10_000);
    expect(sized?.maxRejectedModelRequests).toBe(1_000);
    expect(evalSizing([], plan(false), limits, CAPACITY)).toBeNull();
    const many = Array.from({ length: 101 }, (_, i) => ({
      id: `qa-${i}`,
      role: "qa" as const,
    }));
    expect(evalSizing(many, plan(false), limits, CAPACITY)).toBeNull();
    const slow = () => ({
      maxTurns: 10,
      maxMinutes: EVAL_MAX_DEADLINE_MINUTES,
      maxUsd: 1,
    });
    expect(evalSizing(CASES, plan(false), slow, CAPACITY)).toBeNull();
  });
});

describe("whether this week starts a Job (unit: O-156)", () => {
  it("starts the first Job of a month with the baseline, the cap and both providers' key paths", () => {
    const start = planWeekStart(input());
    if (!start.start) throw new Error(start.reason);
    expect(start).toMatchObject({
      weekStart: "2026-11-22",
      baseline: true,
      capUsd: 10,
      spentBeforeUsd: 0,
      keyPaths: {
        deepinfra: "eval/models/deepinfra",
        anthropic: "eval/models/anthropic",
      },
    });
    expect(start.entries).toHaveLength(5);
    expect(start.deadlineAt).toEqual(new Date(SUNDAY.getTime() + 1250 * 60_000));
  });

  it("leaves Claude and its key out once the month's baseline ran", () => {
    const earlier = job({
      id: "70000000-0000-4000-8000-000000000009",
      weekStart: "2026-11-15",
      startedAt: new Date("2026-11-15T07:17:00Z"),
      end: finished(1.5),
    });
    const start = planWeekStart(
      input({ jobs: [earlier], results: [result(earlier.id)] }),
    );
    if (!start.start) throw new Error(start.reason);
    expect(start.baseline).toBe(false);
    expect(start.entries.map((e) => e.provider)).toEqual([
      "deepinfra",
      "deepinfra",
      "deepinfra",
    ]);
    expect(start.keyPaths).toEqual({ deepinfra: "eval/models/deepinfra" });
    // Last week's spend is last week's: this week starts at 0.
    expect(start.spentBeforeUsd).toBe(0);
  });

  it.each([
    ["a Job still running", [job()], "job_running"],
    ["a Job of the week that finished", [job({ end: finished(0.4) })], "week_done"],
    [
      "a Job of the week lost after it may have run",
      [job({ end: failed("did_not_end") })],
      "spend_unknown",
    ],
    ["a week whose Jobs spent the cap", [job({ end: finished(10.01) })], "cap_spent"],
  ] as const)("starts nothing with %s", (_label, jobs, reason) => {
    expect(planWeekStart(input({ jobs: [...jobs] }))).toEqual({
      start: false,
      reason,
      leftOut: [],
    });
  });

  it("starts again after a Job that never started, with the week's spend so far", () => {
    const start = planWeekStart(
      input({ jobs: [job({ end: failed("start_failed", 0) })] }),
    );
    expect(start.start).toBe(true);
  });

  it("starts nothing with no priced model, or a plan too large, and says which models were left out", () => {
    const noPrices = catalogOf({
      ...SEEDED_MODEL_CATALOG,
      models: { "claude-opus-5-5": SEEDED_MODEL_CATALOG.models["claude-opus-5-5"] },
    } as Json);
    const none = planWeekStart(
      input({ catalog: noPrices, settings: { ...settingsOf(), baseline: [] } }),
    );
    expect(none).toMatchObject({ start: false, reason: "no_model" });
    expect(none.leftOut).toHaveLength(3);
    expect(planWeekStart(input({ cases: [] }))).toMatchObject({
      start: false,
      reason: "plan_too_large",
    });
  });
});
