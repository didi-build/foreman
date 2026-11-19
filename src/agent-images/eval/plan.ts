// The week's plan for the weekly test job (ADR 0117, D-429, D-432), and the job's other list
// settings. Each is read from the job's environment and checked before any model call; a problem
// names the setting, the entry's position and the field, never a value.
//
// FOREMAN_EVAL_PLAN is a JSON list of 1 to MAX_PLAN_ENTRIES entries, each one model on one
// provider:
//
//   { "model": "deepseek-ai/DeepSeek-V4-Pro-0813", "provider": "deepinfra", "tier": "flex",
//     "price": { "tiers": ["standard", "flex"], "pricePerMTok": { "standard": {...}, ... } },
//     "roles": ["qa", "triage", "council"] }
//
// `price` is the model catalog's entry for the model, in the shape a run gets it
// (FOREMAN_MODEL_PRICE, ../shared/price.ts), checked the same way: an entry without a Standard
// price, or without a price for the tier it asks for when the provider has that tier, is refused,
// so every run's dollar limit and cost can be enforced and recorded. `roles` are the case roles
// the entry runs: Claude's monthly baseline is two entries, Opus 5.5 for `qa` and Sonnet 5.5 for
// `triage` and `council` (D-429). An entry's provider must be one each of its roles' bot files
// lists, so the job runs only what a real run of that role could be routed to, and have an
// address in FOREMAN_MODEL_BASE_URLS.
import type { BotFiles } from "../../adapters/contracts-file/bot-files.ts";
import type { ServiceTier } from "../../core/store.ts";
import { CASE_ID, type EvalCase, type EvalRole } from "../../eval/cases.ts";
import { readRunPrice, type RunPrice } from "../shared/price.ts";
import { MODEL_ID, baseUrl } from "../shared/settings.ts";
import { MAX_PLAN_ENTRIES, PROVIDER_NAME } from "./result.ts";

export interface PlanEntry {
  model: string;
  provider: string;
  tier: ServiceTier;
  price: RunPrice;
  roles: EvalRole[];
}

const FIELDS = ["model", "provider", "tier", "price", "roles"];
const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];
const ROLES: readonly EvalRole[] = ["qa", "triage", "council"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function json(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("is not valid JSON");
  }
}

function readEntry(value: unknown, where: string): PlanEntry {
  if (!isObject(value)) throw new Error(`${where} is not an object`);
  if (Object.keys(value).some((key) => !FIELDS.includes(key))) {
    throw new Error(`${where} has an unknown field`);
  }
  const { model, provider, tier, price, roles } = value;
  if (typeof model !== "string" || !MODEL_ID.test(model)) {
    throw new Error(`${where} has no valid model`);
  }
  if (typeof provider !== "string" || !PROVIDER_NAME.test(provider)) {
    throw new Error(`${where} has no valid provider`);
  }
  if (!TIERS.includes(tier as ServiceTier))
    throw new Error(`${where} has no valid tier`);
  let checked: RunPrice;
  try {
    checked = readRunPrice(price, tier as ServiceTier);
  } catch (error) {
    throw new Error(
      `${where} has no usable price: it ${error instanceof Error ? error.message : "is invalid"}`,
    );
  }
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every((role) => ROLES.includes(role as EvalRole)) ||
    new Set(roles).size !== roles.length
  ) {
    throw new Error(
      `${where} has no valid roles: one or more of qa, triage and council`,
    );
  }
  return {
    model,
    provider,
    tier: tier as ServiceTier,
    price: checked,
    roles: [...(roles as EvalRole[])],
  };
}

/** Reads FOREMAN_EVAL_PLAN. Throws naming the entry and the field, never a value. */
export function parsePlan(raw: string): PlanEntry[] {
  const entries = json(raw);
  if (!Array.isArray(entries)) throw new Error("must be a JSON list");
  if (entries.length === 0 || entries.length > MAX_PLAN_ENTRIES) {
    throw new Error(`must have 1 to ${MAX_PLAN_ENTRIES} entries`);
  }
  const plan = entries.map((entry, i) => readEntry(entry, `entry ${i + 1}`));
  const seen = new Set<string>();
  plan.forEach((entry, i) => {
    const key = `${entry.provider} ${entry.model}`;
    if (seen.has(key))
      throw new Error(`entry ${i + 1} repeats a model on its provider`);
    seen.add(key);
  });
  return plan;
}

/**
 * Reads FOREMAN_MODEL_BASE_URLS: a JSON object from each provider's name to its address on the
 * job's egress proxy, `http://<proxy>:<port>/<provider>`, as the runtime names a provider's
 * address for a run (`base_url_env`). The Anthropic SDK adds `/v1/messages` to it.
 */
export function parseBaseUrls(raw: string): Record<string, string> {
  const value = json(raw);
  if (!isObject(value) || Object.keys(value).length === 0) {
    throw new Error("must be a JSON object from provider names to addresses");
  }
  const urls: Record<string, string> = {};
  for (const [name, url] of Object.entries(value)) {
    if (!PROVIDER_NAME.test(name))
      throw new Error("has a key that is not a provider name");
    try {
      urls[name] = baseUrl("").parse(typeof url === "string" ? url : "");
    } catch (error) {
      throw new Error(
        `has no usable address for ${name}: it ${error instanceof Error ? error.message : "is invalid"}`,
      );
    }
  }
  return urls;
}

/** Reads FOREMAN_EVAL_CASES: case ids separated by commas, or empty for every case. */
export function parseCaseList(raw: string): string[] | null {
  if (raw.trim() === "") return null;
  const ids = raw.split(",").map((id) => id.trim());
  if (!ids.every((id) => CASE_ID.test(id)))
    throw new Error("is not a list of case ids");
  if (new Set(ids).size !== ids.length) throw new Error("names a case twice");
  return ids;
}

/** The cases the job runs, in id order: all of them, or those FOREMAN_EVAL_CASES names. */
export function selectCases(
  cases: readonly EvalCase[],
  ids: readonly string[] | null,
): EvalCase[] {
  if (ids === null) return [...cases];
  if (!ids.every((id) => cases.some((c) => c.id === id))) {
    throw new Error("FOREMAN_EVAL_CASES names a case that is not in the set");
  }
  return cases.filter((c) => ids.includes(c.id));
}

/**
 * Checks the plan against the bot files and the proxy's addresses: each entry's provider is one
 * every role it covers lists in its bot file, and has an address.
 */
export function checkPlan(
  plan: readonly PlanEntry[],
  bots: BotFiles,
  baseUrls: Readonly<Record<string, string>>,
): void {
  plan.forEach((entry, i) => {
    for (const role of entry.roles) {
      if (!bots[role].providers.some((p) => p.name === entry.provider)) {
        throw new Error(
          `FOREMAN_EVAL_PLAN entry ${i + 1} names a provider the ${role} bot file does not list`,
        );
      }
    }
    if (baseUrls[entry.provider] === undefined) {
      throw new Error(
        `FOREMAN_MODEL_BASE_URLS has no address for the provider of FOREMAN_EVAL_PLAN entry ${i + 1}`,
      );
    }
  });
}
