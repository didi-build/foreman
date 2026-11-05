// Seam: the flows that start work on the event in D-329 slice 4 (O-104), with fake adapters on
// the memory store and the real contracts and guards. The called advance flow takes the reconcile
// pass's own step 4 for one item: once, never under a switch, and once between it and a pass at
// the same time. The run-end flow starts QA's run when a builder's report moves the item into
// review (N-80), the visual comparison once QA's review passed on a design item, and the first
// runs of the project's ready items a run's freed slot lets start (N-81). The reconcile flow's
// dispatch step starts QA on an item in review that has none, as the safety net. What the receiver
// decides is in test/github-receiver-starts.test.ts. Fake data only.
import { describe, expect, it } from "vitest";

import { run as advanceItem } from "../../flows/advance-item.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { startQaRuns } from "../../flows/lib/ready-runs.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { ROUTING_SETTINGS } from "../../src/core/routing.ts";
import {
  FIRST_OUTPUT_TOKEN_NEEDS,
  FIRST_ROUTING_POLICY,
} from "../../src/core/routing-testing.ts";
import type { Node } from "../../src/core/store.ts";
import { HEAD } from "../reconcile-fixture.ts";
import { setupVisual } from "../visual-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 3,
  costUsd: 0.1,
  minutes: 2,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

/** Makes the clock move one second at each read, as a real clock moves between steps. */
function ticking(t: FlowFixture) {
  const read = t.clock.now;
  t.clock.now = () => {
    t.advanceMinutes(1 / 60);
    return read();
  };
}

async function live() {
  const f = await createFlowFixture();
  ticking(f);
  await f.live();
  return f;
}

/** CI's end on the head as the receiver records it, and the Developer's docs note for it. */
async function greenHead(f: FlowFixture, node: Node, pr = 7) {
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr, changedPaths: ["src/a.ts"] },
    { commitSha: HEAD },
  );
  await f.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });
}

const qaRuns = async (f: FlowFixture, node: Node) =>
  (await f.store.listRuns({ nodeId: node.id })).filter((r) => r.bot === "qa");

