import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  mapRunEnd,
  parseAgentResult,
} from "../../adapters/agent-runtime/kubernetes/result.ts";
import { CEILING_MESSAGE, REJECTED_CEILING_MESSAGE } from "../../egress-proxy/proxy.ts";
import type { RunPrice } from "../shared/price.ts";
import { PLACEHOLDER_CREDENTIAL } from "../shared/settings.ts";
import { refuseRepositoryConfig } from "./checkout.ts";
import { OPENCODE_SWITCHES, openCodeCommand } from "./command.ts";
import { capTier, openCodeConfig } from "./config.ts";
import {
  EMPTY_TALLY,
  addEventLine,
  readError,
  stepTokens,
  type RunTally,
} from "./events.ts";
import { runOpenCodeImage } from "./image.ts";
import { limitStop } from "./limits.ts";
import { mcpBlock } from "./magicpath.ts";
import { openCodePermissions } from "./permissions.ts";
import type { StopClock } from "./process.ts";
import { OPENCODE_RETRIES, openCodeResult } from "./result.ts";
import type { OpenCodeSettings } from "./settings.ts";

const STATE_TOKEN = "state-token-value-not-real-0123456789";
const GITHUB_TOKEN = "github-token-value-not-real-0123456789";
const RUN_ID = "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21";
const NOW = new Date("2026-10-31T12:00:00Z");

const SONNET_PRICE: RunPrice = {
  tiers: ["standard"],
  pricePerMTok: {
    standard: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  },
};
const OPEN_PRICE: RunPrice = {
  tiers: ["standard", "flex", "priority"],
  pricePerMTok: {
    standard: { input: 0.3, cachedInput: 0.06, output: 1.2 },
    flex: { input: 0.15, cachedInput: 0.03, output: 0.6 },
    priority: { input: 0.6, cachedInput: 0.12, output: 2.4 },
  },
};

const settings: OpenCodeSettings = {
  runId: RUN_ID,
  role: "developer",
  model: "claude-sonnet-5-5",
  maxTurns: 100,
  maxUsd: 5,
  taskFile: "/task/task.json",
  modelApi: "anthropic",
  modelBaseUrl: "http://10.245.0.10:8080/anthropic/v1",
  stateApiUrl: "http://10.245.0.10:8080/state-api",
  stateApiToken: STATE_TOKEN,
  workDir: "/work",
  serviceTier: "standard",
  price: SONNET_PRICE,
  maxOutputTokens: 16000,
  cliPath: "/opt/opencode/bin/opencode",
  configHome: "/opt/opencode/xdg-config",
  magicPathUrl: undefined,
};

const TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git *)", "Bash(npm *)"];

describe("OpenCode permissions (unit: D-196 mapped, check 3 of the spike)", () => {
  it("maps D-196's tool list, denying everything else first and never asking", () => {
    expect(openCodePermissions("developer", TOOLS)).toEqual({
      "*": "deny",
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      bash: { "*": "deny", "git *": "allow", "npm *": "allow" },
    });
    const json = JSON.stringify(openCodePermissions("designer", TOOLS));
    expect(json).not.toContain("ask");
    expect(Object.keys(openCodePermissions("developer", TOOLS))[0]).toBe("*");
  });

  it("allows no shell at all when no Bash pattern is listed", () => {
    expect(openCodePermissions("developer", ["Read"])).toEqual({
      "*": "deny",
      read: "allow",
    });
  });

  it("refuses bare Bash, Bash(*), an unknown tool and an empty list, naming the position only", () => {
    expect(() => openCodePermissions("developer", ["Read", "Bash"])).toThrow(
      /^allowed tool 2 would allow every shell command$/,
    );
    expect(() => openCodePermissions("developer", ["Bash(*)"])).toThrow(
      /every shell command/,
    );
    expect(() => openCodePermissions("developer", ["Bash( * )"])).toThrow(
      /every shell command/,
    );
    expect(() => openCodePermissions("developer", ["Read", "WebFetch"])).toThrow(
      /^allowed tool 2 has no OpenCode permission$/,
    );
    expect(() => openCodePermissions("developer", [])).toThrow(/allowed tools/);
  });

  it("gives the MagicPath MCP tools to the Designer only", () => {
    expect(openCodePermissions("designer", ["Read", "mcp__magicpath"])).toEqual({
      "*": "deny",
      read: "allow",
      "magicpath_*": "allow",
    });
    expect(() => openCodePermissions("developer", ["mcp__magicpath"])).toThrow(
      /only for a Designer/,
    );
  });
});

