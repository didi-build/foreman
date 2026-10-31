// Seam: the reconcile pass in dry run (build plan M2.4, technical architecture section 2.5) with
// the real machine-2 contracts and guards, on the memory store and the fake GitHub. Each step
// gets a fixture project; every test also checks that nothing outside the dry-run rows changed.
// The same write path on Postgres is in test/db/reconcile.test.ts.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_LIMITS,
  executionAlert,
  readExecutionLimits,
} from "../src/core/reconcile.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import {
  HEAD,
  MINUTE,
  REPO,
  DEVELOPER_APP,
  START,
  createReconcileFixture,
  type ReconcileFixture,
} from "./reconcile-fixture.ts";

const NEWER = "d".repeat(40);

const ciGreen = (f: ReconcileFixture, nodeId: string, sha = HEAD) =>
  f.evidence(
    nodeId,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: [] },
    { commitSha: sha },
  );

const docsNone = (f: ReconcileFixture, nodeId: string) =>
  f.evidence(nodeId, "docs_note", { impact: "none" });

/** Nothing acts in dry run: no run inserted and no gate request closed. */
async function expectNothingActed(
  f: ReconcileFixture,
  activeBefore: number,
  openGates: number,
) {
  expect(await f.store.listActiveRuns()).toHaveLength(activeBefore);
  expect(await f.store.listOpenGateRequests(f.projectId)).toHaveLength(openGates);
}

describe("reconcile pass, kill switch and mode (unit: section 2.5 step 1)", () => {
  it("stops before anything when the kill switch is on, polling included", async () => {
    const f = await createReconcileFixture();
    const blocker = await f.node("done");
    const blocked = await f.node("blocked");
    await f.blocks(blocker.id, blocked.id);
    await f.node("ready_for_dev");
    await f.evidence(blocked.id, "dispatch_record", {
      repo: REPO,
      branch: "foreman/x",
    });
    await f.setting("kill_switch", true);

    const report = await f.pass();

    expect(report.stopped).toBe("kill_switch");
    expect(report.releases).toEqual([]);
    expect(report.dispatches).toEqual([]);
    expect(report.polls).toEqual([]);
    expect(f.github.reads).toBe(0);
    expect(await f.transitions(blocked.id)).toEqual([]);
  });

  it("stops when dry_run is false, since live mode is not built", async () => {
    const f = await createReconcileFixture();
    const blocker = await f.node("done");
    const blocked = await f.node("blocked");
    await f.blocks(blocker.id, blocked.id);
    await f.setting("dry_run", false);

    const report = await f.pass();

    expect(report.stopped).toBe("live_mode_not_built");
    expect(await f.transitions(blocked.id)).toEqual([]);
    expect((await f.store.getNode(blocked.id))?.state).toBe("blocked");
  });
});

describe("reconcile pass, release (unit: section 2.5 step 2)", () => {
  it("plans the release of a blocked item whose blockers are done, and leaves the node as it is", async () => {
    const f = await createReconcileFixture();
    const blocker = await f.node("done");
    const blocked = await f.node("blocked");
    await f.blocks(blocker.id, blocked.id);

    const report = await f.pass();

    expect(report.stopped).toBeNull();
    expect(report.releases).toHaveLength(1);
    expect(report.releases[0]).toMatchObject({
      nodeId: blocked.id,
      fromState: "blocked",
      toState: "ready_for_dev",
      outcome: "planned",
    });
    const rows = await f.transitions(blocked.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mode: "dry_run",
      fromState: "blocked",
      toState: "ready_for_dev",
      triggerKind: "reconcile",
      actorId: "reconcile",
      specVersion: f.contracts.version,
    });
    const after = await f.store.getNode(blocked.id);
    expect(after?.state).toBe("blocked");
    expect(after?.version).toBe(0);
  });

  it("does not release an item with a blocker that is not done", async () => {
    const f = await createReconcileFixture();
    const blocker = await f.node("in_development");
    const blocked = await f.node("blocked");
    await f.blocks(blocker.id, blocked.id);

    const report = await f.pass();

    expect(report.releases[0]).toMatchObject({
      outcome: "rejected",
      reason: "guard_failed",
    });
    const failed = report.releases[0]?.guardReport
      .filter((c) => !c.pass)
      .map((c) => c.name);
    expect(failed).toEqual(["blockers_done"]);
    expect(await f.transitions(blocked.id)).toEqual([]);
  });

  it("does not release an item whose done design blocker has no merged spec", async () => {
    const f = await createReconcileFixture();
    const design = await f.node("done", { track: "design" });
    const blocked = await f.node("blocked");
    await f.blocks(design.id, blocked.id);

    const report = await f.pass();
    const failed = report.releases[0]?.guardReport
      .filter((c) => !c.pass)
      .map((c) => c.name);
    expect(failed).toEqual(["design_spec_merged"]);

    await f.evidence(
      design.id,
      "merge_commit",
      { pr: 3 },
      { commitSha: "c".repeat(40) },
    );
    expect((await f.pass()).releases[0]?.outcome).toBe("planned");
  });
});

