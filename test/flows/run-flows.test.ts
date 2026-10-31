// Seam: the dispatch, run-end and cancel-runs flows (build plan M3.1 and M3.2, ADR 0102, ADR 0106
// sections 5 to 7, ADR 0107, D-202, D-213) with a fake agent runtime on the memory store and the
// real machine-2 contracts and guards. Admission itself is tested in src/core/runs.test.ts and
// the task input in src/core/task-input.test.ts; this covers the flows around them: what is
// started and with what, what is recorded, what happens when a step fails part way, and that a
// duplicate trigger gives one run and one end.
import { describe, expect, it } from "vitest";

import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { run as cancelRuns } from "../../flows/cancel-runs.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { visualApprovalTopic } from "../../src/core/guards/design.ts";
import { hashRunToken } from "../../src/core/run-tokens.ts";
import type { Store } from "../../src/core/store.ts";
import { createFlowFixture, HEAD, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "token-like-text-that-is-never-stored",
  turns: 12,
  costUsd: 0.4,
  minutes: 6,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

async function readyItem(f: FlowFixture) {
  return f.node("ready_for_dev", {
    body: {
      description: "Add the health check.",
      acceptanceCriteria: ["GET /health answers 200"],
      pathsInScope: ["src/service/"],
      checks: ["npm run check"],
    },
  });
}

/** What a dispatch wrote for a node: its runs, tokens, handles, dispatch records and moves. */
async function written(f: FlowFixture, nodeId: string) {
  const runs = await f.store.listRuns({ nodeId });
  return {
    runs,
    handles: await Promise.all(runs.map((r) => f.store.getRunHandle(r.id))),
    dispatchRecords: await f.store.listEvidence({ nodeId, kind: "dispatch_record" }),
    transitions: await f.transitions(nodeId),
    state: (await f.store.getNode(nodeId))?.state,
  };
}

const tokenOf = (f: FlowFixture, i = 0) =>
  f.store.getRunToken(hashRunToken(f.tokens[i] ?? ""));

describe("dispatch flow (flow: fake adapters, build plan M3.1 and M3.2)", () => {
  it("starts a Developer run with its task, route and token, and records the start with its move", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const result = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    const after = await written(f, node.id);
    const [run] = after.runs;
    if (!run || result.outcome !== "started") throw new Error("not started");

    // Started once, with the route's model and provider and the run's own token.
    expect(f.runtime.started).toEqual([
      {
        task: {
          runId: run.id,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          stateApiToken: f.tokens[0],
        },
        limits: f.deps.limits.developer,
      },
    ]);
    // Only the token's hash is stored, linked to the run; the token is in no stored row.
    expect(await tokenOf(f)).toMatchObject({
      runId: run.id,
      role: "developer",
      revokedAt: null,
    });
    expect(JSON.stringify(after)).not.toContain(f.tokens[0]);

    // The handle, the dispatch record and the move, all written together.
    expect(after.handles).toEqual([{ runtime: "fake", runId: run.id }]);
    expect(after.dispatchRecords).toMatchObject([
      {
        runId: run.id,
        recordedBy: "runner",
        payload: { repo: "didi-build/rehearsal", branch: `foreman/${node.id}` },
      },
    ]);
    expect(after.transitions).toMatchObject([
      {
        fromState: "ready_for_dev",
        toState: "in_development",
        mode: "applied",
        triggerKind: "event",
        triggerRef: `dispatch:${run.id}`,
      },
    ]);
    expect(after.transitions[0]?.evidenceIds).toContain(after.dispatchRecords[0]?.id);
    expect(after.state).toBe("in_development");
    expect(result).toEqual({
      outcome: "started",
      runId: run.id,
      handle: { runtime: "fake", runId: run.id },
      transitionId: after.transitions[0]?.id,
      dispatchRecordId: after.dispatchRecords[0]?.id,
    });
  });

  it("gives the task source the item's input (D-213) and the branch", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    const [start] = f.tasksFor;
    expect(start?.branch).toBe(`foreman/${node.id}`);
    expect(start?.input).toContain(
      "## Acceptance criteria\n\n- GET /health answers 200",
    );
    expect(start?.input).toContain(
      "## Checks that must pass before a push\n\n- npm run check",
    );
    expect(start?.input).toContain(`## Branch\n\nforeman/${node.id}`);
    expect(start?.evidenceIds).toEqual([]);
  });

  it("refuses under the kill switch, writes nothing and starts nothing", async () => {
    const f = await createFlowFixture();
    await f.live();
    await f.killed();
    const node = await readyItem(f);
    const before = await f.footprint(node.id);
    expect(await dispatch(f.deps, { nodeId: node.id, role: "developer" })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.started).toEqual([]);
  });

  it("in dry run plans the run, inserts nothing and starts nothing", async () => {
    const f = await createFlowFixture();
    const node = await readyItem(f);
    const before = await f.footprint(node.id);
    const result = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    expect(result).toMatchObject({ outcome: "planned", run: { nodeId: node.id } });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.started).toEqual([]);
    expect(f.tokens).toEqual([]);
  });

  it("checks the move's guards before anything is admitted or started", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    await f.openGate(node.id, `scope:${node.id}`);
    const before = await f.footprint(node.id);
    expect(await dispatch(f.deps, { nodeId: node.id, role: "developer" })).toEqual({
      outcome: "not_started",
      allowed: false,
      reason: "guard_failed",
      failedGuards: ["no_pending_gate"],
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.started).toEqual([]);
  });

  it("refuses an item whose body has a field of the wrong shape, naming the field", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("ready_for_dev", { body: { acceptanceCriteria: "one" } });
    const before = await f.footprint(node.id);
    await expect(
      dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).rejects.toThrow("body.acceptanceCriteria must be a list of text");
    expect(await f.footprint(node.id)).toBe(before);
  });

  it("gives one run for a duplicate trigger, in turn or at once", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const input = { nodeId: node.id, role: "developer" as const };
    await dispatch(f.deps, input);
    expect(await dispatch(f.deps, input)).toEqual({
      outcome: "not_admitted",
      admitted: false,
      reason: "item_has_active_run",
    });
    const other = await readyItem(f);
    const both = await Promise.all([
      dispatch(f.deps, { ...input, nodeId: other.id }),
      dispatch(f.deps, { ...input, nodeId: other.id }),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["not_admitted", "started"]);
    expect(await f.store.listRuns({ nodeId: node.id })).toHaveLength(1);
    expect((await written(f, other.id)).transitions).toHaveLength(1);
    expect(f.runtime.started).toHaveLength(2);
  });

  it("starts QA with the runner's evidence on the head to cite, and no dispatch record or move", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("in_qa_review");
    const ci = await f.evidence(
      node.id,
      "ci_run",
      { conclusion: "success", pr: 7 },
      { commitSha: HEAD },
    );
    await f.evidence(
      node.id,
      "ci_run",
      { conclusion: "success", pr: 7 },
      {
        commitSha: "a".repeat(40),
      },
    );
    const input = { nodeId: node.id, role: "qa" as const, prNumber: 7, headSha: HEAD };
    expect((await dispatch(f.deps, input)).outcome).toBe("started");
    expect(f.tasksFor[0]).toMatchObject({ branch: null, evidenceIds: [ci] });
    expect(f.tasksFor[0]?.input).toContain(`## Head commit\n\n${HEAD}`);
    const after = await written(f, node.id);
    expect(after.dispatchRecords).toEqual([]);
    expect(after.transitions).toEqual([]);
    expect(after.handles).toHaveLength(1);
    expect(await dispatch(f.deps, input)).toMatchObject({ reason: "qa_duplicate" });
    expect(f.runtime.started).toHaveLength(1);
  });

  it("records a fresh dispatch record and no move for a Developer run resumed in In development", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("in_development");
    expect(
      (await dispatch(f.deps, { nodeId: node.id, role: "developer" })).outcome,
    ).toBe("started");
    const after = await written(f, node.id);
    expect(after.dispatchRecords).toMatchObject([
      { payload: { branch: `foreman/${node.id}` } },
    ]);
    expect(after.transitions).toEqual([]);
    expect(after.state).toBe("in_development");
  });
});