describe("OpenCode config (unit: one provider at the proxy, catalog prices, limits)", () => {
  it("builds the exact Developer config for an Anthropic route", () => {
    expect(
      openCodeConfig(settings, { allowedTools: TOOLS }, "/tmp/run/instructions.md"),
    ).toEqual({
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      lsp: false,
      formatter: false,
      enabled_providers: ["foreman"],
      model: "foreman/claude-sonnet-5-5",
      small_model: "foreman/claude-sonnet-5-5",
      provider: {
        foreman: {
          npm: "@ai-sdk/anthropic",
          options: {
            baseURL: "http://10.245.0.10:8080/anthropic/v1",
            apiKey: PLACEHOLDER_CREDENTIAL,
          },
          models: {
            "claude-sonnet-5-5": {
              tool_call: true,
              limit: { context: 0, output: 16000 },
              cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            },
          },
        },
      },
      permission: {
        "*": "deny",
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        bash: { "*": "deny", "git *": "allow", "npm *": "allow" },
      },
      instructions: ["/tmp/run/instructions.md"],
      agent: { build: { steps: 100 } },
    });
  });

  it("sets the tier and a run cache key on an OpenAI-compatible Flex route, and prices at Standard", () => {
    const config = openCodeConfig(
      {
        ...settings,
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
        modelApi: "openai-compatible",
        modelBaseUrl: "http://10.245.0.10:8080/deepinfra/v1/openai",
        serviceTier: "flex",
        price: OPEN_PRICE,
        maxOutputTokens: 8000,
        maxTurns: 7,
      },
      { allowedTools: ["Read"] },
      "/tmp/i.md",
    );
    expect(config.model).toBe("foreman/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo");
    const provider = config.provider.foreman!;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.models["Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo"]).toEqual({
      tool_call: true,
      limit: { context: 0, output: 8000 },
      // No cache write price: the uncached input rate (O-26). Flex is billed below Standard.
      cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.3 },
      options: { service_tier: "flex", prompt_cache_key: RUN_ID },
    });
    expect(config.agent.build.steps).toBe(7);
  });

  it("prices a Priority route at Priority, and sends no tier on Standard", () => {
    const priority = openCodeConfig(
      { ...settings, serviceTier: "priority", price: OPEN_PRICE },
      { allowedTools: ["Read"] },
      "/tmp/i.md",
    );
    expect(priority.provider.foreman!.models["claude-sonnet-5-5"]).toMatchObject({
      cost: { input: 0.6, output: 2.4, cache_read: 0.12, cache_write: 0.6 },
      options: { service_tier: "priority" },
    });
    expect(capTier(OPEN_PRICE, "priority")).toBe("priority");
    expect(capTier(SONNET_PRICE, "priority")).toBeNull();
    expect(capTier(OPEN_PRICE, "flex")).toBeNull();
    const standard = openCodeConfig(settings, { allowedTools: ["Read"] }, "/tmp/i.md");
    expect(standard.provider.foreman!.models["claude-sonnet-5-5"]).not.toHaveProperty(
      "options",
    );
  });

  it("has no MCP block while MagicPath is off, and refuses a MagicPath setting", () => {
    expect(
      openCodeConfig(settings, { allowedTools: TOOLS }, "/tmp/i.md"),
    ).not.toHaveProperty("mcp");
    expect(() =>
      openCodeConfig(
        {
          ...settings,
          role: "designer",
          magicPathUrl: "http://10.245.0.10:8080/magicpath/mcp",
        },
        { allowedTools: TOOLS },
        "/tmp/i.md",
      ),
    ).toThrow(/D-190/);
  });

  it("when MagicPath is on, points the Designer at the proxy route with a placeholder bearer (D-198)", () => {
    const config = openCodeConfig(
      {
        ...settings,
        role: "designer",
        magicPathUrl: "http://10.245.0.10:8080/magicpath/mcp",
      },
      { allowedTools: ["Read", "mcp__magicpath"] },
      "/tmp/i.md",
      true,
    );
    expect(config.mcp).toEqual({
      magicpath: {
        type: "remote",
        url: "http://10.245.0.10:8080/magicpath/mcp",
        enabled: true,
        oauth: false,
        timeout: 10000,
        headers: { Authorization: `Bearer ${PLACEHOLDER_CREDENTIAL}` },
      },
    });
    expect(config.permission["magicpath_*"]).toBe("allow");
    expect(() =>
      mcpBlock("developer", "http://10.245.0.10:8080/magicpath/mcp", true),
    ).toThrow(/only for a Designer/);
    expect(() =>
      mcpBlock("designer", "http://user:pw@10.245.0.10:8080/magicpath", true),
    ).toThrow(/no credentials/);
  });
});

