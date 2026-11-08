// Bootstrap's token job, without the token (D-358 lock 1, O-113): applies the prepare job's patch
// as data with `git apply` and commits it as github-actions[bot]. It runs no hook and no
// repository code, and refuses a patch that touches `.github/`, the protected code this job
// runs next. Node built-ins only (`node .github/scripts/check-bootstrap-isolation.mjs`).
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import {
  appendGithubOutput,
  appendStepSummary,
  envForGit,
  isMain,
} from "./bootstrap-common.mjs";

export const SETUP_COMMIT_MESSAGE = "chore: initialize project from Launchpad template";
export const BOT_NAME = "github-actions[bot]";
export const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
/** The init patch is text and small; anything near this is not one. */
export const MAX_PATCH_BYTES = 20 * 1024 * 1024;

/**
 * Paths a setup patch may not touch: `.github/` holds the scripts and workflows this job trusts.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function forbiddenPatchPaths(paths) {
  return paths.filter((path) => {
    const lower = path.toLowerCase();
    return lower === ".github" || lower.startsWith(".github/");
  });
}

/**
 * Runs git with hooks switched off and no inherited configuration or token.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
function git(args, env, cwd) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...envForGit(env), HUSKY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * @param {ReturnType<typeof git>} result
 */
function printGit(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

/**
 * @param {string} patchPath
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {number} the exit code
 */
export function runCommit(patchPath, env, cwd) {
  /** @param {string} message */
  const fail = (message) => {
    console.error(`::error title=Bootstrap setup commit::${message}`);
    console.error(message);
    appendStepSummary(env, [`- Setup commit refused: ${message}`]);
    return 1;
  };

  if (!patchPath) {
    return fail("Pass the path of the setup patch.");
  }
  const stat = lstatSync(patchPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return fail("The setup patch is missing or is not a regular file.");
  }
  if (stat.size > MAX_PATCH_BYTES) {
    return fail(`The setup patch is larger than ${MAX_PATCH_BYTES} bytes.`);
  }
  if (stat.size === 0) {
    console.log("The setup patch is empty: nothing to commit.");
    appendGithubOutput(env, { committed: "false" });
    appendStepSummary(env, ["- The setup patch was empty: no commit."]);
    return 0;
  }

  const check = git(["apply", "--check", "--index", patchPath], env, cwd);
  if (check.status !== 0) {
    printGit(check);
    return fail("git apply --check refused the setup patch.");
  }
  const apply = git(["apply", "--index", patchPath], env, cwd);
  if (apply.status !== 0) {
    printGit(apply);
    return fail("git apply refused the setup patch.");
  }

  const staged = git(
    ["diff", "--cached", "--name-only", "--no-renames", "-z"],
    env,
    cwd,
  );
  if (staged.status !== 0) {
    printGit(staged);
    return fail("Could not list the files the setup patch changed.");
  }
  const paths = staged.stdout.split("\0").filter(Boolean);
  const forbidden = forbiddenPatchPaths(paths);
  if (forbidden.length > 0) {
    return fail(
      `The setup patch changes files under .github/, which only a reviewed pull request may change: ${forbidden.join(", ")}`,
    );
  }
  if (paths.length === 0) {
    console.log("The setup patch changes nothing: nothing to commit.");
    appendGithubOutput(env, { committed: "false" });
    appendStepSummary(env, ["- The setup patch changed nothing: no commit."]);
    return 0;
  }

  const commit = git(
    [
      "-c",
      `user.name=${BOT_NAME}`,
      "-c",
      `user.email=${BOT_EMAIL}`,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      SETUP_COMMIT_MESSAGE,
    ],
    env,
    cwd,
  );
  printGit(commit);
  if (commit.status !== 0) {
    return fail("git commit failed.");
  }
  console.log(`Committed the setup patch (${paths.length} files) as ${BOT_NAME}.`);
  appendGithubOutput(env, { committed: "true" });
  appendStepSummary(env, [
    `- Committed the setup patch (${paths.length} files) as ${BOT_NAME}.`,
  ]);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runCommit(process.argv[2] ?? "", process.env, process.cwd());
}
