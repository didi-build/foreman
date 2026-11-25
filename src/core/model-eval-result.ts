// The weekly model test Job's result as the runner reads it (ADR 0117, D-430, D-432, O-155,
// O-156): the `structured` part of the Job's result line, checked as untrusted data before
// anything is stored, then turned into one results row per run.
//
// The contract is the test job's (src/agent-images/eval/result.ts, `checkEvalResult`). The core
// cannot import the image's code (ADR 0101: the core imports nothing outside itself), and that
// code reads the case files, so this is the same check written again: exact fields, every bound,
// each reason of its outcome, facts only for a usable answer and the totals' counts.
// test/model-eval-contract.test.ts holds the two checks to the same answers, field lists, codes
// and bounds, so neither can drift. Errors name the field, never a value.
import { MAX_PULL_INS } from "./discussion-record.ts";
import type { EvalPlanEntry, EvalRole } from "./model-eval.ts";
import { PERSONAS, type PersonaId } from "./personas.ts";
import type {
  Json,
  ModelEvalJob,
  ModelEvalResult,
  ServedTier,
  ServiceTier,
} from "./store.ts";

export const EVAL_OUTCOMES = [
  "correct",
  "wrong",
  "unusable",
  "error",
  "skipped",
] as const;
export type EvalOutcome = (typeof EVAL_OUTCOMES)[number];

/** Every reason code with its outcome: the scores' (src/eval/scoring.ts) and the runs' own. */
export const EVAL_REASONS: Readonly<Record<string, EvalOutcome>> = {
  as_expected: "correct",
  wrong_verdict: "wrong",
  no_accepted_finding: "wrong",
  wrong_item_count: "wrong",
  items_do_not_cover: "wrong",
  wrong_blocked_by: "wrong",
  wrong_flags: "wrong",
  should_resolve: "wrong",
  should_go_to_didi: "wrong",
  wrong_didi_reason: "wrong",
  answer_not_json: "unusable",
  answer_rejected: "unusable",
  citation_not_at_head: "unusable",
  discussion_rejected: "unusable",
  provider_error: "error",
  endpoint_unreachable: "error",
  max_turns: "error",
  max_usd: "error",
  cap_limit: "error",
  max_minutes: "error",
  output_limit: "error",
  refused: "error",
  unknown_stop: "error",
  run_error: "error",
  cap_reached: "skipped",
};

/** The bounds of the result (the test job's own). */
export const EVAL_RESULT_BOUNDS = {
  maxRuns: 300,
  maxPlanEntries: 8,
  maxFindingPaths: 5,
  maxItemCount: 1000,
  /** A Council discussion's cast in the facts: every persona but the chair (ADR 0119 slice 6e). */
  maxCast: PERSONAS.length - 1,
  /** A Council discussion's pull-ins in the facts (D-464). */
  maxPullIns: MAX_PULL_INS,
} as const;
/** The most bytes of the Job's log the runner reads: the result line and its frame. */
export const EVAL_RESULT_LOG_BYTES = 1024 * 1024;

const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_ID =
  /^(?=.{1,200}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const PROVIDER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FACT_PATH =
  /^(?=.{1,200}$)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
const ERROR_TYPE = /^[a-z0-9_]{0,64}$/;
const ROLES: readonly EvalRole[] = ["qa", "triage", "council"];
const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];
const SERVED: readonly ServedTier[] = [...TIERS, "mixed"];
const TOKEN_FIELDS = [
  "uncachedInput",
  "cachedInput",
  "cacheWriteInput",
  "output",
] as const;

export type EvalFacts =
  | { verdict: "pass" | "fail"; findingPaths: string[] }
  | { itemCount: number }
  | {
      outcome: "resolve" | "cannot_resolve";
      changesProductDirection: boolean;
      passesGate: boolean;
      /**
       * The discussion's cast and pull-ins, persona ids only (ADR 0119 slice 6e). Both or neither:
       * a weekly test image from before slice 6e, still pinned until slice 6f, gives neither.
       */
      cast?: PersonaId[];
      pullIns?: { persona: PersonaId; by: PersonaId }[];
    };

