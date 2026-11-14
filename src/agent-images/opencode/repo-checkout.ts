// The Developer's and Designer's working tree (O-134, ADR 0106 sections 3 and 5). The run's pod
// starts with an empty work folder, and the builder's instructions say to work on the branch the
// input names and push it with git: so before OpenCode starts, the wrapper checks out the run's
// one repository into the work folder, on the run's branch. A branch already on GitHub (a fix
// round) is checked out as it is; otherwise the branch starts from the default branch's head.
// Until O-134 nothing did, and the rehearsal's first Developer runs stopped at once asking for a
// decision because /work held no repository.
//
// Git reaches github.com through the run's egress proxy (HTTPS_PROXY), with the run's own
// installation token: a credential helper in the checkout's own config reads GITHUB_TOKEN from
// the environment each time git asks, so the token is never written to disk, into the remote
// URL or into a commit, and the agent's own `git push` later uses the same helper. Every git
// command runs with fixed arguments and no shell; the repository and the branch are checked
// against their patterns first. Git's output is never printed or kept: a failed step throws one
// of the fixed sentences D-385 keeps, naming the step only. OpenCode's own folders in the work
// folder are excluded from git, so they are never committed.
//
// The work folder is the pod's emptyDir volume, owned by root, while the run's user is another:
// git refuses a repository in a folder another user owns ("dubious ownership"), so every
// command after `git init` failed on the cluster (O-135). The first step therefore marks the work
// folder safe in git's global config, which is `.gitconfig` in HOME, the work folder itself, so
// the agent's own git commands, which run with the same HOME, read it too.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { passedThrough } from "../shared/environment.ts";

/** The start of every checkout failure; the step follows (`: git <step> failed`). */
export const CHECKOUT_FAILED = "the repository could not be checked out";

/** The git steps a failure can name. */
export type CheckoutStep =
  "safe-directory" | "init" | "config" | "remote" | "ls-remote" | "fetch" | "checkout";

/**
 * The credential helper, for github.com only: it reads git's request, and on `get` answers with
 * the run's token from the environment as the installation token's user. A shell snippet git runs
 * itself; it holds no value.
 */
export const CREDENTIAL_HELPER =
  '!f() { cat >/dev/null; test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';

/** OpenCode's own folders and git's global config in the work folder (HOME), never committed. */
export const EXCLUDED = [".cache/", ".local/", ".config/", ".gitconfig"];

/** History fetched for the branch the run starts from. */
export const FETCH_DEPTH = 50;

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const RUN_BRANCH =
  /^foreman\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/;
const STEP_TIMEOUT_MS = 120_000;

export interface GitResult {
  code: number;
  stdout: string;
}

/** Runs git with these arguments in `cwd`; never through a shell. */
export type GitRunner = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<GitResult>;

export interface CheckoutOptions {
  workDir: string;
  /** `owner/name`, as FOREMAN_REPOSITORY gives it. */
  repository: string;
  /** The run's branch, `foreman/<node id>`. */
  branch: string;
  role: "developer" | "designer";
  /** The pod's environment: PATH, the proxy variables and GITHUB_TOKEN are passed on. */
  env: NodeJS.ProcessEnv;
  /** Tests only: a local repository instead of github.com. */
  remoteUrl?: string;
  git?: GitRunner;
}

export interface CheckoutResult {
  /** Where the run's branch came from. */
  from: "existing_branch" | "default_branch";
  defaultBranch: string;
}

/** The real runner: git with fixed arguments, no shell, bounded. */
export const execGit: GitRunner = (args, { cwd, env }) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env, timeout: STEP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
  });

/** Checks out the run's repository into the work folder on the run's branch (O-134). */
export async function checkoutRepository(
  options: CheckoutOptions,
): Promise<CheckoutResult> {
  const { workDir, repository, branch, role } = options;
  if (!REPOSITORY.test(repository))
    throw new Error(`${CHECKOUT_FAILED}: not a repository name`);
  if (!RUN_BRANCH.test(branch)) throw new Error(`${CHECKOUT_FAILED}: not a run branch`);
  const git = options.git ?? execGit;
  const env: NodeJS.ProcessEnv = {
    ...passedThrough(options.env),
    HOME: workDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = async (step: CheckoutStep, args: readonly string[]): Promise<string> => {
    const result = await git(args, { cwd: workDir, env });
    if (result.code !== 0) throw new Error(`${CHECKOUT_FAILED}: git ${step} failed`);
    return result.stdout;
  };

  // The work folder's owner is not the run's user (O-135): git works there only once it is safe.
  await run("safe-directory", [
    "config",
    "--global",
    "--add",
    "safe.directory",
    workDir,
  ]);
  await run("init", ["init", "--quiet"]);
  for (const [key, value] of [
    ["credential.https://github.com.helper", CREDENTIAL_HELPER],
    ["user.name", `Foreman ${role === "developer" ? "Developer" : "Designer"}`],
    ["user.email", `${role}@foreman.invalid`],
    // A plain `git push` from the agent pushes the run's branch to the same name.
    ["push.default", "current"],
    ["push.autoSetupRemote", "true"],
  ] as const) {
    await run("config", ["config", key, value]);
  }
  await run("remote", [
    "remote",
    "add",
    "origin",
    options.remoteUrl ?? `https://github.com/${repository}.git`,
  ]);

  const head = await run("ls-remote", ["ls-remote", "--symref", "origin", "HEAD"]);
  const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
  if (defaultBranch === undefined || !BRANCH_NAME.test(defaultBranch)) {
    throw new Error(`${CHECKOUT_FAILED}: git ls-remote failed`);
  }
  const existing = (
    await run("ls-remote", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])
  ).trim();
  const from = existing === "" ? defaultBranch : branch;
  await run("fetch", [
    "fetch",
    "--quiet",
    "--no-tags",
    `--depth=${FETCH_DEPTH}`,
    "origin",
    `+refs/heads/${from}:refs/remotes/origin/${from}`,
  ]);
  await run("checkout", [
    "checkout",
    "--quiet",
    "-B",
    branch,
    `refs/remotes/origin/${from}`,
  ]);
  mkdirSync(join(workDir, ".git", "info"), { recursive: true });
  appendFileSync(join(workDir, ".git", "info", "exclude"), `${EXCLUDED.join("\n")}\n`);
  return {
    from: existing === "" ? "default_branch" : "existing_branch",
    defaultBranch,
  };
}
