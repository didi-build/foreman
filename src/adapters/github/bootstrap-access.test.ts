// Seam: the ports for BOOTSTRAP_TOKEN's access on GitHub's REST API (unit with fakes, D-358,
// O-114). Fake token ports and fake HTTP ports stand in for the runner App and GitHub; the answers
// are synthetic JSON made here. The exact URLs, methods and bodies of the grant, the removal, the
// list, the restart and the read of Bootstrap's newest restarted run, which token each one uses,
// and how each answer is read: done, not shared with selected repositories, refused, or failed.
// No network, no real repository, id or token.
import { describe, expect, it } from "vitest";

import {
  createGitHubBootstrapAccess,
  createGitHubBootstrapRuns,
  newestRunOf,
} from "./bootstrap-access.ts";
import type { BootstrapTokens } from "./bootstrap-tokens.ts";
import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import type {
  GitHubGetRequest,
  GitHubGetResponse,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";
import type { GitHubWriteHttp, GitHubWriteRequest } from "./write-http.ts";

const CHANGE_TOKEN = "fake-change-token-not-real";
const LIST_TOKEN = "fake-list-token-not-real";
const RESTART_TOKEN = "fake-restart-token-not-real";
const READ_TOKEN = "fake-read-token-not-real";
/** A synthetic repository id, made up for the test. */
const REPO_ID = 1234567;
const SECRET_PATH = "/orgs/didi-build/actions/secrets/BOOTSTRAP_TOKEN/repositories";

const encode = (body: unknown) =>
  new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));

function fakes(
  options: {
    refuseMint?: boolean;
    gets?: GitHubGetResponse[];
    writeStatus?: number;
    writeThrows?: boolean;
    postStatus?: number;
  } = {},
) {
  const mints: string[] = [];
  const readMints: RunnerAppTokenRequest[] = [];
  const gets: GitHubGetRequest[] = [];
  const writes: GitHubWriteRequest[] = [];
  const posts: GitHubPostRequest[] = [];
  const answers = [...(options.gets ?? [])];
  const mint = (kind: string, token: string) => async (name?: string) => {
    mints.push(name === undefined ? kind : `${kind} ${name}`);
    if (options.refuseMint) throw new Error("GitHub refused the token");
    return token;
  };
  const tokens: BootstrapTokens = {
    secretsChange: mint("secretsChange", CHANGE_TOKEN),
    secretsList: mint("secretsList", LIST_TOKEN),
    restart: mint("restart", RESTART_TOKEN),
  };
  const readTokens: RunnerAppTokens = {
    async mint(request) {
      readMints.push(request);
      return READ_TOKEN;
    },
  };
  const http = {
    async get(request: GitHubGetRequest) {
      gets.push(request);
      return answers.shift() ?? { status: 500, body: encode("") };
    },
  };
  const write: GitHubWriteHttp = {
    async send(request) {
      writes.push(request);
      if (options.writeThrows) throw new Error("the connection dropped");
      return { status: options.writeStatus ?? 204, body: encode("") };
    },
  };
  const post: GitHubPostHttp = {
    async post(request) {
      posts.push(structuredClone(request));
      return { status: options.postStatus ?? 204, body: encode("") };
    },
  };
  return {
    access: createGitHubBootstrapAccess({ tokens, http, write }),
    runs: createGitHubBootstrapRuns({ tokens, readTokens, http, post }),
    mints,
    readMints,
    gets,
    writes,
    posts,
  };
}

const repositoryAnswer = (extra: Record<string, unknown> = {}): GitHubGetResponse => ({
  status: 200,
  body: encode({ id: REPO_ID, full_name: "didi-build/garden-notes", ...extra }),
});