export interface EvalRunRecord {
  caseId: string;
  caseVersion: number;
  role: EvalRole;
  model: string;
  provider: string;
  tier: ServiceTier;
  outcome: EvalOutcome;
  reason: string;
  turns: number;
  tokens: {
    uncachedInput: number;
    cachedInput: number;
    cacheWriteInput: number;
    output: number;
  };
  costUsd: number;
  serviceTierServed: ServedTier | null;
  minutes: number;
  providerError?: { status: number | null; type: string };
  facts?: EvalFacts;
}

export interface EvalJobResult {
  evalResult: 1;
  runId: string;
  capUsd: number;
  spentBeforeUsd: number;
  runs: EvalRunRecord[];
  totals: {
    spentUsd: number;
    runs: number;
    skipped: number;
    models: {
      model: string;
      provider: string;
      runs: number;
      correct: number;
      costUsd: number;
    }[];
  };
}

export class EvalJobResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalJobResultError";
  }
}

type Fields = Record<string, unknown>;

const fail = (at: string, problem: string): never => {
  throw new EvalJobResultError(`the test job's result: ${at} ${problem}`);
};
const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function object(
  value: unknown,
  at: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields {
  if (!isObject(value)) return fail(at, "is not an object");
  for (const key of required) if (!(key in value)) fail(at, `has no ${key}`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key))
      fail(at, "has an unknown field");
  }
  return value;
}
function count(value: unknown, at: string, max = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  ) {
    fail(at, "is not a count in its bound");
  }
  return value as number;
}
function amount(value: unknown, at: string, positive = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (positive && value === 0)
  ) {
    fail(at, positive ? "is not an amount above 0" : "is not an amount");
  }
  return value as number;
}
function matching(value: unknown, at: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(at, "is not in its form");
  return value as string;
}
function oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) fail(at, "is not one of its values");
  return value as T;
}
function list(value: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    fail(at, `is not a list of at most ${max}`);
  return value as unknown[];
}

function readFacts(value: unknown, at: string, role: EvalRole): EvalFacts {
  if (role === "qa") {
    const f = object(value, at, ["verdict", "findingPaths"]);
    return {
      verdict: oneOf(f.verdict, `${at}.verdict`, ["pass", "fail"] as const),
      findingPaths: list(
        f.findingPaths,
        `${at}.findingPaths`,
        EVAL_RESULT_BOUNDS.maxFindingPaths,
      ).map((path, i) => matching(path, `${at}.findingPaths[${i}]`, FACT_PATH)),
    };
  }
  if (role === "triage") {
    const f = object(value, at, ["itemCount"]);
    return {
      itemCount: count(f.itemCount, `${at}.itemCount`, EVAL_RESULT_BOUNDS.maxItemCount),
    };
  }
  const f = object(
    value,
    at,
    ["outcome", "changesProductDirection", "passesGate"],
    ["cast", "pullIns"],
  );
  if (
    typeof f.changesProductDirection !== "boolean" ||
    typeof f.passesGate !== "boolean"
  ) {
    fail(at, "has a flag that is not true or false");
  }
  const facts = {
    outcome: oneOf(f.outcome, `${at}.outcome`, ["resolve", "cannot_resolve"] as const),
    changesProductDirection: f.changesProductDirection as boolean,
    passesGate: f.passesGate as boolean,
  };
  // The discussion's two facts come together, or not at all from an image before slice 6e.
  if ("cast" in f !== "pullIns" in f) fail(at, "has one of cast and pullIns only");
  if (!("cast" in f)) return facts;
  return {
    ...facts,
    cast: list(f.cast, `${at}.cast`, EVAL_RESULT_BOUNDS.maxCast).map((id, i) =>
      oneOf(id, `${at}.cast[${i}]`, PERSONAS),
    ),
    pullIns: list(f.pullIns, `${at}.pullIns`, EVAL_RESULT_BOUNDS.maxPullIns).map(
      (entry, i) => {
        const p = object(entry, `${at}.pullIns[${i}]`, ["persona", "by"]);
        return {
          persona: oneOf(p.persona, `${at}.pullIns[${i}].persona`, PERSONAS),
          by: oneOf(p.by, `${at}.pullIns[${i}].by`, PERSONAS),
        };
      },
    ),
  };
}