describe("dispatch flow when a step fails part way (flow: fake adapters, build plan M3.2)", () => {
  it.each(["start", "task"] as const)(
    "ends the run fail and revokes its token when the %s step fails, with nothing running",
    async (step) => {
      const f = await createFlowFixture();
      await f.live();
      const node = await readyItem(f);
      if (step === "start") f.runtime.failNext.add("start");
      else
        f.deps.tasks.taskFor = async () => {
          throw new Error("no bot file");
        };
      await expect(
        dispatch(f.deps, { nodeId: node.id, role: "developer" }),
      ).rejects.toThrow();
      const after = await written(f, node.id);
      expect(after.runs).toMatchObject([{ outcome: "fail" }]);
      expect(after.handles).toEqual([null]);
      expect(after.dispatchRecords).toEqual([]);
      expect(after.transitions).toEqual([]);
      expect(after.state).toBe("ready_for_dev");
      expect((await tokenOf(f))?.revokedAt).not.toBeNull();
      expect(f.runtime.started).toEqual([]);
    },
  );

  it("cancels the started run when the kill switch is turned on while it starts", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    f.runtime.duringStart = () => f.killed();
    const result = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    const after = await written(f, node.id);
    expect(result).toEqual({
      outcome: "cancelled",
      runId: after.runs[0]?.id,
      reason: "kill_switch",
    });
    expect(f.runtime.cancelled).toEqual([
      { runtime: "fake", runId: after.runs[0]?.id },
    ]);
    expect(after.runs).toMatchObject([{ outcome: "cancelled" }]);
    expect(after.dispatchRecords).toEqual([]);
    expect(after.transitions).toEqual([]);
    expect(after.state).toBe("ready_for_dev");
    expect((await tokenOf(f))?.revokedAt).not.toBeNull();
  });

  it("cancels the started run when its move is refused at the record step, writing nothing", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    // A gate request opened after the guards were checked and before the start was recorded.
    f.runtime.duringStart = async () => {
      await f.openGate(node.id, visualApprovalTopic(node.id));
    };
    expect(
      await dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).toMatchObject({
      outcome: "cancelled",
      reason: "guard_failed",
    });
    const after = await written(f, node.id);
    expect(after.runs).toMatchObject([{ outcome: "cancelled" }]);
    expect(after.handles).toEqual([null]);
    expect(after.dispatchRecords).toEqual([]);
    expect(after.transitions).toEqual([]);
  });

  it("keeps the handle on the run when the started run cannot be cancelled, for the cancel pass", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    f.runtime.duringStart = () => f.killed();
    f.runtime.failNext.add("cancel");
    await expect(
      dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).rejects.toThrow("the fake runtime refused to cancel");
    const after = await written(f, node.id);
    expect(after.runs).toMatchObject([{ endedAt: null }]);
    expect(after.handles).toEqual([{ runtime: "fake", runId: after.runs[0]?.id }]);
    // The cancel pass then stops it.
    expect(await cancelRuns(f.deps)).toMatchObject({ cancelled: [after.runs[0]?.id] });
    expect((await written(f, node.id)).runs).toMatchObject([{ outcome: "cancelled" }]);
  });

  it("cancels the started run when the store fails while recording the start", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const store = f.deps.store as Store;
    const real = store.transaction.bind(store);
    f.runtime.duringStart = async () => {
      store.transaction = async () => {
        store.transaction = real;
        throw new Error("the database went away");
      };
    };
    await expect(
      dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).rejects.toThrow("the database went away");
    const after = await written(f, node.id);
    expect(f.runtime.cancelled).toHaveLength(1);
    expect(after.runs).toMatchObject([{ outcome: "cancelled" }]);
    expect(after.dispatchRecords).toEqual([]);
    expect(after.transitions).toEqual([]);
    expect((await tokenOf(f))?.revokedAt).not.toBeNull();
  });
});

