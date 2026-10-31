// Model routing (ADR 0114 sections 2 and 5): the route a run is started with. A P-11 decision
// point filled by a rule: a pure function of the task type, the item's earlier runs, and four
// settings (the routing policy, the model catalog, the approved providers and each task type's
// output need). It returns the first policy candidate that passes every hard rule, or `no_route`
// with the reason each candidate failed. The hard rules live here, never in data alone.
//
// Settings are checked strictly. A malformed policy, catalog, provider list or output need fails
// closed: nothing is routed. Problems name the field, never a value from the setting.
import { createHash } from "node:crypto";

import type { AgentRole, Json, Run, ServiceTier } from "./store.ts";

/** The settings routing reads (migration 0005). */
export const ROUTING_SETTINGS = {
  catalog: "model_catalog",
  policy: "model_routing_policy",
  providers: "model_providers_approved",
  outputNeeds: "model_output_token_needs",
} as const;

/** The P-11 decision point and the rule that fills it. */
export const MODEL_ROUTE_DECISION_POINT = "model_route";
export const MODEL_ROUTE_DECIDER = "model_route_rule_v1";

export const SERVICE_TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];

/** US dollars per million tokens at one tier. */
export interface TierPrice {
  input: number;
  cachedInput: number;
  /** Optional: DeepInfra lists no cache-write price (docs/costs.md section 2). */
  cacheWrite?: number;
  output: number;
}

export interface CatalogModel {
  provider: string;
  family: string;
  /** The tiers the provider supports for this model. Any other tier is served at Standard. */
  tiers: ServiceTier[];
  pricePerMTok: Partial<Record<ServiceTier, TierPrice>>;
  /** The provider's output cap per response; null when it sets none below any need. */
  maxOutputTokens: number | null;
  /**
   * True when the provider resells another company's model instead of hosting it itself, as
   * DeepInfra does for Anthropic and Google models. A provider approved only for the models it
   * hosts (`covers: "self_hosted"`) cannot route to a resold model.
   */
  resold: boolean;
  priceSource: string;
  priceReadOn: string;
}

export interface ModelCatalog {
  version: string;
  models: Record<string, CatalogModel>;
}

export interface RouteCandidate {
  provider: string;
  model: string;
  tier: ServiceTier;
  /** DeepInfra's `fail_fast` (ADR 0114 section 9). False unless the policy says so. */
  failFast: boolean;
}

/**
 * `wait`: after a capacity end the dispatch queues, as today. `next_candidate`: the next dispatch
 * takes the next candidate. Only `wait` is acted on yet; `next_candidate` is parsed and kept on
 * the route for the slice that builds Flex capacity handling (ADR 0114 section 11).
 */
export type OnCapacity = "wait" | "next_candidate";

export interface TaskTypeRouting {
  candidates: RouteCandidate[];
  onCapacity: OnCapacity;
}

export type QaIndependence = "model_id" | "family";

export interface RoutingPolicy {
  version: string;
  qaIndependence: QaIndependence;
  taskTypes: Record<string, TaskTypeRouting>;
}

export interface ApprovedProvider {
  /** The decision log id that approved the provider under D-154, for example `D-171`. */
  decision: string;
  /**
   * What the approval covers. `all`: every model the provider serves. `self_hosted`: only models
   * the provider hosts itself, so a resold model fails hard rule 3 (D-208 for DeepInfra).
   */
  covers: "all" | "self_hosted";
  note?: string;
}

/** The settings as stored. A missing setting is null. */
export interface RoutingSettingValues {
  policy: Json;
  catalog: Json;
  providers: Json;
  outputNeeds: Json;
}

/** What a route choice reads from an earlier run on the item. */
export type EarlierRun = Pick<Run, "bot" | "model" | "modelFamily">;

export interface RouteInput {
  role: AgentRole;
  taskType: string;
  /** The item's earlier runs, any order. */
  earlierRuns: readonly EarlierRun[];
  settings: RoutingSettingValues;
}

