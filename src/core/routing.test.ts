// Seam: unit. The route choice (ADR 0114 section 5): each hard rule passing and failing, candidate
// order, both QA independence modes, strict settings checks that fail closed, and the input hash.
// Pure functions, no store. Recording the route at admission is in runs.test.ts.
import { describe, expect, it } from "vitest";

import {
  chooseRoute,
  routeInputHash,
  type EarlierRun,
  type RouteChoice,
  type RouteInput,
} from "./routing.ts";
import {
  FIRST_APPROVED_PROVIDERS,
  FIRST_MODEL_CATALOG,
  FIRST_OUTPUT_TOKEN_NEEDS,
  FIRST_ROUTING_POLICY,
  firstRunPrice,
} from "./routing-testing.ts";
import type { AgentRole, Json } from "./store.ts";

/** An open model of another family, for the tests only. Not a real catalog entry. */
const QWEN = {
  provider: "deepinfra",
  family: "qwen",
  tiers: ["standard", "flex"],
  pricePerMTok: {
    standard: { input: 0.3, cachedInput: 0.1, output: 1 },
    flex: { input: 0.24, cachedInput: 0.08, output: 0.8 },
  },
  maxOutputTokens: 16384,
  resold: false,
  priceSource: "test",
  priceReadOn: "2026-10-31",
};

const CATALOG = {
  version: "test.1",
  models: { ...FIRST_MODEL_CATALOG.models, "test/qwen-coder": QWEN },
};

const candidate = (model: string, provider = "anthropic", tier = "standard"): Json => ({
  provider,
  model,
  tier,
});

const policy = (
  taskType: string,
  candidates: Json[],
  qaIndependence = "model_id",
): Json => ({
  version: "test.1",
  qaIndependence,
  taskTypes: { [taskType]: { candidates, onCapacity: "wait" } },
});

function input(
  overrides: Partial<Omit<RouteInput, "settings">> & {
    settings?: Partial<RouteInput["settings"]>;
  } = {},
): RouteInput {
  return {
    role: overrides.role ?? "developer",
    taskType: overrides.taskType ?? "developer:code",
    earlierRuns: overrides.earlierRuns ?? [],
    settings: {
      policy: FIRST_ROUTING_POLICY,
      catalog: CATALOG,
      providers: FIRST_APPROVED_PROVIDERS,
      outputNeeds: FIRST_OUTPUT_TOKEN_NEEDS,
      ...overrides.settings,
    },
  };
}

const developerRun = (model: string, modelFamily: string): EarlierRun => ({
  bot: "developer",
  model,
  modelFamily,
});

function routed(choice: RouteChoice) {
  if (!choice.routed) throw new Error(`no route: ${JSON.stringify(choice.noRoute)}`);
  return choice.route;
}

function refused(choice: RouteChoice) {
  if (choice.routed) throw new Error(`routed to ${choice.route.model}`);
  return choice.noRoute;
}

describe("the first policy (ADR 0114 section 5, D-185, D-186)", () => {
  it.each([
    ["developer", "developer:code", "claude-sonnet-5-5"],
    ["developer", "developer:infra", "claude-sonnet-5-5"],
    ["designer", "designer", "claude-sonnet-5-5"],
    ["qa", "qa:review", "claude-opus-5-5"],
    ["council", "council", "claude-sonnet-5-5"],
    ["triage", "triage", "claude-sonnet-5-5"],
  ] as const)(
    "routes %s (%s) to %s on Anthropic at Standard",
    (role, taskType, model) => {
      const choice = chooseRoute(
        input({
          role: role as AgentRole,
          taskType,
          settings: { catalog: FIRST_MODEL_CATALOG },
        }),
      );
      expect(routed(choice)).toEqual({
        taskType,
        provider: "anthropic",
        model,
        family: "claude",
        tier: "standard",
        failFast: false,
        onCapacity: "wait",
        policyVersion: "2026-10-31.1",
        catalogVersion: "2026-10-31.1",
        price: firstRunPrice(model),
      });
    },
  );

  it("is pure: the same input gives the same route and the same hash", () => {
    const one = input({ role: "qa", taskType: "qa:review" });
    const two = structuredClone(one);
    expect(chooseRoute(one)).toEqual(chooseRoute(two));
    expect(routeInputHash(one)).toBe(routeInputHash(two));
  });
});

