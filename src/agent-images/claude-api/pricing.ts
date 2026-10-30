// Prices for the dollar limit inside the Messages API loop (ADR 0106 section 6). Claude Code
// reports its own cost; a loop that calls the API directly must work it out from usage.
//
// US dollars per million tokens, Anthropic's first-party list prices as of 2026-10 (claude-api
// reference, models table and prompt caching notes). Cache writes are the 5-minute rate (1.25
// times input). A model with no row here cannot run: the run fails closed rather than spend
// without a limit. The model itself always comes from the bot file, never from this table.
import type { RunTokens } from "../../core/runs.ts";

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelPrice {
  base: Rate;
  /** A higher rate card for prompts above `aboveTokens` (Claude Haiku 5.5). */
  long?: { aboveTokens: number; rate: Rate };
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": {
    base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  "claude-sonnet-5-5": {
    base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  "claude-haiku-5-5": {
    base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    long: {
      aboveTokens: 100_000,
      rate: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
};

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/** The cost of one request's usage, in US dollars. */
export function requestCostUsd(model: string, tokens: RunTokens): number {
  const price = PRICES[model];
  if (price === undefined)
    throw new Error("the model has no price, so its budget cannot be enforced");
  const prompt =
    tokens.uncachedInput + tokens.cachedInput + (tokens.cacheWriteInput ?? 0);
  const rate =
    price.long !== undefined && prompt > price.long.aboveTokens
      ? price.long.rate
      : price.base;
  return (
    (tokens.uncachedInput * rate.input +
      tokens.cachedInput * rate.cacheRead +
      (tokens.cacheWriteInput ?? 0) * rate.cacheWrite +
      tokens.output * rate.output) /
    1_000_000
  );
}
