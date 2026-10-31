// The Claude Code image's run (Developer and Designer, ADR 0106 and 0107): read the settings and
// the task, run the pinned CLI once, and print one result line. Any failure before or around
// the CLI is still one result line with status `error`, so the runner always reads an end.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  errorResult,
  exitCode,
  printResult,
  type AgentResult,
} from "../shared/result.ts";
import { readImageSettings, secretValues } from "../shared/settings.ts";
import { readTask } from "../shared/task.ts";
import { claudeCommand } from "./args.ts";
import { mcpConfig } from "./magicpath.ts";
import { parseClaudeCodeResult } from "./parse.ts";
import { runCli } from "./run.ts";

export async function runClaudeCodeImage(
  env: NodeJS.ProcessEnv,
  write?: (line: string) => void,
): Promise<number> {
  let secrets: string[] = [];
  let result: AgentResult;
  try {
    const settings = readImageSettings("claude-code", env);
    secrets = secretValues(settings, env);
    const task = readTask(settings.role, settings.taskFile);
    const config = mcpConfig(settings.role, { url: env.FOREMAN_MAGICPATH_URL });
    const configPath = join(env.TMPDIR ?? "/tmp", `foreman-mcp-${settings.runId}.json`);
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const command = claudeCommand(
      env.FOREMAN_CLAUDE_CLI ?? "",
      settings,
      task,
      configPath,
      env,
    );
    let run;
    try {
      run = await runCli(command);
    } catch {
      throw new Error("the Claude Code CLI could not be started");
    }
    result = parseClaudeCodeResult(run.stdout, run.exitCode);
  } catch (error) {
    // Setting, task and command errors name the problem, never a value.
    result = errorResult(
      error instanceof Error
        ? error.message
        : "the run failed before Claude Code started",
    );
  }
  printResult(result, secrets, write);
  return exitCode(result);
}
