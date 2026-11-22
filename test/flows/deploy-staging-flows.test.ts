// Seam: the staging deploy in the flows (flow, D-353, D-356, O-116) on the memory store, through the
// flow layer's deps (`flowDepsFor`): the called flow `f/foreman/deploy_staging` with the real
// deploy adapter (the file-set check and Cloudflare's three upload calls, with a Worker module and
// its inherited `DB` for a build in the new layout, O-159, O-160) behind a fake HTTP port and
// fake credentials, on a real zip;
// the same with the composition's credential port, which refuses until Didi creates the token,
// so nothing is sent, nothing counts and the daily check shows the deploy that did not go through; and with the runner's own GitHub reads and no runner
// App key stored, so the token is refused before anything is sent. A build that requires a secret
// the staging Worker does not have is held after the secret list and before any upload, the daily
// check names the secret and the Set project secret form, and the backstop deploys once the
// secret is set (D-448, O-163). A build with D1 migrations has the new ones applied with the D1
// token before the upload, a second deploy applies none, and a migration the database refuses
// as SQL sends the item back with one failure and uploads nothing (O-165). Synthetic data only;
// nothing reaches GitHub, Cloudflare or Windmill.
import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { run as deployStaging } from "../../flows/deploy-staging.ts";
import { stagingDeploysOf } from "../../flows/lib/staging-deploys.ts";
import {
  runnerStagingBuilds,
  unbuiltStagingDeployCredentials,
  windmillD1Credentials,
} from "../../flows/lib/compose.ts";
import {
  createCloudflareStagingTarget,
  type CloudflareAnswer,
  type CloudflareRequest,
} from "../../src/adapters/deploy/cloudflare-staging.ts";
import { mainBuild } from "../../src/adapters/deploy/fake.ts";
import { REPO } from "../reconcile-fixture.ts";
import { setupStaging } from "../staging-fixture.ts";
import { storedZip } from "../zip-fixture.ts";
import { appTokensWithoutKeys, flowDepsFor } from "./flow-fixture.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

/**
 * The D1 token's port with nothing stored: a deploy of a build without migrations never reads it
 * (O-160, O-165).
 */
const noD1Credentials = windmillD1Credentials({
  secret: async (path) => {
    throw new Error(`a deploy read ${path}`);
  },
});

/** A made-up id of the project's staging database. */
const DB_ID = "11111111-2222-4333-8444-555555555555";

/**
 * A fake Cloudflare that holds no file yet and accepts every upload, and lists the staging
 * Worker's secrets by name (names only, as "List secrets bound to a Worker script" gives them).
 * It holds the project's staging database, whose `d1_migrations` it keeps as D1 would, refusing a
 * migration whose text holds `CREAT TABLE` as SQL (400, code 7500) and recording nothing then.
 */
function fakeCloudflare() {
  const sent: CloudflareRequest[] = [];
  const secrets = new Set<string>();
  const migrations: string[] = [];
  return {
    sent,
    secrets,
    migrations,
    http: {
      async send(request: CloudflareRequest): Promise<CloudflareAnswer> {
        sent.push(request);
        const ok = (result: unknown, status = 200) => ({
          status,
          body: { success: true, result },
        });
        if (request.method === "GET" && request.path.includes("/d1/database?")) {
          return ok([{ name: "rehearsal-staging", uuid: DB_ID }]);
        }
        if (request.path.endsWith(`/d1/database/${DB_ID}/query`)) {
          const { sql } = request.json as { sql: string };
          const name = /values \('([^']+)'\);$/.exec(sql)?.[1];
          if (sql.startsWith("SELECT name")) {
            return ok([
              { success: true, results: migrations.map((n) => ({ name: n })) },
            ]);
          }
          if (name && sql.includes("CREAT TABLE")) {
            return { status: 400, body: { success: false, errors: [{ code: 7500 }] } };
          }
          if (name) migrations.push(name);
          return ok([{ success: true, results: [] }]);
        }
        if (request.method === "GET" && request.path.endsWith("/secrets")) {
          return ok([...secrets].map((name) => ({ name, type: "secret_text" })));
        }
        if (request.path.endsWith("/assets-upload-session")) {
          const manifest = (
            request.json as { manifest: Record<string, { hash: string }> }
          ).manifest;
          return ok({
            jwt: "fake.session.jwt",
            buckets: [Object.values(manifest).map((m) => m.hash)],
          });
        }
        if (request.path.includes("/workers/assets/upload")) {
          return ok({ jwt: "fake.completion.jwt" }, 201);
        }
        return ok({ id: "rehearsal-staging" });
      },
    },
  };
}

