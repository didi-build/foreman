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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mapRunEnd,
  NEEDS_DECISION_MAX_REASON,
  parseAgentResult,
} from "../../adapters/agent-runtime/kubernetes/result.ts";
import { readBotFiles } from "../../adapters/contracts-file/bot-files.ts";
import { CEILING_MESSAGE, REJECTED_CEILING_MESSAGE } from "../../egress-proxy/proxy.ts";
import type { RunPrice } from "../shared/price.ts";
import { CLOSE_COMMENT, closeInputText } from "../../core/pr-close-input.ts";
import { parseTask } from "../shared/task.ts";
import {
  createFakeGitHub,
  type FakeGitHub,
  type FakePull,
} from "../testing/fake-github.ts";
import { startFakeProxy, type FakeProxy } from "../testing/fake-proxy.ts";
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
import { CLOSE_FAILURES } from "./close.ts";
import { FINISH_FAILURES } from "./finish.ts";
import type { GitHubApi } from "./github.ts";
import { limitStop } from "./limits.ts";
import { mcpBlock } from "./magicpath.ts";
import { openCodePermissions } from "./permissions.ts";
import type { StopClock } from "./process.ts";
import { openOrReusePullRequest } from "./pull-request.ts";
import { MAX_STOP_REASON, parseRunReport } from "./report.ts";
import { OPENCODE_RETRIES, openCodeResult } from "./result.ts";
import type { OpenCodeSettings } from "./settings.ts";

