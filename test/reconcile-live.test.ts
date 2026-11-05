// Seam: unit, the reconcile pass in live mode and the first-run check it shares with the flows
// (D-329 slice 3, O-103), with the real contracts and guards on the memory store and the fake
// GitHub. The live plan is checked against the dry-run plan of the same store: the same releases,
// dispatches, advances, attention list, stalls and clean-up candidates, so the two modes cannot
// drift. What the reconcile flow does with the plan is in test/flows/reconcile-live-flow.test.ts.
// QA's check on an item in review and the pass's QA backstop in both modes (N-80, O-104) are here
// too; the flows that start QA's run are in test/flows/event-starts-flows.test.ts.
import { describe, expect, it } from "vitest";

import { createReadyRuns } from "../src/core/ready-runs.ts";
import type { MovePlan, ReconcileReport } from "../src/core/reconcile.ts";
import {
  HEAD,
  MINUTE,
  REPO,
  createReconcileFixture,
  type ReconcileFixture,
} from "./reconcile-fixture.ts";

const ENDED = {
  turns: 3,
  minutes: 20,
  costUsd: 0.1,
  tokens: null,
  transcriptRef: null,
  retryAfterSeconds: null,
  serviceTierServed: null,
  capacityRetries: null,
  capacityWaitSeconds: null,
  firstTokenMs: null,
  reportedCostUsd: null,
};

/** Ends a run `usage_exhausted` now, so its node waits for `usage_exhausted_wait_minutes`. */
async function exhausted(f: ReconcileFixture, runId: string) {
  await f.store.endRun(runId, {
    ...ENDED,
    endedAt: f.clock.now(),
    outcome: "usage_exhausted",
    usageExhaustedCause: "rate_limit",
  });
}

/**
 * One store with every kind of outcome each step can plan. Ids come from the fixture's counter,
 * so two fixtures seeded the same way hold the same rows.
 */
async function seed(f: ReconcileFixture) {
  // Step 2: one Blocked item whose blocker is Done, one whose blocker is still open.
  const blocker = await f.node("done");
  const released = await f.node("blocked");
  await f.blocks(blocker.id, released.id);
  const open = await f.node("in_development");
  await f.evidence(open.id, "dispatch_record", { repo: REPO, branch: "foreman/x" });
  await f.run(open.id, "developer", 5);
  const waits = await f.node("blocked");
  await f.blocks(open.id, waits.id);
  // Step 3: four ready items for the two Developer slots left, one gated, one held, and a
  // design item with no plan attached.
  const ready = [];
  for (let i = 0; i < 4; i++) ready.push(await f.node("ready_for_dev"));
  const gated = await f.node("ready_for_dev");
  await f.openGate(gated.id, `escalation:${gated.id}`);
  await f.node("ready_for_dev", { hold: true });
  await f.node("ready_for_design_exploration", {
    track: "design",
    ownerRole: "designer",
  });
  // A whole interval later: the ready items are on the attention list and `open`'s run stalls.
  f.advanceMinutes(121);
  // A node queued after `usage_exhausted`, still waiting.
  const queued = await f.node("in_development");
  await exhausted(f, (await f.run(queued.id, "developer", 20)).id);
  // Step 4: CI green on the head and a docs note.
  const built = await f.node("in_development");
  await f.evidence(
    built.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: [] },
    { commitSha: HEAD },
  );
  await f.evidence(built.id, "docs_note", { impact: "none" });
  // Step 6: a request on a Done node.
  await f.openGate(blocker.id, `escalation:${blocker.id}`);
  // Step 3's safety net for QA (N-80, O-104): an item in review with no QA run on its head.
  const reviewed = await f.node("in_qa_review", { ownerRole: "qa" });
  await f.evidence(
    reviewed.id,
    "ci_run",
    { conclusion: "success", pr: 8, changedPaths: [] },
    { commitSha: HEAD },
  );
  return { released, waits, ready, gated, queued, built, reviewed };
}

/**
 * The plan of a report, with the one thing dry run adds: its dry-run row. A move it wrote or
 * found written (`planned`, `already_planned`) is what live mode reports `due`.
 */
function planOf(report: ReconcileReport) {
  const move = <T extends MovePlan>(m: T): T => {
    const plan: T = { ...m };
    delete plan.transitionId;
    const written = m.outcome === "planned" || m.outcome === "already_planned";
    return { ...plan, outcome: written ? "due" : m.outcome };
  };
  return {
    polls: report.polls,
    releases: report.releases.map(move),
    dispatches: report.dispatches.map((d) =>
      d.transition ? { ...d, transition: move(d.transition) } : d,
    ),
    advances: report.advances.map(move),
    attention: report.attention,
    stalls: report.stalls,
    gateCleanup: report.gateCleanup,
    problems: report.problems,
  };
}