describe("candidate order", () => {
  it("takes the first candidate that passes, and skips one that fails", () => {
    const both = [
      candidate("test/qwen-coder", "deepinfra", "flex"),
      candidate("claude-sonnet-5-5"),
    ];
    expect(
      routed(
        chooseRoute(input({ settings: { policy: policy("developer:code", both) } })),
      ),
    ).toMatchObject({
      provider: "deepinfra",
      model: "test/qwen-coder",
      tier: "flex",
      family: "qwen",
      policyVersion: "test.1",
      catalogVersion: "test.1",
      // The model's whole price entry from that catalog version, recorded on the run.
      price: { tiers: ["standard", "flex"], pricePerMTok: QWEN.pricePerMTok },
    });
    const unapprovedFirst = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", both),
          providers: { anthropic: { decision: "D-171", covers: "all" } },
        },
      }),
    );
    expect(routed(unapprovedFirst).model).toBe("claude-sonnet-5-5");
  });

  it("names why each candidate failed, in policy order", () => {
    const choice = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [
            candidate("not-in-catalog"),
            candidate("test/qwen-coder", "deepinfra"),
          ]),
          providers: { anthropic: { decision: "D-171", covers: "all" } },
        },
      }),
    );
    expect(refused(choice)).toEqual({
      settingsProblems: [],
      rejected: [
        {
          index: 0,
          provider: "anthropic",
          model: "not-in-catalog",
          tier: "standard",
          failed: [
            { rule: "known_price", detail: "the model is not in the catalog" },
            { rule: "output_cap", detail: "no catalog output cap to compare" },
          ],
        },
        {
          index: 1,
          provider: "deepinfra",
          model: "test/qwen-coder",
          tier: "standard",
          failed: [
            {
              rule: "approved_provider",
              detail: "the provider is not on the approved list",
            },
          ],
        },
      ],
    });
  });
});

describe("hard rule 1: QA independence", () => {
  const qa = (runs: EarlierRun[], candidates: Json[], mode = "model_id") =>
    chooseRoute(
      input({
        role: "qa",
        taskType: "qa:review",
        earlierRuns: runs,
        settings: { policy: policy("qa:review", candidates, mode) },
      }),
    );

  it("model_id: admits a QA model whose id differs from every Developer run's", () => {
    const runs = [developerRun("claude-sonnet-5-5", "claude")];
    expect(routed(qa(runs, [candidate("claude-opus-5-5")])).model).toBe(
      "claude-opus-5-5",
    );
  });

  it("model_id: refuses a QA model that a Developer run on the item used", () => {
    const runs = [
      developerRun("claude-opus-5-5", "claude"),
      developerRun("claude-sonnet-5-5", "claude"),
    ];
    expect(
      refused(qa(runs, [candidate("claude-sonnet-5-5")])).rejected[0]?.failed,
    ).toEqual([
      {
        rule: "qa_independence",
        detail: "the same model id as a Developer run on the item",
      },
    ]);
  });

  it("family: refuses a QA model of a Developer run's family, even with another id", () => {
    const runs = [developerRun("claude-sonnet-5-5", "claude")];
    expect(
      refused(qa(runs, [candidate("claude-opus-5-5")], "family")).rejected[0]?.failed,
    ).toEqual([
      {
        rule: "qa_independence",
        detail: "the same model family as a Developer run on the item",
      },
    ]);
  });

  it("family: admits a QA model of another family, skipping a same-family candidate", () => {
    const runs = [developerRun("claude-sonnet-5-5", "claude")];
    const route = routed(
      qa(
        runs,
        [candidate("claude-opus-5-5"), candidate("test/qwen-coder", "deepinfra")],
        "family",
      ),
    );
    expect(route).toMatchObject({ model: "test/qwen-coder", family: "qwen" });
  });

  it("family: refuses a QA candidate with no catalog family to compare", () => {
    const failed = refused(
      qa(
        [developerRun("claude-sonnet-5-5", "claude")],
        [candidate("unknown")],
        "family",
      ),
    ).rejected[0]?.failed.map((f) => f.rule);
    expect(failed).toContain("qa_independence");
  });

  it("reads only Developer runs, and does not apply to other roles", () => {
    const earlier: EarlierRun[] = [
      { bot: "qa", model: "claude-opus-5-5", modelFamily: "claude" },
    ];
    expect(routed(qa(earlier, [candidate("claude-opus-5-5")])).model).toBe(
      "claude-opus-5-5",
    );
    const developer = chooseRoute(
      input({ earlierRuns: [developerRun("claude-sonnet-5-5", "claude")] }),
    );
    expect(routed(developer).model).toBe("claude-sonnet-5-5");
  });
});