/** The D1 token's port with a made-up token stored (O-165). */
const d1Stored = windmillD1Credentials({
  secret: async (path) =>
    path.endsWith("account-id") ? ACCOUNT : "fake-d1-token-for-tests-0123456789",
});

/** A build in the new layout that requires no secret, with these migration files. */
const migrationsBuild = (commit: string, files: Record<string, string>) =>
  storedZip([
    {
      name: "foreman-deploy.json",
      data: JSON.stringify({
        schema: 1,
        compatibilityDate: "2026-10-26",
        compatibilityFlags: [],
        requiredSecrets: [],
      }),
    },
    { name: "assets/foreman-commit.txt", data: `${commit}\n` },
    { name: "assets/index.html", data: "<!doctype html><title>Rehearsal</title>" },
    { name: "worker/index.js", data: "export default { fetch() {} };" },
    ...Object.entries(files).map(([name, data]) => ({
      name: `migrations/${name}`,
      data,
    })),
  ]);

const site = (commit: string, extra: { name: string; data: string }[] = []) =>
  storedZip([
    { name: "foreman-commit.txt", data: `${commit}\n` },
    {
      name: "index.html",
      data: "<!doctype html><title>Rehearsal</title>",
      deflate: true,
    },
    ...extra,
  ]);

async function flow(d1Credentials = noD1Credentials) {
  const t = await setupStaging();
  const cloudflare = fakeCloudflare();
  const target = createCloudflareStagingTarget({
    credentials: {
      read: async () => ({
        accountId: ACCOUNT,
        token: "fake-token-for-tests-0123456789",
      }),
    },
    d1Credentials,
    http: cloudflare.http,
  });
  const parts = flowDepsFor(t.deps, t.checker, { builds: t.builds });
  const deps = { ...parts.deps, stagingTarget: target };
  return { t, deps, cloudflare };
}

