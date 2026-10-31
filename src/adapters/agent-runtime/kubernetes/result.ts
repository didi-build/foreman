// Reading how a run ended (ADR 0106 sections 4 and 6, ADR 0107). The agent image prints one JSON
// object as its last line of output: its result. This file defines that shape, parses it
// without ever throwing, and maps the Job's state and the result to a `runs.outcome`.
import type { RunTokens } from "../../../core/runs.ts";
import type {
  ServedTier,
  ServiceTier,
  UsageExhaustedCause,
} from "../../../core/store.ts";
import {
  CEILING_MESSAGE,
  REJECTED_CEILING_MESSAGE,
} from "../../../egress-proxy/proxy.ts";
import type { AgentRunResult } from "../runtime.ts";
import type { JobStatus } from "./objects.ts";

/**
 * What an agent image prints as its last line (version 1). The image's wrapper maps its
 * runtime's own output (for Claude Code, `--output-format json`) into it.
 *
 * ```json
 * { "foremanResult": 1, "status": "success", "finalText": "...", "turns": 3, "costUsd": 0.02,
 *   "tokens": { "uncachedInput": 10, "cachedInput": 900, "cacheWriteInput": 50, "output": 120 },
 *   "structured": { "verdict": "pass" },
 *   "errorText": "...", "providerError": { "status": 429, "type": "rate_limit_error",
 *   "message": "...", "retryAfterSeconds": 30 },
 *   "serviceTierServed": "flex", "capacityRetries": 1, "capacityWaitSeconds": 30,
 *   "firstTokenMs": 900 }
 * ```
 *
 * `status` is `success`, `error`, `max_turns` (the runtime's turn cap) or `max_budget` (its
 * dollar cap). `providerError` is the model provider's last error response, if the run ended on
 * one. Every field but `foremanResult` and `status` may be missing. The last four are what the
 * runtime measured about the route (ADR 0114 sections 2, 8 and 9), each only where it can: the
 * tier the provider's responses reported (one tier, or `mixed`), the Flex capacity rejections it
 * retried and the whole seconds it waited on them, and the time to the first output token.
 */
export interface AgentResult {
  status: "success" | "error" | "max_turns" | "max_budget";
  finalText: string;
  structured?: unknown;
  turns: number | null;
  costUsd: number | null;
  tokens: RunTokens | null;
  errorText: string;
  providerError: ProviderError | null;
  serviceTierServed?: ServedTier;
  capacityRetries?: number;
  capacityWaitSeconds?: number;
  firstTokenMs?: number;
}

export interface ProviderError {
  status: number | null;
  type: string;
  message: string;
  retryAfterSeconds: number | null;
}

const STATUSES = new Set(["success", "error", "max_turns", "max_budget"]);
const SERVED_TIERS: readonly ServedTier[] = ["standard", "flex", "priority", "mixed"];
const MAX_FINAL_TEXT = 64 * 1024;
const MAX_ERROR_TEXT = 4 * 1024;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

function tokens(value: unknown): RunTokens | null {
  if (!isObject(value)) return null;
  const { uncachedInput, cachedInput, cacheWriteInput, output } = value;
  if (!isCount(uncachedInput) || !isCount(cachedInput) || !isCount(output)) return null;
  return {
    uncachedInput,
    cachedInput,
    output,
    ...(isCount(cacheWriteInput) ? { cacheWriteInput } : {}),
  };
}

function providerError(value: unknown): ProviderError | null {
  if (!isObject(value)) return null;
  const status = isCount(value.status) && value.status <= 999 ? value.status : null;
  return {
    status,
    type: text(value.type, 64),
    message: text(value.message, MAX_ERROR_TEXT),
    retryAfterSeconds: isCount(value.retryAfterSeconds)
      ? value.retryAfterSeconds
      : null,
  };
}

/**
 * The agent's result from its log, or null if there is none. The last line that is a version 1
 * result counts. Never throws: bad output is a null, which the runner records as `fail`.
 */
export function parseAgentResult(log: string | null): AgentResult | null {
  if (!log) return null;
  const lines = log.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(value) || value.foremanResult !== 1) continue;
    if (typeof value.status !== "string" || !STATUSES.has(value.status)) return null;
    return {
      status: value.status as AgentResult["status"],
      finalText: text(value.finalText, MAX_FINAL_TEXT),
      ...(value.structured === undefined ? {} : { structured: value.structured }),
      turns: isCount(value.turns) ? value.turns : null,
      costUsd: isAmount(value.costUsd) ? value.costUsd : null,
      tokens: tokens(value.tokens),
      errorText: text(value.errorText, MAX_ERROR_TEXT),
      providerError: providerError(value.providerError),
      ...(SERVED_TIERS.includes(value.serviceTierServed as ServedTier)
        ? { serviceTierServed: value.serviceTierServed as ServedTier }
        : {}),
      ...(isCount(value.capacityRetries)
        ? { capacityRetries: value.capacityRetries }
        : {}),
      ...(isCount(value.capacityWaitSeconds)
        ? { capacityWaitSeconds: value.capacityWaitSeconds }
        : {}),
      ...(isCount(value.firstTokenMs) ? { firstTokenMs: value.firstTokenMs } : {}),
    };
  }
  return null;
}

export type JobState =
  "running" | "stopping" | "complete" | "deadline" | "failed" | "gone";