export interface Route {
  taskType: string;
  provider: string;
  model: string;
  family: string;
  tier: ServiceTier;
  failFast: boolean;
  onCapacity: OnCapacity;
  policyVersion: string;
  catalogVersion: string;
}

export type HardRule =
  "qa_independence" | "known_price" | "approved_provider" | "output_cap";

export interface CandidateRejection {
  /** The candidate's place in the policy's list, from 0. */
  index: number;
  provider: string;
  model: string;
  tier: ServiceTier;
  failed: { rule: HardRule; detail: string }[];
}

export interface NoRoute {
  /** Why the settings could not be used. Empty when they were valid. */
  settingsProblems: string[];
  /** Why each candidate failed, in policy order. */
  rejected: CandidateRejection[];
}

export type RouteChoice =
  { routed: true; route: Route } | { routed: false; noRoute: NoRoute };

// ---- Settings shapes --------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isTier = (value: unknown): value is ServiceTier =>
  SERVICE_TIERS.includes(value as ServiceTier);

const PROVIDER_NAME = /^[a-z][a-z0-9_-]*$/;
const DECISION_ID = /^D-[0-9]{3,}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** A prototype-free record, so a lookup by a model or task type id never finds an inherited name. */
const bare = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function checkKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown field ${key}`);
  }
}

function parsePrice(
  where: string,
  value: unknown,
  problems: string[],
): TierPrice | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  checkKeys(where, value, ["input", "cachedInput", "cacheWrite", "output"], problems);
  let ok = true;
  for (const field of ["input", "cachedInput", "output"]) {
    if (!isAmount(value[field])) {
      problems.push(`${where}.${field} must be a number of at least 0`);
      ok = false;
    }
  }
  if (value.cacheWrite !== undefined && !isAmount(value.cacheWrite)) {
    problems.push(`${where}.cacheWrite must be a number of at least 0`);
    ok = false;
  }
  if (!ok) return null;
  const price: TierPrice = {
    input: value.input as number,
    cachedInput: value.cachedInput as number,
    output: value.output as number,
  };
  if (value.cacheWrite !== undefined) price.cacheWrite = value.cacheWrite as number;
  return price;
}

function parseCatalogModel(
  where: string,
  value: unknown,
  problems: string[],
): CatalogModel | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  checkKeys(
    where,
    value,
    [
      "provider",
      "family",
      "tiers",
      "pricePerMTok",
      "maxOutputTokens",
      "resold",
      "priceSource",
      "priceReadOn",
    ],
    problems,
  );
  if (!(isText(value.provider) && PROVIDER_NAME.test(value.provider))) {
    problems.push(`${where}.provider must be a provider name`);
  }
  if (!isText(value.family))
    problems.push(`${where}.family must be a non-empty string`);
  const tiers = value.tiers;
  if (
    !Array.isArray(tiers) ||
    tiers.length === 0 ||
    !tiers.every(isTier) ||
    new Set(tiers).size !== tiers.length
  ) {
    problems.push(`${where}.tiers must be a non-empty list of distinct service tiers`);
  }
  const prices: Partial<Record<ServiceTier, TierPrice>> = {};
  if (!isRecord(value.pricePerMTok)) {
    problems.push(`${where}.pricePerMTok must be an object of tiers`);
  } else {
    for (const [tier, price] of Object.entries(value.pricePerMTok)) {
      if (!isTier(tier)) {
        problems.push(`${where}.pricePerMTok: unknown tier ${tier}`);
        continue;
      }
      const parsed = parsePrice(`${where}.pricePerMTok.${tier}`, price, problems);
      if (parsed) prices[tier] = parsed;
    }
  }
  if (value.maxOutputTokens !== null && !isPositiveInteger(value.maxOutputTokens)) {
    problems.push(`${where}.maxOutputTokens must be null or a whole number above 0`);
  }
  if (typeof value.resold !== "boolean") {
    problems.push(`${where}.resold must be true or false`);
  }
  if (!isText(value.priceSource)) {
    problems.push(`${where}.priceSource must be a non-empty string`);
  }
  if (!(typeof value.priceReadOn === "string" && DAY.test(value.priceReadOn))) {
    problems.push(`${where}.priceReadOn must be a date (YYYY-MM-DD)`);
  }
  if (problems.length > before) return null;
  return {
    provider: value.provider as string,
    family: value.family as string,
    tiers: [...(tiers as ServiceTier[])],
    pricePerMTok: prices,
    maxOutputTokens: value.maxOutputTokens as number | null,
    resold: value.resold as boolean,
    priceSource: value.priceSource as string,
    priceReadOn: value.priceReadOn as string,
  };
}

/** Checks the `model_catalog` setting. Returns null and adds problems when it is malformed. */
export function parseModelCatalog(
  value: unknown,
  problems: string[],
): ModelCatalog | null {
  const where = ROUTING_SETTINGS.catalog;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  checkKeys(where, value, ["version", "models"], problems);
  if (!isText(value.version))
    problems.push(`${where}.version must be a non-empty string`);
  const models = bare<CatalogModel>();
  if (!isRecord(value.models) || Object.keys(value.models).length === 0) {
    problems.push(`${where}.models must be a non-empty object of model ids`);
  } else {
    for (const [id, entry] of Object.entries(value.models)) {
      const model = parseCatalogModel(`${where}.models.${id}`, entry, problems);
      if (model) models[id] = model;
    }
  }
  if (problems.length > before) return null;
  return { version: value.version as string, models };
}

function parseCandidate(
  where: string,
  value: unknown,
  problems: string[],
): RouteCandidate | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  checkKeys(where, value, ["provider", "model", "tier", "failFast"], problems);
  if (!(isText(value.provider) && PROVIDER_NAME.test(value.provider))) {
    problems.push(`${where}.provider must be a provider name`);
  }
  if (!isText(value.model)) problems.push(`${where}.model must be a non-empty string`);
  if (!isTier(value.tier)) {
    problems.push(`${where}.tier must be ${SERVICE_TIERS.join(", ")}`);
  }
  if (value.failFast !== undefined && typeof value.failFast !== "boolean") {
    problems.push(`${where}.failFast must be a boolean`);
  }
  if (problems.length > before) return null;
  return {
    provider: value.provider as string,
    model: value.model as string,
    tier: value.tier as ServiceTier,
    failFast: value.failFast === true,
  };
}

/** Checks the `model_routing_policy` setting. Returns null and adds problems when malformed. */
export function parseRoutingPolicy(
  value: unknown,
  problems: string[],
): RoutingPolicy | null {
  const where = ROUTING_SETTINGS.policy;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const before = problems.length;
  checkKeys(where, value, ["version", "qaIndependence", "taskTypes"], problems);
  if (!isText(value.version))
    problems.push(`${where}.version must be a non-empty string`);
  if (value.qaIndependence !== "model_id" && value.qaIndependence !== "family") {
    problems.push(`${where}.qaIndependence must be model_id or family`);
  }
  const taskTypes = bare<TaskTypeRouting>();
  if (!isRecord(value.taskTypes)) {
    problems.push(`${where}.taskTypes must be an object of task types`);
  } else {
    for (const [taskType, entry] of Object.entries(value.taskTypes)) {
      const at = `${where}.taskTypes.${taskType}`;
      if (!isRecord(entry)) {
        problems.push(`${at} must be an object`);
        continue;
      }
      checkKeys(at, entry, ["candidates", "onCapacity"], problems);
      if (entry.onCapacity !== "wait" && entry.onCapacity !== "next_candidate") {
        problems.push(`${at}.onCapacity must be wait or next_candidate`);
      }
      if (!Array.isArray(entry.candidates) || entry.candidates.length === 0) {
        problems.push(`${at}.candidates must be a non-empty list`);
        continue;
      }
      const candidates = entry.candidates.map((c, i) =>
        parseCandidate(`${at}.candidates.${i}`, c, problems),
      );
      if (candidates.every((c): c is RouteCandidate => c !== null)) {
        taskTypes[taskType] = {
          candidates,
          onCapacity: entry.onCapacity as OnCapacity,
        };
      }
    }
  }
  if (problems.length > before) return null;
  return {
    version: value.version as string,
    qaIndependence: value.qaIndependence as QaIndependence,
    taskTypes,
  };
}

/** Checks the `model_providers_approved` setting: provider name to the decision that approved it. */
export function parseApprovedProviders(
  value: unknown,
  problems: string[],
): Record<string, ApprovedProvider> | null {
  const where = ROUTING_SETTINGS.providers;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object of provider names`);
    return null;
  }
  const before = problems.length;
  const providers = bare<ApprovedProvider>();
  for (const [name, entry] of Object.entries(value)) {
    const at = `${where}.${name}`;
    if (!PROVIDER_NAME.test(name)) {
      problems.push(`${where}: a key must be a provider name`);
      continue;
    }
    if (!isRecord(entry)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    checkKeys(at, entry, ["decision", "covers", "note"], problems);
    if (!(typeof entry.decision === "string" && DECISION_ID.test(entry.decision))) {
      problems.push(`${at}.decision must be a decision id such as D-171`);
      continue;
    }
    if (entry.covers !== "all" && entry.covers !== "self_hosted") {
      problems.push(`${at}.covers must be all or self_hosted`);
      continue;
    }
    if (entry.note !== undefined && !isText(entry.note)) {
      problems.push(`${at}.note must be a non-empty string`);
      continue;
    }
    const covers = entry.covers;
    providers[name] = entry.note
      ? { decision: entry.decision, covers, note: entry.note as string }
      : { decision: entry.decision, covers };
  }
  if (problems.length > before) return null;
  return providers;
}

