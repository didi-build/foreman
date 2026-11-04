// Seam: unit, plain logic over the memory store with the real contracts and guards and a clock the
// test moves (D-162). The one read-only stall check (src/core/stalls.ts, D-302, D-112, O-94): the
// stalled items and what each waits on, and the stalled runs the reconcile pass's step 5 reports.
// The pass's own report is in test/reconcile.test.ts, the daily check's section in
// test/daily-check.test.ts. Synthetic data only.
import { describe, expect, it } from "vitest";

import { ROUTING_SETTINGS } from "../src/core/routing.ts";
import {
  CYCLE_SETTING_PROBLEM,
  stalledItems,
  stalledRuns,
} from "../src/core/stalls.ts";
import type { Store } from "../src/core/store.ts";
import {
  createReconcileFixture,
  MINUTE,
  START,
  type ReconcileFixture,
} from "./reconcile-fixture.ts";

/** The store with every write refused: anything but a read throws. */
function readOnly(store: Store): Store {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof key === "string" && !/^(get|list|find)/.test(key)) {
        return () => {
          throw new Error(`the stall check called ${key}`);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const CYCLE = 120;

async function fixture() {
  const f = await createReconcileFixture();
  const items = (store: Store = f.store) => stalledItems({ ...f.deps, store });
  const runs = () => stalledRuns(f.deps);
  /** Live mode: dry run off, so admission alone decides. */
  const live = () => f.setting("dry_run", false);
  return { ...f, items, runs, live };
}

/** A run that ended `usage_exhausted` now. */
async function exhausted(f: ReconcileFixture, nodeId: string) {
  const run = await f.run(nodeId, "developer", 20);
  await f.store.endRun(run.id, {
    endedAt: f.clock.now(),
    outcome: "usage_exhausted",
    turns: 3,
    minutes: 20,
    costUsd: 0.1,
    tokens: null,
    transcriptRef: null,
    usageExhaustedCause: "rate_limit",
    retryAfterSeconds: null,
    serviceTierServed: null,
    capacityRetries: null,
    capacityWaitSeconds: null,
    firstTokenMs: null,
    reportedCostUsd: null,
  });
  return run;
}

describe("the stall check, stalled items (unit: D-112, D-302)", () => {
  it("lists a ready item with no run after one reconcile cycle, and not before", async () => {
    const f = await fixture();
    const ready = await f.node("ready_for_dev", { title: "Build the page" });

    f.advanceMinutes(CYCLE - 1);
    expect(await f.items()).toEqual({ cycleMinutes: CYCLE, items: [], problem: null });

    f.advanceMinutes(1);
    expect(await f.items()).toEqual({
      cycleMinutes: CYCLE,
      problem: null,
      items: [
        {
          nodeId: ready.id,
          projectId: f.projectId,
          title: "Build the page",
          state: "ready_for_dev",
          role: "developer",
          readySince: new Date(START),
          stalledForMinutes: CYCLE,
          // In dry run the runner starts nothing, so that is what it waits on.
          waits: [{ code: "dry_run", detail: null }],
        },
      ],
    });
  });

  it("says nothing was found when nothing would stop the runner starting it", async () => {
    const f = await fixture();
    await f.live();
    await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    const { items } = await f.items();
    expect(items.map((i) => i.waits)).toEqual([
      [{ code: "nothing_found", detail: null }],
    ]);
  });

  it("names the kill switch, once, with dry run", async () => {
    const f = await fixture();
    await f.setting("kill_switch", true);
    await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    const { items } = await f.items();
    expect(items.map((i) => i.waits)).toEqual([
      [
        { code: "kill_switch", detail: null },
        { code: "dry_run", detail: null },
      ],
    ]);
  });

  it("names the cluster's active-run limit, counting the runs it admits earlier in the check", async () => {
    const f = await fixture();
    await f.live();
    await f.setting("agent_cluster_max_active_runs", 2);
    await f.run((await f.node("in_development")).id, "developer", 10);
    const first = await f.node("ready_for_dev");
    const second = await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    const { items } = await f.items();
    expect(items.map((i) => [i.nodeId, i.waits])).toEqual([
      [first.id, [{ code: "nothing_found", detail: null }]],
      [second.id, [{ code: "cluster_full", detail: null }]],
    ]);

    await f.setting("agent_cluster_max_active_runs", 0);
    expect((await f.items()).items.map((i) => i.waits[0]?.code)).toEqual([
      "cluster_limit_unset",
      "cluster_limit_unset",
    ]);
  });

  it("names the project's Developer limit", async () => {
    const f = await fixture();
    await f.live();
    for (let i = 0; i < 3; i++)
      await f.run((await f.node("in_development")).id, "developer", 10);
    await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    // The three runs are past their budget of 50 minutes too: both kinds show.
    expect((await f.items()).items.map((i) => i.waits)).toEqual([
      [{ code: "developer_limit", detail: null }],
    ]);
    expect(await f.runs()).toHaveLength(3);
  });

  it("names a usage-exhausted wait with when it ends, counted from the run's end", async () => {
    const f = await fixture();
    await f.live();
    await f.setting("usage_exhausted_wait_minutes", 600);
    const queued = await f.node("in_development");
    f.advanceMinutes(30);
    await exhausted(f, queued.id);
    f.advanceMinutes(CYCLE);
    expect((await f.items()).items).toEqual([
      expect.objectContaining({
        nodeId: queued.id,
        state: "in_development",
        role: "developer",
        readySince: new Date(START + 30 * MINUTE),
        stalledForMinutes: CYCLE,
        waits: [
          {
            code: "usage_exhausted_wait",
            detail: "rate_limit",
            until: new Date(START + (30 + 600) * MINUTE),
          },
        ],
      }),
    ]);
  });

  it("names no route for the task type, with why", async () => {
    const f = await fixture();
    await f.live();
    await f.setting(ROUTING_SETTINGS.policy, null);
    await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    const [item] = (await f.items()).items;
    expect(item?.waits).toEqual([{ code: "no_route", detail: expect.any(String) }]);
  });

  it("names each failing guard of the dispatch move with the guard's own note", async () => {
    const f = await fixture();
    await f.live();
    // A design item with no accepted plan or product direction linked.
    const design = await f.node("ready_for_design_exploration", {
      track: "design",
      ownerRole: "designer",
    });
    // A non-blocking open request also stops the dispatch guard.
    const ready = await f.node("ready_for_dev");
    await f.openGate(ready.id, `hold-release:${ready.id}`, {
      kind: "scope",
      owner: "didi",
      blocking: false,
    });
    f.advanceMinutes(CYCLE);
    expect((await f.items()).items.map((i) => [i.nodeId, i.role, i.waits])).toEqual([
      [
        design.id,
        "designer",
        [
          {
            code: "guard_failed",
            guard: "plan_attached",
            detail: "not linked: accepted plan and product direction",
          },
        ],
      ],
      [
        ready.id,
        "developer",
        [
          {
            code: "guard_failed",
            guard: "no_pending_gate",
            detail: `open gate request(s): hold-release:${ready.id}`,
          },
        ],
      ],
    ]);
  });

  it("leaves out a blocked, held, not agent-ready, gated or running item, and one not ready to start", async () => {
    const f = await fixture();
    const blocker = await f.node("in_development");
    const blocked = await f.node("ready_for_dev");
    await f.blocks(blocker.id, blocked.id);
    await f.node("ready_for_dev", { hold: true });
    await f.node("ready_for_dev", { agentReady: false });
    await f.node("ready_for_dev", { stale: true });
    const gated = await f.node("ready_for_dev");
    await f.openGate(gated.id, `escalation:${gated.id}`);
    const running = await f.node("ready_for_dev");
    await f.run(running.id, "developer", 0);
    await f.node("in_qa_review");
    await f.node("done");
    f.advanceMinutes(CYCLE);
    expect((await f.items()).items).toEqual([]);
  });

  it("lists nothing, and says why, when the cycle setting is missing", async () => {
    const f = await fixture();
    await f.setting("reconcile_interval_minutes", null);
    await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    expect(await f.items()).toEqual({
      cycleMinutes: null,
      items: [],
      problem: CYCLE_SETTING_PROBLEM,
    });
  });

  it("lists the longest stalled first, and writes nothing", async () => {
    const f = await fixture();
    await f.live();
    const older = await f.node("ready_for_dev");
    f.advanceMinutes(10);
    const newer = await f.node("ready_for_dev");
    f.advanceMinutes(CYCLE);
    const before = await f.store.listActiveRuns();
    const { items } = await f.items(readOnly(f.store));
    expect(items.map((i) => [i.nodeId, i.stalledForMinutes])).toEqual([
      [older.id, CYCLE + 10],
      [newer.id, CYCLE],
    ]);
    expect(await f.store.listActiveRuns()).toEqual(before);
    expect(await f.transitions(older.id, newer.id)).toEqual([]);
  });
});

describe("the stall check, stalled runs (unit: section 2.5 step 5, D-302)", () => {
  it("lists active runs quiet past their budget or with an unreadable budget, longest idle first", async () => {
    const f = await fixture();
    const quiet = await f.run((await f.node("in_development")).id, "developer", 60);
    const unreadable = await f.run(
      (await f.node("in_development")).id,
      "developer",
      5,
      {
        budget: { maxTurns: 10 },
      },
    );
    const older = await f.run((await f.node("in_qa_review")).id, "qa", 90);
    await f.run((await f.node("in_development")).id, "developer", 10);
    const busy = await f.run((await f.node("in_development")).id, "developer", 60);
    await f.evidence(
      busy.nodeId as string,
      "agent_report",
      { summary: "still going" },
      { runId: busy.id },
    );

    expect(await stalledRuns({ ...f.deps, store: readOnly(f.store) })).toEqual([
      {
        runId: older.id,
        projectId: f.projectId,
        nodeId: older.nodeId,
        bot: "qa",
        lastActivityAt: new Date(START - 90 * MINUTE),
        budgetMinutes: 20,
        idleMinutes: 90,
      },
      {
        runId: quiet.id,
        projectId: f.projectId,
        nodeId: quiet.nodeId,
        bot: "developer",
        lastActivityAt: new Date(START - 60 * MINUTE),
        budgetMinutes: 50,
        idleMinutes: 60,
      },
      {
        runId: unreadable.id,
        projectId: f.projectId,
        nodeId: unreadable.nodeId,
        bot: "developer",
        lastActivityAt: new Date(START - 5 * MINUTE),
        budgetMinutes: null,
        idleMinutes: 5,
      },
    ]);
    // The reconcile pass reports the same list.
    expect((await f.pass()).stalls).toEqual(await f.runs());
  });
});
