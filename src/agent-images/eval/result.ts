// The weekly test job's result (ADR 0117, D-432): what the job hands back in its one result line.
// The line is the shared agent result line (version 1 of `AgentResult`, ../shared/result.ts).
// `status` is `success` when the job ran its plan, with an `EvalResult` as `structured` and the
// job's spend as `costUsd`; it is `error`, with a fixed `errorText` and nothing else, when the job
// could not start: a bad setting, a broken plan, unreadable cases or bot files, a case the
// runner's builders refuse, or a proxy that never became ready.
//
// The runner reads the line from the pod's log as it reads the repo map Job's
// (src/adapters/agent-runtime/kubernetes/repo-maps.ts: `parseAgentResult`, then a strict check),
// with at most `EVAL_RESULT_LOG_BYTES` of the log, and checks `structured` with
// `checkEvalResult` before it records anything. The image checks its own result the same way
// before printing, so a result the runner would refuse fails in the job.
//
// Everything in it is bounded and checked: counts, amounts, fixed codes, ids and names in their
// forms, and from each answer only facts the runner's own checks read (src/eval/scoring.ts):
// QA's verdict and the files its findings name (at most `MAX_FINDING_PATHS`, each a plain path),
// Triage's item count, the Council's outcome and its two flags, and its discussion's cast and
// pull-ins as persona ids (at most `MAX_CAST` and `MAX_PULL_IN_FACTS`, ADR 0119 slice 6e; both or
// neither, since a test image from before slice 6e gives neither). No text the model wrote is in
// it, and no provider error message: a provider error gives only its status and its type.
import { MAX_PULL_INS } from "../../core/discussion-record.ts";
import { PERSONAS } from "../../core/personas.ts";
import type { RunTokens } from "../../core/runs.ts";
import type { ServedTier, ServiceTier } from "../../core/store.ts";
import { CASE_ID, type EvalRole } from "../../eval/cases.ts";
import { SCORE_CODES, type AnswerFacts } from "../../eval/scoring.ts";
import { MODEL_ID, RUN_ID } from "../shared/settings.ts";

export const OUTCOMES = ["correct", "wrong", "unusable", "error", "skipped"] as const;
export type EvalOutcome = (typeof OUTCOMES)[number];

/**
 * The reasons of a run that did not reach scoring, each with its outcome. `cap_limit`: the run's
 * dollar limit was what was left of the week's cap, and it reached it. `cap_reached`: the week's
 * spend had reached the cap before the run, so it never started.
 */
export const RUN_REASONS = {
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
} as const satisfies Record<string, EvalOutcome>;

/** Every reason code with its outcome: the scores' (src/eval/scoring.ts) and the runs' own. */
export const REASONS: Readonly<Record<string, EvalOutcome>> = {
  ...SCORE_CODES,
  ...RUN_REASONS,
};
export type EvalReason = keyof typeof SCORE_CODES | keyof typeof RUN_REASONS;

/** The most runs one result holds: cases times the plan's entries that cover them. */
export const MAX_RUNS = 300;
/** The most entries a plan has (src/agent-images/eval/plan.ts). */
export const MAX_PLAN_ENTRIES = 8;
/** The most files of QA's findings a run's facts name. */
export const MAX_FINDING_PATHS = 5;
/** A file named in the facts: plain path parts, none `.` or `..`, at most 200 characters. */
export const FACT_PATH =
  /^(?=.{1,200}$)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
/** A provider's name, as the egress proxy takes it (src/egress-proxy/providers.ts). */
export const PROVIDER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** A provider error's type, as Anthropic and the OpenAI-style APIs name them. */
const ERROR_TYPE = /^[a-z0-9_]{0,64}$/;
/** The most Triage items the facts count, far above any plan's. */
const MAX_ITEM_COUNT = 1000;
/** The most personas a Council discussion's cast holds in the facts: every one but the chair. */
export const MAX_CAST = PERSONAS.length - 1;
/** The most pull-ins a Council discussion's facts name (D-464). */
export const MAX_PULL_IN_FACTS = MAX_PULL_INS;
/**
 * The most bytes of the job's log the runner reads: the result line, which its bounds keep below
 * this (result.test.ts builds the largest line they allow), and room for the line's frame.
 */