/** Where a Job is. Only Complete and Failed are ends: FailureTarget means pods still stop. */
export function jobState(job: JobStatus | null): JobState {
  if (job === null) return "gone";
  if (job.metadata.deletionTimestamp) return "stopping";
  const conditions = job.status?.conditions ?? [];
  const holds = (type: string) =>
    conditions.find((c) => c.type === type && c.status === "True");
  if (holds("Complete")) return "complete";
  const failed = holds("Failed");
  if (failed) return failed.reason === "DeadlineExceeded" ? "deadline" : "failed";
  return "running";
}

/** The run's minutes from the Job's own times, or null. */
export function jobMinutes(job: JobStatus | null): number | null {
  const start = Date.parse(job?.status?.startTime ?? "");
  const end = Date.parse(job?.status?.completionTime ?? "");
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round(((end - start) / 60_000) * 100) / 100;
}

/**
 * The overload errors a provider answers a busy Flex request with (ADR 0114 section 9):
 * DeepInfra's `engine_overloaded`, and the overload type of the Anthropic-style API. DeepInfra's
 * queue-timeout form is read in the rehearsal and added here then.
 */
export const FLEX_CAPACITY_ERROR_TYPES: readonly string[] = [
  "engine_overloaded",
  "overloaded_error",
];

/**
 * A Flex capacity rejection: a 429 with an overload error, on a run whose route asked for Flex.
 * Any other 429 is a rate limit. The runtimes that build their own requests retry this one error
 * inside the run (ADR 0114 section 9); the runner maps it to cause `capacity`.
 */
export function isFlexCapacityRejection(
  tier: ServiceTier,
  error: ProviderError | null,
): boolean {
  if (tier !== "flex" || error === null || error.status !== 429) return false;
  return (
    FLEX_CAPACITY_ERROR_TYPES.includes(error.type) ||
    FLEX_CAPACITY_ERROR_TYPES.some((type) => error.message.includes(type))
  );
}

/**
 * A provider rate-limit, capacity or out-of-credit error, as Anthropic and OpenAI-style APIs
 * report them. A 429 is a rate limit unless the route asked for Flex and the error is an
 * overload, which is capacity (ADR 0114 section 9). Anything else is not `usage_exhausted`.
 */
export function usageCause(
  error: ProviderError | null,
  tier: ServiceTier = "standard",
): UsageExhaustedCause | null {
  if (error === null) return null;
  if (isFlexCapacityRejection(tier, error)) return "capacity";
  if (error.status === 429 || error.type === "rate_limit_error") return "rate_limit";
  if (
    error.status === 529 ||
    error.status === 503 ||
    error.type === "overloaded_error"
  ) {
    return "capacity";
  }
  if (error.status === 402 || error.type === "billing_error") return "out_of_credit";
  return null;
}

/**
 * The run's end from its Job and its result (ADR 0106 section 6):
 * the deadline is `timeout` whatever the output says; the runtime's turn or dollar cap, or either
 * of the proxy's ceiling messages, is `budget_exceeded`; a provider rate-limit, capacity or
 * credit error is `usage_exhausted`, with the route's requested tier telling a Flex capacity
 * rejection from a rate limit; success needs both a Complete Job and a `success` result; anything
 * else, bad output included, is `fail`. What the runtime measured about the route is passed on.
 */
export function mapRunEnd(
  state: "complete" | "deadline" | "failed",
  job: JobStatus | null,
  result: AgentResult | null,
  model: string,
  tier: ServiceTier = "standard",
): AgentRunResult {
  const base = {
    finalText: result?.finalText ?? "",
    ...(result?.structured === undefined ? {} : { structured: result.structured }),
    turns: result?.turns ?? null,
    costUsd: result?.costUsd ?? null,
    minutes: jobMinutes(job),
    tokens: result?.tokens ?? null,
    model,
    ...measured(result),
  };
  if (state === "deadline")
    return { ...base, outcome: "timeout", detail: "deadline_exceeded" };
  if (result === null) return { ...base, outcome: "fail", detail: "bad_output" };
  if (state === "complete" && result.status === "success") {
    return { ...base, outcome: "success", detail: "success" };
  }
  if (result.status === "max_turns" || result.status === "max_budget") {
    return { ...base, outcome: "budget_exceeded", detail: result.status };
  }
  const said = (message: string) =>
    result.errorText.includes(message) ||
    (result.providerError?.message ?? "").includes(message);
  if (said(CEILING_MESSAGE)) {
    return { ...base, outcome: "budget_exceeded", detail: "proxy_ceiling" };
  }
  if (said(REJECTED_CEILING_MESSAGE)) {
    return { ...base, outcome: "budget_exceeded", detail: "proxy_rejected_ceiling" };
  }
  const cause = usageCause(result.providerError, tier);
  if (cause !== null) {
    const retryAfter = result.providerError?.retryAfterSeconds;
    return {
      ...base,
      outcome: "usage_exhausted",
      detail: cause,
      usageExhaustedCause: cause,
      ...(retryAfter === null || retryAfter === undefined
        ? {}
        : { retryAfterSeconds: retryAfter }),
    };
  }
  return {
    ...base,
    outcome: "fail",
    detail: state === "complete" ? "agent_error" : "job_failed",
  };
}

/** The route measurements of a result, only those it has. */
function measured(result: AgentResult | null): Partial<AgentRunResult> {
  if (result === null) return {};
  const fields: Partial<AgentRunResult> = {};
  if (result.serviceTierServed !== undefined)
    fields.serviceTierServed = result.serviceTierServed;
  if (result.capacityRetries !== undefined)
    fields.capacityRetries = result.capacityRetries;
  if (result.capacityWaitSeconds !== undefined)
    fields.capacityWaitSeconds = result.capacityWaitSeconds;
  if (result.firstTokenMs !== undefined) fields.firstTokenMs = result.firstTokenMs;
  return fields;
}
