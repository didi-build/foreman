// The exact Claude Code command for a Developer or Designer run (ADR 0106 sections 4 to 6, D-172).
// Pure: the same settings and task give the same command. The CLI is called by its path with an
// argument list, never through a shell, so nothing in the task is ever parsed as shell syntax.
import { passedThrough } from "../shared/environment.ts";
import type { AgentTaskFile } from "../shared/task.ts";
import { PLACEHOLDER_CREDENTIAL, type ImageSettings } from "../shared/settings.ts";

/** One argument is capped at 128 KiB on Linux; keep the prompt and instructions well below. */
export const MAX_ARGUMENT_BYTES = 100 * 1024;

export interface ClaudeCommand {
  /** The pinned CLI's absolute path. */
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * The command. `mcpConfigPath` is a file the caller writes with the run's MCP configuration
 * (empty unless MagicPath is on, ./magicpath.ts); `--strict-mcp-config` makes it the only one.
 */
export function claudeCommand(
  cliPath: string,
  settings: ImageSettings,
  task: AgentTaskFile,
  mcpConfigPath: string,
  env: NodeJS.ProcessEnv,
): ClaudeCommand {
  if (!cliPath.startsWith("/"))
    throw new Error("FOREMAN_CLAUDE_CLI must be an absolute path");
  for (const [name, value] of [
    ["instructions", task.instructions],
    ["input", task.input],
  ] as const) {
    if (Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new Error(`the task's ${name} is too large for a Claude Code run`);
    }
  }
  const tools = task.allowedTools ?? [];
  if (tools.length === 0)
    throw new Error(`a ${settings.role} task needs its allowed tools`);
  const args = [
    // No settings, hooks, plugins or memory files from the image or the repository: only flags.
    "--bare",
    "--print",
    "--output-format",
    "json",
    "--model",
    settings.model,
    "--max-turns",
    String(settings.maxTurns),
    "--max-budget-usd",
    String(settings.maxUsd),
    // Tools not listed are refused without asking: there is no one to ask.
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    tools.join(","),
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--append-system-prompt",
    task.instructions,
    // Everything after `--` is the prompt, even text that starts with a dash.
    "--",
    task.input,
  ];
  // Variables passed through from the pod when set (../shared/environment.ts).
  const passed = passedThrough(env);
  return {
    file: cliPath,
    args,
    cwd: settings.workDir,
    env: {
      ...passed,
      HOME: settings.workDir,
      // The proxy's address for Anthropic and a placeholder key: the proxy adds the real one.
      ANTHROPIC_BASE_URL: settings.modelBaseUrl,
      ANTHROPIC_API_KEY: PLACEHOLDER_CREDENTIAL,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };
}
