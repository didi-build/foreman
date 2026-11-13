// Seam: the runner App's read-only tokens (unit with fakes, D-267, D-365, O-125, D-381). The runner
// App's key is generated when the test runs, and a fake HTTP port stands in for GitHub with
// synthetic answers. The exact request (one repository of didi-build, exactly one permission at
// read: contents, actions, pull_requests or checks), the bearer a JWT the runner App's public key
// verifies, refusals before anything is signed or sent, and the shared mint's refusals after one
// request. No network, no real key or token.
import { describe, expect, it } from "vitest";

import { readJwt, testAppKey } from "../../../test/github-app-key-fixture.ts";
import { createGitHubAppJwt } from "./app-jwt.ts";
import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import type { RunnerReadPermission } from "./runner-app-tokens.ts";
import { createRunnerAppTokens, RunnerAppTokenError } from "./runner-read-tokens.ts";

const RUNNER_APP_ID = 1001;
const INSTALLATION = 4242;
const TOKEN = "fake-runner-read-token-not-real";
const RUNNER = testAppKey();
const NOW = Date.UTC(2026, 10, 12, 9, 30, 0);

const granted = (name: string, permission: string, extra: object = {}) => ({
  token: TOKEN,
  expires_at: "2026-11-12T10:30:00Z",
  permissions: { [permission]: "read", metadata: "read" },
  repository_selection: "selected",
  repositories: [{ name, full_name: `didi-build/${name}` }],
  ...extra,
});

function fakes(status = 201, answer?: unknown) {
  const requests: GitHubPostRequest[] = [];
  let signed = 0;
  const http: GitHubPostHttp = {
    async post(request) {
      requests.push(structuredClone(request));
      const body = answer ?? granted("garden-notes", "contents");
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  const jwt = createGitHubAppJwt({
    role: "runner",
    appId: RUNNER_APP_ID,
    privateKeyPem: RUNNER.privateKeyPem,
    clock: { now: () => new Date(NOW) },
  });
  const tokens = createRunnerAppTokens({
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

describe("the runner App's read-only tokens (unit with fakes, D-267, O-125)", () => {
  it.each(["contents", "actions", "pull_requests", "checks"] as const)(
    "a %s token asks for the one repository and exactly that permission at read, signed by the runner App",
    async (permission) => {
      const f = fakes(201, granted("garden-notes", permission));
      expect(
        await f.tokens.mint({ repository: "didi-build/garden-notes", permission }),
      ).toBe(TOKEN);
      expect(f.requests).toHaveLength(1);
      const [request] = f.requests as [GitHubPostRequest];
      expect(request.path).toBe(`/app/installations/${INSTALLATION}/access_tokens`);
      expect(request.maxBytes).toBe(256 * 1024);
      // Exactly these keys, nothing more: no `repository_ids`, no other permission.
      expect(JSON.stringify(request.body)).toBe(
        `{"repositories":["garden-notes"],"permissions":{"${permission}":"read"}}`,
      );
      const jwt = readJwt(request.token);
      expect(jwt.verifiedBy(RUNNER.publicKey)).toBe(true);
      expect(jwt.claims).toMatchObject({ iss: String(RUNNER_APP_ID) });
    },
  );

  it("refuses a repository outside didi-build, or not owner/name, before anything is signed or sent", async () => {
    for (const repository of [
      "octo-org/garden-notes",
      "didi-build",
      "didi-build/",
      "didi-build/a/b",
      "didi-build/.",
      "didi-build/..",
      " didi-build/garden-notes",
      "didi-build/garden notes",
      "Didi-Build/garden-notes",
      "github.com/didi-build/garden-notes",
    ]) {
      const f = fakes();
      const error = await f.tokens
        .mint({ repository, permission: "contents" })
        .catch((e: unknown) => e);
      expect(error, repository).toBeInstanceOf(RunnerAppTokenError);
      expect((error as Error).message).toBe(
        "The runner App's read token is only for a repository of didi-build",
      );
      expect(f.requests).toEqual([]);
      expect(f.signed()).toBe(0);
    }
  });

  it("refuses any permission but the four reads, before anything is signed or sent", async () => {
    for (const permission of [
      "metadata",
      "administration",
      "organization_secrets",
      "repository_creation",
      "pull_requests:write",
      "toString",
      "",
    ]) {
      const f = fakes();
      await expect(
        f.tokens.mint({
          repository: "didi-build/garden-notes",
          permission: permission as RunnerReadPermission,
        }),
      ).rejects.toThrow(
        new RunnerAppTokenError(
          "The runner App's read token is only for contents, actions, pull_requests or checks",
        ),
      );
      expect(f.requests).toEqual([]);
      expect(f.signed()).toBe(0);
    }
  });

  it("throws on a refused mint after one request, and never asks again", async () => {
    for (const status of [401, 403, 404, 422, 500]) {
      const f = fakes(status, { message: TOKEN });
      const error = (await f.tokens
        .mint({ repository: "didi-build/garden-notes", permission: "actions" })
        .catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(RunnerAppTokenError);
      expect(error.message).toBe(
        `GitHub refused the runner App's actions read token with ${status}`,
      );
      expect(f.requests).toHaveLength(1);
      expect(f.signed()).toBe(1);
    }
  });

  it("refuses a token granted wider than asked, and does not return it", async () => {
    const base = granted("garden-notes", "contents");
    for (const change of [
      { permissions: { contents: "write", metadata: "read" } },
      { permissions: { ...base.permissions, actions: "read" } },
      { permissions: { ...base.permissions, pull_requests: "write" } },
      { repository_selection: "all" },
      { repositories: [{ name: "garden-notes" }, { name: "foreman" }] },
      { repositories: [{ name: "foreman" }] },
    ]) {
      const f = fakes(201, { ...base, ...change });
      const error = (await f.tokens
        .mint({ repository: "didi-build/garden-notes", permission: "contents" })
        .catch((e: unknown) => e)) as Error;
      expect(error, JSON.stringify(change)).toBeInstanceOf(RunnerAppTokenError);
      expect(error.message).toBe(
        "GitHub granted the runner App's contents read token more than was asked, so it is not used",
      );
      expect(error.message).not.toContain(TOKEN);
      expect(f.requests).toHaveLength(1);
    }
  });

  it("names neither the token nor the signed value in an error", async () => {
    for (const [status, body] of [
      [403, { message: TOKEN }],
      [201, { ...granted("garden-notes", "contents"), token: "" }],
      [201, "not json"],
    ] as const) {
      const f = fakes(status, body);
      const error = (await f.tokens
        .mint({ repository: "didi-build/garden-notes", permission: "contents" })
        .catch((e: unknown) => e)) as Error;
      const signed = f.requests[0]?.token ?? "";
      expect(signed).not.toBe("");
      expect(error.message).not.toContain(TOKEN);
      for (const part of signed.split(".")) expect(error.message).not.toContain(part);
    }
  });
});
