// Seam: the reconcile flow (build plan M3.1, architecture section 2.5) with fake adapters on the
// memory store. The pass itself is tested in test/reconcile.test.ts; this covers what the flow
// adds: the execution count from the composition layer and one result per run, and the live
// staging pass's deploy waits on the attention count (D-225).
import { describe, expect, it } from "vitest";

import { run } from "../../flows/reconcile.ts";
import { run as verifyStaging } from "../../flows/verify-staging.ts";
import type { FlowDeps } from "../../flows/lib/compose.ts";
import { setupMerge } from "../merge-fixture.ts";
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
      tasks: { taskFor: notUsed },
      newRunToken: () => "not-used",
      executionsThisMonth: async () => 120,
      close: async () => undefined,
    };
    const first = await run(deps);
    expect(first.stopped).toBe("live_mode_not_built");
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
    tasks: { taskFor: notUsed },
    newRunToken: () => "not-used",
    executionsThisMonth: async () => 120,
    close: async () => undefined,
  };
}

describe("staging in the flows (flow: fake adapters, build plan M3.4)", () => {
  it("the reconcile flow in live mode runs the staging pass after the merge pass, once", async () => {
    const t = await setupStaging();
    t.deploy();
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

  it("the reconcile flow runs no staging check in dry run, and the pass records the deploy", async () => {
    const t = await setupStaging({ dryRun: true });
    t.deploy();
    const result = await run(stagingFlowDeps(t));
    expect(result.verified).toBeNull();
    expect(result.planned.staging).toBe(1);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("the staging flow verifies the item a deploy event names, once for a repeated event", async () => {
    const t = await setupStaging();
    t.deploy();
    const deps = stagingFlowDeps(t);
    const input = { repo: REPO, sha: t.mergeSha };
    expect(await verifyStaging(deps, input)).toMatchObject({
      outcome: "verified",
      results: [{ move: { toState: "done", outcome: "applied" } }],
    });
    await verifyStaging(deps, input);
    expect(t.checker.calls).toHaveLength(1);
    expect(await verifyStaging(deps, { ...input, sha: "a".repeat(40) })).toEqual({
      outcome: "verified",
      results: [],
      builderRuns: [],
    });
  });

  it("the staging flow refuses under the kill switch and writes nothing", async () => {
    const t = await setupStaging();
    t.deploy();
    await t.setting("kill_switch", true);
    const before = await t.transitions(t.node.id);
    expect(
      await verifyStaging(stagingFlowDeps(t), {
        repo: REPO,
        sha: t.mergeSha,
      }),
    ).toEqual({ outcome: "refused", reason: "kill_switch" });
    expect(await t.transitions(t.node.id)).toEqual(before);
    expect(t.checker.calls).toEqual([]);
  });
});
