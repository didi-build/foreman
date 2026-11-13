// Seam: the flow layer's composition module and its Windmill binding (unit, build plan M3.1,
// ADR 0111 section 4). With a fake environment: which secrets and values are read and when, that
// every part not built yet refuses with a reason, and that each GitHub App's id and key are read
// only on that App's first token (O-125), the runner's GitHub client's included (D-381, O-127). No database is reached: the pool connects on first use
// and the test never uses it. No network either: `fetch` is replaced by one that records and
// refuses, and each test checks it was never called; the Apps' tokens are minted against fake
// HTTP ports with keys generated when the test runs.
import { checkServerIdentity } from "node:tls";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubAppJwtError } from "../../src/adapters/github/app-jwt.ts";
import { InstallationTokenError } from "../../src/adapters/github/installation-tokens.ts";
import type { GitHubPostRequest } from "../../src/adapters/github/post-http.ts";
import type { GitHubGetRequest } from "../../src/adapters/github/runner-app-tokens.ts";
import { RunnerAppTokenError } from "../../src/adapters/github/runner-read-tokens.ts";
import { readJwt, testAppKey, type TestAppKey } from "../github-app-key-fixture.ts";
import { readApprovalReply } from "../../flows/lib/approval.ts";
import { readBotFiles } from "../../src/adapters/contracts-file/bot-files.ts";
import { storedZip } from "../zip-fixture.ts";
import {
  DatabaseTlsError,
  LOCAL_WITHOUT_TLS_ENV,
  readDatabaseCa,
} from "../../src/adapters/store-postgres/tls.ts";
import {
  compose,
  unbuiltStagingDeployCredentials,
  windmillGitHubAppTokens,
  windmillStagingDeployCredentials,
  type RunToStart,
} from "../../flows/lib/compose.ts";
import {
  SECRET_PATHS,
  VALUE_NAMES,
  type FlowEnvironment,
} from "../../flows/lib/environment.ts";
import {
  windmillEnvironment,
  WindmillNotConfiguredError,
} from "../../flows/lib/windmill.ts";

const DIGEST = `@sha256:${"c".repeat(64)}`;
const IMAGES = JSON.stringify({
  opencode: `registry.example.com/foreman/opencode${DIGEST}`,
  "claude-api": `registry.example.com/foreman/claude-api${DIGEST}`,
});

/** A Council run as the dispatch admits it, on the first routing policy. Fake data only. */
const COUNCIL_START = {
  run: {
    id: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
    bot: "council",
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    serviceTierRequested: "standard",
    modelPrice: {
      tiers: ["standard"],
      pricePerMTok: { standard: { input: 3, cachedInput: 0.3, output: 15 } },
    },
    nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    headSha: null,
    prNumber: null,
  },
  project: { slug: "rehearsal", repo: "didi-build/rehearsal" },
  input: "Fixture input.",
  branch: null,
  evidenceIds: [],
  capacity: { flexCapacityRetries: 3, maxRejectedModelRequests: 6 },
  stateApiToken: "state-token-value-not-real-0123456789",
  outputSchema: readBotFiles().council.outputSchemas?.escalation,
} as unknown as RunToStart;

/** The Apps' made-up ids, as Didi stores them: decimal text, here with a trailing newline. */
const APP_IDS: Record<string, string> = {
  [VALUE_NAMES.runnerAppId]: "1001\n",
  [VALUE_NAMES.developerAppId]: "2001",
  [VALUE_NAMES.designerAppId]: "2002",
  [VALUE_NAMES.qaAppId]: "2003",
  [VALUE_NAMES.runnerAppInstallationId]: "4242",
};

const APP_KEY_PATHS = [
  SECRET_PATHS.runnerAppPrivateKey,
  SECRET_PATHS.developerAppPrivateKey,
  SECRET_PATHS.designerAppPrivateKey,
  SECRET_PATHS.qaAppPrivateKey,
] as string[];

/**
 * Every secret is the same made-up database address, so an App's key read here is not a PEM and
 * its first token is refused before anything is sent.
 */
