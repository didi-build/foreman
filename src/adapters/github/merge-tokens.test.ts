// Seam: the runner App's merge token (unit with fakes, D-365, D-381). The runner App's key is
// generated when the test runs, and a fake HTTP port stands in for GitHub with synthetic answers.
// The exact request (one repository of didi-build, exactly `contents: write`), the bearer a JWT
// the runner App's public key verifies, refusals before anything is signed or sent, and the shared
// mint's refusals after one request. No network, no real key or token.
import { describe, expect, it } from "vitest";

import { readJwt, testAppKey } from "../../../test/github-app-key-fixture.ts";
import { createGitHubAppJwt } from "./app-jwt.ts";
import { createRunnerMergeTokens, RunnerMergeTokenError } from "./merge-tokens.ts";
import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";

const RUNNER_APP_ID = 1001;
const INSTALLATION = 4242;
const TOKEN = "fake-runner-merge-token-not-real";
const RUNNER = testAppKey();
const NOW = Date.UTC(2026, 10, 13, 9, 30, 0);

const granted = (extra: object = {}) => ({
  token: TOKEN,
  expires_at: "2026-11-13T10:30:00Z",
  permissions: { contents: "write", metadata: "read" },
  repository_selection: "selected",
  repositories: [{ name: "garden-notes", full_name: "didi-build/garden-notes" }],
  ...extra,
});

function fakes(status = 201, answer: unknown = granted()) {
  const requests: GitHubPostRequest[] = [];
  let signed = 0;
  const http: GitHubPostHttp = {
    async post(request) {
      requests.push(structuredClone(request));
      const text = typeof answer === "string" ? answer : JSON.stringify(answer);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  const jwt = createGitHubAppJwt({
    role: "runner",
    appId: RUNNER_APP_ID,
    privateKeyPem: RUNNER.privateKeyPem,
    clock: { now: () => new Date(NOW) },
  });
  const tokens = createRunnerMergeTokens({
    appJwt: {
      sign: async () => {
        signed += 1;
        return jwt.sign();
      },
    },
    installationId: INSTALLATION,
    http,
  });
  return { tokens, requests, signed: () => signed };
}

describe("the runner App's merge token (unit with fakes, D-365, D-381)", () => {
  it("asks for the one repository and exactly contents write, signed by the runner App", async () => {
    const f = fakes();
    expect(await f.tokens.mint("didi-build/garden-notes")).toBe(TOKEN);
    expect(f.requests).toHaveLength(1);
    const [request] = f.requests as [GitHubPostRequest];
    expect(request.path).toBe(`/app/installations/${INSTALLATION}/access_tokens`);
    // Exactly these keys, nothing more: no Pull requests write, which the runner App has not.
    expect(JSON.stringify(request.body)).toBe(
      '{"repositories":["garden-notes"],"permissions":{"contents":"write"}}',
    );
    const jwt = readJwt(request.token);
    expect(jwt.verifiedBy(RUNNER.publicKey)).toBe(true);
    expect(jwt.claims).toMatchObject({ iss: String(RUNNER_APP_ID) });
  });

  it("refuses a repository outside didi-build, or not owner/name, before anything is signed or sent", async () => {
    for (const repository of [
      "octo-org/garden-notes",
      "didi-build",
      "didi-build/",
      "didi-build/a/b",
      "didi-build/..",
      "Didi-Build/garden-notes",
    ]) {
      const f = fakes();
      const error = await f.tokens.mint(repository).catch((e: unknown) => e);
      expect(error, repository).toBeInstanceOf(RunnerMergeTokenError);
      expect((error as Error).message).toBe(
        "The runner App's merge token is only for a repository of didi-build",
      );
      expect(f.requests).toEqual([]);
      expect(f.signed()).toBe(0);
    }
  });

  it("throws on a refused mint after one request, and never asks again or wider", async () => {
    for (const status of [401, 403, 422, 500]) {
      const f = fakes(status, { message: TOKEN });
      const error = (await f.tokens
        .mint("didi-build/garden-notes")
        .catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(RunnerMergeTokenError);
      expect(error.message).toBe(
        `GitHub refused the runner App's merge token with ${status}`,
      );
      expect(error.message).not.toContain(TOKEN);
      expect(f.requests).toHaveLength(1);
    }
  });

  it("refuses a token granted wider than asked, and does not return it", async () => {
    for (const change of [
      { permissions: { contents: "write", pull_requests: "write", metadata: "read" } },
      { permissions: { contents: "write", actions: "write", metadata: "read" } },
      { permissions: { contents: "admin", metadata: "read" } },
      { repository_selection: "all" },
      { repositories: [{ name: "garden-notes" }, { name: "foreman" }] },
    ]) {
      const f = fakes(201, granted(change));
      const error = (await f.tokens
        .mint("didi-build/garden-notes")
        .catch((e: unknown) => e)) as Error;
      expect(error, JSON.stringify(change)).toBeInstanceOf(RunnerMergeTokenError);
      expect(error.message).toBe(
        "GitHub granted the runner App's merge token more than was asked, so it is not used",
      );
      expect(error.message).not.toContain(TOKEN);
    }
  });
});
