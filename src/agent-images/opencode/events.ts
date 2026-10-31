// Reads `opencode run --format json`: one JSON object per line (docs/spikes/opencode-runtime.md,
// check 1). Each has `type`, `timestamp`, `sessionID` and a `part` or an `error`. The wrapper
// keeps a running tally: one turn per `step_finish` (one per model request), the tokens and the
// cost summed over the steps, the last text and the last error. There is no final summary event,
// so the result is built from this tally. Checked against OpenCode 1.19.5, the version the image
// pins. Pure: no clock and no I/O.
import type { RunTokens } from "../../core/runs.ts";
import type { ServiceTier } from "../../core/store.ts";
import { requestCostUsd, type RunPrice } from "../shared/price.ts";
import { providerErrorFromHttp } from "../shared/provider-error.ts";
import type { ProviderError } from "../shared/result.ts";
import { reportedTier } from "../shared/tiers.ts";
import { NO_TOKENS, addTokens } from "../shared/tokens.ts";

const MAX_TEXT = 64 * 1024;
const MAX_ERROR_TEXT = 4 * 1024;

export interface RunTally {
  turns: number;
  tokens: RunTokens;
  costUsd: number;
  /** The cost of the latest step: the next request rereads at least that context. */
  lastStepCostUsd: number;
  /** The latest `step_finish` reason; `stop` means the model gave its final answer. */
  lastReason: string | null;
  finalText: string;
  /** The latest `error` event, if any. */
  error: TallyError | null;
  /** Each step's reported tier, in order (null: none reported). */
  tiers: (ServiceTier | null)[];
}

export interface TallyError {
  /** For `errorText`: the provider's message, so the proxy's ceiling texts are matched. */
  text: string;
  /** Present when the error carries an HTTP status from the provider or the proxy. */
  providerError: ProviderError | null;
  /** OpenCode's own flag: a retryable error has already been retried before it is reported. */
  retryable: boolean;
}

export const EMPTY_TALLY: RunTally = {
  turns: 0,
  tokens: NO_TOKENS,
  costUsd: 0,
  lastStepCostUsd: 0,
  lastReason: null,
  finalText: "",
  error: null,
  tiers: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/**
 * A step's tokens. OpenCode's `input` already leaves out cache reads and writes; it reports
 * reasoning apart from output, and bills it as output.
 */
export function stepTokens(tokens: unknown): RunTokens {
  const t = isObject(tokens) ? tokens : {};
  const cache = isObject(t.cache) ? t.cache : {};
  return {
    uncachedInput: count(t.input),
    cachedInput: count(cache.read),
    cacheWriteInput: count(cache.write),
    output: count(t.output) + count(t.reasoning),
  };
}

/** Response headers as OpenCode reports them (a plain object), read without regard to case. */
function headerReader(headers: unknown): { get(name: string): string | null } {
  const entries = isObject(headers) ? Object.entries(headers) : [];
  return {
    get: (name) => {
      const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
      return typeof found?.[1] === "string" ? found[1] : null;
    },
  };
}

/** An `error` event's `error`: `{ name, data: { message, statusCode, responseHeaders, ... } }`. */
export function readError(error: unknown, now: Date): TallyError {
  const fields = isObject(error) ? error : {};
  const data = isObject(fields.data) ? fields.data : {};
  const dataMessage = typeof data.message === "string" ? data.message : "";
  const name = typeof fields.name === "string" ? fields.name.slice(0, 64) : "";
  const status =
    typeof data.statusCode === "number" &&
    Number.isSafeInteger(data.statusCode) &&
    data.statusCode >= 100 &&
    data.statusCode <= 999
      ? data.statusCode
      : null;
  let providerError: ProviderError | null = null;
  if (status !== null) {
    let body: unknown = null;
    if (typeof data.responseBody === "string") {
      try {
        body = JSON.parse(data.responseBody);
      } catch {
        // Not JSON: the message stands alone.
      }
    }
    const parsed = providerErrorFromHttp(
      status,
      headerReader(data.responseHeaders),
      body,
      now,
    );
    // The proxy's 403 body is `{"error":"<ceiling text>"}`; a provider's names its own message.
    providerError = {
      ...parsed,
      message: parsed.message || dataMessage.slice(0, 2000),
    };
  }
  const message = providerError?.message || dataMessage;
  const text =
    message !== ""
      ? message
      : `OpenCode reported ${name === "" ? "an error" : `an error (${name})`} with no message`;
  return {
    text: text.slice(0, MAX_ERROR_TEXT),
    providerError,
    retryable: data.isRetryable === true,
  };
}

/**
 * The tally after one line. Lines that are not a JSON object, and events other than these, are
 * skipped: `step_start`, `tool_use` and `reasoning` carry nothing the result needs.
 */
export function addEventLine(
  tally: RunTally,
  line: string,
  price: RunPrice,
  priceTier: ServiceTier | null,
  now: Date,
): RunTally {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return tally;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return tally;
  }
  if (!isObject(event)) return tally;
  const part = isObject(event.part) ? event.part : {};
  switch (event.type) {
    case "step_finish": {
      const tokens = stepTokens(part.tokens);
      const cost = requestCostUsd(price, priceTier, tokens);
      return {
        ...tally,
        turns: tally.turns + 1,
        tokens: addTokens(tally.tokens, tokens),
        costUsd: tally.costUsd + cost,
        lastStepCostUsd: cost,
        lastReason: typeof part.reason === "string" ? part.reason : null,
        tiers: [...tally.tiers, reportedTier(part)],
      };
    }
    case "text":
      return typeof part.text === "string"
        ? { ...tally, finalText: part.text.slice(0, MAX_TEXT) }
        : tally;
    case "error":
      return { ...tally, error: readError(event.error, now) };
    default:
      return tally;
  }
}
