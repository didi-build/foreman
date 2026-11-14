// Seam: the runner's own GitHub client (unit with fakes, D-381, O-127). Fake token ports record
// each mint, and fake HTTP ports record each request and answer with synthetic bodies in GitHub's
// REST shape. Checked: the exact paths, queries and bodies; that each request carries the token
// minted for that call, for exactly its repository and permission; pagination and its bounds;
// 404 as null where the core defines it; refusals before any token or request; malformed
// answers; the merge's answers; the compare's relations; the branch name's encoding; and that no
// error holds a token, a body or a branch name. No network, no real repository or token.
import { describe, expect, it } from "vitest";

import type { PullRequest } from "../../core/github.ts";
import { pullRequestEvent } from "./fake.ts";
import { RunnerMergeTokenError, type RunnerMergeTokens } from "./merge-tokens.ts";
import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";
import { GitHubReadError } from "./runner-app-tokens.ts";
import {
  createRunnerGitHub,
  GitHubMergeError,
  MAX_CHECK_RUN_PAGES,
  MAX_FILE_PAGES,
  MAX_OPEN_PULL_PAGES,
} from "./runner-github.ts";
import type { GitHubWriteHttp, GitHubWriteRequest } from "./write-http.ts";

const REPO = "didi-build/rehearsal";
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const MERGE_COMMIT = "c".repeat(40);
/** GitHub's test merge commit of an open pull request, never a commit on main. */
const TEST_MERGE = "d".repeat(40);
const FORK_BRANCH = "fork-branch-name-never-in-an-error";
const BODY_TEXT = "body-text-never-in-an-error";

type Answer = { status: number; body: unknown };

function fakes(
  answer: (path: string) => Answer = () => ({ status: 500, body: BODY_TEXT }),
  merge: () => Answer = () => ({ status: 500, body: BODY_TEXT }),
) {
  const minted: RunnerAppTokenRequest[] = [];
  const mergeMinted: string[] = [];
  const gets: GitHubGetRequest[] = [];
  const writes: GitHubWriteRequest[] = [];
  const encode = (body: unknown) =>
    new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const tokens: RunnerAppTokens = {
    mint: async (request) => {
      minted.push({ ...request });
      return `test-only-${request.permission}-token-${minted.length}`;
    },
  };
  const mergeTokens: RunnerMergeTokens = {
    mint: async (repository) => {
      mergeMinted.push(repository);
      return `test-only-merge-token-${mergeMinted.length}`;
    },
  };
  const http: GitHubHttp = {
    get: async (request) => {
      gets.push(structuredClone(request));
      const { status, body } = answer(request.path);
      return { status, body: encode(body) };
    },
  };
  const write: GitHubWriteHttp = {
    send: async (request) => {
      writes.push(structuredClone(request));
      const { status, body } = merge();
      return { status, body: encode(body) };
    },
  };
  const github = createRunnerGitHub({ tokens, mergeTokens, http, write });
  return { github, minted, mergeMinted, gets, writes };
}

