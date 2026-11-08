// Seam: the BOOTSTRAP_TOKEN access tokens' mint (unit with fakes, D-358, O-114). A fake signer and
// a fake HTTP port stand in for the runner App and GitHub; the answers are synthetic JSON made
// here. The exact request of each token (its one repository, and exactly `organization_secrets:
// write` with `metadata: read`, `organization_secrets: read`, or `actions: write`), and that a
// refused mint, or a token granted wider than asked, throws after one request and is never tried
// again. No network, no real key or token.
import { describe, expect, it } from "vitest";

import {
  BootstrapTokenError,
  createBootstrapTokens,
  type BootstrapTokens,
} from "./bootstrap-tokens.ts";
import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";

const SIGNED = "fake-app-jwt-not-real";
const TOKEN = "fake-bootstrap-access-token-not-real";
const INSTALLATION = 4242;

function fakes(status: number, body: unknown) {
  const requests: GitHubPostRequest[] = [];
  let signed = 0;
  const http: GitHubPostHttp = {
    async post(request) {
      requests.push(structuredClone(request));
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  const tokens = createBootstrapTokens({
    appJwt: {
      async sign() {
        signed += 1;
        return SIGNED;
      },
    },
    installationId: INSTALLATION,
    http,
  });
  return { tokens, requests, signed: () => signed };
}

/** Each token, what it asks GitHub for exactly, and the answer for a token narrowed as asked. */
const TOKENS: {
  name: string;
  mint: (t: BootstrapTokens) => Promise<string>;
  body: string;
  granted: Record<string, unknown>;
}[] = [
  {
    name: "the change token",
    mint: (t) => t.secretsChange("garden-notes"),
    body: '{"repositories":["garden-notes"],"permissions":{"organization_secrets":"write","metadata":"read"}}',
    granted: {
      permissions: { organization_secrets: "write", metadata: "read" },
      repositories: [{ name: "garden-notes" }],
    },
  },
  {
    name: "the list token",
    mint: (t) => t.secretsList(),
    body: '{"repositories":["foreman"],"permissions":{"organization_secrets":"read"}}',
    granted: {
      permissions: { organization_secrets: "read", metadata: "read" },
      repositories: [{ name: "foreman" }],
    },
  },
  {
    name: "the restart token",
    mint: (t) => t.restart("garden-notes"),
    body: '{"repositories":["garden-notes"],"permissions":{"actions":"write"}}',
    granted: {
      permissions: { actions: "write", metadata: "read" },
      repositories: [{ name: "garden-notes" }],
    },
  },
];

const answer = (
  granted: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  token: TOKEN,
  expires_at: "2026-11-07T13:00:00Z",
  repository_selection: "selected",
  ...granted,
  ...extra,
});

describe("the BOOTSTRAP_TOKEN access tokens (unit with fakes, D-358, O-114)", () => {
  it.each(TOKENS)(
    "$name asks for its one repository and exactly its permissions",
    async (t) => {
      const f = fakes(201, answer(t.granted));
      expect(await t.mint(f.tokens)).toBe(TOKEN);
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]).toMatchObject({
        path: `/app/installations/${INSTALLATION}/access_tokens`,
        token: SIGNED,
        maxBytes: 256 * 1024,
      });
      // Exactly these keys, nothing more: no `repository_ids`, no other permission.
      expect(JSON.stringify(f.requests[0]?.body)).toBe(t.body);
    },
  );

  it.each(TOKENS)(
    "$name is refused when GitHub grants it wider than asked, after one request",
    async (t) => {
      const permissions = t.granted.permissions as Record<string, string>;
      const wider = [
        { permissions: { ...permissions, administration: "write" } },
        { permissions: { ...permissions, secrets: "write" } },
        { permissions: { ...permissions, contents: "write" } },
        {
          permissions: {
            ...permissions,
            actions: "write",
            organization_secrets: "write",
          },
        },
        { permissions: { ...permissions, metadata: "write" } },
        { repository_selection: "all" },
        // Not the one repository asked for: none, or two.
        { repositories: [] },
        { repositories: [{ name: "garden-notes" }, { name: "foreman" }] },
        { repositories: [{ name: "launchpad" }] },
      ].filter(
        (change) =>
          JSON.stringify({ ...t.granted, ...change }) !== JSON.stringify(t.granted),
      );
      for (const change of wider) {
        const f = fakes(201, answer(t.granted, change));
        const error = await t.mint(f.tokens).catch((e: unknown) => e);
        expect(error, JSON.stringify(change)).toBeInstanceOf(BootstrapTokenError);
        expect((error as Error).message).toMatch(/more than was asked/);
        expect((error as Error).message).not.toContain(TOKEN);
        expect(f.requests).toHaveLength(1);
      }
    },
  );

  it("asks for an organization secrets token at the read level only for the list", async () => {
    const f = fakes(
      201,
      answer(TOKENS[1]!.granted, { permissions: { organization_secrets: "write" } }),
    );
    await expect(f.tokens.secretsList()).rejects.toThrow(/more than was asked/);
  });

  it.each(TOKENS)(
    "$name throws on a refused mint after one request, and never asks again",
    async (t) => {
      for (const status of [401, 403, 404, 422, 500]) {
        const f = fakes(status, { message: TOKEN });
        const error = (await t.mint(f.tokens).catch((e: unknown) => e)) as Error;
        expect(error, String(status)).toBeInstanceOf(BootstrapTokenError);
        expect(error.message).toMatch(new RegExp(`with ${status}$`));
        expect(error.message).not.toContain(TOKEN);
        expect(error.message).not.toContain(SIGNED);
        expect(f.requests).toHaveLength(1);
        expect(f.signed()).toBe(1);
      }
    },
  );

  it("refuses a name that is not a repository's before any request", async () => {
    for (const name of ["", "a/b", "..", "a b", "x".repeat(101)]) {
      const f = fakes(201, answer(TOKENS[0]!.granted));
      await expect(f.tokens.secretsChange(name), name).rejects.toThrow(
        BootstrapTokenError,
      );
      await expect(f.tokens.restart(name), name).rejects.toThrow(BootstrapTokenError);
      expect(f.requests).toEqual([]);
      expect(f.signed()).toBe(0);
    }
  });
});
