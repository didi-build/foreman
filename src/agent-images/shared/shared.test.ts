import { describe, expect, it } from "vitest";

import {
  mapRunEnd,
  parseAgentResult,
} from "../../adapters/agent-runtime/kubernetes/result.ts";
import { CEILING_MESSAGE } from "../../egress-proxy/proxy.ts";
import { ConfigError } from "../../service-kit/config.ts";
import {
  providerErrorFromClaudeCode,
  providerErrorFromHttp,
  retryAfterSeconds,
} from "./provider-error.ts";
import { errorResult, redact, resultLine, type AgentResult } from "./result.ts";
import { PLACEHOLDER_CREDENTIAL, readImageSettings, secretValues } from "./settings.ts";
import { parseTask } from "./task.ts";
import { parseRunPrice, requestCostUsd, type RunPrice } from "./price.ts";
import { runCostUsd } from "../../core/run-cost.ts";
import { firstRunPrice } from "../../core/routing-testing.ts";
import type { ServiceTier } from "../../core/store.ts";
import { reportedTier, servedTier } from "./tiers.ts";
import { addTokens, tokensFromUsage } from "./tokens.ts";

// Unit: the helpers every agent image shares (ADR 0106 sections 4 to 6). No network.

const STATE_TOKEN = "state-token-value-not-real-0123456789";
const GITHUB_TOKEN = "github-token-value-not-real-0123456789";

const ENV = {
  FOREMAN_RUN_ID: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
  FOREMAN_ROLE: "qa",
  FOREMAN_MODEL: "claude-opus-5-5",
  FOREMAN_MAX_TURNS: "50",
  FOREMAN_MAX_BUDGET_USD: "2",
  FOREMAN_TASK_FILE: "/task/task.json",
  ANTHROPIC_BASE_URL: "http://10.245.0.10:8080/anthropic",
  FOREMAN_STATE_API_URL: "http://10.245.0.10:8080/state-api",
  FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
  HOME: "/work",
};

const sample: AgentResult = {
  status: "success",
  finalText: "Done.",
  structured: { verdict: "pass" },
  turns: 3,
  costUsd: 0.0207,
  tokens: { uncachedInput: 12, cachedInput: 4500, cacheWriteInput: 300, output: 80 },
  errorText: "",
  providerError: null,
};