describe("reconcile pass in live mode (unit: D-329 slice 3, O-103)", () => {
  it("plans exactly what dry run plans for the same store, and writes nothing", async () => {
    const dry = await createReconcileFixture();
    await seed(dry);
    const live = await createReconcileFixture();
    const nodes = await seed(live);
    await live.setting("dry_run", false);
    const before = await live.store.listNodes({});
    const runsOf = () =>
      Promise.all(before.map((n) => live.store.listRuns({ nodeId: n.id })));
    const runsBefore = await runsOf();

    const dryReport = await dry.pass({ windmillExecutionsThisMonth: 100 });
    const liveReport = await live.pass({ windmillExecutionsThisMonth: 100 });

    expect(dryReport.mode).toBe("dry_run");
    expect(liveReport.mode).toBe("live");
    expect(planOf(liveReport)).toEqual(planOf(dryReport));
    // The plan holds every kind of outcome, so the match covers each.
    expect(liveReport.releases.map((r) => [r.nodeId, r.outcome])).toEqual([
      [nodes.released.id, "due"],
      [nodes.waits.id, "rejected"],
    ]);
    expect(liveReport.dispatches.map((d) => d.outcome)).toEqual([
      "planned",
      "planned",
      "refused",
      "refused",
      "guard_failed",
      "not_dispatchable",
      "guard_failed",
      "waiting",
      "planned",
    ]);
    expect(liveReport.dispatches.at(-1)).toMatchObject({
      nodeId: nodes.reviewed.id,
      role: "qa",
      run: { headSha: HEAD, prNumber: 8 },
    });
    expect(liveReport.dispatches[2]?.reason).toBe("developer_limit");
    expect(liveReport.dispatches[0]?.transition?.outcome).toBe("due");
    expect(liveReport.advances.map((a) => a.outcome)).toEqual([
      "rejected",
      "rejected",
      "due",
    ]);
    expect(liveReport.advances[2]).toMatchObject({
      nodeId: nodes.built.id,
      toState: "in_qa_review",
      dispatch: { role: "qa", outcome: "planned", run: { headSha: HEAD, prNumber: 7 } },
    });
    expect(liveReport.attention.length).toBeGreaterThan(0);
    expect(liveReport.stalls).toHaveLength(1);
    expect(liveReport.gateCleanup).toHaveLength(1);
    // Live mode writes no row and changes nothing: the reconcile flow acts on the plan.
    expect(await live.transitions(...before.map((n) => n.id))).toEqual([]);
    expect(await live.store.listNodes({})).toEqual(before);
    expect(await runsOf()).toEqual(runsBefore);
    expect(await dry.transitions(nodes.released.id)).toMatchObject([
      { mode: "dry_run", toState: "ready_for_dev" },
    ]);
  });

  it("leaves the merge, staging and cancel steps to the reconcile flow's live passes", async () => {
    const f = await createReconcileFixture();
    const reviewed = await f.node("in_qa_review", { ownerRole: "qa" });
    await f.setting("dry_run", false);
    const report = await f.pass();
    expect(report).toMatchObject({ merges: [], staging: [], cancels: [] });
    expect(f.github.reads).toBe(0);
    expect(await f.transitions(reviewed.id)).toEqual([]);
  });

  it("leaves a Council run queued after usage_exhausted to the Council pass, in both modes", async () => {
    for (const dryRun of [true, false]) {
      const f = await createReconcileFixture();
      await f.setting("dry_run", dryRun);
      const item = await f.node("in_development");
      const run = await f.run(item.id, "council", 5, {
        questionTopic: `still-needed:${item.id}`,
      });
      await exhausted(f, run.id);
      f.advanceMinutes(60);
      // Before O-103 the dispatch step asked for a Council dispatch with no question, which the
      // dispatch refuses by throwing, so the whole pass stopped.
      const report = await f.pass();
      expect(report.dispatches, String(dryRun)).toEqual([]);
    }
  });
});

