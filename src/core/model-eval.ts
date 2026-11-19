// The weekly model test set's runner side (ADR 0117, D-204, D-427 to D-433, O-156): its setting,
// the week's plan and whether this week starts a Job. Plain logic over values the flow reads: the
// `model_eval` setting, the model catalog, the case list, the bot files' limits, the capacity
// settings, the stored Jobs and results, and the clock (D-162). It reads and writes nothing.
//
// - **The setting** (`model_eval`, migration 0027): the weekly cap (D-204), the models tested each
//   week and Claude's baseline (D-429), the baseline's cadence, and the Windmill key path of each
//   provider (D-433). Read strictly: a malformed setting starts nothing, and each problem names
//   the field, never a value.
// - **The week** runs from Sunday 00:00 UTC to the next Sunday. The weekly flow fires once a day
//   (flows/windmill.yaml); the first fire of a week starts the week's Job, and later fires read its
//   result, so the flow never waits on the Job (O-156).
// - **The baseline** runs in the first Job of each calendar month (UTC): a week includes Claude
//   when no Claude run of a Job started in the same month has started (a skipped run does not
//   count). So it is the first weekly Job of the month, and a month whose first Job ran no Claude
//   case (the cap reached first, or the Job lost) tries again the next week.
// - **The plan**: each model with the catalog's price for it, in the shape a run records it
//   (`runPriceOf`, ADR 0114 section 8). A model the catalog does not list under its provider, or
//   without a Standard price and a price for its tier, is left out with a fixed reason (ADR 0114
//   hard rule 2); the others still run.
// - **The spend so far**: what this week's earlier Jobs spent, from the stored Jobs, so a second
//   Job in a week keeps one cap. A Job that ended without a readable result after it may have run
//   leaves the week's spend unknown, and the week starts nothing more: its cap counts as spent.
// - **The sizes**: the proxy's request ceiling, its 429 allowance and the Job's deadline cover the
//   whole week: every planned run's turn limit and Flex retries, the 429 allowance of each run, and
//   every run's minute limit, each with a fixed bound.
import type { EvalJobResult } from "./model-eval-result.ts";
import { runPriceOf, type ModelCatalog, type RunPrice } from "./routing.ts";
import type { RunCapacityLimits, RunLimits } from "./runs.ts";
import type { Json, ModelEvalJob, ModelEvalResult, ServiceTier } from "./store.ts";

/** The setting that holds the weekly model test's plan and cap (migration 0027). */
export const MODEL_EVAL_SETTING = "model_eval";

/** The roles the weekly cases cover (D-427), each with its one task type. */
export const EVAL_ROLES = ["qa", "triage", "council"] as const;
export type EvalRole = (typeof EVAL_ROLES)[number];
export const EVAL_TASK_TYPES: Readonly<Record<EvalRole, string>> = {
  qa: "qa:review",
  triage: "triage",
  council: "council",
};

/** The baseline's cadences. Only one: the first Job of each calendar month, UTC (see above). */
export const BASELINE_CADENCES = ["first_run_of_month"] as const;
export type BaselineCadence = (typeof BASELINE_CADENCES)[number];

/** Where a provider's key for the weekly test lives (D-433): `eval/models/<provider>`. */
export const EVAL_KEY_PATH_PREFIX = "eval/models/";
export const evalKeyPath = (provider: string): string =>
  `${EVAL_KEY_PATH_PREFIX}${provider}`;

/** The most entries a plan has, as the test job takes it (src/agent-images/eval/result.ts). */
export const MAX_PLAN_ENTRIES = 8;
/** The most runs one Job makes, as the test job takes it. */
export const EVAL_MAX_RUNS = 300;
/** One run per case and model each week, as the test job runs them (`RUNS_PER_CASE`). */
export const EVAL_RUNS_PER_CASE = 1;
/**
 * The bounds of the Job's proxy ceilings, far above a week's plan: a week with Claude's baseline
 * plans 48 runs, about 2,300 requests and 288 answers with 429 at today's limits.
 */