const RECORD_FIELDS = [
  "caseId",
  "caseVersion",
  "role",
  "model",
  "provider",
  "tier",
  "outcome",
  "reason",
  "turns",
  "tokens",
  "costUsd",
  "serviceTierServed",
  "minutes",
] as const;

function readRecord(value: unknown, at: string): EvalRunRecord {
  const r = object(value, at, RECORD_FIELDS, ["providerError", "facts"]);
  const role = oneOf(r.role, `${at}.role`, ROLES);
  const outcome = oneOf(r.outcome, `${at}.outcome`, EVAL_OUTCOMES);
  const reason = matching(r.reason, `${at}.reason`, /^[a-z_]{1,40}$/);
  if (!Object.hasOwn(EVAL_REASONS, reason) || EVAL_REASONS[reason] !== outcome) {
    fail(`${at}.reason`, "is not a reason of its outcome");
  }
  const t = object(r.tokens, `${at}.tokens`, TOKEN_FIELDS);
  const record: EvalRunRecord = {
    caseId: matching(r.caseId, `${at}.caseId`, CASE_ID),
    caseVersion: count(r.caseVersion, `${at}.caseVersion`),
    role,
    model: matching(r.model, `${at}.model`, MODEL_ID),
    provider: matching(r.provider, `${at}.provider`, PROVIDER_NAME),
    tier: oneOf(r.tier, `${at}.tier`, TIERS),
    outcome,
    reason,
    turns: count(r.turns, `${at}.turns`),
    tokens: {
      uncachedInput: count(t.uncachedInput, `${at}.tokens.uncachedInput`),
      cachedInput: count(t.cachedInput, `${at}.tokens.cachedInput`),
      cacheWriteInput: count(t.cacheWriteInput, `${at}.tokens.cacheWriteInput`),
      output: count(t.output, `${at}.tokens.output`),
    },
    costUsd: amount(r.costUsd, `${at}.costUsd`),
    serviceTierServed:
      r.serviceTierServed === null
        ? null
        : oneOf(r.serviceTierServed, `${at}.serviceTierServed`, SERVED),
    minutes: amount(r.minutes, `${at}.minutes`),
  };
  if (record.caseVersion < 1) fail(`${at}.caseVersion`, "is not a count in its bound");
  if ((reason === "provider_error") !== (r.providerError !== undefined)) {
    fail(
      `${at}.providerError`,
      "is given for a provider error only, and always for one",
    );
  }
  if (r.providerError !== undefined) {
    const e = object(r.providerError, `${at}.providerError`, ["status", "type"]);
    record.providerError = {
      status:
        e.status === null ? null : count(e.status, `${at}.providerError.status`, 599),
      type: matching(e.type, `${at}.providerError.type`, ERROR_TYPE),
    };
  }
  const usable = outcome === "correct" || outcome === "wrong";
  if (usable !== (r.facts !== undefined)) {
    fail(`${at}.facts`, "is given for a usable answer only, and always for one");
  }
  if (r.facts !== undefined) record.facts = readFacts(r.facts, `${at}.facts`, role);
  return record;
}

/**
 * The Job's `structured` result, checked (see above). Throws `EvalJobResultError` naming the
 * field, never a value.
 */