describe("the first-run check (unit: src/core/ready-runs.ts, D-329)", () => {
  it("is due for a ready item with nothing holding it, with the owner's role and the dispatch move", async () => {
    const f = await createReconcileFixture();
    const ready = createReadyRuns(f.deps);
    const code = await f.node("ready_for_dev");
    expect(await ready.check(code.id)).toEqual({
      due: true,
      nodeId: code.id,
      role: "developer",
      toState: "in_development",
    });
  });

  it("says why it is not due: not a ready state, held, stale, gated, running, waiting or gone", async () => {
    const f = await createReconcileFixture();
    const ready = createReadyRuns(f.deps);
    const building = await f.node("in_development");
    const blocked = await f.node("blocked");
    const held = await f.node("ready_for_dev", { hold: true });
    const stale = await f.node("ready_for_dev", { stale: true });
    const gated = await f.node("ready_for_dev");
    await f.openGate(gated.id, `escalation:${gated.id}`);
    const running = await f.node("ready_for_dev");
    await f.run(running.id, "developer", 1);
    const waiting = await f.node("ready_for_dev");
    await exhausted(f, (await f.run(waiting.id, "developer", 5)).id);
    const blocker = await f.node("in_development");
    const design = await f.node("ready_for_design_exploration", {
      track: "design",
      ownerRole: "designer",
    });
    await f.blocks(blocker.id, design.id);

    const reasons = async (id: string) => {
      const check = await ready.check(id);
      return check.due ? "due" : check.reason;
    };
    expect(await reasons(building.id)).toBe("not_ready");
    expect(await reasons(blocked.id)).toBe("not_ready");
    expect(await reasons(held.id)).toBe("not_dispatchable");
    expect(await reasons(stale.id)).toBe("not_dispatchable");
    expect(await ready.check(gated.id)).toMatchObject({
      reason: "guard_failed",
      failedGuards: ["no_pending_gate"],
    });
    expect(await reasons(running.id)).toBe("active_run");
    expect(await ready.check(waiting.id)).toMatchObject({
      reason: "waiting",
      cause: "rate_limit",
      resumeAt: new Date(f.clock.now().getTime() + 30 * MINUTE),
    });
    expect(await ready.check(design.id)).toMatchObject({
      role: "designer",
      reason: "guard_failed",
      failedGuards: ["plan_attached", "blockers_done"],
    });
    expect(await reasons("50000000-0000-4000-8000-999999999999")).toBe("no_node");
  });

  it("decides the dispatch step's first runs, in dry run and live mode alike", async () => {
    const f = await createReconcileFixture();
    const due = await f.node("ready_for_dev");
    const held = await f.node("ready_for_dev", { hold: true });
    const gated = await f.node("ready_for_dev");
    await f.openGate(gated.id, `escalation:${gated.id}`);
    const ready = createReadyRuns(f.deps);
    for (const dryRun of [true, false]) {
      await f.setting("dry_run", dryRun);
      const report = await f.pass();
      expect(report.dispatches.map((d) => [d.nodeId, d.outcome, d.reason])).toEqual([
        [due.id, "planned", undefined],
        [held.id, "not_dispatchable", undefined],
        [gated.id, "guard_failed", "no_pending_gate"],
      ]);
      expect((await ready.check(due.id)).due).toBe(true);
      expect((await ready.check(held.id)).due).toBe(false);
      expect((await ready.check(gated.id)).due).toBe(false);
    }
  });
});

const REVIEW_PR = 7;

/** An item In QA review with CI green on its head: the evidence the move into review carried. */
async function inReview(
  f: ReconcileFixture,
  extra: Parameters<ReconcileFixture["node"]>[1] = {},
) {
  const node = await f.node("in_qa_review", { ownerRole: "qa", ...extra });
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: REVIEW_PR, changedPaths: [] },
    { commitSha: HEAD },
  );
  return node;
}

/** A QA run on the head that started (it has a handle) and ended with `outcome`. */
async function qaRan(
  f: ReconcileFixture,
  nodeId: string,
  outcome: "success" | "fail" | "cancelled" = "success",
  taskType = "qa:review",
) {
  const run = await f.run(nodeId, "qa", 30, {
    headSha: HEAD,
    prNumber: REVIEW_PR,
    taskType,
    endedAt: f.clock.now(),
    outcome,
  });
  await f.store.setRunHandle(run.id, { runtime: "fake", runId: run.id });
  return run;
}