function fakeEnvironment(values: Record<string, string> = {}) {
  const secretsRead: string[] = [];
  const valuesRead: string[] = [];
  const env: FlowEnvironment = {
    async secret(path) {
      secretsRead.push(path);
      return "postgresql://runner:not-a-real-password@localhost:1/none";
    },
    async value(name) {
      valuesRead.push(name);
      const all: Record<string, string> = {
        [VALUE_NAMES.specVersion]: "e".repeat(40),
        [VALUE_NAMES.agentImages]: IMAGES,
        [VALUE_NAMES.developerAppLogin]: "foreman-developer[bot]",
        [VALUE_NAMES.designerAppLogin]: "foreman-designer[bot]",
        [VALUE_NAMES.runnerAppSlug]: "foreman-runner",
        ...APP_IDS,
        ...values,
      };
      const value = all[name];
      if (value === undefined) throw new Error(`${name} is not set`);
      return value;
    },
    async executionsThisMonth() {
      return 42;
    },
  };
  return { env, secretsRead, valuesRead };
}

/** What `fetch` was asked for: nothing, in every test. */
let fetched: string[] = [];

describe("flow composition (unit: flow layer, build plan M3.1)", () => {
  beforeEach(() => {
    fetched = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      fetched.push(String(url));
      throw new Error("no network in tests");
    });
  });
  afterEach(() => {
    expect(fetched).toEqual([]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds the runner's pool through the TLS builder, verified against Supabase's CA (O-117)", async () => {
    const configs: pg.PoolConfig[] = [];
    const RealPool = pg.Pool;
    vi.spyOn(pg, "Pool").mockImplementation(function (config?: pg.PoolConfig) {
      configs.push(config ?? {});
      return new RealPool(config);
    } as unknown as () => pg.Pool);
    const env: FlowEnvironment = {
      ...fakeEnvironment().env,
      secret: async () =>
        "postgresql://runner:not-a-real-password@pooler.example.test:5432/postgres?sslmode=disable",
    };
    const deps = await compose(env);
    try {
      expect(configs).toEqual([
        {
          connectionString:
            "postgresql://runner:not-a-real-password@pooler.example.test:5432/postgres",
          max: 2,
          ssl: { ca: readDatabaseCa(), rejectUnauthorized: true, checkServerIdentity },
        },
      ]);
    } finally {
      await deps.close();
    }
  });

  it("refuses the local opt-out for the runner's remote database", async () => {
    vi.stubEnv(LOCAL_WITHOUT_TLS_ENV, "1");
    const env: FlowEnvironment = {
      ...fakeEnvironment().env,
      secret: async () =>
        "postgresql://runner:not-a-real-password@pooler.example.test/postgres",
    };
    await expect(compose(env)).rejects.toThrow(DatabaseTlsError);
  });

  it("builds the deps from the environment, reading only the database secret up front, and no App's id or key", async () => {
    const { env, secretsRead, valuesRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      expect(secretsRead).toEqual([SECRET_PATHS.database]);
      expect(valuesRead).toEqual([
        VALUE_NAMES.specVersion,
        VALUE_NAMES.developerAppLogin,
        VALUE_NAMES.designerAppLogin,
        VALUE_NAMES.runnerAppSlug,
      ]);
      expect(deps.contracts.version).toBe("e".repeat(40));
      expect(deps.appLogins).toEqual([
        "foreman-developer[bot]",
        "foreman-designer[bot]",
      ]);
      expect(deps.runnerAppSlug).toBe("foreman-runner");
      // Runtime, version and limits come from the bot files (contracts/bots/).
      const bots = readBotFiles();
      expect(deps.bots.qa).toEqual({
        runtime: "claude-api",
        botVersion: bots.qa.version,
        outputSchemas: bots.qa.outputSchemas,
      });
      expect(deps.bots.developer.runtime).toBe("opencode");
      expect(deps.bots.council.outputSchemas).toEqual(bots.council.outputSchemas);
      expect(deps.limits.qa).toEqual({ maxTurns: 50, maxMinutes: 20, maxUsd: 2 });
      expect(deps.taskTypes.version).toBe("e".repeat(40));
      expect(deps.taskTypes.roles.developer.default).toBe("developer:code");
      expect(await deps.executionsThisMonth()).toBe(42);
      // Two ids from the real source differ; the clock is the real clock.
      expect(deps.ids.next()).not.toBe(deps.ids.next());
      // Run tokens are long random values in the API's token pattern, never the same twice.
      const [one, two] = [deps.newRunToken(), deps.newRunToken()];
      expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(one === two).toBe(false);
    } finally {
      await deps.close();
    }
  });

  it("composes the runner's GitHub client without reading an App's key (D-381)", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      // GitHub's deployments are not read at all (D-356, O-116).
      expect("listDeployments" in deps.github).toBe(false);
      // A repository outside didi-build is refused before any token is minted, so no key is read.
      await expect(deps.github.listOpenPullRequests("octo-org/x")).rejects.toThrow(
        "not a repository of didi-build",
      );
      await expect(
        deps.github.squashMerge("octo-org/x", 7, "b".repeat(40)),
      ).rejects.toThrow("not a repository of didi-build");
      // The staging check reads the public marker and needs no credential (O-116); a slug that
      // makes no staging address is no result, with nothing reached.
      expect(
        await deps.stagingChecker.check({
          project: { slug: "Not A Slug" },
          commitSha: "b".repeat(40),
        } as never),
      ).toEqual({ result: "no_result", reason: "unreachable" });
      // None of them reads an App's key.
      expect(secretsRead).toEqual([SECRET_PATHS.database]);
    } finally {
      await deps.close();
    }
  });

  it("reads the runner App's id, key and installation id only on its first token, and refuses a key that is not a PEM before anything is sent (O-125)", async () => {
    const { env, secretsRead, valuesRead } = fakeEnvironment();
    const deps = await compose(env);
    const notPem = new GitHubAppJwtError(
      "The runner App's private key is not a PEM private key",
    );
    try {
      const project = { slug: "x", repo: "didi-build/x" };
      const reads: [string, () => Promise<unknown>][] = [
        // CI's builds and its preview check, with the actions read token (D-267, D-354, O-116).
        ["staging run", () => deps.stagingBuilds.getRun("didi-build/x", 1)],
        ["latest build", () => deps.stagingBuilds.latestMainBuild("didi-build/x")],
        ["site archive", () => deps.stagingBuilds.siteArchive("didi-build/x", 1)],
        [
          "workflow runs",
          () => deps.github.listWorkflowRuns("didi-build/x", "ci.yml", "b".repeat(40)),
        ],
        ["workflow jobs", () => deps.github.listWorkflowJobs("didi-build/x", 1)],
        // The runner's own GitHub client (D-381): each call mints its own token first.
        ["pull request", () => deps.github.getPullRequest("didi-build/x", 7)],
        ["changed files", () => deps.github.listChangedPaths("didi-build/x", 7)],
        ["check runs", () => deps.github.listCheckRuns("didi-build/x", "b".repeat(40))],
        ["open pull requests", () => deps.github.listOpenPullRequests("didi-build/x")],
        ["mergeable state", () => deps.github.getMergeability("didi-build/x", 7)],
        ["merge", () => deps.github.squashMerge("didi-build/x", 7, "b".repeat(40))],
        [
          "compare",
          () =>
            deps.github.compareCommits("didi-build/x", "b".repeat(40), "c".repeat(40)),
        ],
        ["branch head", () => deps.github.getBranchHead("didi-build/x", "main")],
        // The repo map's Job and the scan mint the token before the cluster is read (D-275 (2)).
        ["repo map at a commit", () => deps.repoMaps.read(project, "b".repeat(40))],
        ["repo map at the head", () => deps.repoMaps.read(project)],
        ["scan", () => deps.repoScans.scan(project)],
        [
          "screenshots",
          () => deps.screenshots.read("didi-build/x", "b".repeat(40), "gallery"),
        ],
        [
          "folder id",
          () =>
            deps.repoFolders.folderId(
              "didi-build/x",
              "b".repeat(40),
              "design/a/b/options/c",
            ),
        ],
      ];
      for (const [name, read] of reads) {
        await expect(read(), name).rejects.toThrow(notPem);
      }
      // Only the runner App's: its key, its id and its installation id.
      expect([...new Set(secretsRead)]).toEqual([
        SECRET_PATHS.database,
        SECRET_PATHS.runnerAppPrivateKey,
      ]);
      expect([...new Set(valuesRead)].slice(4)).toEqual([
        VALUE_NAMES.runnerAppInstallationId,
        VALUE_NAMES.runnerAppId,
      ]);
    } finally {
      await deps.close();
    }
  });

  it("refuses the staging deploy on its credential until Didi creates it, uploading nothing (D-353, O-116)", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      // A site that passes the file-set check still reaches no network: the credential refuses.
      const commit = "b".repeat(40);
      const archive = storedZip([{ name: "foreman-commit.txt", data: `${commit}\n` }]);
      expect(
        await deps.stagingTarget.deploy({
          project: { slug: "x", repo: "didi-build/x" } as never,
          commitSha: commit,
          archive,
        }),
      ).toEqual({
        outcome: "refused",
        cause: "infrastructure",
        reason: "credential_unavailable",
        text: "the staging deploy credential is not available",
      });
      await expect(unbuiltStagingDeployCredentials().read()).rejects.toThrow(
        /Workers Scripts Edit only/,
      );
      // Nothing beyond the database secret was read.
      expect(secretsRead).toEqual([SECRET_PATHS.database]);
    } finally {
      await deps.close();
    }
  });

  it("reads the staging deploy token and account id by path once Didi stores them (O-116)", async () => {
    const read: string[] = [];
    const credentials = windmillStagingDeployCredentials({
      async secret(path) {
        read.push(path);
        return path === SECRET_PATHS.cloudflareAccountId
          ? `${"0".repeat(32)}\n`
          : "fake-token-for-tests-only-0123456789";
      },
    });
    expect(await credentials.read()).toEqual({
      accountId: "0".repeat(32),
      token: "fake-token-for-tests-only-0123456789",
    });
    expect(read).toEqual([
      SECRET_PATHS.cloudflareAccountId,
      SECRET_PATHS.stagingDeployToken,
    ]);
    expect(SECRET_PATHS.stagingDeployToken).toBe(
      "platform/cloudflare/staging-deploy-token",
    );
    expect(SECRET_PATHS.cloudflareAccountId).toBe("platform/cloudflare/account-id");
  });

  it("mints the register-project form's tokens with the runner App, refusing a key that is not a PEM before anything is sent (D-345, D-346, O-125)", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      // The settings file on main is read with the runner App's contents read token (O-109).
      await expect(deps.projectSettings.listedSlugs()).rejects.toThrow(
        GitHubAppJwtError,
      );
      // The create mints the creation token first; refused, nothing is sent and nothing retried.
      expect(
        await deps.projectRepositories.generate({
          name: "x",
          description: "A project.",
        }),
      ).toEqual({ kind: "refused", step: "creation_token" });
      await expect(deps.projectRepositories.read("x")).rejects.toThrow(
        GitHubAppJwtError,
      );
      expect([...new Set(secretsRead)]).toEqual([
        SECRET_PATHS.database,
        SECRET_PATHS.runnerAppPrivateKey,
      ]);
    } finally {
      await deps.close();
    }
  });

  it("mints BOOTSTRAP_TOKEN's access tokens with the runner App, refusing a key that is not a PEM before anything is sent (D-358, O-114, O-125)", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      // Each change mints its own narrow token first; refused, nothing is sent and nothing retried.
      for (const change of [
        await deps.bootstrapAccess.grant("x"),
        await deps.bootstrapAccess.remove("x"),
        await deps.bootstrapRuns.restart("x"),
      ]) {
        expect(change).toEqual({ kind: "refused", step: "token" });
      }
      await expect(deps.bootstrapAccess.list()).rejects.toThrow(GitHubAppJwtError);
      // Bootstrap's runs are read with the runner App's actions read token (D-267).
      await expect(deps.bootstrapRuns.latestRestart("x")).rejects.toThrow(
        GitHubAppJwtError,
      );
      expect([...new Set(secretsRead)]).toEqual([
        SECRET_PATHS.database,
        SECRET_PATHS.runnerAppPrivateKey,
      ]);
    } finally {
      await deps.close();
    }
  });

  it("builds a Council task from its bot file, reading its model key by path and the images once", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      const task = (await deps.tasks.taskFor(COUNCIL_START)) as {
        image: string;
        providers: { secretPath?: string }[];
        credentials: { models: Record<string, string>; githubToken?: string };
        task: { instructions: string; outputSchema?: unknown };
      };
      expect(task.image).toBe(`registry.example.com/foreman/claude-api${DIGEST}`);
      expect(task.providers.map((p) => p.secretPath)).toEqual([
        "projects/rehearsal/models/anthropic",
      ]);
      expect(Object.keys(task.credentials.models)).toEqual([
        "projects/rehearsal/models/anthropic",
      ]);
      expect(task.credentials.githubToken).toBeUndefined();
      expect(task.task.instructions).toBe(readBotFiles().council.instructions);
      expect(task.task.outputSchema).toEqual(COUNCIL_START.outputSchema);
      expect(secretsRead).toEqual([
        SECRET_PATHS.database,
        "projects/rehearsal/models/anthropic",
      ]);
    } finally {
      await deps.close();
    }
  });

  it("reads the cluster token only when an agent is started or polled", async () => {
    const { env, secretsRead } = fakeEnvironment({
      [VALUE_NAMES.clusterEndpoint]: "https://cluster.example.test",
      [VALUE_NAMES.clusterCaCertificate]: "not a certificate",
      [VALUE_NAMES.agentRunSettings]: "{}",
    });
    const deps = await compose(env);
    try {
      // The fake settings are incomplete, so building the runtime fails after the read.
      await expect(deps.runtime.poll({})).rejects.toThrow();
      expect(secretsRead).toEqual([SECRET_PATHS.database, SECRET_PATHS.clusterToken]);
    } finally {
      await deps.close();
    }
  });

  it("names a bad agent images value, never its content", async () => {
    for (const raw of ["{secret-ish", JSON.stringify(["not", "an", "object"])]) {
      const { env } = fakeEnvironment({ [VALUE_NAMES.agentImages]: raw });
      const deps = await compose(env);
      try {
        await expect(deps.tasks.taskFor(COUNCIL_START)).rejects.toThrow(
          /^agent_images (is not valid JSON|must be an object of image references)$/,
        );
      } finally {
        await deps.close();
      }
    }
  });

  it("has a Windmill binding that refuses outside a Windmill job, and composes nothing there (O-121)", async () => {
    // The binding itself is tested in ./windmill-binding.test.ts, with a fake fetch.
    const env = windmillEnvironment({ env: {} });
    await expect(env.secret(SECRET_PATHS.database)).rejects.toThrow(
      WindmillNotConfiguredError,
    );
    await expect(env.value(VALUE_NAMES.specVersion)).rejects.toThrow(
      WindmillNotConfiguredError,
    );
    await expect(env.executionsThisMonth()).rejects.toThrow(WindmillNotConfiguredError);
    await expect(compose(env)).rejects.toThrow(WindmillNotConfiguredError);
  });
});