export function readEvalJobResult(value: unknown): EvalJobResult {
  const { maxRuns, maxPlanEntries } = EVAL_RESULT_BOUNDS;
  const v = object(value, "the result", [
    "evalResult",
    "runId",
    "capUsd",
    "spentBeforeUsd",
    "runs",
    "totals",
  ]);
  if (v.evalResult !== 1) fail("evalResult", "is not 1");
  const runs = list(v.runs, "runs", maxRuns).map((r, i) => readRecord(r, `runs[${i}]`));
  const t = object(v.totals, "totals", ["spentUsd", "runs", "skipped", "models"]);
  const totals: EvalJobResult["totals"] = {
    spentUsd: amount(t.spentUsd, "totals.spentUsd"),
    runs: count(t.runs, "totals.runs", maxRuns),
    skipped: count(t.skipped, "totals.skipped", maxRuns),
    models: list(t.models, "totals.models", maxPlanEntries).map((m, i) => {
      const at = `totals.models[${i}]`;
      const f = object(m, at, ["model", "provider", "runs", "correct", "costUsd"]);
      const total = {
        model: matching(f.model, `${at}.model`, MODEL_ID),
        provider: matching(f.provider, `${at}.provider`, PROVIDER_NAME),
        runs: count(f.runs, `${at}.runs`, maxRuns),
        correct: count(f.correct, `${at}.correct`, maxRuns),
        costUsd: amount(f.costUsd, `${at}.costUsd`),
      };
      if (total.correct > total.runs) fail(`${at}.correct`, "is more than its runs");
      return total;
    }),
  };
  const skipped = runs.filter((r) => r.outcome === "skipped").length;
  if (totals.skipped !== skipped || totals.runs !== runs.length - skipped) {
    fail("totals", "do not count the runs");
  }
  return {
    evalResult: 1,
    runId: matching(v.runId, "runId", RUN_ID),
    capUsd: amount(v.capUsd, "capUsd", true),
    spentBeforeUsd: amount(v.spentBeforeUsd, "spentBeforeUsd"),
    runs,
    totals,
  };
}

/**
 * The checked result against the Job it came from: its id, cap and spend so far as the Job was
 * given them, and every run on a model of its plan. Throws `EvalJobResultError`.
 */
export function checkResultOfJob(
  result: EvalJobResult,
  job: Pick<ModelEvalJob, "id" | "capUsd" | "spentBeforeUsd">,
  entries: readonly Pick<EvalPlanEntry, "model" | "provider" | "tier" | "roles">[],
): void {
  if (result.runId !== job.id) fail("runId", "is not the Job's id");
  if (result.capUsd !== job.capUsd) fail("capUsd", "is not the Job's cap");
  if (result.spentBeforeUsd !== job.spentBeforeUsd) {
    fail("spentBeforeUsd", "is not what the Job was told");
  }
  result.runs.forEach((r, i) => {
    const entry = entries.find((e) => e.model === r.model && e.provider === r.provider);
    if (!entry || entry.tier !== r.tier || !entry.roles.includes(r.role)) {
      fail(`runs[${i}]`, "is not on a model of the Job's plan");
    }
  });
}

/** A run's facts as the results row keeps them. */
function factsJson(facts: EvalFacts): Json {
  if ("findingPaths" in facts) {
    return { verdict: facts.verdict, findingPaths: [...facts.findingPaths] };
  }
  if ("itemCount" in facts) return { itemCount: facts.itemCount };
  return {
    outcome: facts.outcome,
    changesProductDirection: facts.changesProductDirection,
    passesGate: facts.passesGate,
    ...(facts.cast ? { cast: [...facts.cast] } : {}),
    ...(facts.pullIns
      ? { pullIns: facts.pullIns.map(({ persona, by }) => ({ persona, by })) }
      : {}),
  };
}

/** One results row per run of the checked result, in the Job's order. */
export function resultRows(
  job: Pick<ModelEvalJob, "id">,
  result: EvalJobResult,
  entries: readonly Pick<EvalPlanEntry, "model" | "provider" | "baseline">[],
  ids: { next(): string },
  recordedAt: Date,
  recordedBy: string,
): ModelEvalResult[] {
  return result.runs.map((r, i) => ({
    id: ids.next(),
    jobId: job.id,
    seq: i + 1,
    caseId: r.caseId,
    caseVersion: r.caseVersion,
    role: r.role,
    model: r.model,
    provider: r.provider,
    tier: r.tier,
    baseline: entries.some(
      (e) => e.model === r.model && e.provider === r.provider && e.baseline,
    ),
    outcome: r.outcome,
    reason: r.reason,
    turns: r.turns,
    tokens: { ...r.tokens },
    costUsd: r.costUsd,
    serviceTierServed: r.serviceTierServed,
    minutes: r.minutes,
    providerError: r.providerError ? { ...r.providerError } : null,
    facts: r.facts ? factsJson(r.facts) : null,
    recordedBy,
    recordedAt,
  }));
}
