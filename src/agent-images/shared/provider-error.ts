// A model provider's error response as the result line's `providerError` (ADR 0106 section 6).
// The Kubernetes runtime turns a rate limit (429), a capacity error (529, 503) or an out-of-credit
// error (402) into `usage_exhausted` with its cause and retry-after, and the proxy's request
// ceiling (403 with its fixed message) into `budget_exceeded`.
import type { ServiceTier } from "../../core/store.ts";
import type { ProviderError } from "./result.ts";

const MAX_MESSAGE = 2000;
const ERROR_TYPE = /"type"\s*:\s*"([a-z_]{1,60}_error)"/;

/**
 * Seconds from a `retry-after` header: whole seconds, or an HTTP date measured from `now`.
 * Null when absent or unreadable.
 */
export function retryAfterSeconds(
  header: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (header === null || header === undefined || header.trim() === "") return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/**
 * From an HTTP error: its status, its headers and its JSON body. Anthropic's body is
 * `{"type":"error","error":{"type":"rate_limit_error","message":"..."}}`; the egress proxy's is
 * `{"error":"..."}`. An OpenAI-style body names its error in `code` when it has no `type`, so
 * that is read as the type then.
 */
export function providerErrorFromHttp(
  status: number | null,
  headers: { get(name: string): string | null } | null | undefined,
  body: unknown,
  now: Date = new Date(),
): ProviderError {
  let type = "";
  let message = "";
  const outer =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const inner = outer.error;
  if (typeof inner === "string") {
    message = inner;
  } else if (typeof inner === "object" && inner !== null) {
    const fields = inner as Record<string, unknown>;
    if (typeof fields.type === "string") type = fields.type;
    else if (typeof fields.code === "string") type = fields.code;
    if (typeof fields.message === "string") message = fields.message;
  }
  return {
    status,
    type: type.slice(0, 64),
    message: message.slice(0, MAX_MESSAGE),
    retryAfterSeconds: retryAfterSeconds(headers?.get("retry-after"), now),
  };
}

/**
 * From Claude Code's JSON result, which reports the API error's status as `api_error_status`
 * and the provider's error text in `result` or `errors`. Claude Code does not report a
 * retry-after, so the runner's wait setting applies (ADR 0106 section 6).
 */
export function providerErrorFromClaudeCode(
  status: number | null,
  text: string,
): ProviderError | null {
  const type = ERROR_TYPE.exec(text)?.[1] ?? "";
  if (status === null && type === "") return null;
  return {
    status,
    type,
    message: text.slice(0, MAX_MESSAGE),
    retryAfterSeconds: null,
  };
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