/** Each App's key, generated for this test run only. */
const KEYS: Record<"runner" | "developer" | "designer" | "qa", TestAppKey> = {
  runner: testAppKey(),
  developer: testAppKey(),
  designer: testAppKey("pkcs8"),
  qa: testAppKey(),
};

const KEY_AT: Record<string, TestAppKey> = {
  [SECRET_PATHS.runnerAppPrivateKey]: KEYS.runner,
  [SECRET_PATHS.developerAppPrivateKey]: KEYS.developer,
  [SECRET_PATHS.designerAppPrivateKey]: KEYS.designer,
  [SECRET_PATHS.qaAppPrivateKey]: KEYS.qa,
};

/**
 * The Apps' token ports over a fake environment that holds each App's generated key (as Windmill
 * gives it back: CRLF line ends and a trailing newline) and its id, and fake HTTP ports that answer
 * as GitHub documents. Each mint answers with a new token, so a kept token would show.
 */
function appTokens(
  options: { failFirstKeyRead?: boolean; ids?: Record<string, string> } = {},
) {
  const secretsRead: string[] = [];
  const valuesRead: string[] = [];
  const gets: GitHubGetRequest[] = [];
  const posts: GitHubPostRequest[] = [];
  let failNext = options.failFirstKeyRead ?? false;
  const env: Pick<FlowEnvironment, "secret" | "value"> = {
    async secret(path) {
      secretsRead.push(path);
      const key = KEY_AT[path];
      if (key === undefined) throw new Error(`${path} is not stored`);
      if (failNext) {
        failNext = false;
        throw new Error("Windmill did not answer the read");
      }
      return `${key.privateKeyPem.replace(/\n/g, "\r\n")}\r\n`;
    },
    async value(name) {
      valuesRead.push(name);
      const value = { ...APP_IDS, ...options.ids }[name];
      if (value === undefined) throw new Error(`${name} is not set`);
      return value;
    },
  };
  const tokens = windmillGitHubAppTokens(
    env,
    { now: () => new Date(Date.UTC(2026, 10, 12, 9, 30, 0)) },
    {
      get: {
        async get(request) {
          gets.push(structuredClone(request));
          const body = { id: 88001, account: { login: "didi-build" } };
          return { status: 200, body: new TextEncoder().encode(JSON.stringify(body)) };
        },
      },
      post: {
        async post(request) {
          posts.push(structuredClone(request));
          const asked = request.body as {
            repositories: string[];
            permissions: Record<string, string>;
          };
          const body = {
            token: `fake-token-${posts.length}-not-real`,
            permissions: { ...asked.permissions, metadata: "read" },
            repository_selection: "selected",
            repositories: asked.repositories.map((name) => ({ name })),
          };
          return { status: 201, body: new TextEncoder().encode(JSON.stringify(body)) };
        },
      },
    },
  );
  return { tokens, secretsRead, valuesRead, gets, posts };
}