describe("the staging deploy flow (flow: the real deploy adapter, fake HTTP, O-116)", () => {
  it("checks CI's build, uploads it in Cloudflare's three calls, records the deploy and moves the item to Done", async () => {
    const { t, deps, cloudflare } = await flow();
    t.builds.putRun(REPO, mainBuild(REPO, 31, t.mergeSha), site(t.mergeSha));
    const result = await deployStaging(deps, { repo: REPO, runId: 31 });
    expect(result).toMatchObject({
      outcome: "done",
      deploy: {
        step: "deployed",
        files: 2,
        covers: [t.node.id],
        verified: [{ move: { toState: "done", outcome: "applied" } }],
      },
    });
    expect(
      cloudflare.sent.map((r) => `${r.method} ${r.path.split("/").slice(3).join("/")}`),
    ).toEqual([
      "POST workers/scripts/rehearsal-staging/assets-upload-session",
      "POST workers/assets/upload?base64=true",
      "PUT workers/scripts/rehearsal-staging",
    ]);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
    expect(await t.state()).toBe("done");
  });

  it("uploads a build with a Worker module in the same three calls, inheriting DB strictly, and the check then probes the Worker (O-159, O-160)", async () => {
    const { t, deps, cloudflare } = await flow();
    cloudflare.secrets.add("MODEL_API_KEY");
    const archive = storedZip([
      {
        name: "foreman-deploy.json",
        data: JSON.stringify({
          schema: 1,
          compatibilityDate: "2026-10-26",
          compatibilityFlags: [],
          requiredSecrets: ["MODEL_API_KEY"],
        }),
      },
      { name: "assets/foreman-commit.txt", data: `${t.mergeSha}\n` },
      { name: "assets/index.html", data: "<!doctype html><title>Rehearsal</title>" },
      { name: "worker/index.js", data: "export default { fetch() {} };" },
    ]);
    t.builds.putRun(REPO, mainBuild(REPO, 36, t.mergeSha), archive);
    const result = await deployStaging(deps, { repo: REPO, runId: 36 });
    expect(result).toMatchObject({
      outcome: "done",
      deploy: {
        step: "deployed",
        files: 2,
        worker: { requiredSecrets: ["MODEL_API_KEY"] },
        verified: [{ move: { toState: "done", outcome: "applied" } }],
      },
    });
    // The secret list first (D-448), then the same three upload calls.
    expect(
      cloudflare.sent.map((r) => `${r.method} ${r.path.split("/").slice(3).join("/")}`),
    ).toEqual([
      "GET workers/scripts/rehearsal-staging/secrets",
      "POST workers/scripts/rehearsal-staging/assets-upload-session",
      "POST workers/assets/upload?base64=true",
      "PUT workers/scripts/rehearsal-staging?bindings_inherit=strict",
    ]);
    expect(cloudflare.sent[3]?.form?.map((part) => part.name)).toEqual([
      "metadata",
      "index.js",
    ]);
    expect(t.checker.calls.map((c) => c.worker)).toEqual([true]);
  });

  it("holds a build whose required secret is not set, after the secret list and before any upload; the daily check names it and the form, and the next pass deploys once it is set (D-448, O-163)", async () => {
    const { t, deps, cloudflare } = await flow();
    const archive = storedZip([
      {
        name: "foreman-deploy.json",
        data: JSON.stringify({
          schema: 1,
          compatibilityDate: "2026-10-26",
          compatibilityFlags: [],
          requiredSecrets: ["MODEL_API_KEY"],
        }),
      },
      { name: "assets/foreman-commit.txt", data: `${t.mergeSha}\n` },
      { name: "assets/index.html", data: "<!doctype html><title>Rehearsal</title>" },
      { name: "worker/index.js", data: "export default { fetch() {} };" },
    ]);
    t.builds.putRun(REPO, mainBuild(REPO, 37, t.mergeSha), archive);
    const held = await deployStaging(deps, { repo: REPO, runId: 37 });
    expect(held).toMatchObject({
      outcome: "done",
      deploy: {
        step: "refused_infrastructure",
        reason: "secrets_missing",
        missingSecrets: ["MODEL_API_KEY"],
        covers: [t.node.id],
        verified: [],
      },
      builderRuns: [],
    });
    expect(
      cloudflare.sent.map((r) => `${r.method} ${r.path.split("/").at(-1)}`),
    ).toEqual(["GET secrets"]);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.counter("failure")).toBe(0);
    const { text } = (await dailyCheck(deps)).render_all[1].json;
    expect(text).toContain(
      ": the build needs product secrets not set on the staging Worker: MODEL_API_KEY. Set each with the Set project secret form. Counted as no failure; the reconcile pass tries again",
    );
    // Didi sets it with the form (on Cloudflare here); the reconcile pass's backstop deploys.
    cloudflare.secrets.add("MODEL_API_KEY");
    const [step] = await stagingDeploysOf(deps).backstop();
    expect(step).toMatchObject({
      step: "deploy",
      deploy: { step: "deployed", verified: [{ move: { toState: "done" } }] },
    });
    expect(cloudflare.sent.at(-1)?.path).toMatch(
      /\/workers\/scripts\/rehearsal-staging\?bindings_inherit=strict$/,
    );
    expect(await t.counter("failure")).toBe(0);
  });

  it("applies a build's new D1 migrations with the D1 token before the upload, and a second deploy applies none (O-165)", async () => {
    const { t, deps, cloudflare } = await flow(d1Stored);
    const archive = migrationsBuild(t.mergeSha, {
      "0001_init.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY);",
    });
    t.builds.putRun(REPO, mainBuild(REPO, 38, t.mergeSha), archive);
    expect(await deployStaging(deps, { repo: REPO, runId: 38 })).toMatchObject({
      outcome: "done",
      deploy: {
        step: "deployed",
        migrationsApplied: ["0001_init.sql"],
        verified: [{ move: { toState: "done", outcome: "applied" } }],
      },
    });
    const query = `POST d1/database/${DB_ID}/query`;
    expect(
      cloudflare.sent.map((r) => `${r.method} ${r.path.split("/").slice(3).join("/")}`),
    ).toEqual([
      "GET d1/database?name=rehearsal-staging&per_page=100",
      query,
      query,
      query,
      "POST workers/scripts/rehearsal-staging/assets-upload-session",
      "POST workers/assets/upload?base64=true",
      "PUT workers/scripts/rehearsal-staging?bindings_inherit=strict",
    ]);
    expect(
      cloudflare.sent.filter((r) => r.path.includes("/d1/")).map((r) => r.bearer),
    ).toEqual(Array(4).fill("fake-d1-token-for-tests-0123456789"));
    expect(cloudflare.migrations).toEqual(["0001_init.sql"]);
    // The next build of the same files applies nothing, and still uploads.
    t.builds.putRun(REPO, mainBuild(REPO, 39, t.mergeSha), archive);
    const sentBefore = cloudflare.sent.length;
    expect(await deployStaging(deps, { repo: REPO, runId: 39 })).toMatchObject({
      deploy: { step: "deployed", migrationsApplied: [] },
    });
    expect(
      cloudflare.sent.slice(sentBefore).filter((r) => r.path.endsWith("/query")),
    ).toHaveLength(2);
    expect(cloudflare.migrations).toEqual(["0001_init.sql"]);
  });

  it("sends the item back with one failure when the database refuses a migration as SQL, naming the file and uploading nothing (O-165)", async () => {
    const { t, deps, cloudflare } = await flow(d1Stored);
    t.builds.putRun(
      REPO,
      mainBuild(REPO, 40, t.mergeSha),
      migrationsBuild(t.mergeSha, {
        "0001_broken.sql": "CREAT TABLE broken (id INTEGER);",
      }),
    );
    expect(await deployStaging(deps, { repo: REPO, runId: 40 })).toMatchObject({
      outcome: "done",
      deploy: {
        step: "refused_file_set",
        reason: "migration_failed",
        text: "the migration 0001_broken.sql failed on the staging database; nothing after it was applied or uploaded",
        detail: { call: "migration_apply", status: 400, codes: [7500] },
        verified: [{ step: "deploy_failed", move: { toState: "in_development" } }],
      },
    });
    expect(cloudflare.sent.some((r) => r.path.includes("/workers/"))).toBe(false);
    expect(cloudflare.migrations).toEqual([]);
    expect(await t.state()).toBe("in_development");
    expect(await t.counter("failure")).toBe(1);
  });

  it("refuses a build with _worker.js before anything is sent, and sends the item back with one failure", async () => {
    const { t, deps, cloudflare } = await flow();
    t.builds.putRun(
      REPO,
      mainBuild(REPO, 32, t.mergeSha),
      site(t.mergeSha, [{ name: "_worker.js", data: "export default {}" }]),
    );
    const result = await deployStaging(deps, { repo: REPO, runId: 32 });
    expect(result).toMatchObject({
      outcome: "done",
      deploy: {
        step: "refused_file_set",
        reason: "worker_code",
        verified: [{ step: "deploy_failed", move: { toState: "in_development" } }],
      },
    });
    expect(cloudflare.sent).toEqual([]);
    expect(await t.state()).toBe("in_development");
    expect(await t.counter("failure")).toBe(1);
  });

  it("with the composition's credential port, sends nothing, counts nothing, and the daily check shows it", async () => {
    const t = await setupStaging();
    const cloudflare = fakeCloudflare();
    const parts = flowDepsFor(t.deps, t.checker, { builds: t.builds });
    const deps = {
      ...parts.deps,
      stagingTarget: createCloudflareStagingTarget({
        credentials: unbuiltStagingDeployCredentials(),
        d1Credentials: noD1Credentials,
        http: cloudflare.http,
      }),
    };
    t.builds.putRun(REPO, mainBuild(REPO, 33, t.mergeSha), site(t.mergeSha));
    expect(await deployStaging(deps, { repo: REPO, runId: 33 })).toMatchObject({
      outcome: "done",
      deploy: {
        step: "refused_infrastructure",
        reason: "credential_unavailable",
        covers: [t.node.id],
        verified: [],
      },
      builderRuns: [],
    });
    expect(cloudflare.sent).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.counter("failure")).toBe(0);
    const { text } = (await dailyCheck(deps)).render_all[1].json;
    expect(text).toContain("the staging deploy did not go through at 2026-");
    expect(text).toContain(
      ": the staging deploy credential is not available. Counted as no failure; the reconcile pass tries again",
    );
  });

  it("with the runner's own GitHub reads and no runner App key stored, refuses on the runner App's token and records nothing", async () => {
    const t = await setupStaging();
    const parts = flowDepsFor(t.deps, t.checker);
    const apps = appTokensWithoutKeys();
    const deps = { ...parts.deps, stagingBuilds: runnerStagingBuilds(apps.runner) };
    expect(await deployStaging(deps, { repo: REPO, runId: 34 })).toMatchObject({
      outcome: "done",
      deploy: { step: "refused_infrastructure", reason: "run_unreadable" },
    });
    expect(parts.stagingTarget.deploys).toEqual([]);
    expect(await t.kind("staging_deploy_failed")).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(apps.sent).toEqual([]);
  });

  it("in dry run says what it would deploy, and under the kill switch refuses, uploading nothing either way", async () => {
    const { t, deps, cloudflare } = await flow();
    t.builds.putRun(REPO, mainBuild(REPO, 35, t.mergeSha), site(t.mergeSha));
    await t.setting("dry_run", true);
    expect(await deployStaging(deps, { repo: REPO, runId: 35 })).toMatchObject({
      outcome: "done",
      deploy: { step: "would_deploy", commitSha: t.mergeSha, covers: [t.node.id] },
    });
    await t.setting("kill_switch", true);
    expect(await deployStaging(deps, { repo: REPO, runId: 35 })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(cloudflare.sent).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
  });
});