describe("reconcile pass, dispatch (unit: section 2.5 step 3)", () => {
  it("plans dispatches within the Developer limit, skips items with an active run, and inserts no run", async () => {
    const f = await createReconcileFixture();
    const working = await f.node("in_development");
    await f.run(working.id, "developer", 5);
    const readyRunning = await f.node("ready_for_dev");
    await f.run(readyRunning.id, "developer", 5);
    const ready = [];
    for (let i = 0; i < 4; i++) ready.push(await f.node("ready_for_dev"));

    const report = await f.pass();

    // Two Developer runs are active, so one of the three per-project slots is left.
    expect(report.dispatches.map((d) => d.nodeId)).toEqual(ready.map((n) => n.id));
    expect(report.dispatches.map((d) => d.outcome)).toEqual([
      "planned",
      "refused",
      "refused",
      "refused",
    ]);
    expect(report.dispatches.slice(1).map((d) => d.reason)).toEqual([
      "developer_limit",
      "developer_limit",
      "developer_limit",
    ]);
    const first = report.dispatches[0];
    expect(first?.role).toBe("developer");
    expect(first?.run?.id).toMatch(/^planned:/);
    expect(first?.transition).toMatchObject({
      toState: "in_development",
      outcome: "planned",
    });
    // Only the planned dispatch writes its dry-run transition.
    expect(await f.transitions(...ready.map((n) => n.id))).toHaveLength(1);
    await expectNothingActed(f, 2, 0);
    expect((await f.store.getNode(ready[0]!.id))?.state).toBe("ready_for_dev");
  });

  it("does not dispatch a ready item with a pending gate, on hold, or not agent-ready", async () => {
    const f = await createReconcileFixture();
    const gated = await f.node("ready_for_dev");
    await f.openGate(gated.id, `escalation:${gated.id}`);
    const held = await f.node("ready_for_dev", { hold: true });
    const notReady = await f.node("ready_for_dev", { agentReady: false });

    const report = await f.pass();

    expect(report.dispatches).toEqual([
      expect.objectContaining({
        nodeId: gated.id,
        outcome: "guard_failed",
        reason: "no_pending_gate",
      }),
      expect.objectContaining({ nodeId: held.id, outcome: "not_dispatchable" }),
      expect.objectContaining({ nodeId: notReady.id, outcome: "not_dispatchable" }),
    ]);
    await expectNothingActed(f, 0, 1);
  });

  it("puts a ready item that is still not running at the next pass on the attention list", async () => {
    const f = await createReconcileFixture();
    const ready = await f.node("ready_for_dev");

    expect((await f.pass()).attention).toEqual([]);
    f.advanceMinutes(120);
    const second = await f.pass();

    expect(second.attention).toEqual([
      {
        nodeId: ready.id,
        state: "ready_for_dev",
        readySince: new Date(START),
        dispatch: "planned",
      },
    ]);
  });

  it("dispatches a node queued after usage_exhausted only once its wait has passed", async () => {
    const f = await createReconcileFixture();
    const queued = await f.node("in_development");
    const run = await f.run(queued.id, "developer", 20);
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
    });

    f.advanceMinutes(10);
    const early = await f.pass();
    expect(early.dispatches).toEqual([
      expect.objectContaining({
        nodeId: queued.id,
        outcome: "waiting",
        reason: "rate_limit",
        resumeAt: new Date(START + 30 * MINUTE),
      }),
    ]);

    f.advanceMinutes(21);
    const later = await f.pass();
    expect(later.dispatches).toEqual([
      expect.objectContaining({
        nodeId: queued.id,
        outcome: "planned",
        role: "developer",
      }),
    ]);
    // It stays in its state: no transition, only the planned run.
    expect(later.dispatches[0]?.transition).toBeUndefined();
    await expectNothingActed(f, 0, 0);
  });
});

