// The tiers the model provider says it served, as the egress proxy counts them for its run
// (D-423, ADR 0114 section 8, O-151). The proxy reads `service_tier` from each served model
// response (./tier-reader.ts) and counts the request under the tier it names. After each counted
// request it logs the run's whole tally as one fixed line. At the run's end the Kubernetes runtime
// adapter reads the newest such line from the proxy container's log, as it reads the agent's
// result line from the agent's, and fills the run's served tier from it when the agent reported
// none. The line's format and its parser live here together, so the two cannot drift apart.
// The line holds counts only: never a body, a header value or a credential.

/** The tiers a request can be counted under, each a `runs.service_tier_served` value. */
export const TALLY_TIERS = ["standard", "flex", "priority"] as const;
export type TallyTier = (typeof TALLY_TIERS)[number];

/**
 * What one served request was read as: one tier; `mixed` when the chunks of one stream named
 * different tiers; or `unknown` when the response named none, named something else, or was not
 * read.
 */
export type RequestTier = TallyTier | "mixed" | "unknown";

/** Served model requests by what each was read as. */
export type ServedTierTally = Record<RequestTier, number>;

/** The tier a whole run was served at: one tier, `mixed`, or null when no request named one. */
export type RunServedTier = TallyTier | "mixed" | null;

/** The message of the tally line. */
export const SERVED_TIERS_MESSAGE = "served tiers";
/** The service name the proxy's logger writes on every line (./main.ts). */
const SERVICE = "egress-proxy";
const KEYS: readonly RequestTier[] = [...TALLY_TIERS, "mixed", "unknown"];

export function emptyTally(): ServedTierTally {
  return { standard: 0, flex: 0, priority: 0, mixed: 0, unknown: 0 };
}

/**
 * The tier a provider's `service_tier` value names. DeepInfra documents `default` (Standard),
 * `priority` and `flex`; any other value, or none, names no tier.
 */
export function tierOf(value: unknown): TallyTier | null {
  if (value === "default") return "standard";
  if (value === "flex" || value === "priority") return value;
  return null;
}

/** The fields of the tally line, a copy of the counts and nothing else. */
export function servedTiersFields(tally: ServedTierTally): {
  servedTiers: ServedTierTally;
} {
  return { servedTiers: { ...tally } };
}

/**
 * The run's served tier from its tally. Only requests whose tier is known decide: all on one tier
 * give that tier, more than one tier or any `mixed` request give `mixed`, and none give null (the
 * run is then priced at Standard, as before). `unknown` requests change nothing.
 */
export function servedTierOf(tally: ServedTierTally): RunServedTier {
  if (tally.mixed > 0) return "mixed";
  const served = TALLY_TIERS.filter((tier) => tally[tier] > 0);
  if (served.length === 0) return null;
  return served.length === 1 ? (served[0] as TallyTier) : "mixed";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The tally from the newest tally line of a proxy's log, or null. A line counts as a tally line
 * by its message; the newest one must be well formed (the proxy's service, level and run id, and
 * exactly the five counts as whole numbers) or the answer is null, never an older line. Lines
 * that are not JSON are skipped, so a cut first line of a log tail does no harm. Never throws.
 */
export function parseServedTiersLog(
  log: string | null,
  runId: string,
): ServedTierTally | null {
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
    if (!isObject(value) || value.message !== SERVED_TIERS_MESSAGE) continue;
    return readTallyLine(value, runId);
  }
  return null;
}

function readTallyLine(
  line: Record<string, unknown>,
  runId: string,
): ServedTierTally | null {
  if (line.service !== SERVICE || line.level !== "info" || line.runId !== runId) {
    return null;
  }
  const counts = line.servedTiers;
  if (!isObject(counts) || Object.keys(counts).length !== KEYS.length) return null;
  const tally = emptyTally();
  for (const key of KEYS) {
    const count = counts[key];
    if (!isCount(count)) return null;
    tally[key] = count;
  }
  return tally;
}
