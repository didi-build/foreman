// Seam: the staging deploy in the flows (flow, D-353, D-356, O-116) on the memory store, through the
// flow layer's deps (`flowDepsFor`): the called flow `f/foreman/deploy_staging` with the real
// deploy adapter (the file-set check and Cloudflare's three upload calls) behind a fake HTTP port
// and fake credentials, on a real zip; the same with the composition's credential port, which
// refuses until Didi creates the token, so nothing is sent, nothing counts and the daily check
// shows the deploy that did not go through; and with the runner's own GitHub reads, which refuse
// until the runner App exists. Synthetic data only; nothing reaches GitHub, Cloudflare or Windmill.
import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { run as deployStaging } from "../../flows/deploy-staging.ts";
import {
  runnerStagingBuilds,
  unbuiltStagingDeployCredentials,
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
import { flowDepsFor } from "./flow-fixture.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

/** A fake Cloudflare that holds no file yet and accepts every upload. */
function fakeCloudflare() {
  const sent: CloudflareRequest[] = [];
  return {
    sent,
    http: {
      async send(request: CloudflareRequest): Promise<CloudflareAnswer> {
        sent.push(request);
        const ok = (result: unknown, status = 200) => ({
          status,
          body: { success: true, result },
        });
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

async function flow() {
  const t = await setupStaging();
  const cloudflare = fakeCloudflare();
  const target = createCloudflareStagingTarget({
    credentials: {
      read: async () => ({
        accountId: ACCOUNT,
        token: "fake-token-for-tests-0123456789",
      }),
    },
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

  it("with the runner's own GitHub reads, refuses on the runner App's token and records nothing", async () => {
    const t = await setupStaging();
    const parts = flowDepsFor(t.deps, t.checker);
    const deps = { ...parts.deps, stagingBuilds: runnerStagingBuilds() };
    expect(await deployStaging(deps, { repo: REPO, runId: 34 })).toMatchObject({
      outcome: "done",
      deploy: { step: "refused_infrastructure", reason: "run_unreadable" },
    });
    expect(parts.stagingTarget.deploys).toEqual([]);
    expect(await t.kind("staging_deploy_failed")).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
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