describe("hard rule 2: known price (fails closed)", () => {
  const withModel = (model: Json, tier = "standard") =>
    chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [candidate("m", "deepinfra", tier)]),
          catalog: { version: "c", models: { m: model } },
        },
      }),
    );

  it("refuses a model with no Standard price, which every request may be billed at", () => {
    const noStandard = { ...QWEN, pricePerMTok: { flex: QWEN.pricePerMTok.flex } };
    expect(refused(withModel(noStandard, "flex")).rejected[0]?.failed).toEqual([
      { rule: "known_price", detail: "no Standard price" },
    ]);
  });

  it("refuses a supported tier with no price for it", () => {
    const noFlex = { ...QWEN, pricePerMTok: { standard: QWEN.pricePerMTok.standard } };
    expect(refused(withModel(noFlex, "flex")).rejected[0]?.failed).toEqual([
      { rule: "known_price", detail: "no flex price" },
    ]);
  });

  it("admits a tier the model does not support when Standard is priced (it is served at Standard)", () => {
    const standardOnly = {
      ...QWEN,
      tiers: ["standard"],
      pricePerMTok: { standard: QWEN.pricePerMTok.standard },
    };
    expect(routed(withModel(standardOnly, "flex")).tier).toBe("flex");
  });

  it("refuses a model the catalog lists under another provider", () => {
    const choice = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [
            candidate("claude-sonnet-5-5", "deepinfra"),
          ]),
        },
      }),
    );
    expect(refused(choice).rejected[0]?.failed).toEqual([
      {
        rule: "known_price",
        detail: "the catalog lists the model under another provider",
      },
    ]);
  });
});

describe("hard rule 3: approved provider", () => {
  it("refuses a provider that is not on model_providers_approved", () => {
    const choice = chooseRoute(
      input({
        settings: {
          providers: { deepinfra: { decision: "D-208", covers: "self_hosted" } },
        },
      }),
    );
    expect(refused(choice).rejected[0]?.failed).toEqual([
      { rule: "approved_provider", detail: "the provider is not on the approved list" },
    ]);
  });

  it("refuses a resold model from a provider approved only for the models it hosts", () => {
    const resold = { ...QWEN, family: "claude", resold: true };
    const choice = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [candidate("test/resold", "deepinfra")]),
          catalog: { version: "test.1", models: { "test/resold": resold } },
        },
      }),
    );
    expect(refused(choice).rejected[0]?.failed).toEqual([
      {
        rule: "approved_provider",
        detail:
          "the provider is approved only for models it hosts itself, and this model is resold",
      },
    ]);
  });

  it("admits a model the provider hosts itself under a self_hosted approval", () => {
    const choice = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [candidate("test/qwen-coder", "deepinfra")]),
        },
      }),
    );
    expect(choice.routed).toBe(true);
  });

  it("admits a resold model when the approval covers all models", () => {
    const choice = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [candidate("test/resold", "deepinfra")]),
          catalog: {
            version: "test.1",
            models: { "test/resold": { ...QWEN, resold: true } },
          },
          providers: { deepinfra: { decision: "D-208", covers: "all" } },
        },
      }),
    );
    expect(choice.routed).toBe(true);
  });

  it("refuses an approval with no covers value", () => {
    const choice = chooseRoute(
      input({ settings: { providers: { anthropic: { decision: "D-171" } } } }),
    );
    expect(choice.routed).toBe(false);
    expect(refused(choice).settingsProblems).toContain(
      "model_providers_approved.anthropic.covers must be all or self_hosted",
    );
  });

  it("does not take a prototype name as an approved provider", () => {
    const choice = chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [
            candidate("claude-sonnet-5-5", "constructor"),
          ]),
          providers: {},
        },
      }),
    );
    expect(refused(choice).rejected[0]?.failed.map((f) => f.rule)).toContain(
      "approved_provider",
    );
  });
});

