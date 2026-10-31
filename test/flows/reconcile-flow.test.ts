// Seam: the reconcile flow (build plan M3.1, architecture section 2.5) with fake adapters on the
// memory store. The pass itself is tested in test/reconcile.test.ts; this covers what the flow
// adds: the execution count from the composition layer and one result per run.
import { describe, expect, it } from "vitest";

import { run } from "../../flows/reconcile.ts";
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
});