export const EVAL_MAX_MODEL_REQUESTS = 10_000;
export const EVAL_MAX_REJECTED_MODEL_REQUESTS = 1_000;
/** Time the Job takes before its first run: the proxy's start and the cases' loading. */
export const EVAL_START_MINUTES = 10;
/** The longest deadline a week's Job may have: one day, so the next day's fire reads it. */
export const EVAL_MAX_DEADLINE_MINUTES = 1_440;

const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];
const MODEL_ID =
  /^(?=.{1,200}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const PROVIDER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export interface EvalSettingEntry {
  model: string;
  provider: string;
  tier: ServiceTier;
  roles: EvalRole[];
}

export interface ModelEvalSettings {
  /** The weekly cap in US dollars (D-204). Claude's baseline counts toward it. */
  capUsd: number;
  /** The models tested every week (D-429). */
  weekly: EvalSettingEntry[];
  /** Claude's baseline, run once a month (D-429). */
  baseline: EvalSettingEntry[];
  baselineCadence: BaselineCadence;
  /** Each provider's Windmill key path, always `eval/models/<provider>` (D-433). */
  keyPaths: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) problems.push(`${where}: missing field ${key}`);
  }
}

function parseEntry(
  where: string,
  value: unknown,
  problems: string[],
): EvalSettingEntry | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  checkKeys(where, value, ["model", "provider", "tier", "roles"], problems);
  const { model, provider, tier, roles } = value;
  if (typeof model !== "string" || !MODEL_ID.test(model)) {
    problems.push(`${where}.model must be a model id`);
  }
  if (typeof provider !== "string" || !PROVIDER_NAME.test(provider)) {
    problems.push(`${where}.provider must be a provider name`);
  }
  if (!TIERS.includes(tier as ServiceTier)) {
    problems.push(`${where}.tier must be ${TIERS.join(", ")}`);
  }
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every((r) => EVAL_ROLES.includes(r as EvalRole)) ||
    new Set(roles).size !== roles.length
  ) {
    problems.push(`${where}.roles must be one or more of ${EVAL_ROLES.join(", ")}`);
  }
  if (problems.length > before) return null;
  return {
    model: model as string,
    provider: provider as string,
    tier: tier as ServiceTier,
    roles: [...(roles as EvalRole[])],
  };
}