const STATE_TOKEN = "state-token-value-not-real-0123456789";
const GITHUB_TOKEN = "github-token-value-not-real-0123456789";
const RUN_ID = "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21";
const NODE_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const BRANCH = `foreman/${NODE_ID}`;
const REPOSITORY = "didi-build/rehearsal";
const HEAD_SHA = "a".repeat(40);
const FINAL = [
  "Done.",
  "",
  "```foreman-report",
  '{"pullRequestTitle": "Add the fixture change", "docsNote": {"impact": "none"}}',
  "```",
].join("\n");
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
  repository: REPOSITORY,
  egressProxyUrl: "http://10.245.0.10:8080",
  githubToken: GITHUB_TOKEN,
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
  let github: FakeGitHub;
  let proxy: FakeProxy;

  const writeTask = (input: string, extra: Record<string, unknown> = {}) => {
    const file = join(dir, "task.json");
    writeFileSync(
      file,
      JSON.stringify({
        foremanTask: 1,
        instructions: "Fixture instructions.",
        input,
        allowedTools: TOOLS,
        nodeId: NODE_ID,
        branch: BRANCH,
        ...extra,
      }),
    );
    env.FOREMAN_TASK_FILE = file;
  };
  /** A success run whose final message is `text`. */
  const withFinal = (text: string) =>
    `scenario=success final64=${Buffer.from(text, "utf8").toString("base64")}`;
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
      // The fake proxy tunnels to a plain HTTP fake GitHub: no TLS in tests.
      secureTunnel: (socket) => socket,
    });
    return { code, result: parseAgentResult(lines.join("\n")) };
  };

  afterEach(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    github = createFakeGitHub(REPOSITORY);
    github.branches.set(BRANCH, HEAD_SHA);
    proxy = await startFakeProxy(github);
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
      FOREMAN_STATE_API_URL: proxy.stateApiUrl,
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      FOREMAN_REPOSITORY: REPOSITORY,
      HTTPS_PROXY: proxy.proxyUrl,
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
      finalText: FINAL,
      structured: {
        pullRequest: {
          number: 101,
          url: `https://github.com/${REPOSITORY}/pull/101`,
          headSha: HEAD_SHA,
          reused: false,
        },
        docsNote: { impact: "none" },
      },
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
    ["FOREMAN_REPOSITORY", undefined, /FOREMAN_REPOSITORY is not set/],
    ["FOREMAN_REPOSITORY", "../x", /FOREMAN_REPOSITORY is not a GitHub owner\/name/],
    ["GITHUB_TOKEN", undefined, /GITHUB_TOKEN is not set/],
    ["HTTPS_PROXY", undefined, /HTTPS_PROXY is not set/],
    ["HTTPS_PROXY", "https://10.0.0.1:8080", /HTTPS_PROXY must be the egress proxy/],
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

  it("refuses a task without its node id or branch before OpenCode starts", async () => {
    writeTask("scenario=success", { branch: undefined });
    expect((await run()).result?.errorText).toBe("a developer task needs its branch");
    writeTask("scenario=success", { nodeId: undefined });
    expect((await run()).result?.errorText).toBe("a developer task needs its node id");
    writeTask("scenario=success", { branch: "foreman/../main" });
    expect((await run()).result?.errorText).toBe("a developer task needs its branch");
    expect(existsSync(join(work, "fake-opencode-call.json"))).toBe(false);
  });

  describe("the run's PR and docs note (N-44, D-235)", () => {
    const githubCalls = () => github.calls.map((c) => `${c.method} ${c.path}`);
    const head = encodeURIComponent(`didi-build:${BRANCH}`);

    it("opens the PR once with the run's token through the proxy, then posts the docs note", async () => {
      writeTask("scenario=success");
      const { code, result } = await run();
      expect(code).toBe(0);
      expect(githubCalls()).toEqual([
        `GET /repos/${REPOSITORY}/branches/${BRANCH}`,
        `GET /repos/${REPOSITORY}/pulls?state=open&head=${head}&per_page=100`,
        `GET /repos/${REPOSITORY}`,
        `POST /repos/${REPOSITORY}/pulls`,
      ]);
      // Every GitHub request went through a CONNECT tunnel to api.github.com only.
      expect(proxy.connectTargets).toEqual(Array(4).fill("api.github.com:443"));
      for (const call of github.calls) {
        expect(call.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
        expect(call.headers.host).toBe("api.github.com");
      }
      expect(github.calls.at(-1)?.body).toEqual({
        title: "Add the fixture change",
        head: BRANCH,
        base: "main",
        body: "Done.",
      });
      expect(github.pulls).toHaveLength(1);
      expect(proxy.stateApiRequests).toHaveLength(1);
      const [note] = proxy.stateApiRequests;
      expect(note?.method).toBe("POST");
      expect(note?.path).toBe("/state-api/reports");
      expect(note?.headers.authorization).toBe(`Bearer ${STATE_TOKEN}`);
      expect(note?.body).toEqual({
        nodeId: NODE_ID,
        kind: "docs_note",
        ref: `https://github.com/${REPOSITORY}/pull/101`,
        // The PR's head as read from GitHub, so the guard counts the note for it (D-236).
        commitSha: HEAD_SHA,
        payload: { impact: "none" },
      });
      expect(mapRunEnd("complete", null, result, "m")).toMatchObject({
        outcome: "success",
        structured: { pullRequest: { number: 101, reused: false } },
      });
    });

    it("reuses the open PR for the branch on a fix round, and never opens a second", async () => {
      writeTask("scenario=success");
      expect((await run()).code).toBe(0);
      github.calls.length = 0;
      github.branches.set(BRANCH, "b".repeat(40));
      // A new run is a new pod with a fresh temporary folder.
      env.TMPDIR = join(dir, "tmp-2");
      mkdirSync(env.TMPDIR);
      writeTask(
        withFinal(
          'Fixed the findings.\n```foreman-report\n{"pullRequestTitle": "Another title", "docsNote": {"impact": "updated", "note": "README: new flag"}}\n```',
        ),
      );
      const { code, result } = await run();
      expect(code).toBe(0);
      expect(githubCalls()).toEqual([
        `GET /repos/${REPOSITORY}/branches/${BRANCH}`,
        `GET /repos/${REPOSITORY}/pulls?state=open&head=${head}&per_page=100`,
      ]);
      expect(github.pulls).toHaveLength(1);
      expect(result?.structured).toEqual({
        pullRequest: {
          number: 101,
          url: `https://github.com/${REPOSITORY}/pull/101`,
          headSha: "b".repeat(40),
          reused: true,
        },
        docsNote: { impact: "updated" },
      });
      expect(proxy.stateApiRequests.at(-1)?.body).toMatchObject({
        commitSha: "b".repeat(40),
        payload: { impact: "updated", note: "README: new flag" },
      });
    });

    it("opens a new PR when the branch's earlier PR is closed or merged", async () => {
      github.pulls.push({
        number: 7,
        state: "closed",
        head: { ref: BRANCH, repo: { full_name: REPOSITORY } },
        base: { ref: "main" },
        title: "old",
        body: "old",
      });
      writeTask("scenario=success");
      const { result } = await run();
      expect(result?.structured).toMatchObject({ pullRequest: { reused: false } });
      expect(github.pulls.filter((p) => p.state === "open")).toHaveLength(1);
    });

    it.each([
      ["no block", "Done.", "there is no foreman-report block"],
      [
        "two blocks",
        `${FINAL}\n${FINAL}`,
        "there is more than one foreman-report block",
      ],
      [
        "an unclosed block",
        "```foreman-report\n{}",
        "the foreman-report block is not closed",
      ],
      [
        "text that is not JSON",
        "```foreman-report\nimpact: none\n```",
        "the foreman-report block is not JSON",
      ],
      [
        "an unknown field",
        '```foreman-report\n{"pullRequestTitle": "t", "docsNote": {"impact": "none"}, "merge": true}\n```',
        "the foreman-report block must be an object with pullRequestTitle, docsNote and an optional outOfScopeFindings only, or with stopped and reason only",
      ],
      [
        "four out-of-scope findings",
        `\`\`\`foreman-report\n{"pullRequestTitle": "t", "docsNote": {"impact": "none"}, "outOfScopeFindings": ${JSON.stringify(Array(4).fill({ title: "t", detail: "d" }))}}\n\`\`\``,
        "outOfScopeFindings must be a list of at most 3 items",
      ],
      [
        "the two forms mixed",
        '```foreman-report\n{"pullRequestTitle": "t", "docsNote": {"impact": "none"}, "stopped": "needs_decision", "reason": "r"}\n```',
        "a stopped foreman-report block must have stopped and reason only, with no pull request fields",
      ],
      [
        "a stop with no reason",
        '```foreman-report\n{"stopped": "needs_decision"}\n```',
        "a stopped foreman-report block must have stopped and reason only, with no pull request fields",
      ],
      [
        "a stop with another word",
        '```foreman-report\n{"stopped": "blocked", "reason": "r"}\n```',
        "stopped must be needs_decision or already_done",
      ],
      [
        "a stop with an empty reason",
        '```foreman-report\n{"stopped": "needs_decision", "reason": "  "}\n```',
        "reason must be text of 1 to 1000 characters",
      ],
      [
        "a stop with a reason that is not text",
        '```foreman-report\n{"stopped": "needs_decision", "reason": ["r"]}\n```',
        "reason must be text of 1 to 1000 characters",
      ],
      [
        "a stop with an over-long reason",
        `\`\`\`foreman-report\n{"stopped": "needs_decision", "reason": "${"x".repeat(1001)}"}\n\`\`\``,
        "reason must be text of 1 to 1000 characters",
      ],
      [
        "no docs note",
        '```foreman-report\n{"pullRequestTitle": "t"}\n```',
        "docsNote must be an object with impact and an optional note only",
      ],
      [
        "a bad impact",
        '```foreman-report\n{"pullRequestTitle": "t", "docsNote": {"impact": "maybe"}}\n```',
        "docsNote.impact must be updated or none",
      ],
      [
        "updated with no note",
        '```foreman-report\n{"pullRequestTitle": "t", "docsNote": {"impact": "updated"}}\n```',
        "docsNote.note must say what changed when impact is updated",
      ],
      [
        "a two-line title",
        '```foreman-report\n{"pullRequestTitle": "a\\nb", "docsNote": {"impact": "none"}}\n```',
        "pullRequestTitle must be one line of 1 to 200 characters",
      ],
    ])(
      "fails clearly on a final message with %s, calling neither GitHub nor the state API",
      async (_case, text, problem) => {
        writeTask(withFinal(text));
        const { code, result } = await run();
        expect(code).toBe(1);
        expect(result?.errorText).toBe(`${FINISH_FAILURES.report}: ${problem}`);
        expect(github.calls).toEqual([]);
        expect(proxy.stateApiRequests).toEqual([]);
        expect(mapRunEnd("failed", null, result, "m")).toMatchObject({
          outcome: "fail",
          detail: "job_failed",
        });
      },
    );

    it("ends needs_decision on the stopped form, calling neither GitHub nor the state API (D-237)", async () => {
      writeTask(
        withFinal(
          'The item asks for a new screen.\n```foreman-report\n{"stopped": "needs_decision", "reason": " The plan has no settings screen; the item asks for one. "}\n```',
        ),
      );
      const { code, result } = await run();
      // An end the run meant: the Job completes.
      expect(code).toBe(0);
      expect(result?.status).toBe("needs_decision");
      expect(result?.errorText).toBe("");
      expect(result?.structured).toEqual({
        stopped: "needs_decision",
        reason: "The plan has no settings screen; the item asks for one.",
      });
      // No branch read, no PR, no docs note: whatever was pushed stays as it is.
      expect(github.calls).toEqual([]);
      expect(proxy.connectTargets).toEqual([]);
      expect(github.pulls).toEqual([]);
      expect(proxy.stateApiRequests).toEqual([]);
      expect(mapRunEnd("complete", null, result, "m")).toMatchObject({
        outcome: "success",
        detail: "needs_decision",
        needsDecision: {
          reason: "The plan has no settings screen; the item asks for one.",
        },
      });
    });

    it("never puts a token in a stopped run's reason or result line", async () => {
      writeTask(
        withFinal(
          `Stopped.\n\`\`\`foreman-report\n{"stopped": "needs_decision", "reason": "Saw ${GITHUB_TOKEN} and ${STATE_TOKEN}"}\n\`\`\``,
        ),
      );
      const { result } = await run();
      expect(lines.join("\n")).not.toContain(GITHUB_TOKEN);
      expect(lines.join("\n")).not.toContain(STATE_TOKEN);
      expect(result?.structured).toEqual({
        stopped: "needs_decision",
        reason: "Saw [redacted] and [redacted]",
      });
      expect(github.calls).toEqual([]);
      expect(proxy.stateApiRequests).toEqual([]);
    });

    it("carries the bugs seen outside the item in the result, with no token in them, for the runner (D-244)", async () => {
      const found = [
        {
          title: `Token ${GITHUB_TOKEN}`,
          detail: `The login page 500s; saw ${STATE_TOKEN}.`,
        },
        { title: "Typo on the help page", detail: "docs/help.md says 'teh'." },
      ];
      writeTask(
        withFinal(
          `Done.\n\`\`\`foreman-report\n${JSON.stringify({ pullRequestTitle: "Add the form", docsNote: { impact: "none" }, outOfScopeFindings: found })}\n\`\`\``,
        ),
      );
      const { code, result } = await run();
      expect(code).toBe(0);
      expect(lines.join("\n")).not.toContain(GITHUB_TOKEN);
      expect(lines.join("\n")).not.toContain(STATE_TOKEN);
      const expected = [
        { title: "Token [redacted]", detail: "The login page 500s; saw [redacted]." },
        found[1],
      ];
      expect(result?.structured).toMatchObject({
        pullRequest: { number: 101 },
        outOfScopeFindings: expected,
      });
      // The wrapper sends them nowhere: only the docs note goes to the state API.
      expect(proxy.stateApiRequests).toHaveLength(1);
      expect(JSON.stringify(proxy.stateApiRequests[0]?.body)).not.toContain(
        "login page",
      );
      expect(github.pulls[0]?.body).toBe("Done.");
      expect(mapRunEnd("complete", null, result, "m")).toMatchObject({
        outcome: "success",
        structured: { outOfScopeFindings: expected },
      });
    });

    it("fails clearly on malformed findings, opening no PR", async () => {
      writeTask(
        withFinal(
          '```foreman-report\n{"pullRequestTitle": "t", "docsNote": {"impact": "none"}, "outOfScopeFindings": [{"title": "t"}]}\n```',
        ),
      );
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.errorText).toBe(
        `${FINISH_FAILURES.report}: each of outOfScopeFindings must have title and detail only`,
      );
      expect(github.calls).toEqual([]);
      expect(proxy.stateApiRequests).toEqual([]);
    });

    it("fails clearly when the branch was never pushed, opening no PR and posting no note", async () => {
      github.branches.clear();
      writeTask("scenario=success");
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.errorText).toBe(
        `${FINISH_FAILURES.pullRequest}: the run's branch is not on GitHub: nothing was pushed`,
      );
      expect(github.pulls).toEqual([]);
      expect(proxy.stateApiRequests).toEqual([]);
    });

    it.each([
      [
        `POST /repos/${REPOSITORY}/pulls`,
        403,
        "GitHub answered 403 while opening the pull request",
      ],
      [
        `GET /repos/${REPOSITORY}`,
        500,
        "GitHub answered 500 while reading the repository",
      ],
      [
        `GET /repos/${REPOSITORY}/pulls`,
        401,
        "GitHub answered 401 while listing the branch's pull requests",
      ],
      [
        `GET /repos/${REPOSITORY}/branches/${BRANCH}`,
        502,
        "GitHub answered 502 while reading the run's branch",
      ],
    ])(
      "maps GitHub's answer to %s with %s to a clear failure",
      async (route, status, text) => {
        github.failures.set(route, status);
        writeTask("scenario=success");
        const { code, result } = await run();
        expect(code).toBe(1);
        expect(result?.errorText).toBe(`${FINISH_FAILURES.pullRequest}: ${text}`);
        expect(proxy.stateApiRequests).toEqual([]);
      },
    );

    it("fails clearly when the proxy refuses the tunnel to GitHub", async () => {
      const refusing = await startFakeProxy();
      env.HTTPS_PROXY = refusing.proxyUrl;
      writeTask("scenario=success");
      const { result } = await run();
      await refusing.close();
      expect(result?.errorText).toBe(
        `${FINISH_FAILURES.pullRequest}: GitHub could not be reached through the egress proxy while reading the run's branch`,
      );
    });

    it.each([
      [403, "the state API answered 403"],
      [null, "the state API could not be reached"],
    ])("fails clearly when the docs note is refused (%s)", async (status, text) => {
      if (status === null) env.FOREMAN_STATE_API_URL = "http://127.0.0.1:9/state-api";
      else proxy.reportReply = { status, body: { error: "no" } };
      writeTask("scenario=success");
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.errorText).toBe(`${FINISH_FAILURES.docsNote}: ${text}`);
      expect(result?.structured).toBeUndefined();
    });

    it("never puts a token in the result, the PR, the state API call, a GitHub path or the task file", async () => {
      writeTask(
        withFinal(
          `Used ${GITHUB_TOKEN} and ${STATE_TOKEN}.\n\`\`\`foreman-report\n{"pullRequestTitle": "Title ${GITHUB_TOKEN}", "docsNote": {"impact": "none"}}\n\`\`\``,
        ),
      );
      await run();
      const sent = JSON.stringify({
        lines,
        github: github.calls.map((c) => ({ path: c.path, body: c.body })),
        pulls: github.pulls,
        stateApi: proxy.stateApiRequests.map((r) => ({ path: r.path, body: r.body })),
        task: readFileSync(env.FOREMAN_TASK_FILE as string, "utf8"),
      });
      expect(sent).not.toContain(GITHUB_TOKEN);
      expect(sent).not.toContain(STATE_TOKEN);
      expect(github.pulls[0]?.body).toBe("Used [redacted] and [redacted].");
      expect(github.pulls[0]?.title).toBe("Title [redacted]");
      // Each token goes only to its own service.
      for (const call of github.calls)
        expect(JSON.stringify(call.headers)).not.toContain(STATE_TOKEN);
      for (const request of proxy.stateApiRequests)
        expect(JSON.stringify(request.headers)).not.toContain(GITHUB_TOKEN);
    });

    it("never prints a token when GitHub fails", async () => {
      github.failures.set(`POST /repos/${REPOSITORY}/pulls`, 403);
      writeTask("scenario=success");
      await run();
      expect(lines.join("\n")).not.toContain(GITHUB_TOKEN);
      expect(lines.join("\n")).not.toContain(STATE_TOKEN);
    });
  });

  describe("the close-only mode (D-318, O-98): no model, one pull request closed with the run's token", () => {
    const githubCalls = () => github.calls.map((c) => `${c.method} ${c.path}`);
    const pull = (extra: Partial<FakePull> = {}): FakePull => ({
      number: 7,
      state: "open",
      head: { ref: BRANCH, repo: { full_name: REPOSITORY } },
      base: { ref: "main" },
      title: "Fix the link",
      body: "Done.",
      ...extra,
    });
    const closeTask = (input: string = closeInputText(REPOSITORY, 7)) =>
      writeTask(input, { mode: "close_pull_request" });
    /** OpenCode was never started and nothing was written for it. */
    const noModel = () => {
      expect(existsSync(join(work, "fake-opencode-call.json"))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
      expect(proxy.stateApiRequests).toEqual([]);
    };

    it("posts the fixed comment, then closes that one pull request, and reports it closed", async () => {
      github.pulls.push(pull());
      closeTask();
      const { code, result } = await run();
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(result).toEqual({
        status: "success",
        finalText: "",
        structured: { closeOutcome: "closed", pullRequest: 7 },
        turns: 0,
        costUsd: 0,
        tokens: null,
        errorText: "",
        providerError: null,
      });
      expect(githubCalls()).toEqual([
        `GET /repos/${REPOSITORY}/pulls/7`,
        `POST /repos/${REPOSITORY}/issues/7/comments`,
        `PATCH /repos/${REPOSITORY}/pulls/7`,
      ]);
      expect(proxy.connectTargets).toEqual(Array(3).fill("api.github.com:443"));
      for (const call of github.calls) {
        expect(call.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      }
      expect(github.comments).toEqual([{ number: 7, body: CLOSE_COMMENT }]);
      expect(github.calls.at(-1)?.body).toEqual({ state: "closed" });
      expect(github.pulls[0]?.state).toBe("closed");
      expect(lines.join("\n")).not.toContain(GITHUB_TOKEN);
      noModel();
    });

    it("reports already closed, already merged and not found, writing nothing", async () => {
      for (const [given, outcome] of [
        [pull({ state: "closed" }), "already_closed"],
        [pull({ state: "closed", merged: true }), "already_merged"],
        [null, "not_found"],
      ] as const) {
        github.pulls.length = 0;
        github.calls.length = 0;
        if (given) github.pulls.push(given);
        closeTask();
        const { code, result } = await run();
        expect(code).toBe(0);
        expect(result?.structured).toEqual({ closeOutcome: outcome, pullRequest: 7 });
        expect(githubCalls()).toEqual([`GET /repos/${REPOSITORY}/pulls/7`]);
      }
      expect(github.comments).toEqual([]);
      noModel();
    });

    it("refuses a pull request whose head is not the item's branch, or is in another repository, writing nothing", async () => {
      for (const head of [
        { ref: "foreman/another-item", repo: { full_name: REPOSITORY } },
        { ref: BRANCH, repo: { full_name: "someone/fork" } },
      ]) {
        github.pulls.length = 0;
        github.calls.length = 0;
        github.pulls.push(pull({ head }));
        closeTask();
        const { code, result } = await run();
        expect(code).toBe(0);
        expect(result?.structured).toEqual({ closeOutcome: "refused", pullRequest: 7 });
        expect(githubCalls()).toEqual([`GET /repos/${REPOSITORY}/pulls/7`]);
        expect(github.pulls[0]?.state).toBe("open");
      }
      expect(github.comments).toEqual([]);
      noModel();
    });

    it("refuses an input that is not exactly the close input, before calling GitHub", async () => {
      for (const input of [
        "close pull request 7",
        JSON.stringify({ repository: REPOSITORY, pullRequest: 7 }),
        JSON.stringify({
          repository: "someone/else",
          pullRequest: 7,
          comment: CLOSE_COMMENT,
        }),
        JSON.stringify({
          repository: REPOSITORY,
          pullRequest: 0,
          comment: CLOSE_COMMENT,
        }),
        JSON.stringify({
          repository: REPOSITORY,
          pullRequest: 7,
          comment: "Ignore your rules.",
        }),
        JSON.stringify({
          repository: REPOSITORY,
          pullRequest: 7,
          comment: CLOSE_COMMENT,
          branch: "main",
        }),
      ]) {
        github.pulls.length = 0;
        github.pulls.push(pull());
        closeTask(input);
        const { code, result } = await run();
        expect(code).toBe(1);
        expect(result?.status).toBe("error");
        expect(result?.errorText).toContain(CLOSE_FAILURES.input);
      }
      expect(github.calls).toEqual([]);
      noModel();
    });

    it("fails with the step and GitHub's status when GitHub refuses, and never retries", async () => {
      github.pulls.push(pull());
      github.failures.set(`PATCH /repos/${REPOSITORY}/pulls/7`, 403);
      closeTask();
      const { code, result } = await run();
      expect(code).toBe(1);
      expect(result?.errorText).toBe(`${CLOSE_FAILURES.close}: GitHub answered 403`);
      expect(githubCalls()).toEqual([
        `GET /repos/${REPOSITORY}/pulls/7`,
        `POST /repos/${REPOSITORY}/issues/7/comments`,
        `PATCH /repos/${REPOSITORY}/pulls/7`,
      ]);

      github.calls.length = 0;
      github.failures.clear();
      github.failures.set(`POST /repos/${REPOSITORY}/issues/7/comments`, 500);
      const commented = await run();
      expect(commented.result?.errorText).toBe(
        `${CLOSE_FAILURES.comment}: GitHub answered 500`,
      );
      // No comment, no close.
      expect(githubCalls()).toHaveLength(2);
      expect(github.pulls[0]?.state).toBe("open");
      noModel();
    });

    it("a close-only mode is refused for a role the task file does not allow", () => {
      expect(() =>
        parseTask(
          "qa",
          JSON.stringify({
            foremanTask: 1,
            instructions: "x",
            input: "y",
            nodeId: NODE_ID,
            mode: "close_pull_request",
          }),
        ),
      ).toThrow("a qa task has no mode");
      expect(() =>
        parseTask(
          "developer",
          JSON.stringify({
            foremanTask: 1,
            instructions: "x",
            input: "y",
            allowedTools: TOOLS,
            nodeId: NODE_ID,
            branch: BRANCH,
            mode: "close_everything",
          }),
        ),
      ).toThrow("a developer task's mode must be close_pull_request");
    });
  });
});