describe("OpenCode command (unit: exact flags, no shell, the spike's switches)", () => {
  it("builds the exact command with the prompt kept off the argument list", () => {
    const command = openCodeCommand(settings, "/tmp/run/opencode.json", "/tmp", {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://10.245.0.10:8080",
      HTTP_PROXY: "http://10.245.0.10:8080",
      NO_PROXY: "10.245.0.10",
      GITHUB_TOKEN,
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      ANTHROPIC_API_KEY: "a-real-key-must-never-pass-0123456789",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
      OPENCODE_PERMISSION: '"allow"',
      OPENCODE_ENABLE_EXA: "1",
    });
    expect(command.file).toBe("/opt/opencode/bin/opencode");
    expect(command.cwd).toBe("/work");
    expect(command.args).toEqual([
      "run",
      "--format",
      "json",
      "--pure",
      "--title",
      RUN_ID,
      "-m",
      "foreman/claude-sonnet-5-5",
    ]);
    expect(command.env).toEqual({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://10.245.0.10:8080",
      NO_PROXY: "10.245.0.10",
      GITHUB_TOKEN,
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      HOME: "/work",
      TMPDIR: "/tmp",
      XDG_CONFIG_HOME: "/opt/opencode/xdg-config",
      OPENCODE_CONFIG: "/tmp/run/opencode.json",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    });
    expect(Object.keys(OPENCODE_SWITCHES)).toHaveLength(7);
  });
});

describe("repository config at start (unit: finding 6a of the spike)", () => {
  it.each([".opencode", "opencode.json", "opencode.jsonc"])(
    "refuses a working folder with %s, naming the file only",
    (name) => {
      const seen = new Set([`/work/${name}`]);
      expect(() => refuseRepositoryConfig("/work", (p) => seen.has(p))).toThrow(
        `the working folder or a folder above it has ${name}, which OpenCode would load; the run is refused`,
      );
    },
  );

  it("refuses one in a folder above, and lets a clean tree start", () => {
    expect(() =>
      refuseRepositoryConfig("/work/repo", (p) => p === "/work/opencode.json"),
    ).toThrow(/opencode\.json/);
    expect(() => refuseRepositoryConfig("/work/repo", () => false)).not.toThrow();
  });
});

const line = (type: string, body: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 1, sessionID: "ses_x", ...body });
const step = (reason: string, tokens: Record<string, unknown>) =>
  line("step_finish", { part: { type: "step-finish", reason, tokens, cost: 0 } });
const feed = (lines: string[], price: RunPrice = SONNET_PRICE): RunTally =>
  lines.reduce((t, l) => addEventLine(t, l, price, null, NOW), EMPTY_TALLY);