describe("reconcile pass, advance from evidence (unit: section 2.5 step 4)", () => {
  it("plans the move to QA review on CI green on the head, and plans the QA dispatch", async () => {
    const f = await createReconcileFixture();
    const item = await f.node("in_development");
    await ciGreen(f, item.id);
    await docsNone(f, item.id);

    const report = await f.pass();

    expect(report.advances).toHaveLength(1);
    expect(report.advances[0]).toMatchObject({
      nodeId: item.id,
      toState: "in_qa_review",
      outcome: "planned",
      dispatch: { role: "qa", outcome: "planned" },
    });
    expect(report.advances[0]?.dispatch?.run).toMatchObject({
      prNumber: 7,
      headSha: HEAD,
    });
    expect((await f.transitions(item.id)).map((t) => t.mode)).toEqual(["dry_run"]);
    expect((await f.store.getNode(item.id))?.state).toBe("in_development");
    await expectNothingActed(f, 0, 0);
  });

  it("does not advance while CI on the head is not green", async () => {
    const f = await createReconcileFixture();
    const item = await f.node("in_development");
    await f.evidence(
      item.id,
      "ci_run",
      { conclusion: "failure", pr: 7 },
      { commitSha: HEAD },
    );
    await docsNone(f, item.id);

    const report = await f.pass();

    expect(report.advances[0]).toMatchObject({
      outcome: "rejected",
      reason: "guard_failed",
    });
    expect(report.advances[0]?.dispatch).toBeUndefined();
    expect(await f.transitions(item.id)).toEqual([]);
  });
});

describe("reconcile pass, stall check (unit: section 2.5 step 5)", () => {
  it("flags an active run with no activity within its budget window, and only that one", async () => {
    const f = await createReconcileFixture();
    const old = await f.run((await f.node("in_development")).id, "developer", 60);
    await f.run((await f.node("in_development")).id, "developer", 10);
    const busy = await f.run((await f.node("in_development")).id, "developer", 60);
    await f.evidence(
      busy.nodeId!,
      "agent_report",
      { summary: "still going" },
      { runId: busy.id },
    );

    const report = await f.pass();

    expect(report.stalls).toEqual([
      expect.objectContaining({ runId: old.id, budgetMinutes: 50, idleMinutes: 60 }),
    ]);
    // Report only: the run is still active.
    expect((await f.store.getRun(old.id))?.endedAt).toBeNull();
  });
});

describe("reconcile pass, gate cleanup (unit: section 2.5 step 6)", () => {
  it("reports an open gate request on a done node as a candidate and leaves it open", async () => {
    const f = await createReconcileFixture();
    const done = await f.node("done");
    const gate = await f.openGate(done.id, `escalation:${done.id}`);
    const working = await f.node("in_development");
    await f.openGate(working.id, `escalation:${working.id}`);

    const report = await f.pass();

    expect(report.gateCleanup).toEqual([
      {
        gateRequestId: gate.id,
        projectId: f.projectId,
        topicKey: gate.topicKey,
        nodeId: done.id,
        reason: "node_done",
      },
    ]);
    expect((await f.store.getGateRequest(gate.id))?.status).toBe("open");
    await expectNothingActed(f, 0, 2);
  });
});

describe("reconcile pass, polling backstop (unit: ADR 0113 section 6)", () => {
  it("polls each repository with dispatched work through the GitHub reader and records the evidence", async () => {
    const f = await createReconcileFixture();
    const item = await f.node("in_development");
    await f.evidence(item.id, "dispatch_record", {
      repo: REPO,
      branch: "foreman/item-1",
    });
    f.github.putPullRequest({
      repo: REPO,
      number: 7,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headSha: HEAD,
      headBranch: "foreman/item-1",
      headRepo: REPO,
      author: DEVELOPER_APP,
    });
    f.github.setCheckRuns(REPO, HEAD, [
      {
        id: 1,
        name: "test",
        appSlug: "github-actions",
        status: "completed",
        conclusion: "success",
      },
    ]);

    const report = await f.pass();

    expect(f.github.reads).toBeGreaterThan(0);
    expect(report.polls).toEqual([
      {
        repo: REPO,
        results: [expect.objectContaining({ pr: 7, outcome: "recorded" })],
      },
    ]);
    const ci = await f.store.listEvidence({ nodeId: item.id, kind: "ci_run" });
    expect(ci).toHaveLength(1);
    expect(ci[0]).toMatchObject({ commitSha: HEAD, recordedBy: "github" });
    // The advance step reads the polled evidence; it waits only for the docs note.
    const failed = report.advances[0]?.guardReport
      .filter((c) => !c.pass)
      .map((c) => c.name);
    expect(failed).toEqual(["docs_updated_or_none"]);
  });

  it("does not poll a repository with no dispatched work", async () => {
    const f = await createReconcileFixture();
    await f.node("ready_for_dev");
    const report = await f.pass();
    expect(report.polls).toEqual([]);
    expect(f.github.reads).toBe(0);
  });
});