describe("the GitHub Apps' tokens from the flow environment (unit: flow layer, D-368, D-370, O-125)", () => {
  it("reads no App's key or id until a token is minted", () => {
    const f = appTokens();
    expect(Object.keys(f.tokens).sort()).toEqual([
      "bootstrap",
      "installation",
      "merge",
      "repositoryCreation",
      "runner",
    ]);
    expect([f.secretsRead, f.valuesRead, f.gets, f.posts]).toEqual([[], [], [], []]);
  });

  it("a runner token reads only the runner App's id, key and installation id, keeps the signer and never the token", async () => {
    const f = appTokens();
    const first = await f.tokens.runner.mint({
      repository: "didi-build/garden-notes",
      permission: "contents",
    });
    const second = await f.tokens.runner.mint({
      repository: "didi-build/garden-notes",
      permission: "actions",
    });
    // Each mint asks GitHub for a new token.
    expect([first, second]).toEqual(["fake-token-1-not-real", "fake-token-2-not-real"]);
    expect(f.posts.map((p) => [p.path, JSON.stringify(p.body)])).toEqual([
      [
        "/app/installations/4242/access_tokens",
        '{"repositories":["garden-notes"],"permissions":{"contents":"read"}}',
      ],
      [
        "/app/installations/4242/access_tokens",
        '{"repositories":["garden-notes"],"permissions":{"actions":"read"}}',
      ],
    ]);
    for (const post of f.posts) {
      const jwt = readJwt(post.token);
      expect(jwt.verifiedBy(KEYS.runner.publicKey)).toBe(true);
      expect(jwt.claims).toMatchObject({ iss: "1001" });
    }
    // Read once, for the whole flow.
    expect(f.secretsRead).toEqual([SECRET_PATHS.runnerAppPrivateKey]);
    expect(f.valuesRead).toEqual([
      VALUE_NAMES.runnerAppInstallationId,
      VALUE_NAMES.runnerAppId,
    ]);
    expect(f.gets).toEqual([]);
  });

  it("the runner's client reads with pull_requests or checks at read, and merges with contents write alone (D-381)", async () => {
    const f = appTokens();
    await f.tokens.runner.mint({
      repository: "didi-build/garden-notes",
      permission: "pull_requests",
    });
    await f.tokens.runner.mint({
      repository: "didi-build/garden-notes",
      permission: "checks",
    });
    expect(await f.tokens.merge.mint("didi-build/garden-notes")).toBe(
      "fake-token-3-not-real",
    );
    expect(f.posts.map((p) => [p.path, JSON.stringify(p.body)])).toEqual([
      [
        "/app/installations/4242/access_tokens",
        '{"repositories":["garden-notes"],"permissions":{"pull_requests":"read"}}',
      ],
      [
        "/app/installations/4242/access_tokens",
        '{"repositories":["garden-notes"],"permissions":{"checks":"read"}}',
      ],
      [
        "/app/installations/4242/access_tokens",
        '{"repositories":["garden-notes"],"permissions":{"contents":"write"}}',
      ],
    ]);
    for (const post of f.posts) {
      expect(readJwt(post.token).verifiedBy(KEYS.runner.publicKey)).toBe(true);
    }
    expect(f.secretsRead).toEqual([SECRET_PATHS.runnerAppPrivateKey]);
    // A merge token for a repository outside didi-build reads no key and sends nothing.
    const refused = appTokens();
    await expect(refused.tokens.merge.mint("octo-org/x")).rejects.toThrow(
      "The runner App's merge token is only for a repository of didi-build",
    );
    expect([refused.secretsRead, refused.posts]).toEqual([[], []]);
  });

  it("the creation and BOOTSTRAP_TOKEN access tokens use the same runner App, read once", async () => {
    const f = appTokens();
    await f.tokens.repositoryCreation.mint();
    await f.tokens.bootstrap.secretsChange("garden-notes");
    await f.tokens.bootstrap.secretsList();
    await f.tokens.bootstrap.restart("garden-notes");
    expect(f.posts.map((p) => JSON.stringify(p.body))).toEqual([
      '{"repositories":["launchpad"],"permissions":{"contents":"read","repository_creation":"write"}}',
      '{"repositories":["garden-notes"],"permissions":{"organization_secrets":"write","metadata":"read"}}',
      '{"repositories":["foreman"],"permissions":{"organization_secrets":"read"}}',
      '{"repositories":["garden-notes"],"permissions":{"actions":"write"}}',
    ]);
    for (const post of f.posts) {
      expect(readJwt(post.token).verifiedBy(KEYS.runner.publicKey)).toBe(true);
    }
    expect(f.secretsRead).toEqual([SECRET_PATHS.runnerAppPrivateKey]);
  });

  it.each([
    [
      "developer",
      "write",
      SECRET_PATHS.developerAppPrivateKey,
      VALUE_NAMES.developerAppId,
      "2001",
    ],
    [
      "designer",
      "write",
      SECRET_PATHS.designerAppPrivateKey,
      VALUE_NAMES.designerAppId,
      "2002",
    ],
    ["qa", "read", SECRET_PATHS.qaAppPrivateKey, VALUE_NAMES.qaAppId, "2003"],
  ] as const)(
    "a %s run's token reads only that App's id and key, and is signed by that App alone",
    async (role, access, keyPath, idName, appId) => {
      const f = appTokens();
      const request = {
        role,
        repository: "didi-build/garden-notes",
        access,
        runId: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
      } as const;
      expect(await f.tokens.installation.mint(request)).toBe("fake-token-1-not-real");
      expect(await f.tokens.installation.mint(request)).toBe("fake-token-2-not-real");
      expect(f.secretsRead).toEqual([keyPath]);
      expect(f.valuesRead).toEqual([idName]);
      expect(f.gets.map((g) => g.path)).toEqual([
        "/repos/didi-build/garden-notes/installation",
        "/repos/didi-build/garden-notes/installation",
      ]);
      expect(f.posts.map((p) => p.path)).toEqual([
        "/app/installations/88001/access_tokens",
        "/app/installations/88001/access_tokens",
      ]);
      for (const token of [...f.gets, ...f.posts].map((r) => r.token)) {
        const jwt = readJwt(token);
        expect(jwt.claims).toMatchObject({ iss: appId });
        for (const [other, key] of Object.entries(KEYS)) {
          expect(jwt.verifiedBy(key.publicKey), other).toBe(other === role);
        }
      }
    },
  );

  it("a refused request reads no key and sends nothing", async () => {
    const f = appTokens();
    await expect(
      f.tokens.installation.mint({
        role: "qa",
        repository: "didi-build/garden-notes",
        access: "write",
        runId: "r",
      }),
    ).rejects.toThrow(InstallationTokenError);
    await expect(
      f.tokens.runner.mint({ repository: "octo-org/x", permission: "contents" }),
    ).rejects.toThrow(RunnerAppTokenError);
    await expect(f.tokens.bootstrap.restart("a/b")).rejects.toThrow(/repository name/);
    expect(f.secretsRead).toEqual([]);
    expect([f.gets, f.posts]).toEqual([[], []]);
  });

  it("refuses an App id or installation id that is not a number before anything is sent", async () => {
    const badId = appTokens({ ids: { [VALUE_NAMES.developerAppId]: "20O1" } });
    await expect(
      badId.tokens.installation.mint({
        role: "developer",
        repository: "didi-build/garden-notes",
        access: "write",
        runId: "r",
      }),
    ).rejects.toThrow(
      new GitHubAppJwtError("The Developer App's id is not a positive whole number"),
    );
    expect([badId.gets, badId.posts]).toEqual([[], []]);
    const badInstallation = appTokens({
      ids: { [VALUE_NAMES.runnerAppInstallationId]: "" },
    });
    await expect(badInstallation.tokens.repositoryCreation.mint()).rejects.toThrow(
      /the installation id is not a positive number/,
    );
    expect(badInstallation.secretsRead).toEqual([]);
    expect(badInstallation.posts).toEqual([]);
  });

  it("tries a failed key read again on the next token, and keeps the signer once made", async () => {
    const f = appTokens({ failFirstKeyRead: true });
    const request = {
      repository: "didi-build/garden-notes",
      permission: "contents",
    } as const;
    await expect(f.tokens.runner.mint(request)).rejects.toThrow(
      "Windmill did not answer the read",
    );
    expect(f.posts).toEqual([]);
    expect(await f.tokens.runner.mint(request)).toBe("fake-token-1-not-real");
    await f.tokens.runner.mint(request);
    expect(f.secretsRead).toEqual([
      SECRET_PATHS.runnerAppPrivateKey,
      SECRET_PATHS.runnerAppPrivateKey,
    ]);
  });

  it("lists every App's key path and id name among what the composition reads", () => {
    expect(Object.values(SECRET_PATHS)).toEqual(expect.arrayContaining(APP_KEY_PATHS));
    expect(Object.values(VALUE_NAMES)).toEqual(
      expect.arrayContaining(Object.keys(APP_IDS)),
    );
  });
});

