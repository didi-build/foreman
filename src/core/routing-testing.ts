// Test support for model routing (ADR 0114): the routing settings migration 0005 seeds, the task
// types in contracts/task-types.yaml, and the route columns of a run on the first policy. Tests
// only. test/db/runs.test.ts checks the seeded settings equal these values, and
// test/contracts-task-types.test.ts checks the file equals TEST_TASK_TYPES, so neither copy can
// drift from the source it stands in for.
import { ROUTING_SETTINGS } from "./routing.ts";
import type { Json, Run, StoreOps } from "./store.ts";
import type { TaskTypes } from "./task-types.ts";

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

const anthropic = (model: string) => ({
  candidates: [{ provider: "anthropic", model, tier: "standard" }],
  onCapacity: "wait",
});

/** The first routing policy: today's models (D-185, D-186). */
export const FIRST_ROUTING_POLICY = {
  version: "2026-10-31.1",
  qaIndependence: "model_id",
  taskTypes: {
    "developer:code": anthropic(SONNET),
    "developer:infra": anthropic(SONNET),
    designer: anthropic(SONNET),
    "qa:review": anthropic(OPUS),
    council: anthropic(SONNET),
    triage: anthropic(SONNET),
  },
} satisfies Json;

const claude = (input: number, cacheWrite: number, output: number) => ({
  provider: "anthropic",
  family: "claude",
  tiers: ["standard"],
  pricePerMTok: { standard: { input, cachedInput: 0.2, cacheWrite, output } },
  maxOutputTokens: null,
  resold: false,
  priceSource: "Anthropic list price (docs/costs.md section 2, claude-api/pricing.ts)",
  priceReadOn: "2026-10-31",
});

/** The first model catalog: only the models the first policy uses. */
export const FIRST_MODEL_CATALOG = {
  version: "2026-10-31.1",
  models: { [SONNET]: claude(2, 2.5, 10), [OPUS]: claude(4, 5, 20) },
} satisfies Json;

export const FIRST_APPROVED_PROVIDERS = {
  anthropic: { decision: "D-171", covers: "all" },
  deepinfra: {
    decision: "D-208",
    covers: "self_hosted",
    note: "Only models DeepInfra hosts itself. Anthropic and Google models resold through DeepInfra are not covered",
  },
} satisfies Json;

export const FIRST_OUTPUT_TOKEN_NEEDS = {
  "developer:code": 16000,
  "developer:infra": 16000,
  designer: 16000,
  "qa:review": 16000,
  council: 16000,
  triage: 16000,
} satisfies Json;

/** Seeds the four routing settings as migration 0005 does. */
export async function seedRoutingSettings(store: StoreOps, at: Date): Promise<void> {
  for (const [key, value] of [
    [ROUTING_SETTINGS.policy, FIRST_ROUTING_POLICY],
    [ROUTING_SETTINGS.catalog, FIRST_MODEL_CATALOG],
    [ROUTING_SETTINGS.providers, FIRST_APPROVED_PROVIDERS],
    [ROUTING_SETTINGS.outputNeeds, FIRST_OUTPUT_TOKEN_NEEDS],
  ] as const) {
    await store.setSetting({ key, value, updatedBy: "test", updatedAt: at });
  }
}

/** The task types in contracts/task-types.yaml. */
export const TEST_TASK_TYPES: TaskTypes = {
  version: "e".repeat(40),
  meanings: {
    "developer:code": "Developer work on application code. The Developer's default.",
    "developer:infra":
      "Developer work on infrastructure code, workflows or migrations.",
    designer: "Designer work.",
    "qa:review": "QA review of a pull request.",
    council: "A Council question.",
    triage: "Triage, and similar short classification or breakdown work.",
  },
  roles: {
    developer: {
      allowed: ["developer:code", "developer:infra"],
      default: "developer:code",
    },
    designer: { allowed: ["designer"], default: "designer" },
    qa: { allowed: ["qa:review"], default: "qa:review" },
    council: { allowed: ["council"], default: "council" },
    triage: { allowed: ["triage"], default: "triage" },
  },
};

type RouteColumns = Pick<
  Run,
  | "taskType"
  | "provider"
  | "modelFamily"
  | "serviceTierRequested"
  | "serviceTierServed"
  | "routingPolicyVersion"
  | "modelCatalogVersion"
  | "capacityRetries"
  | "capacityWaitSeconds"
  | "firstTokenMs"
  | "reportedCostUsd"
>;

/** The route columns of a run on the first policy, for tests that insert runs directly. */
export function testRouteColumns(
  bot: string,
  overrides: Partial<RouteColumns> = {},
): RouteColumns {
  return {
    taskType: bot === "developer" ? "developer:code" : bot === "qa" ? "qa:review" : bot,
    provider: "anthropic",
    modelFamily: "claude",
    serviceTierRequested: "standard",
    serviceTierServed: null,
    routingPolicyVersion: FIRST_ROUTING_POLICY.version,
    modelCatalogVersion: FIRST_MODEL_CATALOG.version,
    capacityRetries: null,
    capacityWaitSeconds: null,
    firstTokenMs: null,
    reportedCostUsd: null,
    ...overrides,
  };
}
