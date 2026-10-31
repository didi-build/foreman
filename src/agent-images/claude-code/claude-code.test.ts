import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  mapRunEnd,
  parseAgentResult,
} from "../../adapters/agent-runtime/kubernetes/result.ts";
import { PLACEHOLDER_CREDENTIAL, type ImageSettings } from "../shared/settings.ts";
import type { AgentTaskFile } from "../shared/task.ts";
import { MAX_ARGUMENT_BYTES, claudeCommand } from "./args.ts";
import { runClaudeCodeImage } from "./image.ts";
import { EMPTY_MCP_CONFIG, mcpConfig } from "./magicpath.ts";
import { parseClaudeCodeResult } from "./parse.ts";

const STATE_TOKEN = "state-token-value-not-real-0123456789";
const GITHUB_TOKEN = "github-token-value-not-real-0123456789";
const CLI = "/opt/claude-code/node_modules/@anthropic-ai/claude-code/bin/claude.exe";

const settings: ImageSettings = {
  runId: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
  role: "developer",
  model: "claude-sonnet-5-5",
  maxTurns: 100,
  maxUsd: 5,
  taskFile: "/task/task.json",
  modelBaseUrl: "http://10.245.0.10:8080/anthropic",
  stateApiUrl: "http://10.245.0.10:8080/state-api",
  stateApiToken: STATE_TOKEN,
  workDir: "/work",
};

const task: AgentTaskFile = {
  foremanTask: 1,
  instructions: "Fixture instructions.",
  input: "Fixture input.",
  allowedTools: ["Read", "Edit", "Bash(git status)"],
};