/** Checks the `model_output_token_needs` setting: task type to the output tokens it needs. */
export function parseOutputNeeds(
  value: unknown,
  problems: string[],
): Record<string, number> | null {
  const where = ROUTING_SETTINGS.outputNeeds;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object of task types`);
    return null;
  }
  const before = problems.length;
  const needs = bare<number>();
  for (const [taskType, need] of Object.entries(value)) {
    if (!isPositiveInteger(need)) {
      problems.push(`${where}.${taskType} must be a whole number above 0`);
      continue;
    }
    needs[taskType] = need;
  }
  if (problems.length > before) return null;
  return needs;
}

// ---- The hard rules (ADR 0114 section 5) ------------------------------------------------------

/** Hard rule 1: QA's model differs from every Developer run's on the item, by id or by family. */
function qaIndependenceProblem(
  policy: RoutingPolicy,
  candidate: RouteCandidate,
  model: CatalogModel | undefined,
  developerRuns: readonly EarlierRun[],
): string | null {
  if (policy.qaIndependence === "model_id") {
    return developerRuns.some((run) => run.model === candidate.model)
      ? "the same model id as a Developer run on the item"
      : null;
  }
  if (!model) return "no catalog family to compare with the Developer runs";
  return developerRuns.some((run) => run.modelFamily === model.family)
    ? "the same model family as a Developer run on the item"
    : null;
}

/**
 * Hard rule 2: a price for the requested tier. Any request may be served and billed at Standard
 * (an unsupported tier, or a fallback), so Standard needs a price too.
 */
function priceProblem(
  candidate: RouteCandidate,
  model: CatalogModel | undefined,
): string | null {
  if (!model) return "the model is not in the catalog";
  if (model.provider !== candidate.provider) {
    return "the catalog lists the model under another provider";
  }
  if (!model.pricePerMTok.standard) return "no Standard price";
  if (model.tiers.includes(candidate.tier) && !model.pricePerMTok[candidate.tier]) {
    return `no ${candidate.tier} price`;
  }
  return null;
}

/** Hard rule 4: the provider's output cap is not below the task type's need. */
function outputCapProblem(
  model: CatalogModel | undefined,
  need: number,
): string | null {
  if (!model) return "no catalog output cap to compare";
  if (model.maxOutputTokens !== null && model.maxOutputTokens < need) {
    return "the output cap is below the task type's need";
  }
  return null;
}

/**
 * Picks the route for one run (ADR 0114 section 5): the first candidate in the policy's order
 * that passes every hard rule. Pure: the same input always gives the same choice.
 */
export function chooseRoute(input: RouteInput): RouteChoice {
  const problems: string[] = [];
  const policy = parseRoutingPolicy(input.settings.policy, problems);
  const catalog = parseModelCatalog(input.settings.catalog, problems);
  const providers = parseApprovedProviders(input.settings.providers, problems);
  const needs = parseOutputNeeds(input.settings.outputNeeds, problems);
  const routing = policy?.taskTypes[input.taskType];
  const need = needs?.[input.taskType];
  if (policy && !routing) {
    problems.push(
      `${ROUTING_SETTINGS.policy}.taskTypes has no entry for the run's task type`,
    );
  }
  if (needs && need === undefined) {
    problems.push(
      `${ROUTING_SETTINGS.outputNeeds} has no need for the run's task type`,
    );
  }
  if (!policy || !catalog || !providers || !routing || need === undefined) {
    return { routed: false, noRoute: { settingsProblems: problems, rejected: [] } };
  }

  const developerRuns = input.earlierRuns.filter((run) => run.bot === "developer");
  const rejected: CandidateRejection[] = [];
  for (const [index, candidate] of routing.candidates.entries()) {
    const model = Object.hasOwn(catalog.models, candidate.model)
      ? catalog.models[candidate.model]
      : undefined;
    const failed: CandidateRejection["failed"] = [];
    const check = (rule: HardRule, detail: string | null) => {
      if (detail !== null) failed.push({ rule, detail });
    };
    if (input.role === "qa") {
      check(
        "qa_independence",
        qaIndependenceProblem(policy, candidate, model, developerRuns),
      );
    }
    check("known_price", priceProblem(candidate, model));
    check("approved_provider", providerProblem(providers, candidate, model));
    check("output_cap", outputCapProblem(model, need));
    if (failed.length === 0 && model) {
      return {
        routed: true,
        route: {
          taskType: input.taskType,
          provider: candidate.provider,
          model: candidate.model,
          family: model.family,
          tier: candidate.tier,
          failFast: candidate.failFast,
          onCapacity: routing.onCapacity,
          policyVersion: policy.version,
          catalogVersion: catalog.version,
        },
      };
    }
    const { provider, model: id, tier } = candidate;
    rejected.push({ index, provider, model: id, tier, failed });
  }
  return { routed: false, noRoute: { settingsProblems: [], rejected } };
}