function parseEntries(
  where: string,
  value: unknown,
  problems: string[],
): EvalSettingEntry[] {
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list`);
    return [];
  }
  return value.flatMap((entry, i) => {
    const parsed = parseEntry(`${where}[${i}]`, entry, problems);
    return parsed ? [parsed] : [];
  });
}

/** Checks the `model_eval` setting. Returns null and adds problems when it is malformed. */
export function parseModelEvalSettings(
  value: Json | undefined,
  problems: string[],
): ModelEvalSettings | null {
  const where = MODEL_EVAL_SETTING;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  checkKeys(
    where,
    value,
    ["capUsd", "weekly", "baseline", "baselineCadence", "keyPaths"],
    problems,
  );
  const { capUsd, baselineCadence, keyPaths } = value;
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd <= 0) {
    problems.push(`${where}.capUsd must be a number above 0`);
  }
  const weekly = parseEntries(`${where}.weekly`, value.weekly, problems);
  const baseline = parseEntries(`${where}.baseline`, value.baseline, problems);
  if (Array.isArray(value.weekly) && value.weekly.length === 0) {
    problems.push(`${where}.weekly must name at least one model`);
  }
  const all = [...weekly, ...baseline];
  if (all.length > MAX_PLAN_ENTRIES) {
    problems.push(`${where} must have at most ${MAX_PLAN_ENTRIES} models in all`);
  }
  const seen = new Set<string>();
  for (const entry of all) {
    const key = `${entry.provider} ${entry.model}`;
    if (seen.has(key)) problems.push(`${where} names a model twice on one provider`);
    seen.add(key);
  }
  if (!BASELINE_CADENCES.includes(baselineCadence as BaselineCadence)) {
    problems.push(`${where}.baselineCadence must be ${BASELINE_CADENCES.join(", ")}`);
  }
  const paths: Record<string, string> = {};
  if (!isRecord(keyPaths)) {
    problems.push(`${where}.keyPaths must be an object of provider names`);
  } else {
    for (const [provider, path] of Object.entries(keyPaths)) {
      // D-433: the weekly test's own keys only, never a project's or the platform's.
      if (!PROVIDER_NAME.test(provider) || path !== evalKeyPath(provider)) {
        problems.push(
          `${where}.keyPaths.${PROVIDER_NAME.test(provider) ? provider : "(a key)"} must be ${EVAL_KEY_PATH_PREFIX}<provider>`,
        );
      } else {
        paths[provider] = path;
      }
    }
    for (const provider of new Set(all.map((e) => e.provider))) {
      if (!Object.hasOwn(keyPaths, provider)) {
        problems.push(`${where}.keyPaths has no key path for ${provider}`);
      }
    }
  }
  if (problems.length > before) return null;
  return {
    capUsd: capUsd as number,
    weekly,
    baseline,
    baselineCadence: baselineCadence as BaselineCadence,
    keyPaths: paths,
  };
}

// ---- The plan --------------------------------------------------------------------------------

/** One model of the week's plan: the test job's plan entry, and whether it is the baseline. */
export interface EvalPlanEntry {
  model: string;
  provider: string;
  tier: ServiceTier;
  /** The catalog's price for the model, as a run records it (`runs.model_price`). */
  price: RunPrice;
  roles: EvalRole[];
  baseline: boolean;
}

/** Why a model was left out of the plan (ADR 0114 hard rule 2). */
export type LeftOutReason = "not_in_catalog" | "other_provider" | "no_price_for_tier";

export const LEFT_OUT_TEXT: Readonly<Record<LeftOutReason, string>> = {
  not_in_catalog: "the model catalog does not list it",
  other_provider: "the model catalog lists it under another provider",
  no_price_for_tier:
    "the model catalog has no Standard price for it, or no price for its tier",
};

export interface LeftOutModel {
  model: string;
  provider: string;
  reason: LeftOutReason;
}

function planEntry(
  catalog: ModelCatalog,
  entry: EvalSettingEntry,
  baseline: boolean,
): EvalPlanEntry | LeftOutModel {
  const left = (reason: LeftOutReason): LeftOutModel => ({
    model: entry.model,
    provider: entry.provider,
    reason,
  });
  if (!Object.hasOwn(catalog.models, entry.model)) return left("not_in_catalog");
  const model = catalog.models[entry.model];
  if (model.provider !== entry.provider) return left("other_provider");
  // The test job refuses a price without Standard, and so does a run (ADR 0114 section 8). The
  // tier must be one the provider has for the model, priced, so each run is billed at it.
  if (
    !model.pricePerMTok.standard ||
    !model.tiers.includes(entry.tier) ||
    !model.pricePerMTok[entry.tier]
  ) {
    return left("no_price_for_tier");
  }
  return {
    model: entry.model,
    provider: entry.provider,
    tier: entry.tier,
    price: runPriceOf(model),
    roles: [...entry.roles],
    baseline,
  };
}

/** The week's plan: the weekly models, and Claude's baseline when `baseline` is true. */
export function weekPlan(
  settings: ModelEvalSettings,
  catalog: ModelCatalog,
  baseline: boolean,
): { entries: EvalPlanEntry[]; leftOut: LeftOutModel[] } {
  const entries: EvalPlanEntry[] = [];
  const leftOut: LeftOutModel[] = [];
  const planned = [
    ...settings.weekly.map((e) => [e, false] as const),
    ...(baseline ? settings.baseline.map((e) => [e, true] as const) : []),
  ];
  for (const [entry, isBaseline] of planned) {
    const made = planEntry(catalog, entry, isBaseline);
    if ("price" in made) entries.push(made);
    else leftOut.push(made);
  }
  return { entries, leftOut };
}

// ---- Weeks, months and spend -----------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The Sunday (UTC) on or before `at`, as `YYYY-MM-DD`: the day its week starts. */
export function weekStartOf(at: Date): string {
  const day = new Date(at.getTime() - at.getUTCDay() * DAY_MS);
  return day.toISOString().slice(0, 10);
}

/** The week that starts `weeks` weeks before the week of `at`. */
export function weeksBefore(at: Date, weeks: number): string {
  return weekStartOf(new Date(at.getTime() - weeks * 7 * DAY_MS));
}

const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

/**
 * Whether this week's Job includes Claude's baseline: no started run of a baseline entry belongs
 * to a Job that started in the same calendar month as `now` (UTC). `jobs` must hold this month's.
 */
export function baselineDue(
  now: Date,
  jobs: readonly ModelEvalJob[],
  results: readonly ModelEvalResult[],
): boolean {
  const month = monthOf(now);
  const inMonth = new Set(
    jobs.filter((j) => monthOf(j.startedAt) === month).map((j) => j.id),
  );
  return !results.some(
    (r) => inMonth.has(r.jobId) && r.baseline && r.outcome !== "skipped",
  );
}

/**
 * Why a Job ended without its result stored (`model_eval_jobs.reason`). Only `start_failed`
 * leaves the spend known: its Job never ran.
 */
export const JOB_FAILURES = [
  "start_failed",
  "deadline",
  "did_not_end",
  "job_gone",
  "job_failed",
  "bad_result",
] as const;
export type JobFailure = (typeof JOB_FAILURES)[number];

export const JOB_FAILURE_TEXT: Readonly<Record<JobFailure, string>> = {
  start_failed: "the cluster refused its objects, so it never ran",
  deadline: "it passed its deadline",
  did_not_end: "it did not end in time, so the runner stopped it",
  job_gone: "its Job was deleted before its result was read",
  job_failed: "it failed",
  bad_result: "its result did not pass the runner's check",
};

/**
 * What this week's Jobs spent, from the stored Jobs (D-204: one cap a week): each finished Job's
 * total. Null when one ended without a readable result after it may have run, or is still open:
 * its spend is unknown, so the week's cap counts as spent.
 */
export function weekSpentUsd(weekJobs: readonly ModelEvalJob[]): number | null {
  let spent = 0;
  for (const job of weekJobs) {
    if (job.end === null || job.end.spentUsd === null) return null;
    spent += job.end.spentUsd;
  }
  return Math.round(spent * 1_000_000) / 1_000_000;
}

// ---- The sizes -------------------------------------------------------------------------------

/** A case of the set, as the runner knows it from its own copy of `eval/cases/`. */
export interface EvalCaseRef {
  id: string;
  role: EvalRole;
}

export interface EvalSizing {
  /** The planned runs: each case on each plan entry that covers its role. */
  runs: number;
  /** The proxy's request ceiling for the whole Job. */
  maxModelRequests: number;
  /** The answers with 429 the proxy lets through for the whole Job. */
  maxRejectedModelRequests: number;
  /** The Job's deadline: every run's minute limit and the Job's start. */
  deadlineMinutes: number;
}

/**
 * The Job's sizes for the plan (see above), or null when it plans no run, more runs than the
 * test job takes, or more time than one day.
 */
export function evalSizing(
  cases: readonly EvalCaseRef[],
  entries: readonly EvalPlanEntry[],
  limits: (role: EvalRole) => RunLimits,
  capacity: RunCapacityLimits,
): EvalSizing | null {
  let runs = 0;
  let requests = 0;
  let minutes = 0;
  for (const c of cases) {
    const own = limits(c.role);
    for (const entry of entries) {
      if (!entry.roles.includes(c.role)) continue;
      runs += EVAL_RUNS_PER_CASE;
      requests += EVAL_RUNS_PER_CASE * (own.maxTurns + capacity.flexCapacityRetries);
      minutes += EVAL_RUNS_PER_CASE * own.maxMinutes;
    }
  }
  const deadlineMinutes = minutes + EVAL_START_MINUTES;
  if (
    runs === 0 ||
    runs > EVAL_MAX_RUNS ||
    deadlineMinutes > EVAL_MAX_DEADLINE_MINUTES
  ) {
    return null;
  }
  return {
    runs,
    maxModelRequests: Math.min(requests, EVAL_MAX_MODEL_REQUESTS),
    maxRejectedModelRequests: Math.min(
      runs * capacity.maxRejectedModelRequests,
      EVAL_MAX_REJECTED_MODEL_REQUESTS,
    ),
    deadlineMinutes,
  };
}

// ---- Whether this week starts a Job ----------------------------------------------------------

export type NotStartedReason =
  | "job_running"
  | "spend_unknown"
  | "cap_spent"
  | "week_done"
  | "no_model"
  | "plan_too_large";

export const NOT_STARTED_TEXT: Readonly<Record<NotStartedReason, string>> = {
  job_running: "a weekly model test Job is still running",
  spend_unknown:
    "a Job of this week ended without a result after it may have run, so the week's spend is unknown and its cap counts as spent",
  cap_spent: "this week's Jobs have spent the weekly cap",
  week_done: "this week's Job has already run",
  no_model: "no model of the plan has a usable catalog price",
  plan_too_large:
    "the plan has no case to run, more runs than the test job takes, or more than a day of run time",
};

export interface WeekStartInput {
  now: Date;
  settings: ModelEvalSettings;
  catalog: ModelCatalog;
  cases: readonly EvalCaseRef[];
  /** A role's limits for its case task type, from its bot file. */
  limits: (role: EvalRole) => RunLimits;
  capacity: RunCapacityLimits;
  /** The stored Jobs since the start of the month and of the week, and every open one. */
  jobs: readonly ModelEvalJob[];
  /** Their results. */
  results: readonly ModelEvalResult[];
}

export type WeekStart =
  | {
      start: true;
      weekStart: string;
      baseline: boolean;
      entries: EvalPlanEntry[];
      leftOut: LeftOutModel[];
      capUsd: number;
      spentBeforeUsd: number;
      sizing: EvalSizing;
      deadlineAt: Date;
      /** The key paths of the providers the plan uses, by provider: only these are read. */
      keyPaths: Record<string, string>;
    }
  | { start: false; reason: NotStartedReason; leftOut: LeftOutModel[] };

/** Whether the week starts a Job now, and with what (see above). */
export function planWeekStart(input: WeekStartInput): WeekStart {
  const { now, settings } = input;
  const no = (reason: NotStartedReason, leftOut: LeftOutModel[] = []): WeekStart => ({
    start: false,
    reason,
    leftOut,
  });
  if (input.jobs.some((j) => j.end === null)) return no("job_running");
  const weekStart = weekStartOf(now);
  const weekJobs = input.jobs.filter((j) => j.weekStart === weekStart);
  const spent = weekSpentUsd(weekJobs);
  if (spent === null) return no("spend_unknown");
  if (spent >= settings.capUsd) return no("cap_spent");
  if (weekJobs.some((j) => j.end?.outcome === "finished")) return no("week_done");
  const baseline =
    settings.baseline.length > 0 && baselineDue(now, input.jobs, input.results);
  const { entries, leftOut } = weekPlan(settings, input.catalog, baseline);
  if (entries.length === 0) return no("no_model", leftOut);
  const sizing = evalSizing(input.cases, entries, input.limits, input.capacity);
  if (sizing === null) return no("plan_too_large", leftOut);
  const keyPaths: Record<string, string> = {};
  for (const { provider } of entries) keyPaths[provider] = settings.keyPaths[provider];
  return {
    start: true,
    weekStart,
    baseline: entries.some((e) => e.baseline),
    entries,
    leftOut,
    capUsd: settings.capUsd,
    spentBeforeUsd: spent,
    sizing,
    deadlineAt: new Date(now.getTime() + sizing.deadlineMinutes * 60_000),
    keyPaths,
  };
}

/** The plan as the test job reads it (`FOREMAN_EVAL_PLAN`): the entries without `baseline`. */
export function jobPlan(entries: readonly EvalPlanEntry[]): Json {
  return entries.map(({ model, provider, tier, price, roles }) => ({
    model,
    provider,
    tier,
    price: price as unknown as Json,
    roles: [...roles],
  }));
}

/** The plan as the Job's row keeps it (`model_eval_jobs.plan`): each entry and its baseline flag. */
export function storedPlan(entries: readonly EvalPlanEntry[]): Json {
  return entries.map((e) => ({
    model: e.model,
    provider: e.provider,
    tier: e.tier,
    price: e.price as unknown as Json,
    roles: [...e.roles],
    baseline: e.baseline,
  }));
}

/** A Job's stored plan entry, as `storedPlan` wrote it, without its price. */
export type StoredPlanEntry = Omit<EvalPlanEntry, "price">;

/** The entries of a Job's stored plan. Throws, naming no value, when it is not one. */
export function storedPlanEntries(plan: Json): StoredPlanEntry[] {
  if (!Array.isArray(plan)) throw new Error("the Job's stored plan is not a list");
  return plan.map((value, i) => {
    const e = isRecord(value) ? value : {};
    const { model, provider, tier, roles, baseline } = e;
    if (
      typeof model !== "string" ||
      typeof provider !== "string" ||
      !TIERS.includes(tier as ServiceTier) ||
      !Array.isArray(roles) ||
      !roles.every((r) => EVAL_ROLES.includes(r as EvalRole)) ||
      typeof baseline !== "boolean"
    ) {
      throw new Error(`the Job's stored plan entry ${i + 1} is not one`);
    }
    return {
      model,
      provider,
      tier: tier as ServiceTier,
      roles: roles as EvalRole[],
      baseline,
    };
  });
}

