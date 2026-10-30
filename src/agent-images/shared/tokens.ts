// Token accounting for `runs.tokens` (D-185): cached and uncached input are counted apart, because
// caching is the largest saving and the runs table must show whether it works.
import type { RunTokens } from "../../core/runs.ts";

/** The usage fields Anthropic's Messages API and Claude Code's JSON result both report. */
export interface ProviderUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/**
 * Anthropic's `input_tokens` already leaves out cache reads and writes, so it is the uncached
 * input as it stands.
 */
export function tokensFromUsage(usage: ProviderUsage | null | undefined): RunTokens {
  return {
    uncachedInput: count(usage?.input_tokens),
    cachedInput: count(usage?.cache_read_input_tokens),
    cacheWriteInput: count(usage?.cache_creation_input_tokens),
    output: count(usage?.output_tokens),
  };
}

export const NO_TOKENS: RunTokens = {
  uncachedInput: 0,
  cachedInput: 0,
  cacheWriteInput: 0,
  output: 0,
};

export function addTokens(a: RunTokens, b: RunTokens): RunTokens {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWriteInput: (a.cacheWriteInput ?? 0) + (b.cacheWriteInput ?? 0),
    output: a.output + b.output,
  };
}