describe("image settings (unit: config from the environment, fail closed)", () => {
  it("reads every setting the Kubernetes runtime writes into the agent Job", () => {
    expect(readImageSettings("claude-api", ENV)).toEqual({
      runId: ENV.FOREMAN_RUN_ID,
      role: "qa",
      model: "claude-opus-5-5",
      maxTurns: 50,
      maxUsd: 2,
      taskFile: "/task/task.json",
      modelBaseUrl: "http://10.245.0.10:8080/anthropic",
      stateApiUrl: "http://10.245.0.10:8080/state-api",
      stateApiToken: STATE_TOKEN,
      workDir: "/work",
    });
  });

  it("reads the provider's API and the proxy's address for it for the OpenCode image (D-222)", () => {
    const env = {
      ...ENV,
      FOREMAN_ROLE: "developer",
      ANTHROPIC_BASE_URL: "http://10.245.0.10:8080/not-read",
      FOREMAN_MODEL_API: "openai-compatible",
      FOREMAN_MODEL_BASE_URL: "http://10.245.0.10:8080/deepinfra/v1/openai/",
    };
    expect(readImageSettings("opencode", env)).toMatchObject({
      role: "developer",
      modelApi: "openai-compatible",
      modelBaseUrl: "http://10.245.0.10:8080/deepinfra/v1/openai",
    });
    expect(() =>
      readImageSettings("opencode", { ...env, FOREMAN_MODEL_API: "anthropic-v2" }),
    ).toThrow(/FOREMAN_MODEL_API is not a model API/);
    expect(() =>
      readImageSettings("opencode", { ...env, FOREMAN_MODEL_BASE_URL: undefined }),
    ).toThrow(/FOREMAN_MODEL_BASE_URL is not set/);
    expect(() => readImageSettings("opencode", ENV)).toThrow(/FOREMAN_ROLE/);
    // The Claude images keep reading ANTHROPIC_BASE_URL and have no API setting.
    expect(readImageSettings("claude-api", ENV)).not.toHaveProperty("modelApi");
  });

  it("refuses a role the image does not run", () => {
    expect(() => readImageSettings("claude-code", ENV)).toThrow(/FOREMAN_ROLE/);
    expect(() =>
      readImageSettings("claude-api", { ...ENV, FOREMAN_ROLE: "developer" }),
    ).toThrow(/FOREMAN_ROLE is not a role this image runs/);
  });

  it("names every missing or bad setting, never its value", () => {
    const env: Record<string, string> = {
      ...ENV,
      FOREMAN_MAX_TURNS: "ten",
      FOREMAN_MAX_BUDGET_USD: "-1",
      ANTHROPIC_BASE_URL: `http://user:${STATE_TOKEN}@proxy/anthropic`,
    };
    delete env.FOREMAN_STATE_API_TOKEN;
    let error: unknown;
    try {
      readImageSettings("claude-api", env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems).toEqual([
      "FOREMAN_MAX_TURNS is not a whole number above 0",
      "FOREMAN_MAX_BUDGET_USD is not an amount above 0",
      "ANTHROPIC_BASE_URL must be an http(s) URL with no credentials, query or fragment",
      "FOREMAN_STATE_API_TOKEN is not set",
    ]);
    expect(String((error as Error).message)).not.toContain(STATE_TOKEN);
  });

  it.each([
    "claude-sonnet-5-5",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
    "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    "nace-ai/drex-v2.0",
  ])("accepts the model id %s", (model) => {
    expect(
      readImageSettings("claude-api", { ...ENV, FOREMAN_MODEL: model }).model,
    ).toBe(model);
  });

  it.each(["../etc", "a/b/c", "/claude", "claude/", "x".repeat(201), "a b"])(
    "refuses the model id %j",
    (model) => {
      expect(() =>
        readImageSettings("claude-api", { ...ENV, FOREMAN_MODEL: model }),
      ).toThrow(/FOREMAN_MODEL is not a model id/);
    },
  );

  it("lists every credential value the run may see, the placeholder included", () => {
    const settings = readImageSettings("claude-api", ENV);
    expect(secretValues(settings, { GITHUB_TOKEN })).toEqual([
      STATE_TOKEN,
      GITHUB_TOKEN,
      PLACEHOLDER_CREDENTIAL,
    ]);
  });
});

describe("task file (unit: the same rules as the runner)", () => {
  const qaTask = {
    foremanTask: 1,
    instructions: "Review.",
    input: "diff",
    nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    evidenceIds: [],
  };

  it("accepts a valid task and refuses one its role does not allow", () => {
    expect(parseTask("qa", JSON.stringify(qaTask))).toEqual(qaTask);
    expect(() => parseTask("council", JSON.stringify(qaTask))).toThrow(/evidence ids/);
    expect(() => parseTask("qa", "not json")).toThrow(/not JSON/);
    expect(() =>
      parseTask("qa", JSON.stringify({ ...qaTask, foremanTask: 2 })),
    ).toThrow(/version 1/);
  });
});

describe("result line (unit: round trip through the runtime's parser, ADR 0106 section 4)", () => {
  it("is one JSON line that the Kubernetes runtime parses back to the same result", () => {
    const line = resultLine(sample, []);
    expect(line).not.toContain("\n");
    expect(parseAgentResult(`some log line\n${line}\n`)).toEqual(sample);
  });

  it("round-trips an error with a provider error and no counts", () => {
    const failed: AgentResult = {
      ...errorResult("the model provider answered 429"),
      providerError: {
        status: 429,
        type: "rate_limit_error",
        message: "slow down",
        retryAfterSeconds: 30,
      },
    };
    expect(parseAgentResult(resultLine(failed, []))).toEqual(failed);
  });

  it("round-trips what the runtime measured about the route (ADR 0114)", () => {
    const measured: AgentResult = {
      ...sample,
      serviceTierServed: "mixed",
      capacityRetries: 2,
      capacityWaitSeconds: 90,
      firstTokenMs: 700,
    };
    expect(parseAgentResult(resultLine(measured, []))).toEqual(measured);
    expect(resultLine(sample, [])).not.toContain("capacityRetries");
  });

  it("removes every credential value, at any depth", () => {
    const leaky: AgentResult = {
      ...sample,
      finalText: `token ${STATE_TOKEN} and ${PLACEHOLDER_CREDENTIAL}`,
      structured: { nested: [GITHUB_TOKEN] },
    };
    const line = resultLine(leaky, [STATE_TOKEN, GITHUB_TOKEN, PLACEHOLDER_CREDENTIAL]);
    for (const secret of [STATE_TOKEN, GITHUB_TOKEN, PLACEHOLDER_CREDENTIAL]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain("[redacted]");
    expect(redact("short", ["short"])).toBe("short");
  });

  it.each([
    [{ status: "max_turns" }, "budget_exceeded", "max_turns"],
    [{ status: "max_budget" }, "budget_exceeded", "max_budget"],
    [
      { status: "error", errorText: CEILING_MESSAGE },
      "budget_exceeded",
      "proxy_ceiling",
    ],
    [
      {
        status: "error",
        providerError: {
          status: 429,
          type: "rate_limit_error",
          message: "",
          retryAfterSeconds: 40,
        },
      },
      "usage_exhausted",
      "rate_limit",
    ],
    [
      {
        status: "error",
        providerError: {
          status: 529,
          type: "overloaded_error",
          message: "",
          retryAfterSeconds: null,
        },
      },
      "usage_exhausted",
      "capacity",
    ],
    [
      {
        status: "error",
        providerError: {
          status: 402,
          type: "billing_error",
          message: "",
          retryAfterSeconds: null,
        },
      },
      "usage_exhausted",
      "out_of_credit",
    ],
  ] as const)("maps %j to %s (%s) through the runtime", (fields, outcome, detail) => {
    const result = { ...errorResult(""), ...fields } as AgentResult;
    const parsed = parseAgentResult(resultLine(result, []));
    const end = mapRunEnd("failed", null, parsed, "claude-opus-5-5");
    expect(end).toMatchObject({ outcome, detail });
    if (detail === "rate_limit") expect(end.retryAfterSeconds).toBe(40);
  });
});

describe("provider errors (unit: 429, 529, 402 and the proxy's ceiling)", () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name] ?? null,
  });

  it("reads Anthropic's error body and the retry-after header", () => {
    expect(
      providerErrorFromHttp(429, headers({ "retry-after": "30" }), {
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      }),
    ).toEqual({
      status: 429,
      type: "rate_limit_error",
      message: "slow down",
      retryAfterSeconds: 30,
    });
    expect(
      providerErrorFromHttp(529, headers({}), {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ).toMatchObject({ status: 529, type: "overloaded_error", retryAfterSeconds: null });
    expect(
      providerErrorFromHttp(402, null, {
        type: "error",
        error: { type: "billing_error", message: "credit" },
      }),
    ).toMatchObject({ status: 402, type: "billing_error" });
  });

  it("reads an OpenAI-style error code as the type when there is no type", () => {
    expect(
      providerErrorFromHttp(429, null, {
        error: { code: "engine_overloaded", message: "busy" },
      }),
    ).toMatchObject({ status: 429, type: "engine_overloaded", message: "busy" });
  });

  it("reads the proxy's own error body", () => {
    expect(providerErrorFromHttp(403, null, { error: CEILING_MESSAGE })).toMatchObject({
      status: 403,
      message: CEILING_MESSAGE,
    });
  });

  it("reads retry-after as seconds or an HTTP date, and ignores anything else", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    expect(retryAfterSeconds("120", now)).toBe(120);
    expect(retryAfterSeconds("Fri, 30 Oct 2026 12:01:30 GMT", now)).toBe(90);
    expect(retryAfterSeconds("Fri, 30 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds("soon", now)).toBeNull();
    expect(retryAfterSeconds(null, now)).toBeNull();
  });

  it("reads Claude Code's api_error_status and the error type in its text", () => {
    expect(
      providerErrorFromClaudeCode(
        429,
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}',
      ),
    ).toMatchObject({ status: 429, type: "rate_limit_error", retryAfterSeconds: null });
    expect(providerErrorFromClaudeCode(null, "something else")).toBeNull();
  });
});