describe("QA's check on an item in review (unit: src/core/ready-runs.ts, N-80, O-104)", () => {
  it("is due for QA's review on the newest ci_run's pull request and head while QA has not run there", async () => {
    const f = await createReconcileFixture();
    const node = await inReview(f);
    const ready = createReadyRuns(f.deps);
    expect(await ready.qaCheck(node.id)).toEqual({
      due: true,
      nodeId: node.id,
      role: "qa",
      prNumber: REVIEW_PR,
      headSha: HEAD,
      taskType: null,
    });
    // A start that failed before it began does not count; a run that reached QA does, whatever
    // its end, a run the kill switch cancelled included.
    await f.run(node.id, "qa", 20, {
      headSha: HEAD,
      prNumber: REVIEW_PR,
      endedAt: f.clock.now(),
      outcome: "fail",
    });
    expect((await ready.qaCheck(node.id)).due).toBe(true);
    await qaRan(f, node.id, "cancelled");
    expect(await ready.qaCheck(node.id)).toMatchObject({ due: false, reason: "ran" });
  });

  it("on the design track, names the visual comparison once the review passed on the head, and then nothing", async () => {
    const f = await createReconcileFixture();
    const node = await inReview(f, { track: "design" });
    const ready = createReadyRuns(f.deps);
    const review = await qaRan(f, node.id);
    // The review ran and its verdict is not a pass yet: nothing more.
    expect(await ready.qaCheck(node.id)).toMatchObject({ due: false, reason: "ran" });
    await f.evidence(
      node.id,
      "qa_verdict",
      { verdict: "pass", findings: [], evidenceIds: [] },
      { commitSha: HEAD, runId: review.id },
    );
    expect(await ready.qaCheck(node.id)).toMatchObject({
      due: true,
      headSha: HEAD,
      prNumber: REVIEW_PR,
      taskType: "qa:visual",
    });
    await qaRan(f, node.id, "success", "qa:visual");
    // The one more visual run after a `cannot_tell` is visualRerunCheck's, not this check's.
    expect(await ready.qaCheck(node.id)).toMatchObject({ due: false, reason: "ran" });
  });

  it("says why it is not due: not in review, running, no head, CI not green, held, or waiting", async () => {
    const f = await createReconcileFixture();
    const ready = createReadyRuns(f.deps);
    const reason = async (id: string) => {
      const check = await ready.qaCheck(id);
      return check.due ? "due" : check.reason;
    };
    expect(await reason((await f.node("in_development")).id)).toBe("not_review");
    const running = await inReview(f);
    await f.run(running.id, "qa", 1, { headSha: HEAD, prNumber: REVIEW_PR });
    expect(await reason(running.id)).toBe("active_run");
    expect(await reason((await f.node("in_qa_review", { ownerRole: "qa" })).id)).toBe(
      "no_head",
    );
    const red = await inReview(f);
    await f.evidence(
      red.id,
      "ci_run",
      { conclusion: "pending", pr: REVIEW_PR, changedPaths: [] },
      { commitSha: "e".repeat(40) },
    );
    expect(await reason(red.id)).toBe("ci_not_green");
    expect(await reason((await inReview(f, { hold: true })).id)).toBe(
      "not_dispatchable",
    );
    // QA's run ended `usage_exhausted`: it goes on, on the same head, once the wait has passed.
    const queued = await inReview(f);
    const exhaustedRun = await f.run(queued.id, "qa", 10, {
      headSha: HEAD,
      prNumber: REVIEW_PR,
      taskType: "qa:review",
    });
    await f.store.setRunHandle(exhaustedRun.id, { runtime: "fake" });
    await exhausted(f, exhaustedRun.id);
    expect(await ready.qaCheck(queued.id)).toMatchObject({
      reason: "waiting",
      cause: "rate_limit",
    });
    f.advanceMinutes(31);
    expect(await ready.qaCheck(queued.id)).toMatchObject({ due: true, taskType: null });
  });

  it("the pass plans QA's run on an item in review as the safety net, the same in dry run and live mode, with no move", async () => {
    for (const dryRun of [true, false]) {
      const f = await createReconcileFixture();
      await f.setting("dry_run", dryRun);
      const due = await inReview(f);
      const ran = await inReview(f);
      await qaRan(f, ran.id);
      const held = await inReview(f, { hold: true });
      const report = await f.pass();
      expect(
        report.dispatches.map((d) => [d.nodeId, d.role, d.outcome]),
        String(dryRun),
      ).toEqual([
        [due.id, "qa", "planned"],
        [held.id, "qa", "not_dispatchable"],
      ]);
      expect(report.dispatches[0]).toMatchObject({
        state: "in_qa_review",
        run: { bot: "qa", headSha: HEAD, prNumber: REVIEW_PR, taskType: "qa:review" },
      });
      // QA's run has no move: nothing is written, in either mode.
      expect(report.dispatches[0]?.transition).toBeUndefined();
      expect(await f.transitions(due.id, ran.id, held.id)).toEqual([]);
      expect(await f.store.listActiveRuns()).toEqual([]);
    }
  });
});