describe("cancel-runs flow, the kill switch (flow: fake adapters, D-202)", () => {
  async function twoRunning() {
    const f = await createFlowFixture();
    await f.live();
    const nodes = [await readyItem(f), await f.node("in_qa_review")];
    await dispatch(f.deps, { nodeId: nodes[0]?.id ?? "", role: "developer" });
    await dispatch(f.deps, {
      nodeId: nodes[1]?.id ?? "",
      role: "qa",
      prNumber: 7,
      headSha: HEAD,
    });
    const runs = await f.store.listActiveRuns();
    expect(runs).toHaveLength(2);
    return { f, runs };
  }

  it("does nothing while the kill switch is off", async () => {
    const { f } = await twoRunning();
    expect(await cancelRuns(f.deps)).toEqual({ outcome: "kill_switch_off" });
    expect(f.runtime.cancelled).toEqual([]);
    expect(await f.store.listActiveRuns()).toHaveLength(2);
  });

  it("stops each active run through the runtime, ends it cancelled and revokes its token", async () => {
    const { f, runs } = await twoRunning();
    const transitions = await f.transitions(...runs.map((r) => r.nodeId ?? ""));
    await f.killed();
    expect(await cancelRuns(f.deps)).toEqual({
      outcome: "cancelled",
      cancelled: runs.map((r) => r.id),
      failed: [],
    });
    expect(f.runtime.cancelled).toEqual(
      runs.map((r) => ({ runtime: "fake", runId: r.id })),
    );
    expect(f.runtime.cleaned).toHaveLength(2);
    for (const run of runs) {
      expect(await f.store.getRun(run.id)).toMatchObject({ outcome: "cancelled" });
    }
    for (const i of [0, 1]) expect((await tokenOf(f, i))?.revokedAt).not.toBeNull();
    // No transition is written, so none is half-written.
    expect(await f.transitions(...runs.map((r) => r.nodeId ?? ""))).toEqual(
      transitions,
    );
    expect(await cancelRuns(f.deps)).toEqual({
      outcome: "cancelled",
      cancelled: [],
      failed: [],
    });
  });

  it("leaves a run it could not stop active, names it, and stops it on the next pass", async () => {
    const { f, runs } = await twoRunning();
    await f.killed();
    f.runtime.failNext.add("cancel");
    expect(await cancelRuns(f.deps)).toEqual({
      outcome: "cancelled",
      cancelled: [runs[1]?.id],
      failed: [runs[0]?.id],
    });
    expect(await f.store.getRun(runs[0]?.id ?? "")).toMatchObject({ endedAt: null });
    // The reconcile flow runs the cancel pass on every pass the kill switch stops.
    expect((await reconcileFlow(f.deps)).cancelled).toEqual({
      cancelled: [runs[0]?.id],
      failed: [],
    });
  });

  it("ends a run still starting, and its dispatch then cancels what it started", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    f.runtime.duringStart = async () => {
      await f.killed();
      await cancelRuns(f.deps);
    };
    const result = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    expect(result).toMatchObject({ outcome: "cancelled" });
    const after = await written(f, node.id);
    expect(after.runs).toMatchObject([{ outcome: "cancelled" }]);
    expect(f.runtime.cancelled).toHaveLength(1);
    expect(after.transitions).toEqual([]);
  });
});

