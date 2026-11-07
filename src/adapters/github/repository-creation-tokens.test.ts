// Seam: the repository creation token's mint (unit with fakes, D-346, O-109). A fake signer and a
// fake HTTP port stand in for the runner App and GitHub; the answers are synthetic JSON made here.
// The exact request (the template repository only, and exactly `contents: read` and
// `repository_creation: write`), and that a refused mint, or a token granted wider than asked,
// throws after one request and is never tried again. No network, no real key or token.
import { describe, expect, it } from "vitest";

import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import {
  createRepositoryCreationTokens,
  RepositoryCreationTokenError,
} from "./repository-creation-tokens.ts";

const SIGNED = "fake-app-jwt-not-real";
const TOKEN = "fake-creation-token-not-real";
const INSTALLATION = 4242;

/** The answer GitHub documents for a token narrowed as asked. */
const GRANTED = {
  token: TOKEN,
  expires_at: "2026-11-07T13:00:00Z",
  permissions: { contents: "read", repository_creation: "write", metadata: "read" },
  repository_selection: "selected",
  repositories: [{ name: "launchpad", full_name: "didi-build/launchpad" }],
};

function fakes(status: number, body: unknown, installationId = INSTALLATION) {
  const requests: GitHubPostRequest[] = [];
  let signed = 0;
  const http: GitHubPostHttp = {
    async post(request) {
      requests.push(structuredClone(request));
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  const tokens = createRepositoryCreationTokens({
    appJwt: {
      async sign() {
        signed += 1;
        return SIGNED;
      },
    },
    installationId,
    http,
  });
  return { tokens, requests, signed: () => signed };
}

describe("the repository creation token (unit with fakes, D-346)", () => {
  it("asks for the template repository only, with exactly the two permissions", async () => {
    const f = fakes(201, GRANTED);
    expect(await f.tokens.mint()).toBe(TOKEN);
    expect(f.requests).toEqual([
      {
        path: `/app/installations/${INSTALLATION}/access_tokens`,
        token: SIGNED,
        body: {
          repositories: ["launchpad"],
          permissions: { contents: "read", repository_creation: "write" },
        },
        maxBytes: 256 * 1024,
      },
    ]);
    // Exactly these keys, nothing more: no `repository_ids`, no other permission.
    expect(JSON.stringify(f.requests[0]?.body)).toBe(
      '{"repositories":["launchpad"],"permissions":{"contents":"read","repository_creation":"write"}}',
    );
  });

  it("accepts an answer that leaves out a permission or the repository list", async () => {
    const fewer = { ...GRANTED, permissions: { contents: "read", metadata: "read" } };
    expect(await fakes(201, fewer).tokens.mint()).toBe(TOKEN);
    // JSON leaves out an undefined field, so the answer has no repository list.
    const noList = { ...GRANTED, repositories: undefined };
    expect(await fakes(201, noList).tokens.mint()).toBe(TOKEN);
  });

  it("throws on a refused mint after one request, and never asks again", async () => {
    for (const status of [401, 403, 404, 422, 500]) {
      const f = fakes(status, { message: "refused" });
      const error = await f.tokens.mint().catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(RepositoryCreationTokenError);
      expect((error as Error).message).toBe(
        `GitHub refused the repository creation token with ${status}`,
      );
      expect(f.requests).toHaveLength(1);
      expect(f.signed()).toBe(1);
    }
  });

  it("refuses a token granted wider than asked, and does not return it", async () => {
    const wider = [
      { permissions: { ...GRANTED.permissions, administration: "write" } },
      { permissions: { ...GRANTED.permissions, contents: "write" } },
      { permissions: { ...GRANTED.permissions, workflows: "write" } },
      { permissions: "all" },
      { repository_selection: "all" },
      { repository_selection: undefined },
      {
        repositories: [
          { name: "launchpad", full_name: "didi-build/launchpad" },
          { name: "foreman", full_name: "didi-build/foreman" },
        ],
      },
      { repositories: [{ name: "foreman", full_name: "didi-build/foreman" }] },
      { repositories: "launchpad" },
    ];
    for (const change of wider) {
      const f = fakes(201, { ...GRANTED, ...change });
      const error = await f.tokens.mint().catch((e: unknown) => e);
      expect(error, JSON.stringify(change)).toBeInstanceOf(
        RepositoryCreationTokenError,
      );
      expect((error as Error).message).toMatch(/more than was asked/);
      expect(f.requests).toHaveLength(1);
    }
  });

  it("refuses an answer with no token or not JSON, and a bad installation id before any request", async () => {
    for (const body of [
      { ...GRANTED, token: "" },
      { ...GRANTED, token: 7 },
      "not json",
    ]) {
      const f = fakes(201, body);
      await expect(f.tokens.mint()).rejects.toThrow(RepositoryCreationTokenError);
    }
    for (const id of [0, -1, 1.5, Number.NaN]) {
      const f = fakes(201, GRANTED, id);
      await expect(f.tokens.mint()).rejects.toThrow(/installation id/);
      expect(f.requests).toEqual([]);
      expect(f.signed()).toBe(0);
    }
  });

  it("never names the token or the signed value in an error", async () => {
    const answers: [number, unknown][] = [
      [403, { message: TOKEN }],
      [201, { ...GRANTED, permissions: { administration: "write" } }],
    ];
    for (const [status, body] of answers) {
      const error = (await fakes(status, body)
        .tokens.mint()
        .catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain(SIGNED);
    }
  });
});