export const EVAL_RESULT_LOG_BYTES = 1024 * 1024;

export interface EvalRunRecord {
  caseId: string;
  caseVersion: number;
  role: EvalRole;
  model: string;
  provider: string;
  /** The tier the plan asked for. */
  tier: ServiceTier;
  outcome: EvalOutcome;
  reason: EvalReason;
  turns: number;
  tokens: Required<RunTokens>;
  /** Priced at the tier each response reported, from the plan's catalog price. */
  costUsd: number;
  /** One tier, `mixed`, or null when no response reported one (ADR 0114 section 8). */
  serviceTierServed: ServedTier | null;
  minutes: number;
  /** Only for `provider_error`: the provider's status and error type, never its message. */
  providerError?: { status: number | null; type: string };
  /** Only for a usable answer: `correct` or `wrong`. */
  facts?: AnswerFacts;
}

export interface EvalModelTotal {
  model: string;
  provider: string;
  /** Runs that started. */
  runs: number;
  correct: number;
  costUsd: number;
}

export interface EvalTotals {
  /** What this job spent; `spentBeforeUsd` is not in it. */
  spentUsd: number;
  /** Runs that started. */
  runs: number;
  skipped: number;
  /** One per plan entry, in the plan's order. */
  models: EvalModelTotal[];
}

export interface EvalResult {
  evalResult: 1;
  runId: string;
  capUsd: number;
  /** What earlier runs of the week had spent before this job, as the job was told. */
  spentBeforeUsd: number;
  /** In the job's order: cases by id, then the plan's entries in order. */
  runs: EvalRunRecord[];
  totals: EvalTotals;
}

/** An amount in US dollars, rounded as the loop rounds a run's cost. */
export const roundUsd = (usd: number): number =>
  Math.round(usd * 1_000_000) / 1_000_000;

/** QA's facts cut to their bounds: plain paths only, at most `MAX_FINDING_PATHS`. */
export function boundFacts(facts: AnswerFacts): AnswerFacts {
  if (!("findingPaths" in facts)) return facts;
  return {
    verdict: facts.verdict,
    findingPaths: facts.findingPaths
      .filter((path) => FACT_PATH.test(path))
      .slice(0, MAX_FINDING_PATHS),
  };
}

/** A provider error as the record keeps it: the status and a type in its form, or "". */
export function boundProviderError(error: {
  status: number | null;
  type: string;
}): NonNullable<EvalRunRecord["providerError"]> {
  const status =
    error.status !== null && Number.isInteger(error.status) && error.status >= 100
      ? error.status <= 599
        ? error.status
        : null
      : null;
  return { status, type: ERROR_TYPE.test(error.type) ? error.type : "" };
}

/** The totals of the records, per plan entry in the plan's order. */
export function evalTotals(
  records: readonly EvalRunRecord[],
  entries: readonly { model: string; provider: string }[],
): EvalTotals {
  const started = records.filter((r) => r.outcome !== "skipped");
  const sum = (rs: readonly EvalRunRecord[]) =>
    roundUsd(rs.reduce((total, r) => total + r.costUsd, 0));
  return {
    spentUsd: sum(started),
    runs: started.length,
    skipped: records.length - started.length,
    models: entries.map(({ model, provider }) => {
      const own = started.filter((r) => r.model === model && r.provider === provider);
      return {
        model,
        provider,
        runs: own.length,
        correct: own.filter((r) => r.outcome === "correct").length,
        costUsd: sum(own),
      };
    }),
  };
}

// ---- The check -------------------------------------------------------------------------------

export class EvalResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalResultError";
  }
}

type Fields = Record<string, unknown>;

const fail = (at: string, problem: string): never => {
  throw new EvalResultError(`the test job's result: ${at} ${problem}`);
};
const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function object(
  value: unknown,
  at: string,
  required: string[],
  optional: string[] = [],
) {
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

const ROLES: readonly EvalRole[] = ["qa", "triage", "council"];
const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];
const SERVED: readonly ServedTier[] = [...TIERS, "mixed"];
const TOKEN_FIELDS = ["uncachedInput", "cachedInput", "cacheWriteInput", "output"];