describe("the grant and the removal (unit with fakes, O-114)", () => {
  it.each([
    ["grant", "PUT"],
    ["remove", "DELETE"],
  ] as const)(
    "%s reads the repository's id, then sends %s for that id, with one change token",
    async (method, verb) => {
      const f = fakes({ gets: [repositoryAnswer()] });
      expect(await f.access[method]("garden-notes")).toEqual({ kind: "done" });
      expect(f.mints).toEqual(["secretsChange garden-notes"]);
      expect(f.gets).toEqual([
        {
          path: "/repos/didi-build/garden-notes",
          token: CHANGE_TOKEN,
          accept: "json",
          maxBytes: 4 * 1024 * 1024,
        },
      ]);
      expect(f.writes).toEqual([
        {
          method: verb,
          path: `${SECRET_PATH}/${REPO_ID}`,
          token: CHANGE_TOKEN,
          maxBytes: 4 * 1024 * 1024,
        },
      ]);
    },
  );

  it("answers not shared with selected repositories on 409, and refused on any other status", async () => {
    const conflict = fakes({ gets: [repositoryAnswer()], writeStatus: 409 });
    expect(await conflict.access.grant("garden-notes")).toEqual({
      kind: "refused",
      step: "not_selected",
    });
    for (const status of [200, 201, 403, 404, 422, 500]) {
      const f = fakes({ gets: [repositoryAnswer()], writeStatus: status });
      expect(await f.access.remove("garden-notes"), String(status)).toEqual({
        kind: "refused",
        step: "call",
      });
      expect(f.writes).toHaveLength(1);
    }
    const dropped = fakes({ gets: [repositoryAnswer()], writeThrows: true });
    expect(await dropped.access.grant("garden-notes")).toEqual({
      kind: "refused",
      step: "call",
    });
  });

  it("refuses at the token, sending nothing, and never asks again", async () => {
    const f = fakes({ refuseMint: true, gets: [repositoryAnswer()] });
    expect(await f.access.grant("garden-notes")).toEqual({
      kind: "refused",
      step: "token",
    });
    expect(f.mints).toEqual(["secretsChange garden-notes"]);
    expect(f.gets).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("sends no change when the repository's answer is not the one asked for", async () => {
    const answers: GitHubGetResponse[] = [
      { status: 404, body: encode({}) },
      repositoryAnswer({ full_name: "didi-build/other" }),
      repositoryAnswer({ full_name: "someone-else/garden-notes" }),
      repositoryAnswer({ id: "1234567" }),
      repositoryAnswer({ id: 0 }),
      repositoryAnswer({ id: 1.5 }),
      { status: 200, body: encode("not json") },
    ];
    for (const answer of answers) {
      const f = fakes({ gets: [answer] });
      expect(await f.access.grant("garden-notes")).toEqual({
        kind: "refused",
        step: "call",
      });
      expect(f.writes).toEqual([]);
    }
  });

  it("refuses a name that is not a repository's before minting", async () => {
    for (const name of ["", "a/b", "..", "a b"]) {
      const f = fakes();
      expect(await f.access.remove(name)).toEqual({ kind: "refused", step: "call" });
      expect(f.mints).toEqual([]);
    }
  });
});

describe("the secret's list (unit with fakes, O-114)", () => {
  const page = (names: string[], total: number): GitHubGetResponse => ({
    status: 200,
    body: encode({
      total_count: total,
      repositories: names.map((name) => ({
        id: REPO_ID,
        name,
        full_name: `didi-build/${name}`,
      })),
    }),
  });

  it("reads the list with the list token, 100 a page, until the last page", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `project-${i}`);
    const f = fakes({ gets: [page(first, 101), page(["foreman"], 101)] });
    expect(await f.access.list()).toEqual([...first, "foreman"]);
    expect(f.mints).toEqual(["secretsList"]);
    expect(f.gets.map((g) => [g.path, g.token])).toEqual([
      [`${SECRET_PATH}?per_page=100&page=1`, LIST_TOKEN],
      [`${SECRET_PATH}?per_page=100&page=2`, LIST_TOKEN],
    ]);
  });

  it("reads an empty list as empty", async () => {
    const f = fakes({ gets: [page([], 0)] });
    expect(await f.access.list()).toEqual([]);
    expect(f.gets).toHaveLength(1);
  });

  it("throws on a refused token, a refused read, or an answer it cannot read", async () => {
    await expect(fakes({ refuseMint: true }).access.list()).rejects.toThrow();
    const answers: GitHubGetResponse[] = [
      { status: 403, body: encode({}) },
      { status: 409, body: encode({}) },
      { status: 200, body: encode({ repositories: [] }) },
      { status: 200, body: encode("not json") },
      {
        status: 200,
        body: encode({
          total_count: 1,
          repositories: [{ name: "x", full_name: "someone-else/x" }],
        }),
      },
      {
        status: 200,
        body: encode({
          total_count: 1,
          repositories: [{ name: "a/b", full_name: "didi-build/a/b" }],
        }),
      },
    ];
    for (const answer of answers) {
      await expect(fakes({ gets: [answer] }).access.list()).rejects.toThrow();
    }
  });
});

