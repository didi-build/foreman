// Integration: Bootstrap's decide step, `.github/scripts/bootstrap-plan.mjs` (D-358 lock 1,
// O-113), run with node as the workflow runs it, in a throwaway git repository, against a fake
// GitHub API (no network). It decides whether the repository still needs setting up, from the
// template files and from GitHub's protection flag on the default branch.
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readBranchProtected } from "../.github/scripts/bootstrap-plan.mjs";
import {
  commitAll,
  fakeFetch,
  fakeGithubEnv,
  hermeticEnv,
  repoRoot,
  runScript,
  tempDir,
  type GithubAnswer,
} from "./bootstrap-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});

type Seed = "template" | "initialized" | "foreman";

function seed(kind: Seed) {
  const dir = tempDir("bootstrap-plan-");
  dirs.push(dir);
  if (kind === "foreman") {
    // Foreman's own repository shape: its real package.json, no README.project.md.
    copyFileSync(join(repoRoot, "package.json"), join(dir, "package.json"));
    writeFileSync(join(dir, "README.md"), "# Foreman\n");
  } else {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "launchpad", launchpadTemplate: true }, null, 2)}\n`,
    );
    if (kind === "template")
      writeFileSync(join(dir, "README.project.md"), "# template\n");
  }
  const env = hermeticEnv();
  const sha = commitAll(dir, env);
  return { dir, sha };
}

const BRANCH_PATH = "GET /repos/didi-build/my-repo/branches/main";
const unprotected: Record<string, GithubAnswer> = {
  [BRANCH_PATH]: { status: 200, body: { name: "main", protected: false } },
};
const protectedBranch: Record<string, GithubAnswer> = {
  [BRANCH_PATH]: { status: 200, body: { name: "main", protected: true } },
};
const description = "Example repository for bootstrap tests";
const didiBuild = {
  GITHUB_REPOSITORY: "didi-build/my-repo",
  GITHUB_REPOSITORY_OWNER: "didi-build",
  DEFAULT_BRANCH: "main",
  GITHUB_TOKEN: "fake-actions-read-token",
};

function plan(kind: Seed, env: Record<string, string>, answers = unprotected) {
  const { dir, sha } = seed(kind);
  const github = fakeGithubEnv(dir, answers);
  const result = runScript("bootstrap-plan.mjs", [], {
    cwd: dir,
    env: hermeticEnv({ ...github.env, ...env }),
  });
  return { ...result, sha, requests: github.requests() };
}

type Case = {
  name: string;
  seed: Seed;
  env: Record<string, string>;
  answers?: Record<string, GithubAnswer>;
  status: number;
  output: Record<string, string>;
  says?: string;
  requests?: number;
};

const cases: Case[] = [
  {
    name: "a template repository on its first push, with the token: init and settings",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
    },
    status: 0,
    output: {
      init: "true",
      settings: "true",
      execute: "true",
      slug: "my-repo",
      display_name: "My Repo",
      purpose: description,
      owner: "Didi Build",
      personal_data: "true",
    },
    requests: 1,
  },
  {
    name: "personal data off when the variable says false",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
      LAUNCHPAD_COLLECTS_PERSONAL_DATA: "false",
    },
    status: 0,
    output: { execute: "true", init: "true", personal_data: "false" },
  },
  {
    name: "an invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA fails before anything",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
      LAUNCHPAD_COLLECTS_PERSONAL_DATA: "maybe",
    },
    status: 1,
    output: {},
    says: "Invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA",
    requests: 0,
  },
  {
    name: "didi-build without the token fails",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "false",
      LAUNCHPAD_REPO_DESCRIPTION: "",
    },
    status: 1,
    output: { token_policy: "fail", execute: "false" },
    says: "BOOTSTRAP_TOKEN is required for didi-build",
  },
  {
    name: "init with an empty repository description fails",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: "   ",
    },
    status: 1,
    output: {},
    says: "This repository has no description",
  },
  {
    name: "another owner without the token warns and skips with the manual fallback",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "acme-corp/my-repo",
      GITHUB_REPOSITORY_OWNER: "acme-corp",
      DEFAULT_BRANCH: "main",
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "false",
      LAUNCHPAD_REPO_DESCRIPTION: "",
    },
    answers: {
      "GET /repos/acme-corp/my-repo/branches/main": {
        status: 200,
        body: { protected: false },
      },
    },
    status: 0,
    output: { token_policy: "warn-skip", execute: "false" },
    says: "Bootstrap skipped: no BOOTSTRAP_TOKEN repository secret",
  },
  {
    name: "a set-up repository with the template files put back does nothing, and warns",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
    },
    answers: protectedBranch,
    status: 0,
    output: { init: "false", settings: "false", execute: "false" },
    says: "Template files on a set-up repository",
  },
  {
    name: "a template repository whose protection cannot be read fails closed",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
    },
    answers: { [BRANCH_PATH]: { status: 403, body: { message: "Forbidden" } } },
    status: 1,
    output: { execute: "false" },
    says: "Could not read whether main is protected",
  },
  {
    name: "no answer from GitHub fails closed",
    seed: "template",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
    },
    answers: { [BRANCH_PATH]: { noAnswer: true } },
    status: 1,
    output: { execute: "false" },
    says: "answered nothing",
  },
  {
    name: "an initialized repository's push does nothing and asks GitHub nothing",
    seed: "initialized",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    status: 0,
    output: {
      init: "false",
      settings: "false",
      needs_token: "false",
      execute: "false",
    },
    says: "already initialized, nothing to do",
    requests: 0,
  },
  {
    name: "Run workflow on an initialized repository not yet protected: settings only",
    seed: "initialized",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    status: 0,
    output: { init: "false", settings: "true", execute: "true" },
  },
  {
    name: "Re-run jobs on an initialized repository not yet protected: settings only",
    seed: "initialized",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "2",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    status: 0,
    output: { settings: "true", execute: "true" },
  },
  {
    name: "Run workflow on a protected repository does nothing",
    seed: "initialized",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    answers: protectedBranch,
    status: 0,
    output: { init: "false", settings: "false", execute: "false" },
    says: "already protected",
  },
  {
    name: "Run workflow without the token on a protected repository does nothing (no failure)",
    seed: "initialized",
    env: {
      ...didiBuild,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      HAS_BOOTSTRAP_TOKEN: "false",
    },
    answers: protectedBranch,
    status: 0,
    output: { execute: "false" },
  },
  {
    name: "Foreman's own push to main stays a no-op, with no request to GitHub",
    seed: "foreman",
    env: {
      GITHUB_REPOSITORY: "didi-build/foreman",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      DEFAULT_BRANCH: "main",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    status: 0,
    output: { init: "false", settings: "false", execute: "false" },
    requests: 0,
  },
  {
    name: "Foreman's Run workflow and Re-run jobs do nothing: its main is protected",
    seed: "foreman",
    env: {
      GITHUB_REPOSITORY: "didi-build/foreman",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      DEFAULT_BRANCH: "main",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "2",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    answers: {
      "GET /repos/didi-build/foreman/branches/main": {
        status: 200,
        body: { protected: true },
      },
    },
    status: 0,
    output: { init: "false", settings: "false", execute: "false" },
    requests: 1,
  },
];

describe("bootstrap decide step (integration: fake GitHub, throwaway repository)", () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = plan(c.seed, c.env, c.answers);
      expect(result.status, result.stderr).toBe(c.status);
      for (const [key, value] of Object.entries(c.output)) {
        expect(result.output[key], `GITHUB_OUTPUT ${key}`).toBe(value);
      }
      if (Object.keys(c.output).length === 0) expect(result.output).toEqual({});
      if (c.says) expect(result.stdout + result.stderr).toContain(c.says);
      if (c.requests !== undefined) expect(result.requests).toHaveLength(c.requests);
      if (result.output.execute === "true") {
        expect(result.output.sha).toBe(result.sha);
      } else {
        expect(result.output.sha).toBeUndefined();
      }
    });
  }

  it("asks GitHub one read-only question with the workflow's token, following no redirect", () => {
    const result = plan("template", {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
    });
    expect(result.requests).toHaveLength(1);
    const [request] = result.requests;
    expect(request.key).toBe(BRANCH_PATH);
    expect(request.url).toBe(
      "https://api.github.com/repos/didi-build/my-repo/branches/main",
    );
    expect(request.headers.authorization).toBe("Bearer fake-actions-read-token");
    expect(request.redirect).toBe("error");
    expect(result.summary).toContain("| Default branch protected | false |");
  });

  it("refuses to decide without a valid repository or default branch", () => {
    const result = plan("template", {
      ...didiBuild,
      DEFAULT_BRANCH: "../main",
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: description,
    });
    expect(result.status).toBe(1);
    expect(result.output.execute).toBe("false");
    expect(result.requests).toHaveLength(0);
  });

  it("passes a description with a line break through the delimiter form", () => {
    const result = plan("template", {
      ...didiBuild,
      GITHUB_EVENT_NAME: "push",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: "first line\nsecond=line",
    });
    expect(result.status).toBe(0);
    expect(result.output.purpose).toBe("first line\nsecond=line");
  });
});

describe("readBranchProtected (unit: fake fetch)", () => {
  const client = (fetchImpl: typeof fetch) => ({
    fetch: fetchImpl,
    apiUrl: "https://api.github.com",
    token: "",
  });

  it("reads only a boolean protected field from a 200 answer", async () => {
    for (const [answer, expected] of [
      [
        { status: 200, body: { protected: true } },
        { ok: true, protected: true },
      ],
      [
        { status: 200, body: { protected: false } },
        { ok: true, protected: false },
      ],
      [
        { status: 200, body: { protected: "yes" } },
        { ok: false, status: 200 },
      ],
      [
        { status: 200, body: {} },
        { ok: false, status: 200 },
      ],
      [
        { status: 404, body: { protected: false } },
        { ok: false, status: 404 },
      ],
      [{ noAnswer: true }, { ok: false, status: 0 }],
    ] as const) {
      const { fetchImpl, requests } = fakeFetch({
        "GET /repos/o/r/branches/main": answer,
      });
      expect(await readBranchProtected(client(fetchImpl), "o/r", "main")).toEqual(
        expected,
      );
      expect(requests[0].headers.authorization).toBeUndefined();
    }
  });
});