describe("the run's price (unit: the dollar limit from the catalog entry, ADR 0114 sections 5 and 8)", () => {
  const OPUS = firstRunPrice("claude-opus-5-5");
  const SONNET = firstRunPrice("claude-sonnet-5-5");
  /** A test open model with Flex and no cache-write price. Not a real catalog entry. */
  const OPEN: RunPrice = {
    tiers: ["standard", "flex"],
    pricePerMTok: {
      standard: { input: 0.3, cachedInput: 0.1, output: 1 },
      flex: { input: 0.24, cachedInput: 0.08, output: 0.8 },
    },
  };
  const MILLION = {
    uncachedInput: 1_000_000,
    cachedInput: 1_000_000,
    cacheWriteInput: 1_000_000,
    output: 1_000_000,
  };

  it("prices today's Claude models as the removed price table did", () => {
    // 1M of each at Opus 5.5: 4 + 0.2 + 5 + 20.
    expect(requestCostUsd(OPUS, "standard", MILLION)).toBeCloseTo(29.2, 9);
    expect(
      requestCostUsd(SONNET, null, {
        uncachedInput: 1000,
        cachedInput: 0,
        output: 1000,
      }),
    ).toBeCloseTo(0.012, 9);
  });

  it("prices an open model at the tier each response reports, and Standard otherwise", () => {
    // Cache writes at the uncached input rate: the catalog lists none.
    expect(requestCostUsd(OPEN, "flex", MILLION)).toBeCloseTo(1.36, 9);
    expect(requestCostUsd(OPEN, "standard", MILLION)).toBeCloseTo(1.7, 9);
    expect(requestCostUsd(OPEN, null, MILLION)).toBeCloseTo(1.7, 9);
    expect(requestCostUsd(OPEN, "priority", MILLION)).toBeCloseTo(1.7, 9);
  });

  it.each<[RunPrice, ServiceTier | null]>([
    [OPEN, "flex"],
    [OPEN, "standard"],
    [OPEN, null],
    [OPEN, "priority"],
    [OPUS, "standard"],
    [SONNET, "flex"],
    [
      {
        tiers: ["standard", "flex"],
        pricePerMTok: { standard: { input: 1, cachedInput: 0.1, output: 2 } },
      },
      "flex",
    ],
  ])("agrees with the core's cost_usd for one response (%#)", (price, tier) => {
    const tokens = {
      uncachedInput: 1234,
      cachedInput: 56789,
      cacheWriteInput: 321,
      output: 987,
    };
    expect(requestCostUsd(price, tier, tokens)).toBeCloseTo(
      runCostUsd(price, tokens, tier),
      9,
    );
  });

  it("reads the runner's JSON, and fails closed on a missing or unusable price", () => {
    expect(parseRunPrice(JSON.stringify(OPEN), "flex")).toEqual(OPEN);
    expect(parseRunPrice(JSON.stringify(SONNET), "flex")).toEqual(SONNET);
    for (const [raw, problem] of [
      ["not json", /is not JSON/],
      ["[]", /is not a run price/],
      [JSON.stringify({ ...OPEN, tiers: [] }), /is not a run price/],
      [JSON.stringify({ ...OPEN, pricePerMTok: { batch: {} } }), /is not a run price/],
      [
        JSON.stringify({ ...OPEN, pricePerMTok: { standard: { input: "1" } } }),
        /is not a price per million tokens/,
      ],
      [
        JSON.stringify({ ...OPEN, pricePerMTok: { flex: OPEN.pricePerMTok.flex } }),
        /has no Standard price/,
      ],
      [
        JSON.stringify({
          ...OPEN,
          pricePerMTok: { standard: OPEN.pricePerMTok.standard },
        }),
        /has no price for the requested tier/,
      ],
    ] as const) {
      expect(() => parseRunPrice(raw, "flex")).toThrow(problem);
    }
  });
});

