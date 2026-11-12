// Seam: a run's GitHub installation token (unit with fakes, ADR 0106 section 5, ADR 0112, D-159,
// D-184, D-365, O-125). Each role's App key is generated when the test runs, and fake HTTP ports
// stand in for GitHub with synthetic answers. Per role: the installation lookup and the mint, each
// signed by that role's own App and by no other, the exact paths and the exact token request; a
// role, an access or a repository that does not fit refused before anything is signed or sent;
// every lookup failure and the shared mint's refusals refused with fixed text and never retried.
// No network, no real key or token.
import { describe, expect, it } from "vitest";

import {
  readJwt,
  testAppKey,
  type TestAppKey,
} from "../../../test/github-app-key-fixture.ts";
import { createGitHubAppJwt } from "./app-jwt.ts";
import {
  createInstallationTokens,
  InstallationTokenError,
  type InstallationTokenRequest,
  type TokenRole,
} from "./installation-tokens.ts";
import type { GitHubPostHttp, GitHubPostRequest } from "./post-http.ts";
import type { GitHubGetRequest, GitHubHttp } from "./runner-app-tokens.ts";

const NOW = Date.UTC(2026, 10, 12, 9, 30, 0);
const TOKEN = "fake-run-installation-token-not-real";
const INSTALLATION = 77001;
const REPO = "didi-build/garden-notes";

const APPS: Record<TokenRole, { id: number; key: TestAppKey }> = {
  developer: { id: 2001, key: testAppKey() },
  designer: { id: 2002, key: testAppKey("pkcs8") },
  qa: { id: 2003, key: testAppKey() },
};

/** Each role's exact token request, and the permissions GitHub grants for it. */
const EXPECTED: Record<TokenRole, { access: "read" | "write"; body: string }> = {
  developer: {
    access: "write",
    body: '{"repositories":["garden-notes"],"permissions":{"contents":"write","pull_requests":"write"}}',
  },
  designer: {
    access: "write",
    body: '{"repositories":["garden-notes"],"permissions":{"contents":"write","pull_requests":"write"}}',
  },
  qa: {
    access: "read",
    body: '{"repositories":["garden-notes"],"permissions":{"contents":"read"}}',
  },
};

const installation = (extra: object = {}) => ({
  id: INSTALLATION,
  app_id: 2001,
  account: { login: "didi-build", type: "Organization" },
  repository_selection: "all",
  ...extra,
});

const granted = (role: TokenRole, extra: object = {}) => ({
  token: TOKEN,
  expires_at: "2026-11-12T10:30:00Z",
  permissions: {
    ...(JSON.parse(EXPECTED[role].body) as { permissions: object }).permissions,
    metadata: "read",
  },
  repository_selection: "selected",
  repositories: [{ name: "garden-notes", full_name: REPO }],
  ...extra,
});

interface Answer {
  status: number;
  body: unknown;
}

const bytes = (body: unknown) =>
  new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));

function fakes(lookup: Answer, mint: Answer) {
  const gets: GitHubGetRequest[] = [];
  const posts: GitHubPostRequest[] = [];
  const signed: TokenRole[] = [];
  const http: GitHubHttp = {
    async get(request) {
      gets.push(structuredClone(request));
      return { status: lookup.status, body: bytes(lookup.body) };
    },
  };
  const post: GitHubPostHttp = {
    async post(request) {
      posts.push(structuredClone(request));
      return { status: mint.status, body: bytes(mint.body) };
    },
  };
  const app = (role: TokenRole) => {
    const jwt = createGitHubAppJwt({
      role,
      appId: APPS[role].id,
      privateKeyPem: APPS[role].key.privateKeyPem,
      clock: { now: () => new Date(NOW) },
    });
    return {
      sign: async () => {
        signed.push(role);
        return jwt.sign();
      },
    };
  };
  const tokens = createInstallationTokens({
    apps: { developer: app("developer"), designer: app("designer"), qa: app("qa") },
    http,
    post,
  });
  return { tokens, gets, posts, signed };
}

const ok = (role: TokenRole) =>
  fakes({ status: 200, body: installation() }, { status: 201, body: granted(role) });

