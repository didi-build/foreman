// Seam: the reconcile flow (build plan M3.1, architecture section 2.5) with fake adapters on the
// memory store. The pass itself is tested in test/reconcile.test.ts; this covers what the flow
// adds: the execution count from the composition layer and one result per run, the live
// staging pass's deploy waits on the attention count (D-225), and the staging deploy backstop
// before it (O-116).
import { describe, expect, it } from "vitest";

import { run } from "../../flows/reconcile.ts";
import { run as deployStaging } from "../../flows/deploy-staging.ts";
import type { FlowDeps } from "../../flows/lib/compose.ts";
import {
  createFakeStagingBuilds,
  createFakeStagingTarget,
} from "../../src/adapters/deploy/fake.ts";
import { createFakeBootstrap } from "../../src/adapters/github/bootstrap-fake.ts";
import { setupMerge } from "../merge-fixture.ts";
import { stalledItems, stalledRuns } from "../../src/core/stalls.ts";
import { HEAD, REPO } from "../reconcile-fixture.ts";
import { createFakeStagingChecker, setupStaging } from "../staging-fixture.ts";
import { createFlowFixture } from "./flow-fixture.ts";

async function withRelease() {
  const f = await createFlowFixture();
  const blocker = await f.node("done");
  const blocked = await f.node("blocked");
  await f.blocks(blocker.id, blocked.id);
  return { f, blocked };
}

