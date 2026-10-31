// A run's cost (ADR 0114 sections 2, 5 and 8): `runs.cost_usd`, which the core works out when the
// run's end is recorded, from the run's tokens and the price recorded on the run at admission
// (`runs.model_price`, migration 0008). Pure: the same run and tokens always give the same cost,
// whatever the catalog says later (D-162). `runs.reported_cost_usd` keeps the runtime's own figure.
//
// Which tier is priced (ADR 0114 section 8, O-25):
// - the served tier, when the run reports one tier and the provider supports it for the model;
// - Standard, when the run reports `mixed` or no tier, or a tier the provider does not support
//   for the model, since that is what an unsupported tier is billed at;
// - when the provider supports the served tier but the catalog has no price for it (the route
//   asked for another tier, and hard rule 2 checks only that one and Standard), the highest
//   cost any of the model's prices gives, so the cost is never below what was billed.
// A cache write is priced at the tier's `cacheWrite`, or at its uncached input rate when the
// catalog lists none (DeepInfra lists none, docs/costs.md section 2; O-25).
//
// The Messages API image prices each request by the same rules for its in-run dollar limit, with
// its own copy of this arithmetic (src/agent-images/shared/price.ts): an image may carry only
// the folders its Dockerfile copies. src/agent-images/shared/shared.test.ts checks the two agree.
import {
  parseTierPrice,
  SERVICE_TIERS,
  type RunPrice,
  type TierPrice,
} from "./routing.ts";
import type { RunTokens } from "./runs.ts";
import type { ServedTier, ServiceTier } from "./store.ts";

/** The tier a run's tokens are priced at, from the tier its responses reported. */
export function pricedTier(price: RunPrice, served: ServedTier | null): ServiceTier {
  if (served === null || served === "mixed") return "standard";
  return price.tiers.includes(served) ? served : "standard";
}

/** US dollars for these tokens at one tier's price. */
export function tierCostUsd(price: TierPrice, tokens: RunTokens): number {
  return (
    (tokens.uncachedInput * price.input +
      tokens.cachedInput * price.cachedInput +
      (tokens.cacheWriteInput ?? 0) * (price.cacheWrite ?? price.input) +
      tokens.output * price.output) /
    1_000_000
  );
}

/** Rounded to a billionth of a dollar, so a stored cost has no float noise. */
const rounded = (usd: number): number => Math.round(usd * 1e9) / 1e9;

/** The run's cost in US dollars, from its tokens, its recorded price and its served tier. */
export function runCostUsd(
  price: RunPrice,
  tokens: RunTokens,
  served: ServedTier | null,
): number {
  const tier = price.pricePerMTok[pricedTier(price, served)];
  if (tier) return rounded(tierCostUsd(tier, tokens));
  const costs = Object.values(price.pricePerMTok).map((p) => tierCostUsd(p, tokens));
  return rounded(Math.max(0, ...costs));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a run price, as stored on the run or passed to a runtime. Returns null and adds problems
 * when it is malformed, or when it lacks a price the run may be billed at: Standard, and the
 * requested tier when the provider supports it (hard rule 2). Problems name fields, never values.
 */
export function parseRunPrice(
  where: string,
  value: unknown,
  requested: ServiceTier,
  problems: string[],
): RunPrice | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  for (const key of Object.keys(value)) {
    if (key !== "tiers" && key !== "pricePerMTok") {
      problems.push(`${where}: unknown field ${key}`);
    }
  }
  const tiers = value.tiers;
  if (
    !Array.isArray(tiers) ||
    tiers.length === 0 ||
    !tiers.every((t) => SERVICE_TIERS.includes(t as ServiceTier)) ||
    new Set(tiers).size !== tiers.length
  ) {
    problems.push(`${where}.tiers must be a non-empty list of distinct service tiers`);
  }
  const prices: Partial<Record<ServiceTier, TierPrice>> = {};
  if (!isRecord(value.pricePerMTok)) {
    problems.push(`${where}.pricePerMTok must be an object of tiers`);
  } else {
    for (const [tier, entry] of Object.entries(value.pricePerMTok)) {
      if (!SERVICE_TIERS.includes(tier as ServiceTier)) {
        problems.push(`${where}.pricePerMTok: unknown tier ${tier}`);
        continue;
      }
      const parsed = parseTierPrice(`${where}.pricePerMTok.${tier}`, entry, problems);
      if (parsed) prices[tier as ServiceTier] = parsed;
    }
  }
  if (problems.length > before) return null;
  const price: RunPrice = {
    tiers: [...(tiers as ServiceTier[])],
    pricePerMTok: prices,
  };
  if (!prices.standard) problems.push(`${where} has no Standard price`);
  if (price.tiers.includes(requested) && !prices[requested]) {
    problems.push(`${where} has no price for the requested tier`);
  }
  return problems.length > before ? null : price;
}