describe("hard rule 4: output cap", () => {
  const route = (need: number) =>
    chooseRoute(
      input({
        settings: {
          policy: policy("developer:code", [candidate("test/qwen-coder", "deepinfra")]),
          outputNeeds: { "developer:code": need },
        },
      }),
    );

  it("admits a cap equal to the need, and refuses one below it", () => {
    expect(routed(route(16384)).model).toBe("test/qwen-coder");
    expect(refused(route(16385)).rejected[0]?.failed).toEqual([
      { rule: "output_cap", detail: "the output cap is below the task type's need" },
    ]);
  });

  it("admits a model with no cap (null) for any need", () => {
    const choice = chooseRoute(
      input({ settings: { outputNeeds: { "developer:code": 1_000_000 } } }),
    );
    expect(routed(choice).model).toBe("claude-sonnet-5-5");
  });
});

describe("malformed settings fail closed, naming the field and never the value", () => {
  const problemsFor = (
    settings: Partial<RouteInput["settings"]>,
    taskType?: string,
  ) => {
    const noRoute = refused(chooseRoute(input({ settings, taskType })));
    expect(noRoute.rejected).toEqual([]);
    return noRoute.settingsProblems;
  };

  it.each([
    ["policy", null, "model_routing_policy must be an object"],
    ["catalog", null, "model_catalog must be an object"],
    ["providers", null, "model_providers_approved must be an object of provider names"],
    ["outputNeeds", null, "model_output_token_needs must be an object of task types"],
  ] as const)("refuses a missing %s setting", (key, value, problem) => {
    expect(problemsFor({ [key]: value })).toContain(problem);
  });

  it("refuses a policy with a bad tier, mode, capacity rule, list or extra field", () => {
    const bad = {
      version: "",
      qaIndependence: "vibes",
      extra: true,
      taskTypes: {
        "developer:code": {
          candidates: [
            {
              provider: "anthropic",
              model: "claude-sonnet-5-5",
              tier: "turbo",
              failFast: "no",
            },
          ],
          onCapacity: "retry",
        },
        triage: { candidates: [], onCapacity: "wait" },
      },
    };
    const problems = problemsFor({ policy: bad });
    expect(problems).toEqual(
      expect.arrayContaining([
        "model_routing_policy: unknown field extra",
        "model_routing_policy.version must be a non-empty string",
        "model_routing_policy.qaIndependence must be model_id or family",
        "model_routing_policy.taskTypes.developer:code.onCapacity must be wait or next_candidate",
        "model_routing_policy.taskTypes.developer:code.candidates.0.tier must be standard, flex, priority",
        "model_routing_policy.taskTypes.developer:code.candidates.0.failFast must be a boolean",
        "model_routing_policy.taskTypes.triage.candidates must be a non-empty list",
      ]),
    );
    expect(problems.join(" ")).not.toMatch(/vibes|turbo|retry/);
  });

  it("refuses a catalog entry with a bad price, tier list, cap or date", () => {
    const bad = {
      version: "c",
      models: {
        m: {
          ...QWEN,
          tiers: ["standard", "standard"],
          pricePerMTok: {
            standard: { input: -1, cachedInput: 0.1, output: "1" },
            gold: {},
          },
          maxOutputTokens: 0,
          priceReadOn: "yesterday",
        },
      },
    };
    const problems = problemsFor({ catalog: bad });
    expect(problems).toEqual(
      expect.arrayContaining([
        "model_catalog.models.m.tiers must be a non-empty list of distinct service tiers",
        "model_catalog.models.m.pricePerMTok.standard.input must be a number of at least 0",
        "model_catalog.models.m.pricePerMTok.standard.output must be a number of at least 0",
        "model_catalog.models.m.pricePerMTok: unknown tier gold",
        "model_catalog.models.m.maxOutputTokens must be null or a whole number above 0",
        "model_catalog.models.m.priceReadOn must be a date (YYYY-MM-DD)",
      ]),
    );
    expect(problems.join(" ")).not.toMatch(/yesterday|-1/);
  });

  it("refuses the whole catalog when an entry the policy does not use is malformed", () => {
    const catalog = {
      ...CATALOG,
      models: { ...CATALOG.models, other: { provider: "x" } },
    };
    expect(problemsFor({ catalog })).toContain(
      "model_catalog.models.other.family must be a non-empty string",
    );
  });

  it("refuses an approved provider without a decision id, and a bad output need", () => {
    expect(problemsFor({ providers: { anthropic: { decision: "yes" } } })).toEqual([
      "model_providers_approved.anthropic.decision must be a decision id such as D-171",
    ]);
    expect(
      problemsFor({ outputNeeds: { ...FIRST_OUTPUT_TOKEN_NEEDS, triage: 1.5 } }),
    ).toEqual(["model_output_token_needs.triage must be a whole number above 0"]);
  });

  it("refuses a task type the policy or the output needs do not name", () => {
    expect(problemsFor({}, "unknown:type")).toEqual([
      "model_routing_policy.taskTypes has no entry for the run's task type",
      "model_output_token_needs has no need for the run's task type",
    ]);
    expect(problemsFor({}, "toString")).toHaveLength(2);
  });
});