function checkFacts(value: unknown, at: string, role: EvalRole): AnswerFacts {
  if (role === "qa") {
    const f = object(value, at, ["verdict", "findingPaths"]);
    return {
      verdict: oneOf(f.verdict, `${at}.verdict`, ["pass", "fail"] as const),
      findingPaths: list(f.findingPaths, `${at}.findingPaths`, MAX_FINDING_PATHS).map(
        (path, i) => matching(path, `${at}.findingPaths[${i}]`, FACT_PATH),
      ),
    };
  }
  if (role === "triage") {
    const f = object(value, at, ["itemCount"]);
    return { itemCount: count(f.itemCount, `${at}.itemCount`, MAX_ITEM_COUNT) };
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
    cast: list(f.cast, `${at}.cast`, MAX_CAST).map((id, i) =>
      oneOf(id, `${at}.cast[${i}]`, PERSONAS),
    ),
    pullIns: list(f.pullIns, `${at}.pullIns`, MAX_PULL_IN_FACTS).map((entry, i) => {
      const p = object(entry, `${at}.pullIns[${i}]`, ["persona", "by"]);
      return {
        persona: oneOf(p.persona, `${at}.pullIns[${i}].persona`, PERSONAS),
        by: oneOf(p.by, `${at}.pullIns[${i}].by`, PERSONAS),
      };
    }),
  };
}

function checkRecord(value: unknown, at: string): EvalRunRecord {
  const r = object(
    value,
    at,
    [
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
    ],
    ["providerError", "facts"],
  );
  const role = oneOf(r.role, `${at}.role`, ROLES);
  const outcome = oneOf(r.outcome, `${at}.outcome`, OUTCOMES);
  const reason = matching(r.reason, `${at}.reason`, /^[a-z_]{1,40}$/) as EvalReason;
  if (REASONS[reason] !== outcome)
    fail(`${at}.reason`, "is not a reason of its outcome");
  const t = object(r.tokens, `${at}.tokens`, TOKEN_FIELDS);
  const tokens = {
    uncachedInput: count(t.uncachedInput, `${at}.tokens.uncachedInput`),
    cachedInput: count(t.cachedInput, `${at}.tokens.cachedInput`),
    cacheWriteInput: count(t.cacheWriteInput, `${at}.tokens.cacheWriteInput`),
    output: count(t.output, `${at}.tokens.output`),
  };
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
    tokens,
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
  if (r.facts !== undefined) record.facts = checkFacts(r.facts, `${at}.facts`, role);
  return record;
}

function checkModelTotal(value: unknown, at: string): EvalModelTotal {
  const m = object(value, at, ["model", "provider", "runs", "correct", "costUsd"]);
  const total = {
    model: matching(m.model, `${at}.model`, MODEL_ID),
    provider: matching(m.provider, `${at}.provider`, PROVIDER_NAME),
    runs: count(m.runs, `${at}.runs`, MAX_RUNS),
    correct: count(m.correct, `${at}.correct`, MAX_RUNS),
    costUsd: amount(m.costUsd, `${at}.costUsd`),
  };
  if (total.correct > total.runs) fail(`${at}.correct`, "is more than its runs");
  return total;
}

/**
 * The job's `structured` result, checked: its exact fields, every bound above, each reason of
 * its outcome, facts only for a usable answer and the totals' counts against the runs. Throws
 * `EvalResultError` naming the field, never a value.
 */
export function checkEvalResult(value: unknown): EvalResult {
  const v = object(value, "the result", [
    "evalResult",
    "runId",
    "capUsd",
    "spentBeforeUsd",
    "runs",
    "totals",
  ]);
  if (v.evalResult !== 1) fail("evalResult", "is not 1");
  const runs = list(v.runs, "runs", MAX_RUNS).map((r, i) =>
    checkRecord(r, `runs[${i}]`),
  );
  const t = object(v.totals, "totals", ["spentUsd", "runs", "skipped", "models"]);
  const totals: EvalTotals = {
    spentUsd: amount(t.spentUsd, "totals.spentUsd"),
    runs: count(t.runs, "totals.runs", MAX_RUNS),
    skipped: count(t.skipped, "totals.skipped", MAX_RUNS),
    models: list(t.models, "totals.models", MAX_PLAN_ENTRIES).map((m, i) =>
      checkModelTotal(m, `totals.models[${i}]`),
    ),
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