/** Hard rule 3: an approved provider, and a model its approval covers. */
function providerProblem(
  providers: Record<string, ApprovedProvider>,
  candidate: RouteCandidate,
  model: CatalogModel | undefined,
): string | null {
  if (!Object.hasOwn(providers, candidate.provider)) {
    return "the provider is not on the approved list";
  }
  if (providers[candidate.provider].covers === "self_hosted" && model?.resold) {
    return "the provider is approved only for models it hosts itself, and this model is resold";
  }
  return null;
}

// ---- The decision record (P-11) ---------------------------------------------------------------

/** JSON with object keys sorted, so equal inputs always hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The SHA-256 of everything the choice reads: the role, the task type, the model and family of
 * each Developer run on the item (in order), and the four settings as stored.
 */
export function routeInputHash(input: RouteInput): string {
  const developerRuns = input.earlierRuns
    .filter((run) => run.bot === "developer")
    .map((run) => ({ model: run.model, modelFamily: run.modelFamily }));
  return createHash("sha256")
    .update(
      canonicalJson({
        role: input.role,
        taskType: input.taskType,
        developerRuns,
        settings: input.settings,
      }),
    )
    .digest("hex");
}

/** The route as a decision record's output. */
export function routeOutput(route: Route, runId: string): Json {
  return {
    runId,
    taskType: route.taskType,
    provider: route.provider,
    model: route.model,
    family: route.family,
    tier: route.tier,
    failFast: route.failFast,
    onCapacity: route.onCapacity,
    policyVersion: route.policyVersion,
    catalogVersion: route.catalogVersion,
  };
}