describe("OpenCode events (unit: summing steps at catalog prices, check 1 and 2 of the spike)", () => {
  it("counts a turn per step, sums the tokens with reasoning as output and prices each step", () => {
    const tally = feed([
      line("step_start", { part: { type: "step-start" } }),
      step("tool-calls", {
        input: 1000,
        output: 40,
        reasoning: 0,
        cache: { write: 5000, read: 0 },
      }),
      "not json at all",
      line("text", { part: { type: "text", text: "Done." } }),
      step("stop", {
        input: 12,
        output: 80,
        reasoning: 20,
        cache: { write: 100, read: 5400 },
      }),
    ]);
    expect(tally.turns).toBe(2);
    expect(tally.tokens).toEqual({
      uncachedInput: 1012,
      cachedInput: 5400,
      cacheWriteInput: 5100,
      output: 140,
    });
    // (1000 x 3 + 5000 x 3.75 + 40 x 15) / 1e6, then (12 x 3 + 5400 x 0.3 + 100 x 3.75 + 100 x 15) / 1e6.
    expect(tally.costUsd).toBeCloseTo(0.02235 + 0.003531, 12);
    expect(tally.lastStepCostUsd).toBeCloseTo(0.003531, 12);
    expect(tally.lastReason).toBe("stop");
    expect(tally.finalText).toBe("Done.");
    expect(tally.error).toBeNull();
  });

  it("reads missing or bad token counts as 0", () => {
    expect(stepTokens({ input: -1, output: "9", cache: null })).toEqual({
      uncachedInput: 0,
      cachedInput: 0,
      cacheWriteInput: 0,
      output: 0,
    });
  });

  it("reads a provider error's status, type, message and retry-after", () => {
    const error = readError(
      {
        name: "APIError",
        data: {
          message: "Overloaded (fake 429)",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "Retry-After": "1" },
          responseBody:
            '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded (fake 429)"}}',
        },
      },
      NOW,
    );
    expect(error).toEqual({
      text: "Overloaded (fake 429)",
      retryable: true,
      providerError: {
        status: 429,
        type: "overloaded_error",
        message: "Overloaded (fake 429)",
        retryAfterSeconds: 1,
      },
    });
  });

  it("puts the proxy's ceiling text into the message, and keeps an error with no status apart", () => {
    const ceiling = readError(
      {
        name: "APIError",
        data: {
          message: "Forbidden",
          statusCode: 403,
          responseBody: JSON.stringify({ error: CEILING_MESSAGE }),
        },
      },
      NOW,
    );
    expect(ceiling.text).toBe(CEILING_MESSAGE);
    expect(ceiling.providerError).toMatchObject({
      status: 403,
      message: CEILING_MESSAGE,
    });
    const unknown = readError(
      { name: "UnknownError", data: { message: "Something broke" } },
      NOW,
    );
    expect(unknown).toEqual({
      text: "Something broke",
      providerError: null,
      retryable: false,
    });
    expect(readError(null, NOW).text).toBe(
      "OpenCode reported an error with no message",
    );
  });
});

describe("OpenCode limits (unit: the wrapper's cap and turn limit, D-223)", () => {
  const tally = (over: Partial<RunTally>): RunTally => ({ ...EMPTY_TALLY, ...over });

  it("stops when the cost plus the last step's cost reaches the cap", () => {
    expect(
      limitStop(
        tally({
          turns: 3,
          costUsd: 0.9,
          lastStepCostUsd: 0.1,
          lastReason: "tool-calls",
        }),
        {
          maxTurns: 100,
          maxUsd: 1,
        },
      ),
    ).toBe("max_budget");
    expect(
      limitStop(
        tally({
          turns: 3,
          costUsd: 0.8,
          lastStepCostUsd: 0.1,
          lastReason: "tool-calls",
        }),
        {
          maxTurns: 100,
          maxUsd: 1,
        },
      ),
    ).toBeNull();
  });

  it("stops at the turn limit, and lets a final answer through", () => {
    const limits = { maxTurns: 3, maxUsd: 5 };
    expect(limitStop(tally({ turns: 3, lastReason: "tool-calls" }), limits)).toBe(
      "max_turns",
    );
    expect(limitStop(tally({ turns: 2, lastReason: "tool-calls" }), limits)).toBeNull();
    expect(
      limitStop(tally({ turns: 3, costUsd: 9, lastReason: "stop" }), limits),
    ).toBeNull();
    expect(limitStop(EMPTY_TALLY, limits)).toBeNull();
  });
});

