// The OpenCode image's run (Developer and Designer, D-222, D-223): read the settings and the task,
// refuse a checkout that would load repository code into OpenCode, write the per-run config,
// run the pinned binary once, enforce the dollar cap and the turn limit from its events, and
// and, once OpenCode has ended with success, open or reuse the run's PR and post its docs note
// from the final message (./finish.ts, N-44, D-235). It prints one result line. Any failure
// before or around OpenCode is still one result line with
// status `error`, so the runner always reads an end. Nothing is written before the settings and
// the task are read. Prompts, keys and tokens are never logged: the result line is the only
// output, with every credential value removed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  errorResult,
  exitCode,
  printResult,
  type AgentResult,
} from "../shared/result.ts";
import { secretValues } from "../shared/settings.ts";
import { readTask } from "../shared/task.ts";
import { refuseRepositoryConfig } from "./checkout.ts";
import { openCodeCommand } from "./command.ts";
import { capTier, openCodeConfig } from "./config.ts";
import { EMPTY_TALLY, addEventLine, type RunTally } from "./events.ts";
import { finishRun } from "./finish.ts";
import { proxiedGitHub, type SecureTunnel } from "./github.ts";
import { limitStop, type LimitStop } from "./limits.ts";
import { runOpenCode, SYSTEM_CLOCK, type StopClock } from "./process.ts";
import { openCodeResult } from "./result.ts";
import { readOpenCodeSettings } from "./settings.ts";

export interface OpenCodeImageDeps {
  write?: (line: string) => void;
  /** The SIGKILL grace timer. Tests pass a fake one. */
  clock?: StopClock;
  /** The time a retry-after date is measured from. */
  now?: () => Date;
  /** Tests turn MagicPath on to check the enabled config; the image never does. */
  magicPathEnabled?: boolean;
  /**
   * Tests only: the fake proxy tunnels to a plain HTTP fake GitHub, so the TLS step is skipped.
   * The image always speaks TLS to api.github.com inside the tunnel.
   */
  secureTunnel?: SecureTunnel;
}

export async function runOpenCodeImage(
  env: NodeJS.ProcessEnv,
  deps: OpenCodeImageDeps = {},
): Promise<number> {
  let secrets: string[] = [];
  let result: AgentResult;
  try {
    const settings = readOpenCodeSettings(env);
    secrets = secretValues(settings, env);
    const task = readTask(settings.role, settings.taskFile);
    // The task file check already refused a Developer or Designer task without these.
    const nodeId = task.nodeId as string;
    const branch = task.branch as string;
    refuseRepositoryConfig(settings.workDir);
    const tmpDir = env.TMPDIR ?? "/tmp";
    // The config and instructions live outside the repository, readable by this user only. The
    // config is built first, so a task it refuses leaves nothing behind.
    const runDir = join(tmpDir, `foreman-opencode-${settings.runId}`);
    const instructionsPath = join(runDir, "instructions.md");
    const configPath = join(runDir, "opencode.json");
    const config = openCodeConfig(
      settings,
      task,
      instructionsPath,
      deps.magicPathEnabled,
    );
    mkdirSync(runDir, { mode: 0o700 });
    writeFileSync(instructionsPath, task.instructions, { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const command = openCodeCommand(settings, configPath, tmpDir, env);

    const priceTier = capTier(settings.price, settings.serviceTier);
    const now = deps.now ?? (() => new Date());
    let tally: RunTally = EMPTY_TALLY;
    let limit: LimitStop | null = null;
    let end;
    try {
      end = await runOpenCode(
        command,
        task.input,
        (line) => {
          tally = addEventLine(tally, line, settings.price, priceTier, now());
          limit = limitStop(tally, settings);
          return limit === null ? undefined : "stop";
        },
        deps.clock ?? SYSTEM_CLOCK,
      );
    } catch {
      throw new Error("OpenCode could not be started");
    }
    result = await finishRun(
      openCodeResult(
        tally,
        {
          exitCode: end.exitCode,
          limit,
          stoppedFromOutside: end.stopped && limit === null,
        },
        settings.serviceTier,
      ),
      {
        github: proxiedGitHub({
          proxyUrl: settings.egressProxyUrl,
          token: settings.githubToken,
          ...(deps.secureTunnel ? { secure: deps.secureTunnel } : {}),
        }),
        repository: settings.repository,
        branch,
        nodeId,
        stateApiUrl: settings.stateApiUrl,
        stateApiToken: settings.stateApiToken,
        secrets,
      },
    );
  } catch (error) {
    // Setting, task and checkout errors name the problem, never a value.
    result = errorResult(
      error instanceof Error ? error.message : "the run failed before OpenCode started",
    );
  }
  printResult(result, secrets, deps.write);
  return exitCode(result);
}