// ---- The Job's port --------------------------------------------------------------------------

/** What the weekly flow starts the week's Job with (src/adapters/agent-runtime/kubernetes/eval-jobs.ts). */
export interface EvalJobSpec {
  jobId: string;
  entries: EvalPlanEntry[];
  /** The cases to run, in id order (`FOREMAN_EVAL_CASES`). */
  caseIds: string[];
  capUsd: number;
  spentBeforeUsd: number;
  sizing: EvalSizing;
  flexCapacityRetries: number;
  /** Each provider's key path, for the providers the plan uses (D-433). */
  keyPaths: Record<string, string>;
}

/** What reading a started Job gives (see the port). */
export type EvalJobCollect =
  | { state: "running" }
  | { state: "finished"; result: EvalJobResult }
  | {
      state: "failed";
      reason: Exclude<JobFailure, "start_failed">;
      /** The Job's own error text, plain words only, or null. */
      detail: string | null;
    };

/** The weekly test's Job port (D-432, D-433, O-156). Tests pass a fake. */
export interface EvalJobs {
  /** Whether the test job's image is pinned (`runSettings.evalImage`). */
  imagePinned(): Promise<boolean>;
  /**
   * Creates the Job, its egress proxy, their NetworkPolicies and the key Secret in the weekly
   * test's namespace. `keys` holds each key by its path. A failure deletes what it made.
   */
  start(spec: EvalJobSpec, keys: Readonly<Record<string, string>>): Promise<void>;
  /**
   * Reads a started Job: still running, or ended with its checked result or a failure. Once the
   * Job has ended, or is still running at `boundAt`, its key Secret and its proxy go first.
   */
  collect(jobId: string, boundAt: Date): Promise<EvalJobCollect>;
  /** Deletes every object of the Job, whatever is left. */
  remove(jobId: string): Promise<void>;
}