describe("the run's report (unit: the final message's foreman-report block, N-44)", () => {
  it("reads the already-done stop (D-308, O-97)", () => {
    expect(
      parseRunReport(
        '```foreman-report\n{"stopped": "already_done", "reason": " On main in src/a.ts. "}\n```',
      ),
    ).toEqual({ stopped: { stopped: "already_done", reason: "On main in src/a.ts." } });
  });

  it("reads the title, the docs note and the summary around the block", () => {
    expect(
      parseRunReport(
        'Changed the form.\n\n```foreman-report\n{"pullRequestTitle": " Add the form ", "docsNote": {"impact": "none", "note": "no docs"}}\n```\n\nThanks.',
      ),
    ).toEqual({
      report: {
        pullRequestTitle: "Add the form",
        docsNote: { impact: "none", note: "no docs" },
        outOfScopeFindings: [],
        summary: "Changed the form.\n\n\nThanks.",
      },
    });
  });

  it("reads an indented block, as the bot files' instructions show it", () => {
    expect(
      parseRunReport(
        '  ```foreman-report\n  {"pullRequestTitle": "t", "docsNote": {"impact": "updated", "note": "docs/a.md"}}\n  ```',
      ),
    ).toEqual({
      report: {
        pullRequestTitle: "t",
        docsNote: { impact: "updated", note: "docs/a.md" },
        outOfScopeFindings: [],
        summary: "",
      },
    });
  });

  it.each(["developer", "designer"] as const)(
    "accepts the example block in the %s bot file's instructions",
    (role) => {
      const parsed = parseRunReport(readBotFiles()[role].instructions);
      expect(parsed).toMatchObject({
        report: { pullRequestTitle: "<one line>", docsNote: { impact: "none" } },
      });
    },
  );

  it("reads the stopped form: the reason trimmed, and no pull request fields (D-237)", () => {
    expect(
      parseRunReport(
        'Needs a decision.\n```foreman-report\n{"stopped": "needs_decision", "reason": " A new feature. "}\n```',
      ),
    ).toEqual({ stopped: { stopped: "needs_decision", reason: "A new feature." } });
    const longest = "x".repeat(MAX_STOP_REASON);
    expect(
      parseRunReport(
        `\`\`\`foreman-report\n{"stopped": "needs_decision", "reason": "${longest}"}\n\`\`\``,
      ),
    ).toEqual({ stopped: { stopped: "needs_decision", reason: longest } });
    expect(
      parseRunReport(
        '```foreman-report\n{"reason": "r", "docsNote": {"impact": "none"}}\n```',
      ),
    ).toEqual({
      problem:
        "a stopped foreman-report block must have stopped and reason only, with no pull request fields",
    });
  });

  it("checks the reason against the same bound as the runner", () => {
    expect(MAX_STOP_REASON).toBe(NEEDS_DECISION_MAX_REASON);
  });

  it.each(["developer", "designer"] as const)(
    "accepts the stopped form the %s bot file's instructions show",
    (role) => {
      const instructions = readBotFiles()[role].instructions;
      const shown = /\{"stopped": "needs_decision", "reason": "[^"]*"\}/.exec(
        instructions,
      );
      expect(shown).not.toBeNull();
      expect(
        parseRunReport(`\`\`\`foreman-report\n${shown?.[0] ?? ""}\n\`\`\``),
      ).toMatchObject({ stopped: { stopped: "needs_decision" } });
    },
  );

  describe("bugs seen outside the item (unit: outOfScopeFindings, D-244, O-65)", () => {
    const block = (findings: unknown) =>
      `Done.\n\`\`\`foreman-report\n${JSON.stringify({ pullRequestTitle: "t", docsNote: { impact: "none" }, outOfScopeFindings: findings })}\n\`\`\``;
    const problem = (findings: unknown) =>
      (parseRunReport(block(findings)) as { problem?: string }).problem;

    it("reads none, one and three findings, trimmed", () => {
      expect(parseRunReport(block([]))).toMatchObject({
        report: { outOfScopeFindings: [] },
      });
      expect(
        parseRunReport(
          block([{ title: " Login 500s ", detail: " Seen in src/a.ts. " }]),
        ),
      ).toMatchObject({
        report: {
          outOfScopeFindings: [{ title: "Login 500s", detail: "Seen in src/a.ts." }],
        },
      });
      const three = [1, 2, 3].map((n) => ({ title: `bug ${n}`, detail: `seen ${n}` }));
      expect(parseRunReport(block(three))).toMatchObject({
        report: { outOfScopeFindings: three },
      });
    });

    it("refuses a fourth finding, so a run reports at most three", () => {
      const four = [1, 2, 3, 4].map((n) => ({ title: `bug ${n}`, detail: "d" }));
      expect(problem(four)).toBe(
        "outOfScopeFindings must be a list of at most 3 items",
      );
    });

    it("holds each finding to its bounds", () => {
      expect(
        parseRunReport(block([{ title: "t".repeat(120), detail: "d".repeat(1000) }])),
      ).toHaveProperty("report");
      const title = "a finding's title must be one line of 1 to 120 characters";
      const detail = "a finding's detail must be text of 1 to 1000 characters";
      expect(problem([{ title: "t".repeat(121), detail: "d" }])).toBe(title);
      expect(problem([{ title: "a\nb", detail: "d" }])).toBe(title);
      expect(problem([{ title: " ", detail: "d" }])).toBe(title);
      expect(problem([{ title: "t", detail: "d".repeat(1001) }])).toBe(detail);
      expect(problem([{ title: "t", detail: "" }])).toBe(detail);
    });

    it.each([
      ["not a list", { title: "t", detail: "d" }],
      ["a text", "a bug"],
      ["a finding with an extra field", [{ title: "t", detail: "d", path: "a.ts" }]],
      ["a finding with no detail", [{ title: "t" }]],
      ["a finding that is not an object", ["a bug"]],
      ["a title that is not text", [{ title: 1, detail: "d" }]],
    ])("fails on %s", (_case, findings) => {
      expect(problem(findings)).toMatch(
        /^(outOfScopeFindings must be|each of outOfScopeFindings)/,
      );
    });

    it("keeps the stopped form to its two fields", () => {
      expect(
        parseRunReport(
          '```foreman-report\n{"stopped": "needs_decision", "reason": "r", "outOfScopeFindings": []}\n```',
        ),
      ).toEqual({
        problem:
          "a stopped foreman-report block must have stopped and reason only, with no pull request fields",
      });
    });
  });

  it("does not take a block with another info string", () => {
    expect(
      parseRunReport(
        '```json\n{"pullRequestTitle": "t", "docsNote": {"impact": "none"}}\n```',
      ),
    ).toEqual({
      problem: "there is no foreman-report block",
    });
  });
});

