// Seam: the New project form's two narrow token mints (unit with fakes, D-443, O-161): the
// settings write token (`contents: write` on `foreman-projects` only) and the workflow start
// token (`actions: write` on `foreman` only). A fake signer and a fake HTTP port stand in for the
// runner App and GitHub; the answers are synthetic JSON made here. The exact request, and that a
// refused mint, or a token granted wider than asked, throws after one request and is never tried
// again. No network, no real key or token.
import { describe, expect, it } from "vitest";

import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import {
  createSettingsWriteTokens,
  SettingsWriteTokenError,
} from "./settings-write-tokens.ts";
import {
  createWorkflowStartTokens,
  WorkflowStartTokenError,
} from "./workflow-start-tokens.ts";

const SIGNED = "fake-app-jwt-not-real";
const TOKEN = "fake-narrow-token-not-real";
const INSTALLATION = 4242;

const MINTS = [
  {
    name: "the settings write token",
    make: createSettingsWriteTokens,
    error: SettingsWriteTokenError,
    repository: "foreman-projects",
    permissions: { contents: "write" },
    body: '{"repositories":["foreman-projects"],"permissions":{"contents":"write"}}',
  },
  {
    name: "the workflow start token",
    make: createWorkflowStartTokens,
    error: WorkflowStartTokenError,
    repository: "foreman",
    permissions: { actions: "write" },
    body: '{"repositories":["foreman"],"permissions":{"actions":"write"}}',
  },
] as const;

function fakes(make: (typeof MINTS)[number]["make"], status: number, body: unknown) {
  const requests: GitHubPostRequest[] = [];
  let signed = 0;
  const http: GitHubPostHttp = {
    async post(request) {
      requests.push(structuredClone(request));
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  const tokens = make({
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

describe.each(MINTS)("$name (unit with fakes, D-443, O-161)", (mint) => {
  const granted = {
    token: TOKEN,
    expires_at: "2026-11-21T13:00:00Z",
    permissions: { ...mint.permissions, metadata: "read" },
    repository_selection: "selected",
    repositories: [
      { name: mint.repository, full_name: `didi-build/${mint.repository}` },
    ],
  };

  it("asks for its one repository with exactly its one permission", async () => {
    const f = fakes(mint.make, 201, granted);
    expect(await f.tokens.mint()).toBe(TOKEN);
    expect(f.requests).toEqual([
      {
        path: `/app/installations/${INSTALLATION}/access_tokens`,
        token: SIGNED,
        body: { repositories: [mint.repository], permissions: mint.permissions },
        maxBytes: 256 * 1024,
      },
    ]);
    expect(JSON.stringify(f.requests[0]?.body)).toBe(mint.body);
  });

  it("throws on a refused mint after one request, and never asks again", async () => {
    for (const status of [401, 403, 404, 422, 500]) {
      const f = fakes(mint.make, status, { message: "refused" });
      const error = await f.tokens.mint().catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(mint.error);
      expect((error as Error).message).toBe(
        `GitHub refused ${mint.name} with ${status}`,
      );
      expect([f.requests.length, f.signed()]).toEqual([1, 1]);
    }
  });

  it("refuses a token granted wider than asked, and never names a token", async () => {
    const wider = [
      { permissions: { ...granted.permissions, administration: "write" } },
      { permissions: { ...granted.permissions, contents: "write", actions: "write" } },
      { permissions: { ...granted.permissions, workflows: "write" } },
      { repository_selection: "all" },
      {
        repositories: [
          ...granted.repositories,
          { name: "launchpad", full_name: "didi-build/launchpad" },
        ],
      },
      { repositories: [{ name: "rehearsal", full_name: "didi-build/rehearsal" }] },
    ];
    for (const change of wider) {
      const f = fakes(mint.make, 201, { ...granted, ...change });
      const error = (await f.tokens.mint().catch((e: unknown) => e)) as Error;
      expect(error, JSON.stringify(change)).toBeInstanceOf(mint.error);
      expect(error.message).toMatch(/more than was asked/);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain(SIGNED);
      expect(f.requests).toHaveLength(1);
    }
  });
});