describe("Claude Code command (unit: exact flags, no shell, ADR 0106 sections 4 to 6)", () => {
  it("builds the exact argument list from the settings and the task", () => {
    const command = claudeCommand(CLI, settings, task, "/tmp/mcp.json", {});
    expect(command.file).toBe(CLI);
    expect(command.cwd).toBe("/work");
    expect(command.args).toEqual([
      "--bare",
      "--print",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5-5",
      "--max-turns",
      "100",
      "--max-budget-usd",
      "5",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Edit,Bash(git status)",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--append-system-prompt",
      "Fixture instructions.",
      "--",
      "Fixture input.",
    ]);
  });

  it("takes the model and limits from the settings, never a default", () => {
    const command = claudeCommand(
      CLI,
      { ...settings, model: "claude-haiku-5-5", maxTurns: 7, maxUsd: 0.5 },
      task,
      "/tmp/mcp.json",
      {},
    );
    const flag = (name: string) => command.args[command.args.indexOf(name) + 1];
    expect(flag("--model")).toBe("claude-haiku-5-5");
    expect(flag("--max-turns")).toBe("7");
    expect(flag("--max-budget-usd")).toBe("0.5");
  });

  it("keeps a prompt that looks like a flag after --, as one argument", () => {
    const command = claudeCommand(
      CLI,
      settings,
      { ...task, input: "--dangerously-skip-permissions; $(rm -rf /)" },
      "/tmp/mcp.json",
      {},
    );
    expect(command.args.slice(-2)).toEqual([
      "--",
      "--dangerously-skip-permissions; $(rm -rf /)",
    ]);
  });

  it("points the CLI at the proxy with a placeholder key and passes only listed variables", () => {
    const command = claudeCommand(CLI, settings, task, "/tmp/mcp.json", {
      PATH: "/usr/bin",
      GITHUB_TOKEN,
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      ANTHROPIC_API_KEY: "a-real-key-must-never-pass-0123456789",
      SECRET_PROJECTS_X_MODELS_ANTHROPIC: "another-real-key-0123456789",
      AWS_SECRET_ACCESS_KEY: "nope-0123456789",
    });
    expect(command.env).toEqual({
      PATH: "/usr/bin",
      GITHUB_TOKEN,
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      HOME: "/work",
      ANTHROPIC_BASE_URL: "http://10.245.0.10:8080/anthropic",
      ANTHROPIC_API_KEY: PLACEHOLDER_CREDENTIAL,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("refuses a relative CLI path, a task with no tools and a prompt over the argument cap", () => {
    expect(() => claudeCommand("claude", settings, task, "/tmp/m.json", {})).toThrow(
      /absolute/,
    );
    expect(() =>
      claudeCommand(CLI, settings, { ...task, allowedTools: [] }, "/tmp/m.json", {}),
    ).toThrow(/allowed tools/);
    expect(() =>
      claudeCommand(
        CLI,
        settings,
        { ...task, input: "x".repeat(MAX_ARGUMENT_BYTES + 1) },
        "/tmp/m.json",
        {},
      ),
    ).toThrow(/too large/);
  });
});

describe("Claude Code result (unit: --output-format json to the result line)", () => {
  const usage = {
    input_tokens: 12,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 4500,
    output_tokens: 80,
  };
  const base = { type: "result", num_turns: 3, total_cost_usd: 0.0207, usage };

  it("maps a success with turns, cost and the cached input apart", () => {
    expect(
      parseClaudeCodeResult(
        JSON.stringify({
          ...base,
          subtype: "success",
          is_error: false,
          result: "Done.",
        }),
        0,
      ),
    ).toEqual({
      status: "success",
      finalText: "Done.",
      turns: 3,
      costUsd: 0.0207,
      tokens: {
        uncachedInput: 12,
        cachedInput: 4500,
        cacheWriteInput: 300,
        output: 80,
      },
      errorText: "",
      providerError: null,
    });
  });

  it("maps Claude Code's own turn and dollar caps to the fields the runtime reads as budget_exceeded", () => {
    for (const [subtype, status] of [
      ["error_max_turns", "max_turns"],
      ["error_max_budget_usd", "max_budget"],
    ] as const) {
      const result = parseClaudeCodeResult(
        JSON.stringify({ ...base, subtype, is_error: true, errors: [] }),
        1,
      );
      expect(result.status).toBe(status);
      expect(mapRunEnd("failed", null, result, "claude-sonnet-5-5")).toMatchObject({
        outcome: "budget_exceeded",
        detail: status,
      });
    }
  });

  it("reports a provider error with its status and type", () => {
    const result = parseClaudeCodeResult(
      JSON.stringify({
        ...base,
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        result:
          'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
      1,
    );
    expect(result.status).toBe("error");
    expect(result.providerError).toMatchObject({
      status: 529,
      type: "overloaded_error",
    });
  });

  it("is an error result when there is no result object", () => {
    expect(parseClaudeCodeResult("Segmentation fault\n", 139)).toMatchObject({
      status: "error",
      errorText: "Claude Code exited with code 139 and printed no result",
    });
  });
});

describe("MagicPath (unit: off until D-190's gate)", () => {
  it("gives every run an empty MCP configuration while MagicPath is off", () => {
    expect(mcpConfig("designer", { url: undefined })).toEqual(EMPTY_MCP_CONFIG);
    expect(mcpConfig("developer", { url: undefined })).toEqual(EMPTY_MCP_CONFIG);
  });

  it("refuses a MagicPath setting while it is off, and for any role but the Designer", () => {
    expect(() => mcpConfig("designer", { url: "https://mcp.example.com/mcp" })).toThrow(
      /D-190/,
    );
    expect(() =>
      mcpConfig("developer", { url: "https://mcp.example.com/mcp" }, true),
    ).toThrow(/only for a Designer/);
  });

  it("when on, names the server and references the credential without writing it", () => {
    const config = mcpConfig("designer", { url: "https://mcp.example.com/mcp" }, true);
    expect(config).toEqual({
      mcpServers: {
        magicpath: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${MAGICPATH_API_KEY}" },
        },
      },
    });
    expect(() =>
      mcpConfig("designer", { url: "http://mcp.example.com/mcp" }, true),
    ).toThrow(/https/);
  });
});

describe("Claude Code image (integration: a fake claude executable, no network)", () => {
  let dir: string;
  let lines: string[];
  let env: Record<string, string>;

  const writeTask = (input: string, role = "developer") => {
    const file = join(dir, "task.json");
    writeFileSync(file, JSON.stringify({ ...task, input }));
    env.FOREMAN_TASK_FILE = file;
    env.FOREMAN_ROLE = role;
  };
  const call = () =>
    JSON.parse(readFileSync(join(dir, "work", "fake-claude-call.json"), "utf8")) as {
      args: string[];
      env: Record<string, string>;
      cwd: string;
    };
  const run = async () => {
    lines = [];
    const code = await runClaudeCodeImage(env, (line) => lines.push(line));
    return { code, result: parseAgentResult(lines.join("\n")) };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-claude-code-"));
    const cli = join(dir, "claude");
    copyFileSync(new URL("../testing/fake-claude.mjs", import.meta.url), cli);
    chmodSync(cli, 0o755);
    const work = join(dir, "work");
    env = {
      PATH: process.env.PATH ?? "",
      TMPDIR: dir,
      HOME: work,
      FOREMAN_RUN_ID: settings.runId,
      FOREMAN_ROLE: "developer",
      FOREMAN_MODEL: "claude-sonnet-5-5",
      FOREMAN_MAX_TURNS: "100",
      FOREMAN_MAX_BUDGET_USD: "5",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/anthropic",
      FOREMAN_STATE_API_URL: "http://127.0.0.1:9/state-api",
      FOREMAN_STATE_API_TOKEN: STATE_TOKEN,
      GITHUB_TOKEN,
      FOREMAN_CLAUDE_CLI: cli,
    };
    // The work folder is the pod's emptyDir.
    mkdirSync(work, { recursive: true });
  });

  it("runs the CLI by its path, reads its result and prints one result line", async () => {
    writeTask("Make the change. scenario=success");
    const { code, result } = await run();
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(result).toEqual({
      status: "success",
      finalText: "Done.",
      turns: 3,
      costUsd: 0.0207,
      tokens: {
        uncachedInput: 12,
        cachedInput: 4500,
        cacheWriteInput: 300,
        output: 80,
      },
      errorText: "",
      providerError: null,
    });
    const seen = call();
    expect(seen.cwd).toBe(join(dir, "work"));
    expect(seen.args.slice(0, 6)).toEqual([
      "--bare",
      "--print",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5-5",
    ]);
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9/anthropic");
    expect(seen.env.ANTHROPIC_API_KEY).toBe(PLACEHOLDER_CREDENTIAL);
    // The MCP file it was given is empty: MagicPath is off.
    const mcpPath = seen.args[seen.args.indexOf("--mcp-config") + 1] as string;
    expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toEqual(EMPTY_MCP_CONFIG);
  });

  it("passes shell syntax in the prompt through as plain text, with no shell", async () => {
    const marker = join(dir, "pwned");
    const prompt = `Fix it; touch ${marker} && echo $(touch ${marker}) 'quoted' "double" scenario=success`;
    writeTask(prompt);
    const { result } = await run();
    expect(result?.status).toBe("success");
    expect(call().args.at(-1)).toBe(prompt);
    expect(call().args.at(-2)).toBe("--");
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["max_turns", "budget_exceeded", "max_turns"],
    ["max_budget", "budget_exceeded", "max_budget"],
    ["rate_limit", "usage_exhausted", "rate_limit"],
    ["overloaded", "usage_exhausted", "capacity"],
    ["billing", "usage_exhausted", "out_of_credit"],
  ])("maps the %s scenario to %s (%s)", async (scenario, outcome, detail) => {
    writeTask(`scenario=${scenario}`);
    const { code, result } = await run();
    expect(code).toBe(1);
    expect(mapRunEnd("failed", null, result, "claude-sonnet-5-5")).toMatchObject({
      outcome,
      detail,
    });
  });

  it("never prints a credential, even when the agent echoes them", async () => {
    writeTask("scenario=echo-secrets");
    await run();
    const output = lines.join("\n");
    for (const secret of [STATE_TOKEN, GITHUB_TOKEN, PLACEHOLDER_CREDENTIAL]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[redacted]");
  });

  it("prints an error line naming the setting when one is missing, and never starts the CLI", async () => {
    writeTask("scenario=success");
    delete env.FOREMAN_MAX_BUDGET_USD;
    const { code, result } = await run();
    expect(code).toBe(1);
    expect(result?.errorText).toContain("FOREMAN_MAX_BUDGET_USD is not set");
    expect(existsSync(join(dir, "work", "fake-claude-call.json"))).toBe(false);
  });

  it("refuses a QA role and a task without tools before the CLI starts", async () => {
    writeTask("scenario=success", "qa");
    expect((await run()).result?.errorText).toMatch(/FOREMAN_ROLE/);
    writeFileSync(
      join(dir, "task.json"),
      JSON.stringify({ ...task, allowedTools: [] }),
    );
    env.FOREMAN_ROLE = "developer";
    expect((await run()).result?.errorText).toMatch(/allowed tools/);
    expect(existsSync(join(dir, "work", "fake-claude-call.json"))).toBe(false);
  });

  it("reports a CLI that prints nothing as an error", async () => {
    writeTask("scenario=no-output");
    const { result } = await run();
    expect(result).toMatchObject({
      status: "error",
      errorText: expect.stringMatching(/code 2/),
    });
  });
});
