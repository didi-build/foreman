// The run's price for the in-run dollar limit (ADR 0106 section 6, ADR 0114 sections 5 and 8).
// The runner passes the route's catalog entry, as recorded on the run (`runs.model_price`), in
// FOREMAN_MODEL_PRICE: `{ "tiers": [...], "pricePerMTok": { "standard": {...}, ... } }`, US
// dollars per million tokens. The model catalog is the one source of prices; no image keeps a
// price table of its own.
//
// The rules are the core's (src/core/run-cost.ts), so a run's limit and its recorded cost agree:
// a response is priced at the tier it reports when the provider supports that tier for the
// model, and at Standard when it reports none or an unsupported one; a supported tier with no
// price is priced at the highest cost any price gives; a cache write with no listed price is
// priced at the uncached input rate (O-25). This file repeats the core's arithmetic because an
// image carries only the folders its Dockerfile copies; shared.test.ts checks the two agree.
//
// A price that is missing, malformed, or has no Standard price or no price for the requested tier
// the provider supports stops the run before any model call: the limit could not be enforced, so
// the run fails closed. Errors name the setting, never its value.
import type { RunPrice, TierPrice } from "../../core/routing.ts";
import type { RunTokens } from "../../core/runs.ts";
import type { ServiceTier } from "../../core/store.ts";

export type { RunPrice };

const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];
const PRICE_FIELDS = ["input", "cachedInput", "cacheWrite", "output"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isTier = (value: unknown): value is ServiceTier =>
  TIERS.includes(value as ServiceTier);

function tierPrice(value: unknown): TierPrice {
  if (!isRecord(value) || !Object.keys(value).every((k) => PRICE_FIELDS.includes(k))) {
    throw new Error("is not a price per million tokens");
  }
  const { input, cachedInput, cacheWrite, output } = value;
  if (
    !isAmount(input) ||
    !isAmount(cachedInput) ||
    !isAmount(output) ||
    (cacheWrite !== undefined && !isAmount(cacheWrite))
  ) {
    throw new Error("is not a price per million tokens");
  }
  return cacheWrite === undefined
    ? { input, cachedInput, output }
    : { input, cachedInput, cacheWrite, output };
}

/**
 * Reads the run's price. Throws, naming no value, when it is malformed or lacks a price the run
 * may be billed at: Standard, and the requested tier when the provider supports it.
 */
export function parseRunPrice(raw: string, requested: ServiceTier): RunPrice {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("is not JSON");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => k !== "tiers" && k !== "pricePerMTok")
  ) {
    throw new Error("is not a run price");
  }
  const { tiers, pricePerMTok } = value;
  if (
    !Array.isArray(tiers) ||
    tiers.length === 0 ||
    !tiers.every(isTier) ||
    new Set(tiers).size !== tiers.length ||
    !isRecord(pricePerMTok) ||
    !Object.keys(pricePerMTok).every(isTier)
  ) {
    throw new Error("is not a run price");
  }
  const prices: Partial<Record<ServiceTier, TierPrice>> = {};
  for (const [tier, entry] of Object.entries(pricePerMTok)) {
    prices[tier as ServiceTier] = tierPrice(entry);
  }
  if (!prices.standard) {
    throw new Error("has no Standard price, so the dollar limit cannot be enforced");
  }
  if (tiers.includes(requested) && !prices[requested]) {
    throw new Error(
      "has no price for the requested tier, so the dollar limit cannot be enforced",
    );
  }
  return { tiers: [...tiers], pricePerMTok: prices };
}

function tierCostUsd(price: TierPrice, tokens: RunTokens): number {
  return (
    (tokens.uncachedInput * price.input +
      tokens.cachedInput * price.cachedInput +
      (tokens.cacheWriteInput ?? 0) * (price.cacheWrite ?? price.input) +
      tokens.output * price.output) /
    1_000_000
  );
}

/** The cost of one response's usage, in US dollars, at the tier it reported (null: none). */
export function requestCostUsd(
  price: RunPrice,
  reported: ServiceTier | null,
  tokens: RunTokens,
): number {
  const tier =
    reported !== null && price.tiers.includes(reported) ? reported : "standard";
  const tierPriceFor = price.pricePerMTok[tier];
  if (tierPriceFor) return tierCostUsd(tierPriceFor, tokens);
  return Math.max(
    0,
    ...Object.values(price.pricePerMTok).map((p) => tierCostUsd(p, tokens)),
  );
}