describe("OpenCode result (unit: the tally as the result line, mapped by the runtime)", () => {
  const done = feed([
    line("text", { part: { type: "text", text: "Done." } }),
    step("stop", { input: 1, output: 1, reasoning: 0, cache: { write: 0, read: 0 } }),
  ]);
  const end = { exitCode: 0, limit: null, stoppedFromOutside: false };

  it("is success only with exit 0, a final answer and no error", () => {
    expect(openCodeResult(done, end, "standard").status).toBe("success");
    expect(openCodeResult(done, { ...end, exitCode: 1 }, "standard")).toMatchObject({
      status: "error",
      errorText: "OpenCode exited with code 1",
    });
    const notFinal = feed([step("tool-calls", {})]);
    expect(openCodeResult(notFinal, end, "standard")).toMatchObject({
      status: "error",
      errorText: "OpenCode ended after a step that was not a final answer (tool-calls)",
    });
    expect(
      openCodeResult(done, { ...end, stoppedFromOutside: true }, "standard").status,
    ).toBe("error");
  });

  it("maps the wrapper's stops to budget_exceeded", () => {
    for (const limit of ["max_budget", "max_turns"] as const) {
      const result = openCodeResult(
        done,
        { ...end, exitCode: null, limit },
        "standard",
      );
      expect(result.status).toBe(limit);
      expect(mapRunEnd("failed", null, result, "m")).toMatchObject({
        outcome: "budget_exceeded",
        detail: limit,
      });
    }
  });

  it("reports OpenCode's fixed retries only for a retryable Flex capacity rejection", () => {
    const rejected = feed([
      line("error", {
        error: {
          name: "APIError",
          data: {
            message: "Model is overloaded",
            statusCode: 429,
            isRetryable: true,
            responseBody:
              '{"error":{"type":"engine_overloaded","message":"Model is overloaded"}}',
          },
        },
      }),
    ]);
    const flex = openCodeResult(rejected, { ...end, exitCode: 1 }, "flex");
    expect(flex.capacityRetries).toBe(OPENCODE_RETRIES);
    expect(flex).not.toHaveProperty("capacityWaitSeconds");
    expect(mapRunEnd("failed", null, flex, "m", "flex")).toMatchObject({
      outcome: "usage_exhausted",
      detail: "capacity",
      capacityRetries: 5,
    });
    const standard = openCodeResult(rejected, { ...end, exitCode: 1 }, "standard");
    expect(standard).not.toHaveProperty("capacityRetries");
    expect(mapRunEnd("failed", null, standard, "m", "standard")).toMatchObject({
      outcome: "usage_exhausted",
      detail: "rate_limit",
    });
  });
});

/** A fake grace timer: it records the wait and fires at once. */
function fakeClock(): StopClock & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    setTimeout: (callback, ms) => {
      waits.push(ms);
      return setImmediate(callback);
    },
    clearTimeout: (handle) => clearImmediate(handle as NodeJS.Immediate),
  };
}