describe("reconcile pass, idempotency (unit: build plan M2.4)", () => {
  it("plans the same thing on a second pass and writes no duplicate dry-run row", async () => {
    const f = await createReconcileFixture();
    const blocker = await f.node("done");
    const blocked = await f.node("blocked");
    await f.blocks(blocker.id, blocked.id);
    const ready = await f.node("ready_for_dev");
    const item = await f.node("in_development");
    await ciGreen(f, item.id);
    await docsNone(f, item.id);
    const nodeIds = [blocked.id, ready.id, item.id];

    const first = await f.pass();
    const rows = await f.transitions(...nodeIds);
    expect(rows).toHaveLength(3);

    f.advanceMinutes(1);
    const second = await f.pass();

    expect(await f.transitions(...nodeIds)).toEqual(rows);
    expect(second.releases.map((r) => r.outcome)).toEqual(["already_planned"]);
    expect(second.dispatches[0]?.transition?.outcome).toBe("already_planned");
    expect(second.advances.map((a) => a.outcome)).toEqual(["already_planned"]);
    const ids = (r: typeof first) => [
      ...r.releases.map((m) => m.transitionId),
      r.dispatches[0]?.transition?.transitionId,
      ...r.advances.map((m) => m.transitionId),
    ];
    expect(ids(second)).toEqual(ids(first));
    expect(second.dispatches.map((d) => d.outcome)).toEqual(
      first.dispatches.map((d) => d.outcome),
    );
    await expectNothingActed(f, 0, 0);
  });

  it("writes a new row when the evidence behind the plan changes", async () => {
    const f = await createReconcileFixture();
    const item = await f.node("in_development");
    await ciGreen(f, item.id);
    await docsNone(f, item.id);
    await f.pass();

    f.advanceMinutes(1);
    await ciGreen(f, item.id, NEWER);
    await docsNone(f, item.id);
    const report = await f.pass();

    expect(report.advances[0]?.outcome).toBe("planned");
    expect(await f.transitions(item.id)).toHaveLength(2);
  });
});

describe("Windmill execution count (unit: D-167, P-21)", () => {
  it("alerts at 80% of the monthly limit", () => {
    expect(executionAlert(799, DEFAULT_EXECUTION_LIMITS).alert).toBe(false);
    expect(executionAlert(800, DEFAULT_EXECUTION_LIMITS)).toEqual({
      monthlyLimit: 1000,
      alertPercent: 80,
      count: 800,
      threshold: 800,
      alert: true,
    });
    expect(executionAlert(450, { monthlyLimit: 500, alertPercent: 90 }).alert).toBe(
      true,
    );
    expect(() => executionAlert(-1, DEFAULT_EXECUTION_LIMITS)).toThrow();
  });

  it("reads the limit and percent from settings, and uses the D-167 values when missing", async () => {
    const store = createMemoryStore();
    const problems: string[] = [];
    expect(await readExecutionLimits(store, problems)).toEqual(
      DEFAULT_EXECUTION_LIMITS,
    );
    expect(problems).toHaveLength(2);

    const f = await createReconcileFixture();
    await f.setting("windmill_monthly_execution_limit", 2000);
    const report = await f.pass({ windmillExecutionsThisMonth: 1700 });
    expect(report.executions).toMatchObject({ threshold: 1600, alert: true });
    expect(report.problems).toEqual([]);
  });

  it("reports the count even when the kill switch stops the pass", async () => {
    const f = await createReconcileFixture();
    await f.setting("kill_switch", true);
    const report = await f.pass({ windmillExecutionsThisMonth: 10 });
    expect(report.stopped).toBe("kill_switch");
    expect(report.executions?.alert).toBe(false);
  });
});