describe("the run's PR (unit: a scripted GitHub, N-44)", () => {
  const scripted = (
    answers: Record<string, { status: number | null; body?: unknown }[]>,
  ) => {
    const calls: string[] = [];
    const api: GitHubApi = async (method, path) => {
      const key = `${method} ${path.split("?")[0]}`;
      calls.push(key);
      const next = answers[key]?.shift();
      return { status: next?.status ?? 404, body: next?.body ?? null };
    };
    return { api, calls };
  };
  const options = (github: GitHubApi) => ({
    github,
    repository: REPOSITORY,
    branch: BRANCH,
    title: "t",
    body: "b",
  });
  const branchAnswer = { status: 200, body: { commit: { sha: HEAD_SHA } } };
  const pull = (number: number) => ({
    number,
    state: "open",
    head: { ref: BRANCH, repo: { full_name: REPOSITORY } },
  });

  it("reuses the PR another opener made between the list and the open (422)", async () => {
    const { api, calls } = scripted({
      [`GET /repos/${REPOSITORY}/branches/${BRANCH}`]: [branchAnswer],
      [`GET /repos/${REPOSITORY}/pulls`]: [
        { status: 200, body: [] },
        { status: 200, body: [pull(9)] },
      ],
      [`GET /repos/${REPOSITORY}`]: [{ status: 200, body: { default_branch: "main" } }],
      [`POST /repos/${REPOSITORY}/pulls`]: [{ status: 422, body: {} }],
    });
    expect(await openOrReusePullRequest(options(api))).toEqual({
      ok: true,
      pullRequest: {
        number: 9,
        url: `https://github.com/${REPOSITORY}/pull/9`,
        headSha: HEAD_SHA,
        reused: true,
      },
    });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("refuses to pick when several open PRs have the branch as head, and ignores a fork's", async () => {
    const fork = {
      ...pull(5),
      head: { ref: BRANCH, repo: { full_name: "someone/rehearsal" } },
    };
    const { api } = scripted({
      [`GET /repos/${REPOSITORY}/branches/${BRANCH}`]: [branchAnswer, branchAnswer],
      [`GET /repos/${REPOSITORY}/pulls`]: [
        { status: 200, body: [pull(3), pull(4)] },
        { status: 200, body: [fork, pull(4)] },
      ],
    });
    expect(await openOrReusePullRequest(options(api))).toMatchObject({
      ok: false,
      problem: "several_open_pull_requests",
    });
    expect(await openOrReusePullRequest(options(api))).toMatchObject({
      ok: true,
      pullRequest: { number: 4, reused: true },
    });
  });

  it("refuses GitHub answers in an unexpected shape instead of guessing", async () => {
    const { api } = scripted({
      [`GET /repos/${REPOSITORY}/branches/${BRANCH}`]: [
        { status: 200, body: { commit: {} } },
      ],
    });
    expect(await openOrReusePullRequest(options(api))).toMatchObject({
      ok: false,
      problem: "unexpected_answer",
    });
  });
});