describe("Bootstrap's restart and its newest restarted run (unit with fakes, O-114)", () => {
  it('restarts Bootstrap on main with exactly {"ref":"main"} and the restart token', async () => {
    const f = fakes();
    expect(await f.runs.restart("garden-notes")).toEqual({ kind: "done" });
    expect(f.mints).toEqual(["restart garden-notes"]);
    expect(f.posts).toEqual([
      {
        path: "/repos/didi-build/garden-notes/actions/workflows/bootstrap.yml/dispatches",
        token: RESTART_TOKEN,
        body: { ref: "main" },
        maxBytes: 4 * 1024 * 1024,
      },
    ]);
    expect(JSON.stringify(f.posts[0]?.body)).toBe('{"ref":"main"}');
  });

  it("refuses a restart GitHub did not answer with 204, or whose token was refused", async () => {
    for (const status of [200, 404, 422, 500]) {
      expect(await fakes({ postStatus: status }).runs.restart("garden-notes")).toEqual({
        kind: "refused",
        step: "call",
      });
    }
    const f = fakes({ refuseMint: true });
    expect(await f.runs.restart("garden-notes")).toEqual({
      kind: "refused",
      step: "token",
    });
    expect(f.posts).toEqual([]);
  });

  it("reads the newest restarted run with the runner App's actions read token for the one repository", async () => {
    const run = {
      id: 9,
      event: "workflow_dispatch",
      path: ".github/workflows/bootstrap.yml@main",
      status: "completed",
      conclusion: "failure",
    };
    const f = fakes({
      gets: [{ status: 200, body: encode({ total_count: 3, workflow_runs: [run] }) }],
    });
    expect(await f.runs.latestRestart("garden-notes")).toEqual({
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
    });
    expect(f.readMints).toEqual([
      { repository: "didi-build/garden-notes", permission: "actions" },
    ]);
    expect(f.mints).toEqual([]);
    expect(f.gets).toEqual([
      {
        path: "/repos/didi-build/garden-notes/actions/workflows/bootstrap.yml/runs?event=workflow_dispatch&per_page=1",
        token: READ_TOKEN,
        accept: "json",
        maxBytes: 4 * 1024 * 1024,
      },
    ]);
  });

  it("reads no run, or no Bootstrap workflow, as none, and throws on any other answer", async () => {
    const none = fakes({
      gets: [{ status: 200, body: encode({ total_count: 0, workflow_runs: [] }) }],
    });
    expect(await none.runs.latestRestart("garden-notes")).toBeNull();
    const missing = fakes({ gets: [{ status: 404, body: encode({}) }] });
    expect(await missing.runs.latestRestart("garden-notes")).toBeNull();
    for (const status of [401, 403, 500]) {
      await expect(
        fakes({ gets: [{ status, body: encode({}) }] }).runs.latestRestart(
          "garden-notes",
        ),
      ).rejects.toThrow();
    }
    await expect(fakes().runs.latestRestart("a/b")).rejects.toThrow();
  });

  it("takes only a restarted Bootstrap run as the newest one", () => {
    const run = {
      event: "workflow_dispatch",
      path: ".github/workflows/bootstrap.yml",
      status: "in_progress",
      conclusion: null,
    };
    expect(newestRunOf({ workflow_runs: [run] })).toEqual({
      event: "workflow_dispatch",
      status: "in_progress",
      conclusion: null,
    });
    for (const bad of [
      { ...run, event: "push" },
      { ...run, path: ".github/workflows/ci.yml" },
      { ...run, status: 3 },
      { ...run, conclusion: 1 },
      "a run",
    ]) {
      expect(
        () => newestRunOf({ workflow_runs: [bad] }),
        JSON.stringify(bad),
      ).toThrow();
    }
    expect(() => newestRunOf({})).toThrow();
    expect(() => newestRunOf(undefined)).toThrow();
  });
});
