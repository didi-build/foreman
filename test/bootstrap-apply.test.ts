// Integration: Bootstrap's prepare-to-apply hand-over and the token job's commit and push
// (D-358 lock 1, O-113). The prepare side runs the real init-project (and nodrift init) in one
// throwaway clone and makes the patch exactly as bootstrap.yml does; the token job's scripts
// (.github/scripts/bootstrap-commit.mjs and bootstrap-push.mjs) then run in a second, fresh
// clone. The push goes to a recording git stub or to a local bare repository, never to GitHub;
// the token is made up.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { forbiddenPatchPaths } from "../.github/scripts/bootstrap-commit.mjs";
import { gitPushArgs } from "../.github/scripts/bootstrap-push.mjs";
import {
  FAKE_TOKEN,
  FAKE_TOKEN_BASIC_B64,
  commitAll,
  git,
  hermeticEnv,
  repoRoot,
  runScript,
  tempDir,
} from "./bootstrap-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function dir(prefix: string) {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
}

/** A template repository as GitHub creates it from Launchpad: one commit. */
function templateOrigin() {
  const origin = dir("bootstrap-origin-");
  writeFileSync(
    join(origin, "README.project.md"),
    "# {{PROJECT_NAME}}\n\n{{PROJECT_PURPOSE}}\n",
  );
  writeFileSync(join(origin, "LICENSE.project"), "Copyright {{PROJECT_OWNER}}\n");
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  pkg.launchpadTemplate = true;
  writeFileSync(join(origin, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
  mkdirSync(join(origin, "docs"), { recursive: true });
  writeFileSync(join(origin, "docs/overview.md"), "{{PROJECT_NAME}} overview\n");
  mkdirSync(join(origin, ".github/scripts"), { recursive: true });
  writeFileSync(join(origin, ".github/scripts/keep.mjs"), "export {};\n");
  // Launchpad ships a PR template, so nodrift init adds none under .github/ (as in 0fb8cf5).
  writeFileSync(join(origin, ".github/pull_request_template.md"), "## What changed\n");
  mkdirSync(join(origin, "scripts/lib"), { recursive: true });
  const env = hermeticEnv();
  const sha = commitAll(origin, env);
  return { origin, sha, env };
}

function clone(origin: string, sha: string, prefix: string) {
  const work = dir(prefix);
  const env = hermeticEnv();
  git(work, ["clone", "-q", origin, "."], env);
  git(work, ["checkout", "-q", "--detach", sha], env);
  return { work, env };
}

/**
 * bootstrap.yml's prepare job: the real init-project, then
 * `git add -A` and `git diff --cached --binary --no-renames --no-ext-diff --no-textconv`.
 */
function prepare(origin: string, sha: string, personalData: boolean) {
  const { work, env } = clone(origin, sha, "bootstrap-prepare-");
  symlinkSync(join(repoRoot, "node_modules"), join(work, "node_modules"));
  const init = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/init-project.mjs"),
      "token-isolation-fixture",
      "Token Isolation Fixture",
      "A fixture",
      "Didi Build",
    ],
    {
      cwd: work,
      encoding: "utf8",
      env: { ...env, LAUNCHPAD_COLLECTS_PERSONAL_DATA: String(personalData) },
    },
  );
  expect(init.status, init.stderr).toBe(0);
  git(work, ["add", "-A"], env);
  const patch = spawnSync(
    "git",
    ["diff", "--cached", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv"],
    { cwd: work, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  expect(patch.status).toBe(0);
  const tree = git(work, ["write-tree"], env);
  const patchPath = join(dir("bootstrap-artifact-"), "bootstrap.patch");
  writeFileSync(patchPath, patch.stdout);
  return { patchPath, tree };
}

function commit(work: string, env: NodeJS.ProcessEnv, patchPath: string) {
  return runScript("bootstrap-commit.mjs", [patchPath], { cwd: work, env });
}

describe("the setup patch, applied as data and committed (integration: real git)", () => {
  it("carries init-project's and nodrift init's changes, new dotfiles included, and commits them as github-actions[bot]", () => {
    const { origin, sha } = templateOrigin();
    const { patchPath, tree } = prepare(origin, sha, true);
    const { work, env } = clone(origin, sha, "bootstrap-apply-");

    const result = commit(work, env, patchPath);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output.committed).toBe("true");
    expect(git(work, ["rev-parse", "HEAD^{tree}"], env)).toBe(tree);
    expect(git(work, ["rev-parse", "HEAD^"], env)).toBe(sha);
    expect(git(work, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"], env)).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|" +
        "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|" +
        "chore: initialize project from Launchpad template",
    );
    const files = git(work, ["show", "--name-only", "--format=", "HEAD"], env).split(
      "\n",
    );
    expect(files).toEqual(
      expect.arrayContaining([
        "README.md",
        "README.project.md",
        ".nodrift/manifest.json",
      ]),
    );
    expect(readFileSync(join(work, "README.md"), "utf8")).toContain(
      "Token Isolation Fixture",
    );
    expect(git(work, ["status", "--porcelain"], env)).toBe("");
  });

  it("runs no git hook, from .git/hooks or from core.hooksPath", () => {
    const { origin, sha } = templateOrigin();
    const { patchPath } = prepare(origin, sha, false);
    const { work, env } = clone(origin, sha, "bootstrap-hooks-");
    const marker = join(work, "..", `${work.split("/").pop()}-hook-ran`);
    const hook = `#!/bin/sh\necho ran >> "${marker}"\n`;
    for (const hooksDir of [join(work, ".git/hooks"), join(work, "repo-hooks")]) {
      mkdirSync(hooksDir, { recursive: true });
      for (const name of [
        "pre-commit",
        "commit-msg",
        "post-commit",
        "pre-applypatch",
      ]) {
        writeFileSync(join(hooksDir, name), hook);
        chmodSync(join(hooksDir, name), 0o755);
      }
    }
    git(work, ["config", "core.hooksPath", "repo-hooks"], env);

    const result = commit(work, env, patchPath);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a patch that changes .github/, whatever the case, and commits nothing", () => {
    const { origin, sha } = templateOrigin();
    for (const target of [".github/scripts/keep.mjs", ".GitHub/scripts/new.mjs"]) {
      const { work: maker, env: makerEnv } = clone(origin, sha, "bootstrap-evil-");
      mkdirSync(join(maker, target, ".."), { recursive: true });
      writeFileSync(join(maker, target), "console.log('not reviewed');\n");
      git(maker, ["add", "-A"], makerEnv);
      const patch = spawnSync("git", ["diff", "--cached", "--binary"], {
        cwd: maker,
        env: makerEnv,
        encoding: "buffer",
      });
      const patchPath = join(dir("bootstrap-artifact-"), "bootstrap.patch");
      writeFileSync(patchPath, patch.stdout);

      const { work, env } = clone(origin, sha, "bootstrap-refuse-");
      const result = commit(work, env, patchPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("changes files under .github/");
      expect(result.output.committed).toBeUndefined();
      expect(git(work, ["rev-parse", "HEAD"], env)).toBe(sha);
    }
    expect(
      forbiddenPatchPaths(["README.md", ".github", ".githubx/a", ".github/x"]),
    ).toEqual([".github", ".github/x"]);
  });

  it("commits nothing for an empty patch, and refuses a missing, linked or unappliable one", () => {
    const { origin, sha } = templateOrigin();
    const { work, env } = clone(origin, sha, "bootstrap-edge-");
    const artifact = dir("bootstrap-artifact-");

    const empty = join(artifact, "empty.patch");
    writeFileSync(empty, "");
    const none = commit(work, env, empty);
    expect(none.status).toBe(0);
    expect(none.output.committed).toBe("false");

    expect(commit(work, env, join(artifact, "missing.patch")).status).toBe(1);

    const link = join(artifact, "link.patch");
    symlinkSync(join(repoRoot, "package.json"), link);
    expect(commit(work, env, link).stderr).toContain("not a regular file");

    const bad = join(artifact, "bad.patch");
    writeFileSync(
      bad,
      "diff --git a/missing.txt b/missing.txt\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-a\n+b\n",
    );
    const refused = commit(work, env, bad);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("git apply --check refused");
    expect(git(work, ["rev-parse", "HEAD"], env)).toBe(sha);
  });
});

type GitCall = { argv: string[]; env: Record<string, string | undefined> };

/** A git on PATH that records each call; `push` prints the token (to test redaction) and stops. */
function recordingGit(work: string) {
  const bin = dir("bootstrap-stub-bin-");
  const log = join(bin, "calls.jsonl");
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: process.env }) + "\\n");
if (argv.includes("push")) {
  process.stderr.write("remote said: " + Buffer.from(String(process.env.GIT_CONFIG_VALUE_0 ?? "").replace("AUTHORIZATION: basic ", ""), "base64").toString() + "\\n");
  process.exit(0);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, argv, { stdio: "inherit" }).status ?? 1);
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return {
    path: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    calls: (): GitCall[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as GitCall)
        : [],
    work,
  };
}

