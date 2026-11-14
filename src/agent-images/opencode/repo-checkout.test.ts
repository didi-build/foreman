// The Developer's and Designer's checkout (O-134, ./repo-checkout.ts). Integration with real git
// against a local bare repository standing in for GitHub (file://), so nothing reaches a network;
// and unit, with a recording git runner, for the exact commands and the github.com address.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECKOUT_FAILED,
  CREDENTIAL_HELPER,
  checkoutRepository,
  type GitRunner,
} from "./repo-checkout.ts";

const REPOSITORY = "example-org/example";
const BRANCH = "foreman/0b8f6f8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const TOKEN = "made-up-token-0123456789";
const CLEAN_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, env: CLEAN_ENV, encoding: "utf8" },
  ).trim();

/** Reads a setting from the checkout's own config, with no `-c` of the test's. */
const config = (cwd: string, key: string): string =>
  execFileSync("git", ["config", "--get", key], {
    cwd,
    env: CLEAN_ENV,
    encoding: "utf8",
  }).trim();

let dir: string;
let remote: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foreman-checkout-test-"));
  const source = join(dir, "source");
  mkdirSync(source);
  git(source, "init", "--quiet", "-b", "main");
  writeFileSync(join(source, "README.md"), "# Example\n");
  writeFileSync(join(source, "package.json"), "{}\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "first");
  remote = join(dir, "remote.git");
  git(dir, "clone", "--quiet", "--bare", source, remote);
  work = join(dir, "work");
  mkdirSync(work);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const checkout = (branch = BRANCH, workDir = work) =>
  checkoutRepository({
    workDir,
    repository: REPOSITORY,
    branch,
    role: "developer",
    env: { ...CLEAN_ENV, GITHUB_TOKEN: TOKEN },
    remoteUrl: `file://${remote}`,
  });

const filesUnder = (root: string): string[] =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

describe("the builder's checkout (integration: real git, a local repository, O-134)", () => {
  it("starts a new run branch from the default branch's head", async () => {
    expect(await checkout()).toEqual({ from: "default_branch", defaultBranch: "main" });
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("# Example\n");
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(git(work, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
  });

  it("checks out the run branch as it is when it is already on the remote (a fix round)", async () => {
    const other = join(dir, "other");
    git(dir, "clone", "--quiet", remote, other);
    git(other, "checkout", "--quiet", "-b", BRANCH);
    writeFileSync(join(other, "README.md"), "# Example\n\nA first round's line.\n");
    git(other, "commit", "--quiet", "-am", "first round");
    git(other, "push", "--quiet", "origin", BRANCH);

    expect(await checkout()).toEqual({
      from: "existing_branch",
      defaultBranch: "main",
    });
    expect(readFileSync(join(work, "README.md"), "utf8")).toContain(
      "A first round's line.",
    );
    expect(git(work, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", BRANCH));
  });

  it("works in a work folder that already holds OpenCode's folders, and never commits them", async () => {
    mkdirSync(join(work, ".cache"));
    writeFileSync(join(work, ".cache", "session"), "made-up");
    mkdirSync(join(work, ".local"));
    await checkout();
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  it("sets up pushing with the token from the environment, writing the token nowhere", async () => {
    await checkout();
    expect(config(work, "credential.https://github.com.helper")).toBe(
      CREDENTIAL_HELPER,
    );
    expect(config(work, "user.email")).toBe("developer@foreman.invalid");
    expect(config(work, "push.default")).toBe("current");
    for (const file of filesUnder(join(work, ".git"))) {
      expect(readFileSync(file).includes(TOKEN)).toBe(false);
    }
  });

  it("answers the helper's get with the token from the environment, and nothing else", () => {
    // Git runs a `!` helper through the shell with the operation appended.
    const helper = CREDENTIAL_HELPER.slice(1);
    const answer = (op: string) =>
      execFileSync("sh", ["-c", `${helper} ${op}`], {
        env: { ...CLEAN_ENV, GITHUB_TOKEN: TOKEN },
        encoding: "utf8",
        input: "protocol=https\nhost=github.com\n\n",
      });
    expect(answer("get")).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(answer("store")).toBe("");
  });

  it("lets the agent's plain git push send the run branch to the same name on the remote", async () => {
    await checkout();
    writeFileSync(join(work, "README.md"), "# Example\n\nA rehearsal line.\n");
    // The agent commits with the checkout's own identity and pushes with no arguments.
    execFileSync("git", ["commit", "--quiet", "-am", "Add a rehearsal line"], {
      cwd: work,
      env: { ...CLEAN_ENV, HOME: work },
    });
    execFileSync("git", ["push", "--quiet"], {
      cwd: work,
      env: { ...CLEAN_ENV, HOME: work },
    });
    expect(git(remote, "rev-parse", BRANCH)).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(remote, "log", "-1", "--format=%ae", BRANCH)).toBe(
      "developer@foreman.invalid",
    );
  });

  it("fails with a fixed sentence naming the step, and keeps nothing of git's output", async () => {
    rmSync(remote, { recursive: true, force: true });
    await expect(checkout()).rejects.toThrow(
      `${CHECKOUT_FAILED}: git ls-remote failed`,
    );
  });
});

describe("the builder's checkout (unit: the commands it runs, O-134)", () => {
  const recording = () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "ls-remote" && args[1] === "--symref") {
        return { code: 0, stdout: "ref: refs/heads/main\tHEAD\nabc\tHEAD\n" };
      }
      return { code: 0, stdout: "" };
    };
    return { calls, runner };
  };

  it("runs fixed commands against github.com, with the helper scoped to github.com only", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "foreman-checkout-unit-"));
    mkdirSync(join(workDir, ".git"));
    const { calls, runner } = recording();
    await checkoutRepository({
      workDir,
      repository: REPOSITORY,
      branch: BRANCH,
      role: "designer",
      env: CLEAN_ENV,
      git: runner,
    });
    expect(calls).toContainEqual([
      "remote",
      "add",
      "origin",
      `https://github.com/${REPOSITORY}.git`,
    ]);
    expect(calls).toContainEqual([
      "config",
      "credential.https://github.com.helper",
      CREDENTIAL_HELPER,
    ]);
    expect(calls).toContainEqual(["config", "user.email", "designer@foreman.invalid"]);
    expect(calls.at(-1)).toEqual([
      "checkout",
      "--quiet",
      "-B",
      BRANCH,
      "refs/remotes/origin/main",
    ]);
    expect(existsSync(join(workDir, ".git", "info", "exclude"))).toBe(true);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("refuses a repository or a branch off their patterns before running git", async () => {
    const { calls, runner } = recording();
    const base = {
      workDir: "/nowhere",
      role: "developer" as const,
      env: CLEAN_ENV,
      git: runner,
    };
    await expect(
      checkoutRepository({ ...base, repository: "a b/c", branch: BRANCH }),
    ).rejects.toThrow(`${CHECKOUT_FAILED}: not a repository name`);
    await expect(
      checkoutRepository({ ...base, repository: REPOSITORY, branch: "main; rm -rf /" }),
    ).rejects.toThrow(`${CHECKOUT_FAILED}: not a run branch`);
    expect(calls).toEqual([]);
  });
});