describe("approval page reply (unit: flow layer, M0.4, D-200, D-254)", () => {
  it.each([
    ["Approve", "approve"],
    ["Request changes", "changes_requested"],
    ["Reject", "reject"],
  ] as const)(
    "reads the form's %s with its options and Didi's feedback exactly as typed",
    (label, choice) => {
      expect(
        readApprovalReply(
          { decision: label, options: ["a", "b"], feedback: " as typed " },
          ["anonymous", 3],
        ),
      ).toEqual({
        answered: true,
        choice,
        words: " as typed ",
        approvers: ["anonymous"],
        options: ["a", "b"],
      });
    },
  );

  it("reads Didi's optional size call on a visual approval, and leaves it out when skipped (D-278)", () => {
    expect(
      readApprovalReply({ decision: "Approve", small_tweak: "Yes, a small tweak" }, []),
    ).toMatchObject({ answered: true, smallTweak: true });
    expect(
      readApprovalReply(
        { decision: "Reject", feedback: "No.", small_tweak: "No, not a small tweak" },
        [],
      ),
    ).toMatchObject({ answered: true, smallTweak: false });
    expect(readApprovalReply({ decision: "Approve" }, [])).not.toHaveProperty(
      "smallTweak",
    );
    expect(
      readApprovalReply({ decision: "Approve", small_tweak: "maybe" }, []),
    ).not.toHaveProperty("smallTweak");
  });

  it("reads a form with no options or no feedback, and refuses options that are not names", () => {
    expect(readApprovalReply({ decision: "Approve" }, [])).toEqual({
      answered: true,
      choice: "approve",
      words: null,
      approvers: [],
      options: [],
    });
    expect(
      readApprovalReply({ decision: "Approve", options: "a", feedback: "x" }, []),
    ).toMatchObject({ answered: false, reason: "bad_options", replyVerbatim: "x" });
    expect(readApprovalReply({ decision: "Approve", options: [3] }, [])).toMatchObject({
      answered: false,
      reason: "bad_options",
    });
    // The older form's label is not one of the Decision field's.
    expect(
      readApprovalReply({ decision: "Changes requested", feedback: "x" }, []),
    ).toMatchObject({ answered: false, reason: "no_choice" });
  });

  it.each([
    ["Approve", "approve"],
    ["Reject", "reject"],
    ["Changes requested", "changes_requested"],
  ] as const)(
    "still reads the older form's %s for a request opened before D-254",
    (label, choice) => {
      expect(
        readApprovalReply({ answer: label, reply: " as typed " }, ["anonymous", 3]),
      ).toEqual({
        answered: true,
        choice,
        words: " as typed ",
        approvers: ["anonymous"],
        options: [],
      });
    },
  );

  it("reads the older form's option name as its one option (D-242, O-66)", () => {
    expect(
      readApprovalReply({ answer: "Approve", reply: "a", option: "a" }, ["anonymous"]),
    ).toMatchObject({ answered: true, options: ["a"] });
    expect(
      readApprovalReply({ answer: "Approve", reply: "a", option: 3 }, []),
    ).toMatchObject({ answered: true, options: [] });
  });

  it("reads a timeout, and a form with no known answer, as no answer, keeping any words", () => {
    expect(readApprovalReply({ error: { name: "timeout" } }, null)).toEqual({
      answered: false,
      reason: "timeout",
      replyVerbatim: null,
      approvers: [],
    });
    expect(readApprovalReply({ reply: "yes" }, [])).toEqual({
      answered: false,
      reason: "no_choice",
      replyVerbatim: "yes",
      approvers: [],
    });
    expect(readApprovalReply({ answer: "toString", reply: "x" }, [])).toMatchObject({
      answered: false,
      reason: "no_choice",
    });
    expect(readApprovalReply(null, [])).toMatchObject({ answered: false });
  });
});