describe("the called advance flow f/foreman/advance_item (flow: fake adapters, O-104)", () => {
  it("moves an item whose advance is due into QA review with the pass's trigger, and starts QA on its head, once", async () => {
    const f = await live();
    const item = await f.node("in_development");
    await greenHead(f, item);

    const result = await advanceItem(f.deps, { nodeId: item.id });

    expect(result).toMatchObject({
      outcome: "advanced",
      advances: [
        {
          nodeId: item.id,
          toState: "in_qa_review",
          move: { outcome: "applied" },
          qa: { role: "qa", plan: "planned", result: { outcome: "started" } },
        },
      ],
    });
    expect((await f.store.getNode(item.id))?.state).toBe("in_qa_review");
    // The same row the pass writes: its trigger and actor (O-103).
    expect(
      (await f.transitions(item.id)).map((t) => [t.toState, t.triggerKind, t.actorId]),
    ).toEqual([["in_qa_review", "reconcile", "reconcile"]]);
    expect(await qaRuns(f, item)).toMatchObject([
      { headSha: HEAD, prNumber: 7, taskType: "qa:review", endedAt: null },
    ]);

    // A second start (a rerun's CI end, say) finds the item moved and starts nothing.
    expect(await advanceItem(f.deps, { nodeId: item.id })).toEqual({
      outcome: "advanced",
      advances: [],
    });
    expect(await qaRuns(f, item)).toHaveLength(1);
    expect(f.runtime.started).toHaveLength(1);
  });

  it("does nothing under the kill switch or in dry run, nor for an item with no advance due", async () => {
    const f = await live();
    const item = await f.node("in_development");
    await greenHead(f, item);
    const before = await f.footprint(item.id);
    await f.killed();
    expect(await advanceItem(f.deps, { nodeId: item.id })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    await f.setting("kill_switch", false);
    await f.setting("dry_run", true);
    expect(await advanceItem(f.deps, { nodeId: item.id })).toEqual({
      outcome: "refused",
      reason: "dry_run",
    });
    expect(await f.footprint(item.id)).toBe(before);

    // Live, but the docs note names another head: the guards refuse, and nothing is written.
    await f.live();
    const other = await f.node("in_development");
    await f.evidence(
      other.id,
      "ci_run",
      { conclusion: "success", pr: 8, changedPaths: [] },
      { commitSha: HEAD },
    );
    const otherBefore = await f.footprint(other.id);
    expect(await advanceItem(f.deps, { nodeId: other.id })).toEqual({
      outcome: "advanced",
      advances: [],
    });
    expect(await f.footprint(other.id)).toBe(otherBefore);
    expect(f.runtime.started).toEqual([]);
  });

  it("with the reconcile pass at the same time gives one move and one QA run", async () => {
    const f = await live();
    const item = await f.node("in_development");
    await greenHead(f, item);
    const [event, pass] = await Promise.all([
      advanceItem(f.deps, { nodeId: item.id }),
      reconcileFlow(f.deps),
    ]);
    const applied = [
      ...(event.outcome === "advanced" ? event.advances : []),
      ...(pass.advanced ?? []),
    ].filter((a) => a.move.outcome === "applied");
    expect(applied).toHaveLength(1);
    expect(
      (await f.transitions(item.id)).filter((t) => t.mode === "applied"),
    ).toHaveLength(1);
    expect(await qaRuns(f, item)).toHaveLength(1);
    expect(f.runtime.started).toHaveLength(1);
  });
});

describe("QA's run on the done report (flow: run-end, N-80, O-104)", () => {
  it("a Developer's report that moves the item into review starts QA's review on the recorded head, once", async () => {
    const f = await live();
    const node = await f.node("ready_for_dev");
    const dev = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    if (dev.outcome !== "started") throw new Error("the Developer was not started");
    await greenHead(f, node);
    f.runtime.status.set(dev.runId, { state: "finished", result: RESULT });

    const ended = await recordRunEnd(f.deps, { runId: dev.runId });

    expect(ended).toMatchObject({
      outcome: "recorded",
      move: { outcome: "applied", toState: "in_qa_review" },
      qaRuns: [
        {
          nodeId: node.id,
          prNumber: 7,
          headSha: HEAD,
          taskType: null,
          result: { outcome: "started" },
        },
      ],
    });
    // The pull request and head are the runner's `ci_run`, never the agent's report.
    expect(f.tasksFor.at(-1)?.run).toMatchObject({
      bot: "qa",
      headSha: HEAD,
      prNumber: 7,
      taskType: "qa:review",
    });
    // A repeated run-end trigger finds QA's run active and starts nothing more.
    expect(await recordRunEnd(f.deps, { runId: dev.runId })).toMatchObject({
      outcome: "already_recorded",
    });
    expect(await qaRuns(f, node)).toHaveLength(1);
  });

  it("starts nothing while a switch holds the runner, nor for an item not in review", async () => {
    const f = await createFlowFixture();
    const review = await f.node("in_qa_review", { ownerRole: "qa" });
    await greenHead(f, review);
    const building = await f.node("in_development");
    // Dry run is the fixture's default.
    expect(await startQaRuns(f.deps, [review.id])).toEqual([]);
    await f.live();
    await f.killed();
    expect(await startQaRuns(f.deps, [review.id])).toEqual([]);
    expect(f.tokens).toEqual([]);
    await f.setting("kill_switch", false);
    expect(
      await startQaRuns(f.deps, [building.id, review.id, review.id]),
    ).toMatchObject([{ nodeId: review.id, result: { outcome: "started" } }]);
    expect(f.runtime.started).toHaveLength(1);
  });

  it("on a design item, QA's passing review starts the visual comparison at the review run's end (D-242)", async () => {
    const f = await live();
    // A `qa:visual` route, the test's own, not a model choice (D-249).
    const policy = structuredClone(FIRST_ROUTING_POLICY) as {
      taskTypes: Record<string, unknown>;
    };
    policy.taskTypes["qa:visual"] = policy.taskTypes["qa:review"];
    await f.setting(ROUTING_SETTINGS.policy, policy as never);
    await f.setting(ROUTING_SETTINGS.outputNeeds, {
      ...FIRST_OUTPUT_TOKEN_NEEDS,
      "qa:visual": 16000,
    });
    const v = await setupVisual(f, f.screenshots, f.repoFolders);
    const [review] = await startQaRuns(f.deps, [v.nodeId]);
    expect(review).toMatchObject({ taskType: null, result: { outcome: "started" } });
    const reviewRun = f.tasksFor.at(-1)?.run;
    if (reviewRun?.bot !== "qa") throw new Error("no review run");
    await f.evidence(
      v.nodeId,
      "qa_verdict",
      { verdict: "pass", findings: [], evidenceIds: [] },
      { commitSha: HEAD, runId: reviewRun.id },
    );
    f.runtime.status.set(reviewRun.id, { state: "finished", result: RESULT });

    const ended = await recordRunEnd(f.deps, { runId: reviewRun.id });

    // The merge waits for the visual comparison, which starts now on the same head.
    expect(ended).toMatchObject({
      outcome: "recorded",
      qaRuns: [
        {
          nodeId: v.nodeId,
          taskType: "qa:visual",
          headSha: HEAD,
          prNumber: 7,
          result: { outcome: "started" },
        },
      ],
    });
    expect((await f.store.getNode(v.nodeId))?.state).toBe("in_qa_review");
    expect(f.tasksFor.at(-1)?.run).toMatchObject({
      bot: "qa",
      taskType: "qa:visual",
      headSha: HEAD,
    });
    expect(f.tasksFor.at(-1)?.images?.length).toBeGreaterThan(0);
  });

  it("the reconcile flow's dispatch step starts QA on an item in review that has none, once (the safety net)", async () => {
    const f = await live();
    const review = await f.node("in_qa_review", { ownerRole: "qa" });
    await greenHead(f, review);
    const result = await reconcileFlow(f.deps);
    expect(result.dispatched).toMatchObject([
      {
        nodeId: review.id,
        role: "qa",
        plan: "planned",
        result: { outcome: "started" },
      },
    ]);
    expect(await qaRuns(f, review)).toMatchObject([
      { headSha: HEAD, prNumber: 7, taskType: "qa:review" },
    ]);
    // QA's run has no move.
    expect(await f.transitions(review.id)).toEqual([]);
    expect((await reconcileFlow(f.deps)).dispatched).toEqual([]);
    expect(await qaRuns(f, review)).toHaveLength(1);
  });
});

describe("a freed slot (flow: run-end, N-81, O-104)", () => {
  it("once a run's end is recorded, starts the project's ready items the limit held, in the pass's order, as many as fit", async () => {
    const f = await live();
    await f.setting("agent_cluster_max_active_runs", 2);
    const busy = await f.node("ready_for_dev");
    const other = await f.node("ready_for_dev");
    const first = await dispatch(f.deps, { nodeId: busy.id, role: "developer" });
    const second = await dispatch(f.deps, { nodeId: other.id, role: "developer" });
    if (first.outcome !== "started" || second.outcome !== "started")
      throw new Error("the Developers were not started");
    // Two ready items wait on the full cluster.
    const older = await f.node("ready_for_dev");
    const newer = await f.node("ready_for_dev");
    expect((await reconcileFlow(f.deps)).dispatched).toMatchObject([
      { nodeId: older.id, plan: "refused", reason: "cluster_full" },
      { nodeId: newer.id, plan: "refused", reason: "cluster_full" },
    ]);
    expect(f.runtime.started).toHaveLength(2);

    // One run ends: its slot goes to the older item, and the newer one still waits.
    f.runtime.status.set(first.runId, {
      state: "finished",
      result: { ...RESULT, outcome: "fail", detail: "error" },
    });
    const ended = await recordRunEnd(f.deps, { runId: first.runId });
    expect(ended).toMatchObject({
      outcome: "recorded",
      freedSlots: [
        { nodeId: older.id, role: "developer", result: { outcome: "started" } },
        {
          nodeId: newer.id,
          result: { outcome: "not_admitted", reason: "cluster_full" },
        },
      ],
    });
    expect((await f.store.getNode(older.id))?.state).toBe("in_development");
    expect((await f.store.getNode(newer.id))?.state).toBe("ready_for_dev");
    expect(f.runtime.started).toHaveLength(3);

    // A repeated trigger for the same end frees nothing more.
    expect(await recordRunEnd(f.deps, { runId: first.runId })).toMatchObject({
      outcome: "already_recorded",
      freedSlots: [{ nodeId: newer.id, result: { outcome: "not_admitted" } }],
    });
    expect(f.runtime.started).toHaveLength(3);
  });

  it("starts nothing under the kill switch or in dry run: the run-end flow records or acts on nothing", async () => {
    const f = await live();
    const busy = await f.node("ready_for_dev");
    const run = await dispatch(f.deps, { nodeId: busy.id, role: "developer" });
    if (run.outcome !== "started") throw new Error("the Developer was not started");
    const waiting = await f.node("ready_for_dev");
    f.runtime.status.set(run.runId, { state: "finished", result: RESULT });
    await f.setting("dry_run", true);
    expect(await recordRunEnd(f.deps, { runId: run.runId })).toMatchObject({
      outcome: "would_record",
    });
    await f.killed();
    expect(await recordRunEnd(f.deps, { runId: run.runId })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect((await f.store.getNode(waiting.id))?.state).toBe("ready_for_dev");
    expect(f.runtime.started).toHaveLength(1);
  });
});
