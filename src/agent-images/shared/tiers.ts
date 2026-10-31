// The service tier a run was served at (ADR 0114 sections 2 and 8). A runtime reads the tier each
// provider response reports and the run records one value: the tier, when every response
// reported the same one; `mixed`, when they differ or only some reported one; null, when none
// did. The core prices a `mixed` or unknown run at Standard.
import type { ServedTier, ServiceTier } from "../../core/store.ts";

const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];

/**
 * The tier a provider response reports, read from `usage.service_tier` (the Messages API, and
 * Claude Code's result) or a top-level `service_tier` (OpenAI-style responses). Any other value,
 * such as Anthropic's `batch`, counts as not reported.
 */
export function reportedTier(response: unknown): ServiceTier | null {
  if (typeof response !== "object" || response === null) return null;
  const { usage, service_tier: topLevel } = response as Record<string, unknown>;
  const inUsage =
    typeof usage === "object" && usage !== null
      ? (usage as Record<string, unknown>).service_tier
      : undefined;
  for (const value of [inUsage, topLevel]) {
    if (TIERS.includes(value as ServiceTier)) return value as ServiceTier;
  }
  return null;
}

/** One value for the run, from each response's reported tier in order (null: not reported). */
export function servedTier(
  reported: readonly (ServiceTier | null)[],
): ServedTier | null {
  const tiers = new Set(reported.filter((tier) => tier !== null));
  if (tiers.size === 0) return null;
  const [only] = tiers;
  if (tiers.size === 1 && !reported.includes(null)) return only ?? null;
  return "mixed";
}