/** A full pull request in GitHub's shape, with fields the runner never reads. */
const pull = (extra: Record<string, unknown> = {}) => ({
  number: 7,
  state: "open",
  merged: false,
  merged_at: null,
  mergeable: true,
  merge_commit_sha: TEST_MERGE,
  title: BODY_TEXT,
  body: BODY_TEXT,
  user: { login: "foreman-developer[bot]", id: 1 },
  head: { sha: HEAD, ref: "foreman/item-1", repo: { full_name: REPO } },
  base: { sha: BASE, ref: "main", repo: { full_name: REPO } },
  ...extra,
});
/** A pull request as a listing gives it: no `merged` and no `mergeable`. */
const listed = (number: number, extra: Record<string, unknown> = {}) => {
  const raw: Record<string, unknown> = pull({ number });
  delete raw.merged;
  delete raw.mergeable;
  return { ...raw, ...extra };
};
const OPEN: PullRequest = {
  repo: REPO,
  number: 7,
  state: "open",
  merged: false,
  mergeCommitSha: null,
  headSha: HEAD,
  headBranch: "foreman/item-1",
  headRepo: REPO,
  author: "foreman-developer[bot]",
};
const checkRun = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `check-${id}`,
  head_sha: HEAD,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions", id: 15368 },
  output: { title: BODY_TEXT },
  ...extra,
});
const pageOf = <T>(count: number, make: (i: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => make(i));
const pageNumber = (path: string): number => Number(/[?&]page=(\d+)/.exec(path)?.[1]);

async function failure(work: () => Promise<unknown>): Promise<Error> {
  const error = await work().then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error("expected the call to throw");
  return error;
}

describe("the runner's GitHub client: pull requests (unit with fakes, D-381)", () => {
  it("reads a pull request with a pull_requests read token for the one repository", async () => {
    const f = fakes(() => ({ status: 200, body: pull() }));
    expect(await f.github.getPullRequest(REPO, 7)).toEqual(OPEN);
    expect(f.minted).toEqual([{ repository: REPO, permission: "pull_requests" }]);
    expect(f.gets).toEqual([
      {
        path: `/repos/${REPO}/pulls/7`,
        token: "test-only-pull_requests-token-1",
        accept: "json",
        maxBytes: 1024 * 1024,
      },
    ]);
  });

  it("maps GitHub's shape exactly as the fake's payload builder spells it", async () => {
    for (const pr of [
      OPEN,
      { ...OPEN, number: 8, headRepo: "someone/rehearsal", author: "someone" },
      {
        ...OPEN,
        number: 9,
        state: "closed" as const,
        merged: true,
        mergeCommitSha: MERGE_COMMIT,
      },
    ]) {
      const shape = pullRequestEvent("opened", pr).pull_request;
      const f = fakes(() => ({ status: 200, body: shape }));
      expect(await f.github.getPullRequest(REPO, pr.number)).toEqual(pr);
    }
  });

  it("reads the merge commit only once merged, never GitHub's test merge commit", async () => {
    const open = fakes(() => ({ status: 200, body: pull() }));
    expect(await open.github.getPullRequest(REPO, 7)).toMatchObject({
      merged: false,
      mergeCommitSha: null,
    });
    const merged = fakes(() => ({
      status: 200,
      body: pull({ state: "closed", merged: true, merge_commit_sha: MERGE_COMMIT }),
    }));
    expect(await merged.github.getPullRequest(REPO, 7)).toMatchObject({
      state: "closed",
      merged: true,
      mergeCommitSha: MERGE_COMMIT,
    });
    const closed = fakes(() => ({ status: 200, body: pull({ state: "closed" }) }));
    expect(await closed.github.getPullRequest(REPO, 7)).toMatchObject({
      state: "closed",
      merged: false,
      mergeCommitSha: null,
    });
  });

  it("gives a fork whose repository was deleted an empty head repository, never the base", async () => {
    const f = fakes(() => ({
      status: 200,
      body: pull({ head: { sha: HEAD, ref: FORK_BRANCH, repo: null } }),
    }));
    expect(await f.github.getPullRequest(REPO, 7)).toMatchObject({
      headRepo: "",
      headBranch: FORK_BRANCH,
    });
  });

  it("answers null for a pull request GitHub does not have (404)", async () => {
    const f = fakes(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await f.github.getPullRequest(REPO, 7)).toBeNull();
    expect(await f.github.getMergeability(REPO, 7)).toBeNull();
  });

  it("throws on any other status, naming only the status", async () => {
    for (const status of [301, 401, 403, 422, 500, 502]) {
      const f = fakes(() => ({ status, body: BODY_TEXT }));
      const error = await failure(() => f.github.getPullRequest(REPO, 7));
      expect(error).toEqual(
        new GitHubReadError(`reading the pull request failed with ${status}`),
      );
    }
  });

  it("refuses a malformed pull request, or one for another pull request, never guessing a field", async () => {
    const malformed = [
      "not json",
      [],
      null,
      pull({ number: "7" }),
      pull({ state: "draft" }),
      pull({ merged: "false" }),
      pull({ merged: undefined }),
      pull({ state: "closed", merged: "true", merge_commit_sha: MERGE_COMMIT }),
      pull({ merged: true }),
      pull({ state: "closed", merged: true, merge_commit_sha: null }),
      pull({ state: "closed", merged: true, merge_commit_sha: "c".repeat(39) }),
      pull({ user: null }),
      pull({ user: { login: "" } }),
      pull({ head: { sha: HEAD.slice(0, 7), ref: "x", repo: { full_name: REPO } } }),
      pull({ head: { sha: HEAD.toUpperCase(), ref: "x", repo: { full_name: REPO } } }),
      pull({ head: { sha: HEAD, ref: "", repo: { full_name: REPO } } }),
      pull({ head: { sha: HEAD, ref: "x", repo: { full_name: "no slash" } } }),
      pull({ head: { sha: HEAD, ref: "x" } }),
      pull({ base: { ref: "main" } }),
    ];
    for (const body of malformed) {
      const f = fakes(() => ({ status: 200, body }));
      const error = await failure(() => f.github.getPullRequest(REPO, 7));
      expect(error, JSON.stringify(body)).toBeInstanceOf(GitHubReadError);
      expect(error.message).toMatch(
        /^the pull request answer is (not JSON|malformed)$/,
      );
    }
    for (const body of [
      pull({ number: 8 }),
      pull({ base: { ref: "main", repo: { full_name: "didi-build/other" } } }),
    ]) {
      const f = fakes(() => ({ status: 200, body }));
      expect(await failure(() => f.github.getPullRequest(REPO, 7))).toEqual(
        new GitHubReadError("the pull request answer is for another pull request"),
      );
    }
  });

  it("reads the mergeable state and the head it is for, null while GitHub works it out", async () => {
    for (const mergeable of [true, false, null]) {
      const f = fakes(() => ({ status: 200, body: pull({ mergeable }) }));
      expect(await f.github.getMergeability(REPO, 7)).toEqual({
        headSha: HEAD,
        mergeable,
      });
      expect(f.minted).toEqual([{ repository: REPO, permission: "pull_requests" }]);
      expect(f.gets.map((g) => g.path)).toEqual([`/repos/${REPO}/pulls/7`]);
    }
    for (const mergeable of ["true", 1, undefined]) {
      const f = fakes(() => ({ status: 200, body: pull({ mergeable }) }));
      expect(await failure(() => f.github.getMergeability(REPO, 7))).toEqual(
        new GitHubReadError("the pull request answer is malformed"),
      );
    }
  });
});

describe("the runner's GitHub client: listings and their bounds (unit with fakes, D-381)", () => {
  it("lists every changed file page by page with one pull_requests read token, until a short page", async () => {
    const f = fakes((path) => {
      const page = pageNumber(path);
      const count = page < 3 ? 100 : 5;
      return {
        status: 200,
        body: pageOf(count, (i) => ({
          filename: `src/p${page}-${i}.ts`,
          status: "modified",
          patch: BODY_TEXT,
        })),
      };
    });
    const paths = await f.github.listChangedPaths(REPO, 7);
    expect(paths).toHaveLength(205);
    expect(paths.slice(0, 2)).toEqual(["src/p1-0.ts", "src/p1-1.ts"]);
    expect(paths.at(-1)).toBe("src/p3-4.ts");
    expect(f.minted).toEqual([{ repository: REPO, permission: "pull_requests" }]);
    expect(f.gets.map((g) => g.path)).toEqual([
      `/repos/${REPO}/pulls/7/files?per_page=100&page=1`,
      `/repos/${REPO}/pulls/7/files?per_page=100&page=2`,
      `/repos/${REPO}/pulls/7/files?per_page=100&page=3`,
    ]);
    expect(new Set(f.gets.map((g) => g.token))).toEqual(
      new Set(["test-only-pull_requests-token-1"]),
    );
    expect(f.gets.every((g) => g.maxBytes === 16 * 1024 * 1024)).toBe(true);
  });

  it("gives a renamed file's old and new path and a removed file's path, each once", async () => {
    const f = fakes(() => ({
      status: 200,
      body: [
        {
          filename: "src/moved.sql",
          previous_filename: "db/migrations/0001.sql",
          status: "renamed",
        },
        { filename: "db/migrations/0002.sql", status: "removed" },
        { filename: "src/a.ts", status: "modified" },
        { filename: "src/a.ts", status: "modified" },
      ],
    }));
    expect(await f.github.listChangedPaths(REPO, 7)).toEqual([
      "src/moved.sql",
      "db/migrations/0001.sql",
      "db/migrations/0002.sql",
      "src/a.ts",
    ]);
  });

  it("refuses a list that reaches GitHub's 3000-file cap rather than returning part of it", async () => {
    const full = fakes((path) => ({
      status: 200,
      body: pageOf(100, (i) => ({
        filename: `f${pageNumber(path)}-${i}`,
        status: "added",
      })),
    }));
    expect(await failure(() => full.github.listChangedPaths(REPO, 7))).toEqual(
      new GitHubReadError(
        "there are 3000 or more changed files, more than the runner reads, so none are used",
      ),
    );
    // It stops at the cap: no page past GitHub's 3000 files is asked for.
    expect(full.gets).toHaveLength(MAX_FILE_PAGES);
    expect(MAX_FILE_PAGES * 100).toBe(3000);

    const under = fakes((path) => {
      const page = pageNumber(path);
      return {
        status: 200,
        body: pageOf(page < MAX_FILE_PAGES ? 100 : 99, (i) => ({
          filename: `f${page}-${i}`,
          status: "added",
        })),
      };
    });
    expect(await under.github.listChangedPaths(REPO, 7)).toHaveLength(2999);
  });

  it("refuses a malformed file listing whole, never dropping an entry", async () => {
    for (const body of [
      "not json",
      { files: [] },
      [{ filename: "" }],
      [{ filename: "/etc/passwd" }],
      [{ filename: "a\u0000b" }],
      [{ status: "modified" }],
      [{ filename: "src/a.ts" }, { filename: 7 }],
      [{ filename: "src/b.ts", previous_filename: null }],
      pageOf(101, (i) => ({ filename: `f${i}` })),
    ]) {
      const f = fakes(() => ({ status: 200, body }));
      const error = await failure(() => f.github.listChangedPaths(REPO, 7));
      expect(error, JSON.stringify(body).slice(0, 80)).toBeInstanceOf(GitHubReadError);
      expect(error.message).toMatch(
        /^the changed files answer is (not JSON|malformed)$/,
      );
    }
    const f = fakes(() => ({ status: 404, body: BODY_TEXT }));
    expect(await failure(() => f.github.listChangedPaths(REPO, 7))).toEqual(
      new GitHubReadError("listing the changed files failed with 404"),
    );
  });

  it("lists the latest check runs on the commit with one checks read token, page by page", async () => {
    const f = fakes((path) => ({
      status: 200,
      body: {
        total_count: 101,
        check_runs:
          pageNumber(path) === 1
            ? pageOf(100, (i) => checkRun(i + 1))
            : [checkRun(101, { status: "in_progress", conclusion: null, app: null })],
      },
    }));
    const runs = await f.github.listCheckRuns(REPO, HEAD);
    expect(runs).toHaveLength(101);
    expect(runs[0]).toEqual({
      id: 1,
      name: "check-1",
      appSlug: "github-actions",
      status: "completed",
      conclusion: "success",
    });
    expect(runs[100]).toEqual({
      id: 101,
      name: "check-101",
      appSlug: null,
      status: "in_progress",
      conclusion: null,
    });
    expect(f.minted).toEqual([{ repository: REPO, permission: "checks" }]);
    expect(f.gets.map((g) => [g.path, g.token])).toEqual([
      [
        `/repos/${REPO}/commits/${HEAD}/check-runs?filter=latest&per_page=100&page=1`,
        "test-only-checks-token-1",
      ],
      [
        `/repos/${REPO}/commits/${HEAD}/check-runs?filter=latest&per_page=100&page=2`,
        "test-only-checks-token-1",
      ],
    ]);
  });

  it("reads GitHub Actions' waiting, requested and pending runs as not started", async () => {
    const f = fakes(() => ({
      status: 200,
      body: {
        check_runs: ["waiting", "requested", "pending", "queued"].map((status, i) =>
          checkRun(i + 1, { status, conclusion: null }),
        ),
      },
    }));
    expect((await f.github.listCheckRuns(REPO, HEAD)).map((r) => r.status)).toEqual([
      "queued",
      "queued",
      "queued",
      "queued",
    ]);
  });

  it("refuses check runs past its bound, and a malformed run, since the CI result needs every one", async () => {
    let n = 0;
    const full = fakes(() => ({
      status: 200,
      body: { check_runs: pageOf(100, () => checkRun(++n)) },
    }));
    expect(await failure(() => full.github.listCheckRuns(REPO, HEAD))).toEqual(
      new GitHubReadError(
        "there are 1000 or more check runs, more than the runner reads, so none are used",
      ),
    );
    expect(full.gets).toHaveLength(MAX_CHECK_RUN_PAGES);
    for (const body of [
      "not json",
      [checkRun(1)],
      { check_runs: null },
      { check_runs: [checkRun(1, { id: "1" })] },
      { check_runs: [checkRun(1, { id: 0 })] },
      { check_runs: [checkRun(1, { name: "" })] },
      { check_runs: [checkRun(1, { status: "done" })] },
      { check_runs: [checkRun(1, { status: "constructor" })] },
      { check_runs: [checkRun(1, { conclusion: "Success" })] },
      { check_runs: [checkRun(1, { conclusion: undefined })] },
      { check_runs: [checkRun(1, { app: { slug: "" } })] },
      { check_runs: [checkRun(1, { app: undefined })] },
    ]) {
      const f = fakes(() => ({ status: 200, body }));
      const error = await failure(() => f.github.listCheckRuns(REPO, HEAD));
      expect(error, JSON.stringify(body).slice(0, 80)).toBeInstanceOf(GitHubReadError);
      expect(error.message).toMatch(/^the check runs answer is (not JSON|malformed)$/);
    }
  });

  it("lists the open pull requests page by page with one pull_requests read token", async () => {
    const f = fakes((path) => ({
      status: 200,
      body:
        pageNumber(path) === 1
          ? pageOf(100, (i) => listed(i + 1))
          : [listed(101, { head: { sha: HEAD, ref: FORK_BRANCH, repo: null } })],
    }));
    const open = await f.github.listOpenPullRequests(REPO);
    expect(open).toHaveLength(101);
    expect(open[0]).toEqual({ ...OPEN, number: 1 });
    expect(open[100]).toEqual({
      ...OPEN,
      number: 101,
      headBranch: FORK_BRANCH,
      headRepo: "",
    });
    expect(f.minted).toEqual([{ repository: REPO, permission: "pull_requests" }]);
    expect(f.gets.map((g) => [g.path, g.token])).toEqual([
      [
        `/repos/${REPO}/pulls?state=open&per_page=100&page=1`,
        "test-only-pull_requests-token-1",
      ],
      [
        `/repos/${REPO}/pulls?state=open&per_page=100&page=2`,
        "test-only-pull_requests-token-1",
      ],
    ]);
  });

  it("refuses open pull requests past its bound, one not open or of another repository, and a malformed one", async () => {
    let n = 0;
    const full = fakes(() => ({ status: 200, body: pageOf(100, () => listed(++n)) }));
    expect(await failure(() => full.github.listOpenPullRequests(REPO))).toEqual(
      new GitHubReadError(
        "there are 1000 or more open pull requests, more than the runner reads, so none are used",
      ),
    );
    expect(full.gets).toHaveLength(MAX_OPEN_PULL_PAGES);
    for (const extra of [
      { state: "closed" },
      { base: { ref: "main", repo: { full_name: "didi-build/other" } } },
    ]) {
      const f = fakes(() => ({ status: 200, body: [listed(1), listed(2, extra)] }));
      expect(await failure(() => f.github.listOpenPullRequests(REPO))).toEqual(
        new GitHubReadError(
          "the open pull requests answer holds a pull request that is not open in this repository",
        ),
      );
    }
    for (const body of [
      "not json",
      { pulls: [] },
      [listed(1, { merged_at: 7 })],
      [listed(1, { merged_at: "2026-11-13T09:00:00Z" })],
      [listed(1, { user: {} })],
    ]) {
      const f = fakes(() => ({ status: 200, body }));
      const error = await failure(() => f.github.listOpenPullRequests(REPO));
      expect(error, JSON.stringify(body).slice(0, 80)).toBeInstanceOf(GitHubReadError);
      expect(error.message).toMatch(
        /^the open pull requests answer is (not JSON|malformed)$/,
      );
    }
  });

  it("reads CI's workflow runs with the actions read token of the workflow reads (D-354)", async () => {
    const f = fakes(() => ({ status: 200, body: { workflow_runs: [] } }));
    expect(await f.github.listWorkflowRuns(REPO, "ci.yml", HEAD)).toEqual([]);
    expect(f.minted).toEqual([{ repository: REPO, permission: "actions" }]);
  });
});

describe("the runner's GitHub client: the squash merge (unit with fakes, D-381, D-365)", () => {
  it("merges with exactly squash and the expected head, with the merge token for the one repository", async () => {
    const f = fakes(undefined, () => ({
      status: 200,
      body: { sha: MERGE_COMMIT, merged: true, message: BODY_TEXT },
    }));
    expect(await f.github.squashMerge(REPO, 7, HEAD)).toEqual({
      merged: true,
      mergeCommitSha: MERGE_COMMIT,
    });
    expect(f.mergeMinted).toEqual([REPO]);
    // No read token is minted for the merge, and nothing is read.
    expect([f.minted, f.gets]).toEqual([[], []]);
    expect(f.writes).toHaveLength(1);
    const [request] = f.writes as [GitHubWriteRequest];
    expect(request).toEqual({
      method: "PUT",
      path: `/repos/${REPO}/pulls/7/merge`,
      token: "test-only-merge-token-1",
      body: { merge_method: "squash", sha: HEAD },
      maxBytes: 64 * 1024,
    });
    expect(JSON.stringify(request.body)).toBe(
      `{"merge_method":"squash","sha":"${HEAD}"}`,
    );
  });

  it("answers 409 as a head that moved and 405 as a pull request GitHub cannot merge", async () => {
    const moved = fakes(undefined, () => ({
      status: 409,
      body: { message: BODY_TEXT },
    }));
    expect(await moved.github.squashMerge(REPO, 7, HEAD)).toEqual({
      merged: false,
      reason: "head_changed",
    });
    const blocked = fakes(undefined, () => ({
      status: 405,
      body: { message: BODY_TEXT },
    }));
    expect(await blocked.github.squashMerge(REPO, 7, HEAD)).toEqual({
      merged: false,
      reason: "not_mergeable",
    });
    expect([moved.writes.length, blocked.writes.length]).toEqual([1, 1]);
  });

  it("throws on any other answer after one request, and never tries again", async () => {
    for (const status of [201, 204, 401, 403, 404, 422, 500]) {
      const f = fakes(undefined, () => ({ status, body: { message: BODY_TEXT } }));
      expect(await failure(() => f.github.squashMerge(REPO, 7, HEAD))).toEqual(
        new GitHubMergeError(`merging the pull request failed with ${status}`),
      );
      expect(f.writes).toHaveLength(1);
    }
    for (const [body, message] of [
      ["not json", "the merge answer is not JSON"],
      [{ sha: MERGE_COMMIT, merged: false }, "the merge answer is malformed"],
      [{ sha: MERGE_COMMIT }, "the merge answer is malformed"],
      [{ sha: "c".repeat(39), merged: true }, "the merge answer is malformed"],
      [{ merged: true }, "the merge answer is malformed"],
      [[], "the merge answer is malformed"],
    ] as const) {
      const f = fakes(undefined, () => ({ status: 200, body }));
      expect(await failure(() => f.github.squashMerge(REPO, 7, HEAD))).toEqual(
        new GitHubMergeError(message),
      );
      expect(f.writes).toHaveLength(1);
    }
  });

  it("refuses a bad repository, number or head before any token is minted", async () => {
    for (const [repo, number, sha, message] of [
      ["octo-org/rehearsal", 7, HEAD, "not a repository of didi-build"],
      ["didi-build/../x", 7, HEAD, "not a repository of didi-build"],
      [REPO, 0, HEAD, "not a pull request number"],
      [REPO, 7.5, HEAD, "not a pull request number"],
      [REPO, 7, HEAD.slice(0, 12), "a commit must be a full 40-character sha"],
      [REPO, 7, `${HEAD.slice(0, 39)}/`, "a commit must be a full 40-character sha"],
    ] as const) {
      const f = fakes();
      expect(await failure(() => f.github.squashMerge(repo, number, sha))).toEqual(
        new GitHubMergeError(message),
      );
      expect([f.mergeMinted, f.writes]).toEqual([[], []]);
    }
  });

  it("passes on the merge token's own refusal, sending nothing", async () => {
    const sent: GitHubWriteRequest[] = [];
    const refusing = createRunnerGitHub({
      tokens: { mint: async () => "unused" },
      mergeTokens: {
        mint: async () => {
          throw new RunnerMergeTokenError(
            "GitHub refused the runner App's merge token with 403",
          );
        },
      },
      http: { get: async () => ({ status: 500, body: new Uint8Array() }) },
      write: {
        send: async (request) => {
          sent.push(request);
          return { status: 200, body: new Uint8Array() };
        },
      },
    });
    await expect(refusing.squashMerge(REPO, 7, HEAD)).rejects.toThrow(
      RunnerMergeTokenError,
    );
    expect(sent).toEqual([]);
  });
});

describe("the runner's GitHub client: commits and branches (unit with fakes, D-381, D-225)", () => {
  it.each(["ahead", "identical", "behind", "diverged"] as const)(
    "reads a compare whose status is %s, with one contents read token",
    async (status) => {
      const f = fakes(() => ({
        status: 200,
        body: { status, ahead_by: 1, behind_by: 0, files: [{ patch: BODY_TEXT }] },
      }));
      expect(await f.github.compareCommits(REPO, BASE, HEAD)).toBe(status);
      expect(f.minted).toEqual([{ repository: REPO, permission: "contents" }]);
      expect(f.gets).toEqual([
        {
          path: `/repos/${REPO}/compare/${BASE}...${HEAD}?per_page=1`,
          token: "test-only-contents-token-1",
          accept: "json",
          maxBytes: 16 * 1024 * 1024,
        },
      ]);
    },
  );

  it("refuses a compare with another status, no status or a failed answer", async () => {
    for (const body of [
      { status: "Ahead" },
      { status: "unknown" },
      {},
      [],
      "not json",
    ]) {
      const f = fakes(() => ({ status: 200, body }));
      const error = await failure(() => f.github.compareCommits(REPO, BASE, HEAD));
      expect(error.message).toMatch(
        /^the compare answer (is not JSON|has no relation the runner reads)$/,
      );
    }
    for (const status of [404, 500]) {
      const f = fakes(() => ({ status, body: BODY_TEXT }));
      expect(await failure(() => f.github.compareCommits(REPO, BASE, HEAD))).toEqual(
        new GitHubReadError(`comparing the commits failed with ${status}`),
      );
    }
  });

  it("lists the paths a compare changed, renames' old paths too, from the same call (D-388)", async () => {
    const f = fakes(() => ({
      status: 200,
      body: {
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
        files: [
          {
            filename: ".github/workflows/ci.yml",
            status: "modified",
            patch: BODY_TEXT,
          },
          {
            filename: "docs/new.md",
            previous_filename: "docs/old.md",
            status: "renamed",
          },
          { filename: ".github/workflows/ci.yml", status: "modified" },
        ],
      },
    }));
    expect(await f.github.listComparedPaths(REPO, BASE, HEAD)).toEqual({
      relation: "ahead",
      paths: [".github/workflows/ci.yml", "docs/new.md", "docs/old.md"],
      complete: true,
    });
    expect(f.minted).toEqual([{ repository: REPO, permission: "contents" }]);
    expect(f.gets.map((g) => g.path)).toEqual([
      `/repos/${REPO}/compare/${BASE}...${HEAD}?per_page=1`,
    ]);
  });

  it("reports a compare that lists 300 files as possibly cut, never as complete", async () => {
    const files = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts` }));
    for (const [n, complete] of [
      [299, true],
      [300, false],
    ] as const) {
      const f = fakes(() => ({
        status: 200,
        body: { status: "ahead", files: files(n) },
      }));
      const listed = await f.github.listComparedPaths(REPO, BASE, HEAD);
      expect([listed.paths.length, listed.complete]).toEqual([n, complete]);
    }
  });

  it("refuses a compare with no files list, a file it cannot read or a failed answer", async () => {
    for (const body of [
      { status: "ahead" },
      { status: "ahead", files: {} },
      { status: "ahead", files: [{ status: "added" }] },
      { status: "ahead", files: [{ filename: "a.ts", previous_filename: 7 }] },
      { files: [] },
    ]) {
      const f = fakes(() => ({ status: 200, body }));
      const error = await failure(() => f.github.listComparedPaths(REPO, BASE, HEAD));
      expect(error.message).toMatch(
        /^the (compare answer has no (files|relation) the runner reads|changed files answer is malformed)$/,
      );
    }
    const f = fakes(() => ({ status: 500, body: BODY_TEXT }));
    expect(await failure(() => f.github.listComparedPaths(REPO, BASE, HEAD))).toEqual(
      new GitHubReadError("comparing the commits failed with 500"),
    );
  });

  it("reads a branch's head with one contents read token, the name encoded, and null when there is none", async () => {
    for (const [branch, encoded] of [
      ["main", "main"],
      ["release/2026-11", "release%2F2026-11"],
      ["foreman/0b6c2f6e-1d2a", "foreman%2F0b6c2f6e-1d2a"],
    ] as const) {
      const f = fakes(() => ({
        status: 200,
        body: { name: branch, commit: { sha: HEAD, url: BODY_TEXT }, protected: true },
      }));
      expect(await f.github.getBranchHead(REPO, branch)).toBe(HEAD);
      expect(f.minted).toEqual([{ repository: REPO, permission: "contents" }]);
      expect(f.gets.map((g) => [g.path, g.token, g.maxBytes])).toEqual([
        [
          `/repos/${REPO}/branches/${encoded}`,
          "test-only-contents-token-1",
          1024 * 1024,
        ],
      ]);
    }
    const missing = fakes(() => ({
      status: 404,
      body: { message: "Branch not found" },
    }));
    expect(await missing.github.getBranchHead(REPO, "main")).toBeNull();
  });

  it("refuses a branch answer for another branch, a malformed one, and another status", async () => {
    for (const [body, message] of [
      [
        { name: "master", commit: { sha: HEAD } },
        "the branch answer is for another branch",
      ],
      [
        { name: "main", commit: { sha: "b".repeat(39) } },
        "the branch answer is malformed",
      ],
      [{ name: "main" }, "the branch answer is malformed"],
      ["not json", "the branch answer is not JSON"],
    ] as const) {
      const f = fakes(() => ({ status: 200, body }));
      expect(await failure(() => f.github.getBranchHead(REPO, "main"))).toEqual(
        new GitHubReadError(message),
      );
    }
    const f = fakes(() => ({ status: 500, body: BODY_TEXT }));
    expect(await failure(() => f.github.getBranchHead(REPO, "main"))).toEqual(
      new GitHubReadError("reading the branch failed with 500"),
    );
  });

  it("refuses a branch name it does not read before any token is minted, never naming it", async () => {
    for (const branch of [
      "",
      ".",
      "..",
      "a/../b",
      "a..b",
      "/main",
      "main/",
      "a//b",
      ".hidden",
      "a/.hidden",
      "x.lock",
      "-main",
      "a b",
      "a?b",
      "a#b",
      "%2e%2e",
      "a\\b",
      "x".repeat(256),
    ]) {
      const f = fakes();
      const error = await failure(() => f.github.getBranchHead(REPO, branch));
      expect(error, branch).toEqual(
        new GitHubReadError("not a branch name the runner reads"),
      );
      expect([f.minted, f.gets]).toEqual([[], []]);
    }
  });
});

describe("the runner's GitHub client: refusals and errors (unit with fakes, D-381)", () => {
  const calls = (repo: string, f: ReturnType<typeof fakes>) => [
    () => f.github.getPullRequest(repo, 7),
    () => f.github.listChangedPaths(repo, 7),
    () => f.github.listCheckRuns(repo, HEAD),
    () => f.github.listOpenPullRequests(repo),
    () => f.github.getMergeability(repo, 7),
    () => f.github.compareCommits(repo, BASE, HEAD),
    () => f.github.listComparedPaths(repo, BASE, HEAD),
    () => f.github.getBranchHead(repo, "main"),
  ];

  it("refuses a repository outside didi-build before any token is minted or request sent", async () => {
    for (const repo of [
      "octo-org/rehearsal",
      "didi-build",
      "didi-build/",
      "didi-build/a/b",
      "didi-build/..",
      "Didi-Build/rehearsal",
      "didi-build/rehearsal?x=1",
      "didi-build/rehearsal#x",
    ]) {
      const f = fakes();
      for (const call of calls(repo, f)) {
        expect(await failure(call), repo).toEqual(
          new GitHubReadError("not a repository of didi-build"),
        );
      }
      expect([f.minted, f.gets, f.writes]).toEqual([[], [], []]);
    }
  });

  it("refuses a pull request number or commit it does not read before any token is minted", async () => {
    const f = fakes();
    for (const [call, message] of [
      [() => f.github.getPullRequest(REPO, 0), "not a pull request number"],
      [() => f.github.getMergeability(REPO, -1), "not a pull request number"],
      [() => f.github.listChangedPaths(REPO, Number.NaN), "not a pull request number"],
      [
        () => f.github.listCheckRuns(REPO, "main"),
        "a commit must be a full 40-character sha",
      ],
      [
        () => f.github.compareCommits(REPO, "HEAD~1", HEAD),
        "a commit must be a full 40-character sha",
      ],
      [
        () => f.github.compareCommits(REPO, BASE, `${HEAD}/..`),
        "a commit must be a full 40-character sha",
      ],
    ] as const) {
      expect(await failure(call)).toEqual(new GitHubReadError(message));
    }
    expect([f.minted, f.gets]).toEqual([[], []]);
  });

  it("never names a token, a body or a fork's branch in an error", async () => {
    const answers: Answer[] = [
      { status: 500, body: BODY_TEXT },
      { status: 200, body: BODY_TEXT },
      { status: 200, body: { message: BODY_TEXT, head: { ref: FORK_BRANCH } } },
      { status: 200, body: pull({ head: { sha: "x", ref: FORK_BRANCH, repo: null } }) },
      { status: 200, body: [{ filename: BODY_TEXT, previous_filename: 7 }] },
      { status: 200, body: { check_runs: [checkRun(1, { status: BODY_TEXT })] } },
      { status: 200, body: { status: BODY_TEXT } },
      { status: 200, body: { name: FORK_BRANCH, commit: { sha: HEAD } } },
    ];
    for (const answer of answers) {
      const f = fakes(
        () => answer,
        () => answer,
      );
      const errors = [...calls(REPO, f), () => f.github.squashMerge(REPO, 7, HEAD)];
      for (const call of errors) {
        const error = await call().then(
          () => null,
          (e: unknown) => e as Error,
        );
        if (error === null) continue;
        expect(error.message).not.toContain(BODY_TEXT);
        expect(error.message).not.toContain(FORK_BRANCH);
        expect(error.message).not.toContain("test-only");
        expect(error.message).not.toMatch(/token-\d/);
      }
    }
  });
});
