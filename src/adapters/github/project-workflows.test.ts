// Seam: the New project form's start of the Platform and Infra runs (unit with fakes, D-443,
// D-444, O-161). A fake token port and a fake HTTP port stand in for the runner App and GitHub;
// the answers are synthetic. One token for the step, exactly the two allowed calls with
// `projects_commit`, the run links GitHub gives, and every refusal. No network, no real token.
import { describe, expect, it } from "vitest";

import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import {
  createGitHubProjectWorkflows,
  WORKFLOW_START_CALLS,
} from "./project-workflows.ts";

const TOKEN = "fake-start-token-not-real";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PLATFORM = "/repos/didi-build/foreman/actions/workflows/platform.yml/dispatches";
const INFRA = "/repos/didi-build/foreman/actions/workflows/infra-apply.yml/dispatches";

type Answer = { status: number; body?: unknown } | "throw";

function fakes(answers: Answer[] = [], refuseMint = false) {
  const posts: GitHubPostRequest[] = [];
  let mints = 0;
  const post: GitHubPostHttp = {
    async post(request) {
      posts.push(structuredClone(request));
      const answer = answers.shift() ?? { status: 204 };
      if (answer === "throw") throw new Error("no answer");
      const text =
        answer.body === undefined
          ? ""
          : typeof answer.body === "string"
            ? answer.body
            : JSON.stringify(answer.body);
      return { status: answer.status, body: new TextEncoder().encode(text) };
    },
  };
  const workflows = createGitHubProjectWorkflows({
    tokens: {
      async mint() {
        mints += 1;
        if (refuseMint) throw new Error("refused");
        return TOKEN;
      },
    },
    post,
  });
  return { workflows, posts, mints: () => mints };
}

const run = (id: number) => ({
  workflow_run_id: id,
  run_url: `https://api.github.com/repos/didi-build/foreman/actions/runs/${id}`,
  html_url: `https://github.com/didi-build/foreman/actions/runs/${id}`,
});

describe("the Platform and Infra starts (unit with fakes, D-443, O-161)", () => {
  it("mints one token and sends exactly the two allowed calls, Platform first, with projects_commit", async () => {
    const f = fakes([
      { status: 200, body: run(11) },
      { status: 200, body: run(12) },
    ]);
    expect(await f.workflows.start(COMMIT)).toEqual({
      platform: {
        kind: "started",
        link: "https://github.com/didi-build/foreman/actions/runs/11",
      },
      infra: {
        kind: "started",
        link: "https://github.com/didi-build/foreman/actions/runs/12",
      },
    });
    expect(f.mints()).toBe(1);
    expect(WORKFLOW_START_CALLS).toEqual([PLATFORM, INFRA]);
    expect(f.posts.map((p) => [p.path, p.token])).toEqual([
      [PLATFORM, TOKEN],
      [INFRA, TOKEN],
    ]);
    for (const p of f.posts) {
      expect(JSON.stringify(p.body)).toBe(
        `{"ref":"main","inputs":{"projects_commit":"${COMMIT}"},"return_run_details":true}`,
      );
      expect(p.maxBytes).toBe(64 * 1024);
    }
  });

  it("links the workflow's runs when GitHub answers 204, or names no run page of Foreman's", async () => {
    const f = fakes([
      { status: 204 },
      { status: 200, body: { html_url: "https://example.test/actions/runs/1" } },
    ]);
    expect(await f.workflows.start(COMMIT)).toEqual({
      platform: {
        kind: "started",
        link: "https://github.com/didi-build/foreman/actions/workflows/platform.yml",
      },
      infra: {
        kind: "started",
        link: "https://github.com/didi-build/foreman/actions/workflows/infra-apply.yml",
      },
    });
    const odd = fakes([
      { status: 200, body: "not json" },
      { status: 200, body: run(0) },
    ]);
    const result = await odd.workflows.start(COMMIT);
    expect(result.platform).toMatchObject({ kind: "started" });
    expect(result.infra).toEqual({
      kind: "started",
      link: "https://github.com/didi-build/foreman/actions/workflows/infra-apply.yml",
    });
  });

  it("refuses a start answered with anything else, naming the status, and still makes the other", async () => {
    for (const status of [401, 403, 404, 422, 500]) {
      const f = fakes([{ status }, { status: 204 }]);
      const result = await f.workflows.start(COMMIT);
      expect(result.platform).toEqual({ kind: "refused", step: "call", status });
      expect(result.infra).toMatchObject({ kind: "started" });
      expect([f.mints(), f.posts.length]).toEqual([1, 2]);
    }
    const dropped = fakes([{ status: 204 }, "throw"]);
    expect((await dropped.workflows.start(COMMIT)).infra).toEqual({
      kind: "refused",
      step: "call",
    });
  });

  it("starts neither when the token is refused, or when the commit is not one, minting nothing then", async () => {
    const f = fakes([], true);
    expect(await f.workflows.start(COMMIT)).toEqual({
      platform: { kind: "refused", step: "token" },
      infra: { kind: "refused", step: "token" },
    });
    expect([f.mints(), f.posts]).toEqual([1, []]);
    for (const commit of [
      "",
      "main",
      COMMIT.toUpperCase(),
      `${COMMIT}0`,
      "a".repeat(39),
    ]) {
      const g = fakes();
      expect(await g.workflows.start(commit)).toEqual({
        platform: { kind: "refused", step: "call" },
        infra: { kind: "refused", step: "call" },
      });
      expect([g.mints(), g.posts]).toEqual([0, []]);
    }
  });
});