describe("served tier (unit: ADR 0114 section 8)", () => {
  it("reads the tier a response reports, in usage or at the top level", () => {
    expect(reportedTier({ usage: { service_tier: "flex" } })).toBe("flex");
    expect(reportedTier({ service_tier: "priority" })).toBe("priority");
    expect(reportedTier({ usage: { service_tier: "batch" } })).toBeNull();
    expect(reportedTier({ usage: {} })).toBeNull();
    expect(reportedTier(null)).toBeNull();
  });

  it("is one tier when every response reported it, mixed otherwise, null when none did", () => {
    expect(servedTier(["flex", "flex"])).toBe("flex");
    expect(servedTier(["standard"])).toBe("standard");
    expect(servedTier(["flex", "standard"])).toBe("mixed");
    expect(servedTier(["flex", null])).toBe("mixed");
    expect(servedTier([null, null])).toBeNull();
    expect(servedTier([])).toBeNull();
  });
});

describe("token accounting (unit: cached and uncached input apart, D-185)", () => {
  it("keeps uncached input, cache reads and cache writes apart", () => {
    expect(
      tokensFromUsage({
        input_tokens: 12,
        cache_read_input_tokens: 4500,
        cache_creation_input_tokens: 300,
        output_tokens: 80,
      }),
    ).toEqual({
      uncachedInput: 12,
      cachedInput: 4500,
      cacheWriteInput: 300,
      output: 80,
    });
  });

  it("treats missing or null counts as zero and adds runs of turns", () => {
    const first = tokensFromUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: null,
    });
    const second = tokensFromUsage({
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 90,
    });
    expect(addTokens(first, second)).toEqual({
      uncachedInput: 12,
      cachedInput: 90,
      cacheWriteInput: 0,
      output: 6,
    });
  });
});