describe("OpenCode image (integration: a fake opencode executable, no network)", () => {
  let dir: string;
  let work: string;
  let tmp: string;
  let lines: string[];
  let env: Record<string, string>;

  const writeTask = (input: string, extra: Record<string, unknown> = {}) => {
    const file = join(dir, "task.json");
    writeFileSync(
      file,
      JSON.stringify({
        foremanTask: 1,
        instructions: "Fixture instructions.",
        input,
        allowedTools: TOOLS,
        ...extra,
      }),
    );
    env.FOREMAN_TASK_FILE = file;
  };
  const call = () =>
    JSON.parse(readFileSync(join(work, "fake-opencode-call.json"), "utf8")) as {
      args: string[];
      env: Record<string, string>;
      cwd: string;
      input: string;
      config: Record<string, unknown>;
      instructions: string;
    };
  const run = async (clock: StopClock = fakeClock()) => {
    lines = [];
    const code = await runOpenCodeImage(env, {
      write: (l) => lines.push(l),
      clock,
      now: () => NOW,
    });
    return { code, result: parseAgentResult(lines.join("\n")) };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-opencode-test-"));
    const cli = join(dir, "opencode");
    copyFileSync(new URL("../testing/fake-opencode.mjs", import.meta.url), cli);
    chmodSync(cli, 0o755);
    work = join(dir, "work");
    tmp = join(dir, "tmp");
    mkdirSync(work);
    mkdirSync(tmp);
    env = {
      PATH: process.env.PATH ?? "",
      TMPDIR: tmp,
      HOME: work,
      FOREMAN_RUN_ID: RUN_ID,
      FOREMAN_ROLE: "developer",
      FOREMAN_MODEL: "claude-sonnet-5-5",
      FOREMAN_MAX_TURNS: "100",
      FOREMAN_MAX_BUDGET_USD: "5",
      FOREMAN_MODEL_API: "anthropic",
      FOREMAN_MODEL_BASE_URL: "http://127.0.0.1:9/anthropic/v1",
      FOREMAN_SERVICE_TIER: "standard",
      FOREMAN_MODEL_PRICE: JSON.stringify(SONNET_PRICE),
      FOREMAN_STATE_API_URL: "http://127.0.0.1:9/state-api",
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      GITHUB_TOKEN,
      FOREMAN_OPENCODE_CLI: cli,
      FOREMAN_OPENCODE_CONFIG_HOME: join(dir, "xdg-config"),
    };
  });

  it("runs OpenCode by its path with the prompt on stdin, sums its steps and prints one result line", async () => {
    const prompt =
      "Make the change; $(touch pwned) --dangerously-skip-permissions\nscenario=success";
    writeTask(prompt);
    const { code, result } = await run();
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(result).toEqual({
      status: "success",
      finalText: "Done.",
      turns: 2,
      costUsd: expect.closeTo(0.025881, 12),
      tokens: {
        uncachedInput: 1012,
        cachedInput: 5400,
        cacheWriteInput: 5100,
        output: 140,
      },
      errorText: "",
      providerError: null,
    });
    const seen = call();
    expect(seen.cwd).toBe(work);
    expect(seen.input).toBe(prompt);
    expect(seen.args).not.toContain(prompt);
    expect(existsSync(join(work, "pwned"))).toBe(false);
    expect(seen.instructions).toBe("Fixture instructions.");
    expect(seen.env.XDG_CONFIG_HOME).toBe(join(dir, "xdg-config"));
    expect(seen.env.HOME).toBe(work);
    expect(seen.env).not.toHaveProperty("FOREMAN_MODEL_PRICE");
    // The config is outside the work folder and readable by this user only.
    const configPath = seen.env.OPENCODE_CONFIG as string;
    expect(configPath.startsWith(tmp)).toBe(true);
    expect(statSync(configPath).mode & 0o077).toBe(0);
    expect(seen.config).toMatchObject({
      model: "foreman/claude-sonnet-5-5",
      provider: {
        foreman: {
          options: {
            baseURL: "http://127.0.0.1:9/anthropic/v1",
            apiKey: PLACEHOLDER_CREDENTIAL,
          },
        },
      },
    });
  });

  it("stops OpenCode at the dollar cap before the next request (max_budget)", async () => {
    // Each fake step costs (100 x 3 + 1000 x 0.3 + 10 x 15) / 1e6 = 0.00075 USD.
    env.FOREMAN_MAX_BUDGET_USD = "0.01";
    writeTask("scenario=forever");
    const { code, result } = await run();
    expect(code).toBe(1);
    expect(result).toMatchObject({ status: "max_budget", turns: 13 });
    expect(result?.costUsd).toBeLessThan(0.01);
    expect(result?.costUsd).toBeCloseTo(13 * 0.00075, 12);
    expect(mapRunEnd("failed", null, result, "claude-sonnet-5-5")).toMatchObject({
      outcome: "budget_exceeded",
      detail: "max_budget",
    });
  });

  it("stops OpenCode at the turn limit (max_turns)", async () => {
    env.FOREMAN_MAX_TURNS = "7";
    writeTask("scenario=forever");
    const { result } = await run();
    expect(result).toMatchObject({ status: "max_turns", turns: 7 });
  });

  it("kills OpenCode after the grace period when it ignores SIGTERM", async () => {
    env.FOREMAN_MAX_TURNS = "3";
    writeTask("scenario=forever-ignore-term");
    const clock = fakeClock();
    const { result } = await run(clock);
    expect(result).toMatchObject({ status: "max_turns", turns: 3 });
    expect(clock.waits).toEqual([10_000]);
  });

  it.each([
    ["flex-overloaded", "flex", "usage_exhausted", "capacity", 7],
    ["anthropic-overloaded", "standard", "usage_exhausted", "rate_limit", 1],
    ["rate-limit", "standard", "usage_exhausted", "rate_limit", 30],
    ["billing", "standard", "usage_exhausted", "out_of_credit", undefined],
    ["proxy-ceiling", "standard", "budget_exceeded", "proxy_ceiling", undefined],
    [
      "rejected-ceiling",
      "standard",
      "budget_exceeded",
      "proxy_rejected_ceiling",
      undefined,
    ],
    ["generic", "standard", "fail", "job_failed", undefined],
  ])(
    "maps the %s scenario on %s to %s (%s)",
    async (scenario, tier, outcome, detail, retryAfter) => {
      if (tier === "flex") {
        env.FOREMAN_SERVICE_TIER = "flex";
        env.FOREMAN_MODEL_API = "openai-compatible";
        env.FOREMAN_MODEL = "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo";
        env.FOREMAN_MODEL_PRICE = JSON.stringify(OPEN_PRICE);
      }
      writeTask(`scenario=${scenario}`);
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.status).toBe("error");
      const mapped = mapRunEnd(
        "failed",
        null,
        result,
        "m",
        tier as "flex" | "standard",
      );
      expect(mapped).toMatchObject({ outcome, detail });
      expect(mapped.retryAfterSeconds).toBe(retryAfter);
      if (scenario === "flex-overloaded") {
        expect(result?.providerError).toEqual({
          status: 429,
          type: "engine_overloaded",
          message: "Model is overloaded, please try again later",
          retryAfterSeconds: 7,
        });
        expect(result?.capacityRetries).toBe(5);
        expect(result?.turns).toBe(1);
      }
      if (scenario === "rejected-ceiling")
        expect(result?.errorText).toBe(REJECTED_CEILING_MESSAGE);
      if (scenario === "generic") expect(result?.errorText).toBe("Something broke");
    },
  );

  it("never prints a credential, even when the agent echoes them", async () => {
    writeTask("scenario=echo-secrets");
    await run();
    const output = lines.join("\n");
    for (const secret of [STATE_TOKEN, GITHUB_TOKEN, PLACEHOLDER_CREDENTIAL]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[redacted]");
  });

  it("reports an OpenCode that prints nothing as an error", async () => {
    writeTask("scenario=no-output");
    const { result } = await run();
    expect(result).toMatchObject({
      status: "error",
      errorText: "OpenCode exited with code 2 before any model step",
      turns: 0,
    });
  });

  it.each([".opencode", "opencode.json", "opencode.jsonc"])(
    "refuses a checkout with %s before anything is written or started",
    async (name) => {
      if (name === ".opencode") mkdirSync(join(work, name));
      else writeFileSync(join(work, name), "{}");
      writeTask("scenario=success");
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.errorText).toContain(`has ${name}, which OpenCode would load`);
      expect(existsSync(join(work, "fake-opencode-call.json"))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    },
  );

  it("fails closed with no settings at all, writing nothing and naming FOREMAN_RUN_ID", async () => {
    const empty = { PATH: env.PATH ?? "", TMPDIR: tmp };
    lines = [];
    const code = await runOpenCodeImage(empty, { write: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(parseAgentResult(lines[0] ?? "")?.errorText).toMatch(
      /FOREMAN_RUN_ID is not set/,
    );
    expect(readdirSync(tmp)).toEqual([]);
  });

  it.each([
    ["FOREMAN_MODEL_PRICE", undefined, /FOREMAN_MODEL_PRICE is not set/],
    ["FOREMAN_MODEL_API", "bedrock", /FOREMAN_MODEL_API is not a model API/],
    ["FOREMAN_MODEL_BASE_URL", undefined, /FOREMAN_MODEL_BASE_URL is not set/],
    ["FOREMAN_SERVICE_TIER", "batch", /FOREMAN_SERVICE_TIER is not a service tier/],
    [
      "FOREMAN_OPENCODE_CLI",
      "opencode",
      /FOREMAN_OPENCODE_CLI must be an absolute path/,
    ],
    [
      "FOREMAN_MAX_OUTPUT_TOKENS",
      "0",
      /FOREMAN_MAX_OUTPUT_TOKENS is not a whole number/,
    ],
    ["FOREMAN_ROLE", "qa", /FOREMAN_ROLE is not a role this image runs/],
  ])(
    "refuses a missing or bad %s by name before OpenCode starts",
    async (name, value, problem) => {
      writeTask("scenario=success");
      if (value === undefined) delete env[name];
      else env[name] = value;
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.errorText).toMatch(problem);
      expect(existsSync(join(work, "fake-opencode-call.json"))).toBe(false);
    },
  );

  it("refuses a task whose tools have no OpenCode permission before OpenCode starts", async () => {
    writeTask("scenario=success", { allowedTools: ["Read", "Bash"] });
    const { result } = await run();
    expect(result?.errorText).toBe("allowed tool 2 would allow every shell command");
    expect(existsSync(join(work, "fake-opencode-call.json"))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