const request = (
  role: TokenRole,
  change: Partial<InstallationTokenRequest> = {},
): InstallationTokenRequest => ({
  role,
  repository: REPO,
  access: EXPECTED[role].access,
  runId: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
  ...change,
});

const ROLES = ["developer", "designer", "qa"] as const;

describe("a run's GitHub installation token (unit with fakes, D-159, D-365, O-125)", () => {
  it.each(ROLES)(
    "the %s's token: its own App finds the installation, then mints for the one repository with exactly its permissions",
    async (role) => {
      const f = ok(role);
      expect(await f.tokens.mint(request(role))).toBe(TOKEN);
      expect(f.signed).toEqual([role, role]);
      expect(f.gets).toHaveLength(1);
      const [lookup] = f.gets as [GitHubGetRequest];
      expect(lookup).toMatchObject({
        path: "/repos/didi-build/garden-notes/installation",
        accept: "json",
        maxBytes: 64 * 1024,
      });
      expect(f.posts).toHaveLength(1);
      const [mint] = f.posts as [GitHubPostRequest];
      expect(mint.path).toBe(`/app/installations/${INSTALLATION}/access_tokens`);
      expect(mint.maxBytes).toBe(256 * 1024);
      // Exactly these keys, nothing more: no `repository_ids`, no other permission.
      expect(JSON.stringify(mint.body)).toBe(EXPECTED[role].body);
      // Both are signed by this role's App, and by no other App's key.
      for (const token of [lookup.token, mint.token]) {
        const jwt = readJwt(token);
        expect(jwt.claims).toMatchObject({ iss: String(APPS[role].id) });
        for (const other of ROLES) {
          expect(jwt.verifiedBy(APPS[other].key.publicKey), other).toBe(other === role);
        }
      }
      // The run id is for the runner's own records: GitHub never sees it.
      expect(JSON.stringify([f.gets, f.posts])).not.toContain(request(role).runId);
    },
  );

  it("refuses an access that is not the role's, before anything is signed or sent", async () => {
    for (const [role, access] of [
      ["developer", "read"],
      ["designer", "read"],
      ["qa", "write"],
    ] as const) {
      const f = ok(role);
      const error = await f.tokens
        .mint(request(role, { access }))
        .catch((e: unknown) => e);
      expect(error, role).toBeInstanceOf(InstallationTokenError);
      expect((error as Error).message).toMatch(
        /^The (Developer|Designer|QA) App's run token is (write|read) only$/,
      );
      expect([f.gets, f.posts, f.signed]).toEqual([[], [], []]);
    }
  });

  it("refuses a role that gets no token, before anything is signed or sent", async () => {
    for (const role of ["council", "triage", "runner", "scanner"]) {
      const f = ok("developer");
      await expect(
        f.tokens.mint(request("developer", { role: role as TokenRole })),
      ).rejects.toThrow(
        new InstallationTokenError(
          "Only Developer, Designer and QA runs get a GitHub token",
        ),
      );
      expect([f.gets, f.posts, f.signed]).toEqual([[], [], []]);
    }
  });

  it("refuses a repository outside didi-build, or not owner/name, before anything is signed or sent", async () => {
    for (const repository of [
      "octo-org/garden-notes",
      "didi-build",
      "didi-build/a/b",
      "didi-build/..",
      "didi-build/garden notes",
      "",
    ]) {
      const f = ok("qa");
      await expect(
        f.tokens.mint(request("qa", { repository })),
        repository,
      ).rejects.toThrow(
        new InstallationTokenError(
          "The QA App's run token is only for a repository of didi-build",
        ),
      );
      expect([f.gets, f.posts, f.signed]).toEqual([[], [], []]);
    }
  });

  it("refuses every installation lookup it cannot use, with fixed text, minting nothing", async () => {
    const cases: [Answer, string][] = [
      [
        { status: 404, body: { message: "Not Found" } },
        "The Developer App is not installed on the repository",
      ],
      ...[301, 401, 403, 500].map((status): [Answer, string] => [
        { status, body: { message: TOKEN } },
        `GitHub refused the Developer App's installation lookup with ${status}`,
      ]),
      [
        { status: 200, body: "not json" },
        "The Developer App's installation answer is not JSON",
      ],
      ...[
        [installation()],
        {},
        installation({ id: undefined }),
        installation({ id: 0 }),
        installation({ id: -3 }),
        installation({ id: 1.5 }),
        installation({ id: "77001" }),
        installation({ id: 2 ** 53 }),
        null,
      ].map((body): [Answer, string] => [
        { status: 200, body },
        "The Developer App's installation answer holds no installation id",
      ]),
      ...[
        installation({ account: { login: "octo-org" } }),
        installation({ account: { login: "Didi-Build" } }),
        installation({ account: {} }),
        installation({ account: "didi-build" }),
        installation({ account: null }),
      ].map((body): [Answer, string] => [
        { status: 200, body },
        "The Developer App's installation is not on didi-build",
      ]),
    ];
    for (const [lookup, message] of cases) {
      const f = fakes(lookup, { status: 201, body: granted("developer") });
      const error = await f.tokens.mint(request("developer")).catch((e: unknown) => e);
      expect(error, JSON.stringify(lookup)).toBeInstanceOf(InstallationTokenError);
      expect((error as Error).message).toBe(message);
      expect(f.gets).toHaveLength(1);
      expect(f.posts).toEqual([]);
    }
  });

  it("takes an installation answer that names no account", async () => {
    const f = fakes(
      { status: 200, body: installation({ account: undefined }) },
      { status: 201, body: granted("designer") },
    );
    expect(await f.tokens.mint(request("designer"))).toBe(TOKEN);
  });

  it("throws on a refused mint after one request, and never asks again", async () => {
    for (const status of [401, 403, 422, 500]) {
      const f = fakes(
        { status: 200, body: installation() },
        { status, body: { message: TOKEN } },
      );
      const error = (await f.tokens
        .mint(request("qa"))
        .catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(InstallationTokenError);
      expect(error.message).toBe(
        `GitHub refused the QA App's run token with ${status}`,
      );
      expect([f.gets.length, f.posts.length]).toEqual([1, 1]);
    }
  });

  it("refuses a token granted wider than asked, and does not return it", async () => {
    const wider: [TokenRole, object][] = [
      // QA asks for contents read only: pull requests read is more than was asked (O-125).
      [
        "qa",
        { permissions: { contents: "read", pull_requests: "read", metadata: "read" } },
      ],
      ["qa", { permissions: { contents: "write", metadata: "read" } }],
      [
        "developer",
        { permissions: { ...granted("developer").permissions, workflows: "write" } },
      ],
      [
        "developer",
        {
          permissions: { ...granted("developer").permissions, administration: "write" },
        },
      ],
      ["designer", { repository_selection: "all" }],
      ["designer", { repositories: [{ name: "garden-notes" }, { name: "foreman" }] }],
    ];
    for (const [role, change] of wider) {
      const f = fakes(
        { status: 200, body: installation() },
        { status: 201, body: granted(role, change) },
      );
      const error = (await f.tokens
        .mint(request(role))
        .catch((e: unknown) => e)) as Error;
      expect(error, JSON.stringify(change)).toBeInstanceOf(InstallationTokenError);
      expect(error.message).toMatch(
        /run token more than was asked, so it is not used$/,
      );
      expect(error.message).not.toContain(TOKEN);
    }
  });

  it("names neither the token nor a signed value in an error", async () => {
    const answers: [Answer, Answer][] = [
      [
        { status: 403, body: { message: TOKEN } },
        { status: 201, body: granted("developer") },
      ],
      [
        { status: 200, body: installation() },
        { status: 403, body: { message: TOKEN } },
      ],
      [
        { status: 200, body: installation() },
        { status: 201, body: granted("developer", { token: "" }) },
      ],
    ];
    for (const [lookup, mint] of answers) {
      const f = fakes(lookup, mint);
      const error = (await f.tokens
        .mint(request("developer"))
        .catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain(TOKEN);
      for (const signed of [...f.gets, ...f.posts].map((r) => r.token)) {
        for (const part of signed.split(".")) expect(error.message).not.toContain(part);
      }
    }
  });
});
