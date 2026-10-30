// A model provider's error response as the result line's `providerError` (ADR 0106 section 6).
// The Kubernetes runtime turns a rate limit (429), a capacity error (529, 503) or an out-of-credit
// error (402) into `usage_exhausted` with its cause and retry-after, and the proxy's request
// ceiling (403 with its fixed message) into `budget_exceeded`.
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
 * `{"error":"..."}`.
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