describe("onCapacity and failFast are parsed and kept on the route", () => {
  it("keeps next_candidate and failFast from the policy", () => {
    const choice = chooseRoute(
      input({
        settings: {
          policy: {
            version: "p",
            qaIndependence: "model_id",
            taskTypes: {
              "developer:code": {
                candidates: [
                  {
                    ...(candidate("test/qwen-coder", "deepinfra", "flex") as object),
                    failFast: true,
                  },
                ],
                onCapacity: "next_candidate",
              },
            },
          },
        },
      }),
    );
    expect(routed(choice)).toMatchObject({
      failFast: true,
      onCapacity: "next_candidate",
    });
  });
});

describe("the input hash", () => {
  it("is a SHA-256 that ignores key order and non-Developer runs, and changes with what the rule reads", () => {
    const base = input({ role: "qa", taskType: "qa:review" });
    const hash = routeInputHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      ...base,
      settings: {
        ...base.settings,
        catalog: { models: CATALOG.models, version: CATALOG.version },
      },
    };
    expect(routeInputHash(reordered)).toBe(hash);
    const withQa = {
      ...base,
      earlierRuns: [{ bot: "qa", model: "x", modelFamily: "y" }],
    };
    expect(routeInputHash(withQa)).toBe(hash);
    const withDeveloper = {
      ...base,
      earlierRuns: [developerRun("claude-sonnet-5-5", "claude")],
    };
    expect(routeInputHash(withDeveloper)).not.toBe(hash);
    expect(routeInputHash({ ...base, taskType: "triage" })).not.toBe(hash);
    const capacityEnd = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      tier: "standard" as const,
    };
    expect(routeInputHash({ ...base, capacityEnd })).not.toBe(hash);
  });
});