const pushEnv = {
  GITHUB_REPOSITORY: "didi-build/token-isolation-fixture",
  DEFAULT_BRANCH: "main",
};

describe("the push with the token (integration: recording git, local bare repository)", () => {
  it("gives the token to git only through GIT_CONFIG_* on the push, never in argv or .git/config", () => {
    const { origin, sha } = templateOrigin();
    const { work, env } = clone(origin, sha, "bootstrap-push-");
    const stub = recordingGit(work);

    const result = runScript("bootstrap-push.mjs", [], {
      cwd: work,
      env: {
        ...env,
        ...pushEnv,
        PATH: stub.path,
        GH_TOKEN: FAKE_TOKEN,
        BOOTSTRAP_TOKEN: FAKE_TOKEN,
        GITHUB_TOKEN: "fake-actions-token",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "inherited",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = stub.calls();
    expect(calls).toHaveLength(1);
    const [push] = calls;
    expect(push.argv).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "https://github.com/didi-build/token-isolation-fixture.git",
      "HEAD:refs/heads/main",
    ]);
    expect(push.argv).toEqual(
      gitPushArgs("didi-build/token-isolation-fixture", "main"),
    );
    for (const arg of push.argv) {
      expect(arg).not.toContain(FAKE_TOKEN);
      expect(arg).not.toContain(FAKE_TOKEN_BASIC_B64);
    }
    expect(push.env.GH_TOKEN).toBeUndefined();
    expect(push.env.BOOTSTRAP_TOKEN).toBeUndefined();
    expect(push.env.GITHUB_TOKEN).toBeUndefined();
    expect(push.env.GIT_CONFIG_COUNT).toBe("1");
    expect(push.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(push.env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${FAKE_TOKEN_BASIC_B64}`,
    );
    expect(push.env.GIT_TERMINAL_PROMPT).toBe("0");
    const configFile = readFileSync(join(work, ".git/config"), "utf8");
    expect(configFile).not.toContain(FAKE_TOKEN);
    expect(configFile).not.toMatch(/extraheader/i);
    // Whatever git prints, the token is not shown.
    expect(result.stderr).toContain("remote said: x-access-token:***");
    expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
  });

  it("refuses a malformed or empty token before git runs, and trims a token with spaces at its ends", () => {
    const { origin, sha } = templateOrigin();
    const { work, env } = clone(origin, sha, "bootstrap-push-token-");
    for (const bad of ["fake\ninner", "fake inner", ""]) {
      const stub = recordingGit(work);
      const result = runScript("bootstrap-push.mjs", [], {
        cwd: work,
        env: { ...env, ...pushEnv, PATH: stub.path, GH_TOKEN: bad },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Malformed BOOTSTRAP_TOKEN");
      expect(stub.calls()).toHaveLength(0);
    }
    const stub = recordingGit(work);
    const trimmed = runScript("bootstrap-push.mjs", [], {
      cwd: work,
      env: { ...env, ...pushEnv, PATH: stub.path, GH_TOKEN: `${FAKE_TOKEN}\n` },
    });
    expect(trimmed.status).toBe(0);
    expect(trimmed.stdout).toContain("::warning title=BOOTSTRAP_TOKEN trimmed");
    expect(stub.calls()[0].env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${FAKE_TOKEN_BASIC_B64}`,
    );
  });

  it("lands the setup commit on main as a fast-forward, and never forces", () => {
    const { origin, sha, env: originEnv } = templateOrigin();
    const bare = dir("bootstrap-remote-");
    git(bare, ["clone", "-q", "--bare", origin, "."], originEnv);
    const { patchPath } = prepare(origin, sha, false);
    const { work, env } = clone(origin, sha, "bootstrap-land-");
    expect(commit(work, env, patchPath).status).toBe(0);
    const setup = git(work, ["rev-parse", "HEAD"], env);
    // Send github.com/didi-build/token-isolation-fixture to the local bare repository instead.
    const config = join(work, "..", `${work.split("/").pop()}-gitconfig`);
    writeFileSync(
      config,
      `[url "file://${bare}"]\n\tinsteadOf = https://github.com/didi-build/token-isolation-fixture.git\n`,
    );
    const landed = runScript("bootstrap-push.mjs", [], {
      cwd: work,
      env: { ...env, ...pushEnv, GIT_CONFIG_GLOBAL: config, GH_TOKEN: FAKE_TOKEN },
    });
    expect(landed.status, landed.stderr).toBe(0);
    expect(git(bare, ["rev-parse", "refs/heads/main"], env)).toBe(setup);

    // main moved on meanwhile: the push is refused rather than forced.
    const { work: other, env: otherEnv } = clone(origin, sha, "bootstrap-other-");
    writeFileSync(join(other, "other.txt"), "other\n");
    commitAll(other, otherEnv, "another commit");
    const raced = runScript("bootstrap-push.mjs", [], {
      cwd: other,
      env: { ...otherEnv, ...pushEnv, GIT_CONFIG_GLOBAL: config, GH_TOKEN: FAKE_TOKEN },
    });
    expect(raced.status).toBe(1);
    expect(git(bare, ["rev-parse", "refs/heads/main"], env)).toBe(setup);
  });
});