describe("run-end flow (flow: fake adapters, build plan M3.1 and M3.2)", () => {
  async function activeRun() {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const started = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    if (started.outcome !== "started") throw new Error("the dispatch was not started");
    return { f, node, input: { runId: started.runId }, handle: started.handle };
  }

  it("polls with the stored handle, records the end once finished, revokes the token, then cleans up", async () => {
    const { f, input, handle } = await activeRun();
    expect(await recordRunEnd(f.deps, input)).toEqual({ outcome: "running" });
    expect(f.runtime.polled).toEqual([handle]);
    expect((await f.store.getRun(input.runId))?.endedAt).toBeNull();

    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    expect(await recordRunEnd(f.deps, input)).toMatchObject({ outcome: "recorded" });
    const ended = await f.store.getRun(input.runId);
    expect(ended).toMatchObject({
      outcome: "success",
      turns: 12,
      minutes: 6,
      costUsd: 0.4,
    });
    expect(ended?.tokens).toEqual(RESULT.tokens);
    expect(JSON.stringify(ended)).not.toContain(RESULT.finalText);
    expect((await tokenOf(f))?.revokedAt).toEqual(ended?.endedAt);
    expect(f.runtime.cleaned).toEqual([handle]);
  });

  it("does not poll a run with no handle kept", async () => {
    const { f } = await activeRun();
    const run = await f.run((await f.node("in_development")).id, "developer");
    expect(await recordRunEnd(f.deps, { runId: run.id })).toEqual({
      outcome: "no_handle",
    });
    expect(f.runtime.polled).toEqual([]);
  });

  it("refuses under the kill switch without polling or writing", async () => {
    const { f, node, input } = await activeRun();
    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    await f.killed();
    const before = await f.footprint(node.id);
    expect(await recordRunEnd(f.deps, input)).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.polled).toEqual([]);
    expect(f.runtime.cleaned).toEqual([]);
  });

  it("in dry run reports what it would record and writes nothing", async () => {
    const { f, node, input } = await activeRun();
    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    await f.setting("dry_run", true);
    const before = await f.footprint(node.id);
    expect(await recordRunEnd(f.deps, input)).toMatchObject({
      outcome: "would_record",
      report: { outcome: "success" },
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.cleaned).toEqual([]);
  });

  it("records one end for a duplicate trigger, in turn or at once", async () => {
    const { f, input } = await activeRun();
    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    const both = await Promise.all([
      recordRunEnd(f.deps, input),
      recordRunEnd(f.deps, input),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["already_recorded", "recorded"]);
    const endedAt = (await f.store.getRun(input.runId))?.endedAt;
    f.advanceMinutes(5);
    expect(await recordRunEnd(f.deps, input)).toEqual({ outcome: "already_recorded" });
    expect((await f.store.getRun(input.runId))?.endedAt).toEqual(endedAt);
  });

  it("records a usage-exhausted end with its cause, which queues the dispatch", async () => {
    const { f, node, input } = await activeRun();
    f.runtime.status.set(input.runId, {
      state: "finished",
      result: {
        ...RESULT,
        outcome: "usage_exhausted",
        usageExhaustedCause: "rate_limit",
        retryAfterSeconds: 60,
      },
    });
    await recordRunEnd(f.deps, input);
    expect(await f.store.getRun(input.runId)).toMatchObject({
      outcome: "usage_exhausted",
      usageExhaustedCause: "rate_limit",
      retryAfterSeconds: 60,
    });
    expect(
      await dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).toMatchObject({
      reason: "usage_exhausted_wait",
    });
  });
});
