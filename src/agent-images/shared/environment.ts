// The pod variables a coding runtime's process may see (D-172): the coding images (Claude Code,
// OpenCode) pass only these through, plus their own settings. Nothing else reaches the runtime,
// so a variable added to the pod later is not handed to the agent by accident.
export const PASSED_THROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "GITHUB_TOKEN",
  "FOREMAN_RUN_ID",
  "FOREMAN_ROLE",
  "FOREMAN_REPOSITORY",
  "FOREMAN_STATE_API_URL",
  "FOREMAN_STATE_API_TOKEN",
] as const;

/** The listed variables that are set, and nothing else. */
export function passedThrough(env: NodeJS.ProcessEnv): Record<string, string> {
  const passed: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = env[name];
    if (value !== undefined) passed[name] = value;
  }
  return passed;
}
