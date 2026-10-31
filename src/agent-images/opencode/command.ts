// The exact OpenCode command for a Developer or Designer run (docs/spikes/opencode-runtime.md,
// "What the image needs", D-172). Pure: the same settings give the same command. The binary is
// called by its path with an argument list, never through a shell. The prompt goes in on stdin,
// not as an argument: OpenCode quotes a message argument before sending it, and stdin arrives
// byte for byte with no size limit.
import { passedThrough } from "../shared/environment.ts";
import { PROVIDER_ID } from "./config.ts";
import type { OpenCodeSettings } from "./settings.ts";

export interface OpenCodeCommand {
  /** The pinned binary's absolute path. */
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * OpenCode's switches: no model list fetch, no update check, no language server downloads, no
 * project or Claude Code config, no default plugins and no external skills. Telemetry stays off
 * because no OTEL_* or OPENCODE_ENABLE_* variable is ever passed.
 */
export const OPENCODE_SWITCHES: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
};

export function openCodeCommand(
  settings: Pick<
    OpenCodeSettings,
    "runId" | "model" | "cliPath" | "configHome" | "workDir"
  >,
  configPath: string,
  tmpDir: string,
  env: NodeJS.ProcessEnv,
): OpenCodeCommand {
  return {
    file: settings.cliPath,
    args: [
      "run",
      "--format",
      "json",
      // No external plugins. Repository plugins are refused before the start (./checkout.ts).
      "--pure",
      // A title of our own: without it OpenCode first asks the model for one, in a request no
      // event reports, so its tokens would be missing from the cost.
      "--title",
      settings.runId,
      "-m",
      `${PROVIDER_ID}/${settings.model}`,
    ],
    cwd: settings.workDir,
    env: {
      ...passedThrough(env),
      // The work folder (emptyDir) holds OpenCode's session database, logs and cache.
      HOME: settings.workDir,
      // Bun unpacks its native libraries here at each start.
      TMPDIR: tmpDir,
      // Read-only, with `opencode/.gitignore` already there, so OpenCode installs nothing.
      XDG_CONFIG_HOME: settings.configHome,
      OPENCODE_CONFIG: configPath,
      ...OPENCODE_SWITCHES,
    },
  };
}
