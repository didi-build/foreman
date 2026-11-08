// Bootstrap's token job, the push (D-358 lock 1, O-113): pushes the setup commit to the default
// branch with the token, without force. The token reaches git only through GIT_CONFIG_* on that
// one process: not in argv, the remote URL or .git/config, and no hook runs. Node built-ins only
// (`node .github/scripts/check-bootstrap-isolation.mjs`).
import { spawnSync } from "node:child_process";
import {
  appendStepSummary,
  envForGit,
  isMain,
  parseBranch,
  parseRepository,
  redact,
  tokenFromEnv,
} from "./bootstrap-common.mjs";

/**
 * Git argv for the push (no credentials in argv).
 *
 * @param {string} repository `owner/name`
 * @param {string} branch
 * @returns {string[]}
 */
export function gitPushArgs(repository, branch) {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    `https://github.com/${repository}.git`,
    `HEAD:refs/heads/${branch}`,
  ];
}

/**
 * Basic x-access-token auth for one `git push` through GIT_CONFIG_* (not in argv or on disk).
 *
 * @param {string} token
 * @returns {Record<string, string>}
 */
export function gitPushAuthProcessEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {number} the exit code
 */
export function runPush(env, cwd) {
  const token = tokenFromEnv(env);
  if (!token) {
    appendStepSummary(env, ["- Push refused: the token is malformed."]);
    return 1;
  }
  const repository = parseRepository(env.GITHUB_REPOSITORY);
  const branch = parseBranch(env.DEFAULT_BRANCH);
  if (!repository || !branch) {
    console.error("GITHUB_REPOSITORY or DEFAULT_BRANCH is missing or not valid.");
    return 1;
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const result = spawnSync("git", gitPushArgs(repository, branch), {
    cwd,
    encoding: "utf8",
    env: { ...envForGit(env), ...gitPushAuthProcessEnv(token) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(redact(result.stdout, [token, basic]));
  if (result.stderr) process.stderr.write(redact(result.stderr, [token, basic]));
  if (result.status !== 0) {
    console.error(
      `::error title=Bootstrap push::git push to ${branch} failed. If an earlier attempt already pushed the setup commit, start Bootstrap again with Run workflow (or Re-run all jobs), so the decide step looks again.`,
    );
    appendStepSummary(env, [`- Push to \`${branch}\` failed.`]);
    return 1;
  }
  appendStepSummary(env, [`- Pushed the setup commit to \`${branch}\`.`]);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runPush(process.env, process.cwd());
}