describe("after a capacity end (ADR 0114 section 5, D-221)", () => {
  const SONNET = "claude-sonnet-5-5";
  const OPUS = "claude-opus-5-5";
  const capacityPolicy = (onCapacity: string, candidates: Json[]): Json => ({
    version: "test.1",
    qaIndependence: "model_id",
    taskTypes: { "developer:code": { candidates, onCapacity } },
  });
  const ranOn = (model: string, provider = "anthropic", tier = "standard") =>
    ({ provider, model, tier }) as RouteInput["capacityEnd"];

  it("takes the first passing candidate after the one that ran, with next_candidate", () => {
    const choice = chooseRoute({
      ...input({
        settings: {
          policy: capacityPolicy("next_candidate", [
            candidate(SONNET),
            candidate("test/unpriced"),
            candidate(OPUS),
          ]),
        },
      }),
      capacityEnd: ranOn(SONNET),
    });
    expect(routed(choice)).toMatchObject({
      model: OPUS,
      afterCapacity: "next_candidate",
    });
  });

  it("does not go back before the candidate that ran", () => {
    const choice = chooseRoute({
      ...input({
        settings: {
          policy: capacityPolicy("next_candidate", [
            candidate(SONNET),
            candidate(OPUS),
          ]),
        },
      }),
      capacityEnd: ranOn(OPUS),
    });
    // No candidate after Opus: the choice is as for wait, from the first candidate (D-221).
    expect(routed(choice)).toMatchObject({
      model: SONNET,
      afterCapacity: "no_later_candidate",
    });
  });

  it("chooses as for wait when no later candidate passes the hard rules (D-221)", () => {
    const choice = chooseRoute({
      ...input({
        settings: {
          policy: capacityPolicy("next_candidate", [
            candidate(SONNET),
            candidate("test/qwen-coder", "together"),
          ]),
        },
      }),
      capacityEnd: ranOn(SONNET),
    });
    expect(routed(choice)).toMatchObject({
      model: SONNET,
      afterCapacity: "no_later_candidate",
    });
  });

  it("chooses as for wait when the policy no longer lists the candidate that ran", () => {
    const choice = chooseRoute({
      ...input({
        settings: {
          policy: capacityPolicy("next_candidate", [
            candidate(SONNET),
            candidate(OPUS),
          ]),
        },
      }),
      capacityEnd: ranOn("test/qwen-coder", "deepinfra", "flex"),
    });
    expect(routed(choice)).toMatchObject({
      model: SONNET,
      afterCapacity: "no_later_candidate",
    });
  });

  it("keeps today's first candidate with wait, marked as a wait", () => {
    const choice = chooseRoute({
      ...input({
        settings: {
          policy: capacityPolicy("wait", [candidate(SONNET), candidate(OPUS)]),
        },
      }),
      capacityEnd: ranOn(SONNET),
    });
    expect(routed(choice)).toMatchObject({ model: SONNET, afterCapacity: "wait" });
  });

  it("matches the candidate that ran by provider, model and tier", () => {
    const choice = chooseRoute({
      ...input({
        settings: {
          policy: capacityPolicy("next_candidate", [
            candidate("test/qwen-coder", "deepinfra", "flex"),
            candidate("test/qwen-coder", "deepinfra", "standard"),
          ]),
        },
      }),
      capacityEnd: ranOn("test/qwen-coder", "deepinfra", "flex"),
    });
    // From Flex to Standard on the same model.
    expect(routed(choice)).toMatchObject({
      tier: "standard",
      afterCapacity: "next_candidate",
    });
  });

  it("still refuses with no_route when no candidate passes at all", () => {
    const noRoute = refused(
      chooseRoute({
        ...input({
          settings: {
            policy: capacityPolicy("next_candidate", [candidate("test/unpriced")]),
          },
        }),
        capacityEnd: ranOn("test/unpriced"),
      }),
    );
    expect(noRoute.rejected).toHaveLength(1);
  });
});