describe("reconcile flow (flow: fake adapters, build plan M3.1)", () => {
  it("runs one dry-run pass and checks the execution count against the D-167 limit", async () => {
    const { f, blocked } = await withRelease();
    const result = await run(f.deps);
    expect(result).toMatchObject({
      stopped: null,
      planned: { releases: 1 },
      executions: { count: 120, threshold: 800, alert: false },
      problems: [],
    });
    expect((await f.transitions(blocked.id)).map((t) => t.toState)).toEqual([
      "ready_for_dev",
    ]);

    f.setExecutions(800);
    expect((await run(f.deps)).executions).toMatchObject({ count: 800, alert: true });
  });

  it("writes only dry-run rows, and the node never moves", async () => {
    const { f, blocked } = await withRelease();
    await run(f.deps);
    const rows = await f.transitions(blocked.id);
    expect(rows.map((t) => t.mode)).toEqual(["dry_run"]);
    expect((await f.store.getNode(blocked.id))?.state).toBe("blocked");
    expect(await f.store.listActiveRuns()).toEqual([]);
  });

  it("writes nothing under the kill switch", async () => {
    const { f, blocked } = await withRelease();
    await f.killed();
    const before = await f.footprint(blocked.id);
    expect((await run(f.deps)).stopped).toBe("kill_switch");
    expect(await f.footprint(blocked.id)).toBe(before);
  });

  it("writes one transition for a duplicate trigger", async () => {
    const { f, blocked } = await withRelease();
    await run(f.deps);
    await run(f.deps);
    expect(await f.transitions(blocked.id)).toHaveLength(1);
  });

  it("still runs the pass when the execution count cannot be read, and says so", async () => {
    const { f } = await withRelease();
    f.setExecutions(null);
    const result = await run(f.deps);
    expect(result.executions).toBeNull();
    expect(result.planned.releases).toBe(1);
    expect(result.problems).toEqual([
      "the Windmill execution count could not be read: no alert check",
    ]);
  });

  it("in live mode runs the merge pass: it merges a passed PR once, and later passes merge nothing", async () => {
    const t = await setupMerge();
    await t.passedOn(HEAD);
    const notUsed = async (): Promise<never> => {
      throw new Error("the merge pass starts no agent");
    };
    const deps: FlowDeps = {
      ...t.deps,
      runtime: { start: notUsed, poll: notUsed, cancel: notUsed },
      stagingChecker: createFakeStagingChecker(),
      stagingBuilds: createFakeStagingBuilds(),
      stagingTarget: createFakeStagingTarget(),
      screenshots: { read: notUsed },
      repoFolders: { folderId: notUsed },
      repoMaps: { read: notUsed },
      repoScans: { scan: notUsed },
      projectSettings: { listedSlugs: notUsed },
      projectRepositories: { generate: notUsed, read: notUsed },
      bootstrapAccess: createFakeBootstrap(),
      bootstrapRuns: createFakeBootstrap(),
      tasks: { taskFor: notUsed },
      newRunToken: () => "not-used",
      executionsThisMonth: async () => 120,
      close: async () => undefined,
    };
    const first = await run(deps);
    expect(first).toMatchObject({ mode: "live", stopped: null });
    expect(first.merged).toMatchObject([
      { nodeId: t.node.id, result: { outcome: "applied" } },
    ]);
    expect((await run(deps)).merged).toEqual([]);
    expect(t.github.merges).toHaveLength(1);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("runs no merge pass in dry run", async () => {
    const { f } = await withRelease();
    expect((await run(f.deps)).merged).toBeNull();
  });
});

/** Flow deps around the staging fixture: no agent is started by these flows. */
function stagingFlowDeps(t: Awaited<ReturnType<typeof setupStaging>>): FlowDeps {
  const notUsed = async (): Promise<never> => {
    throw new Error("the staging pass starts no agent");
  };
  return {
    ...t.deps,
    runtime: { start: notUsed, poll: notUsed, cancel: notUsed },
    stagingChecker: t.checker,
    stagingBuilds: t.builds,
    stagingTarget: t.target,
    screenshots: { read: notUsed },
    repoFolders: { folderId: notUsed },
    repoMaps: { read: notUsed },
    repoScans: { scan: notUsed },
    projectSettings: { listedSlugs: notUsed },
    projectRepositories: { generate: notUsed, read: notUsed },
    bootstrapAccess: createFakeBootstrap(),
    bootstrapRuns: createFakeBootstrap(),
    tasks: { taskFor: notUsed },
    newRunToken: () => "not-used",
    executionsThisMonth: async () => 120,
    close: async () => undefined,
  };
}

describe("staging in the flows (flow: fake adapters, build plan M3.4)", () => {
  it("the reconcile flow in live mode runs the staging pass after the merge pass, once", async () => {
    const t = await setupStaging();
    await t.deploy();
    const deps = stagingFlowDeps(t);
    const first = await run(deps);
    expect(first.verified).toMatchObject([
      {
        nodeId: t.node.id,
        step: "checked",
        move: { toState: "done", outcome: "applied" },
      },
    ]);
    expect((await run(deps)).verified).toEqual([]);
    expect(t.checker.calls).toHaveLength(1);
  });

  it("the reconcile flow in live mode counts an item past the staging deploy wait on the attention list (D-225)", async () => {
    const t = await setupStaging();
    const deps = stagingFlowDeps(t);
    t.advanceMinutes(60);
    expect(await run(deps)).toMatchObject({ attention: 0, stagingWaits: [] });
    t.advanceMinutes(1);
    expect(await run(deps)).toMatchObject({
      attention: 1,
      stagingWaits: [{ nodeId: t.node.id, waitedMinutes: 61, limitMinutes: 60 }],
      problems: [],
    });
  });

  it("the reconcile flow runs no staging check in dry run, and the pass reads the recorded deploy", async () => {
    const t = await setupStaging({ dryRun: true });
    await t.deploy();
    const result = await run(stagingFlowDeps(t));
    expect(result.verified).toBeNull();
    expect(result.planned.staging).toBe(1);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("the reconcile flow's deploy backstop deploys main's newest build for an item with no deploy, once (O-116)", async () => {
    const t = await setupStaging();
    const runId = t.built();
    const deps = stagingFlowDeps(t);
    const first = await run(deps);
    expect(first.stagingDeploys).toMatchObject([
      {
        repo: REPO,
        step: "deploy",
        deploy: { runId, step: "deployed", covers: [t.node.id] },
      },
    ]);
    expect(await t.state()).toBe("done");
    expect(t.target.deploys).toHaveLength(1);
    // Nothing waits any more: no read of GitHub's runs and no second deploy.
    expect((await run(deps)).stagingDeploys).toEqual([]);
    expect(t.target.deploys).toHaveLength(1);
  });

  it("the reconcile flow's deploy backstop only reports in dry run, and does not run under the kill switch", async () => {
    const t = await setupStaging({ dryRun: true });
    const runId = t.built();
    const deps = stagingFlowDeps(t);
    expect((await run(deps)).stagingDeploys).toMatchObject([
      {
        step: "deploy",
        deploy: {
          runId,
          step: "would_deploy",
          commitSha: t.mergeSha,
          covers: [t.node.id],
        },
      },
    ]);
    expect(t.target.deploys).toEqual([]);
    expect(t.builds.reads.filter((r) => r.startsWith("siteArchive"))).toEqual([]);
    await t.setting("kill_switch", true);
    const reads = t.builds.reads.length;
    expect((await run(deps)).stagingDeploys).toBeNull();
    expect(t.builds.reads).toHaveLength(reads);
    expect(await t.kind("staging_deploy")).toEqual([]);
  });

  it("the deploy flow deploys a CI run, records it and checks the item it covers, once for a repeated start", async () => {
    const t = await setupStaging();
    const runId = t.built();
    const deps = stagingFlowDeps(t);
    const input = { repo: REPO, runId };
    expect(await deployStaging(deps, input)).toMatchObject({
      outcome: "done",
      deploy: {
        step: "deployed",
        verified: [{ move: { toState: "done", outcome: "applied" } }],
      },
    });
    await deployStaging(deps, input);
    expect(t.checker.calls).toHaveLength(1);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
    // A run GitHub does not have deploys nothing.
    expect(await deployStaging(deps, { repo: REPO, runId: runId + 50 })).toEqual({
      outcome: "done",
      deploy: { repo: REPO, runId: runId + 50, step: "not_a_main_build" },
      builderRuns: [],
      firstRuns: [],
    });
  });

  it("the deploy flow refuses under the kill switch, and a malformed input, and writes nothing", async () => {
    const t = await setupStaging();
    const runId = t.built();
    await t.setting("kill_switch", true);
    const before = await t.transitions(t.node.id);
    expect(await deployStaging(stagingFlowDeps(t), { repo: REPO, runId })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    await t.setting("kill_switch", false);
    for (const input of [
      { repo: "not a repository", runId },
      { repo: REPO, runId: 0 },
      { repo: REPO, runId: "7" as unknown as number },
    ]) {
      expect(await deployStaging(stagingFlowDeps(t), input)).toEqual({
        outcome: "refused",
        reason: "invalid_input",
      });
    }
    expect(await t.transitions(t.node.id)).toEqual(before);
    expect(t.checker.calls).toEqual([]);
    expect(t.target.deploys).toEqual([]);
  });
});

describe("stalled work in the reconcile flow's result (flow: fake adapters, D-302)", () => {
  it("carries the stalled runs and items from the same read-only check as the daily check, on every pass", async () => {
    const f = await createFlowFixture();
    const ready = await f.node("ready_for_dev");
    const working = await f.node("in_development");
    const quiet = await f.run(working.id, "developer", 0);
    f.advanceMinutes(120);

    const result = await run(f.deps);
    expect(result.stalledItems).toEqual((await stalledItems(f.deps)).items);
    expect(result.stalledItems).toMatchObject([
      { nodeId: ready.id, waits: [{ code: "dry_run" }] },
    ]);
    expect(result.stalledRuns).toEqual(await stalledRuns(f.deps));
    expect(result.stalledRuns).toMatchObject([{ runId: quiet.id, bot: "developer" }]);
    expect(result.stalls).toBe(1);

    // Under the kill switch the pass stops, and the lists still show.
    await f.killed();
    const killed = await run(f.deps);
    expect(killed.stalledItems).toMatchObject([
      { nodeId: ready.id, waits: [{ code: "kill_switch" }, { code: "dry_run" }] },
    ]);

    await f.setting("reconcile_interval_minutes", null);
    expect((await run(f.deps)).problems).toContain(
      "reconcile_interval_minutes is missing or invalid: no stalled items list",
    );
  });
});
