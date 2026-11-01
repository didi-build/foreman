// Seam: the flows around escalation (build plan M3.5, O-42 to O-46) with a fake agent runtime on
// the memory store and the real machine-2 contracts and guards: the run-end flow after a done
// report on a head QA already failed (refused, counted, and the fix round goes on), the dispatch
// flow after repeated failed starts (counted, then the Council), the reconcile flow's escalation
// pass after a Council decision, and the approval resume step after Didi's answer to an
// escalation question. The rules themselves are in test/escalations.test.ts.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import { createLibrary } from "../../src/core/library.ts";
import { HEAD } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 12,
  costUsd: 0.4,
  minutes: 6,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};
const KEEPS = { changesProductDirection: false, passesGate: false };

/** Makes the clock move one second at each read, as a real clock moves between steps. */
function ticking(t: FlowFixture) {
  const read = t.clock.now;
  t.clock.now = () => {
    t.advanceMinutes(1 / 60);
    return read();
  };
}

async function finish(f: FlowFixture, runId: string) {
  f.runtime.status.set(runId, { state: "finished", result: RESULT });
  return recordRunEnd(f.deps, { runId });
}

/** An item escalated to the Council from In development, live. */
async function escalated(f: FlowFixture) {
  const node = await f.node("in_development");
  await f.store.setCounter(node.id, "failure", 3, f.clock.now());
  await createEscalations(f.deps).escalate(
    node.id,
    { kind: "event", ref: "test:escalate" },
    "three failures",
  );
  return node;
}

describe("run-end flow after a done report on a head QA failed (flow: fake adapters, O-42, O-43)", () => {
  it("refuses the move to QA, counts once, and starts the next Developer run on the same branch", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await f.node("ready_for_dev");
    const first = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    if (first.outcome !== "started") throw new Error("the Developer was not started");
    const ciId = await f.evidence(
      node.id,
      "ci_run",
      { conclusion: "success", pr: 7, changedPaths: ["src/a.ts"] },
      { commitSha: HEAD },
    );
    await f.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });
    expect(await finish(f, first.runId)).toMatchObject({
      move: { outcome: "applied", toState: "in_qa_review" },
    });
    const qa = await dispatch(f.deps, {
      nodeId: node.id,
      role: "qa",
      prNumber: 7,
      headSha: HEAD,
    });
    if (qa.outcome !== "started") throw new Error("QA was not started");
    await f.evidence(
      node.id,
      "qa_verdict",
      {
        verdict: "fail",
        findings: [{ path: "src/a.ts", startLine: 1, endLine: 1, note: "wrong" }],
        evidenceIds: [ciId],
      },
      { commitSha: HEAD, runId: qa.runId },
    );
    const failed = await finish(f, qa.runId);
    expect(failed).toMatchObject({
      move: { outcome: "applied", toState: "in_development" },
      builderRuns: [{ cause: "returned", result: { outcome: "started" } }],
    });
    const fix =
      failed.outcome === "recorded" ? failed.builderRuns[0]?.result : undefined;
    if (fix?.outcome !== "started") throw new Error("the fix round was not started");

    // The fix round reports done with no new commit: the head QA failed is still the head.
    const refused = await finish(f, fix.runId);
    expect(refused).toMatchObject({
      outcome: "recorded",
      move: {
        outcome: "rejected",
        failedGuards: ["no_failed_qa_verdict_on_head"],
        failureCount: { counted: true, failures: 2 },
      },
      builderRuns: [
        { role: "developer", cause: "refused", result: { outcome: "started" } },
      ],
    });
    expect((await f.store.getNode(node.id))?.state).toBe("in_development");
    const runs = await f.store.listRuns({ nodeId: node.id });
    expect(runs.map((r) => r.bot)).toEqual([
      "developer",
      "qa",
      "developer",
      "developer",
    ]);
    // The new run is told why, and continues the item's one branch (D-220).
    const input = f.tasksFor.at(-1)?.input ?? "";
    expect(input).toContain("The runner refused the last done report");
    expect(input).toContain("no_failed_qa_verdict_on_head");
    expect(f.tasksFor.at(-1)?.branch).toBe(`foreman/${node.id}`);
    // A repeated run-end trigger counts nothing more and starts nothing more.
    expect(await recordRunEnd(f.deps, { runId: fix.runId })).toMatchObject({
      outcome: "already_recorded",
      move: { failureCount: { counted: "already_counted", failures: 2 } },
      builderRuns: [],
    });
    expect(await f.store.getCounter(node.id, "failure")).toBe(2);
  });
});

describe("dispatch flow after repeated failed starts (flow: fake adapters, O-44)", () => {
  it("counts each failed start after the first, and the third count escalates", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await f.node("ready_for_dev");
    for (let i = 0; i < 4; i++) {
      f.runtime.failNext.add("start");
      await expect(
        dispatch(f.deps, { nodeId: node.id, role: "developer" }),
      ).rejects.toThrow();
    }
    expect(await f.store.getCounter(node.id, "failure")).toBe(3);
    expect((await f.store.getNode(node.id))?.state).toBe("escalated_to_council");
    expect((await f.store.listRuns({ nodeId: node.id })).map((r) => r.outcome)).toEqual(
      ["fail", "fail", "fail", "fail"],
    );
  });

  it("counts nothing for a refusal that admits no run: the kill switch or dry run", async () => {
    const f = await createFlowFixture();
    const node = await f.node("ready_for_dev");
    expect(
      await dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).toMatchObject({
      outcome: "planned",
    });
    await f.killed();
    expect(
      await dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await f.store.getCounter(node.id, "failure")).toBe(0);
    expect(await f.store.listRuns({ nodeId: node.id })).toEqual([]);
  });
});

describe("the escalation pass and Didi's answer (flow: fake adapters, O-46)", () => {
  it("the reconcile flow returns an item the Council resolved, resets its counters and starts the work again", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await escalated(f);
    await createLibrary(f.deps).recordDecision({
      projectId: f.projectId,
      nodeId: node.id,
      kind: "council_decision",
      scope: KEEPS,
      textVerbatim: "Split the change in two.",
      byActor: "council",
    });
    const report = await reconcileFlow(f.deps);
    expect(report.escalations).toMatchObject([
      {
        nodeId: node.id,
        step: "returned",
        move: { outcome: "applied", toState: "in_development" },
      },
    ]);
    expect(report.builderRuns).toMatchObject([
      { nodeId: node.id, cause: "returned", result: { outcome: "started" } },
    ]);
    expect(f.tasksFor.at(-1)?.input).toContain("Split the change in two.");
    expect(await f.store.getCounter(node.id, "failure")).toBe(0);
    // Under the kill switch the pass does not run.
    await f.killed();
    expect((await reconcileFlow(f.deps)).escalations).toBeNull();
  });

  it("the approval resume step records Didi's answer to the escalation question and moves the item back", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await escalated(f);
    await createLibrary(f.deps).recordDecision({
      projectId: f.projectId,
      nodeId: node.id,
      kind: "council_decision",
      scope: { ...KEEPS, outcome: "cannot_resolve" },
      textVerbatim: "Needs Didi.",
      byActor: "council",
    });
    expect(await createEscalations(f.deps).resolve(node.id)).toMatchObject({
      step: "to_didi",
    });
    const gate = await f.store.findOpenGateRequest(
      f.projectId,
      escalationTopic(node.id),
    );
    expect(gate).toMatchObject({ kind: "escalation", owner: "didi" });
    const result = await resume(f.deps, {
      gateRequestId: gate!.id,
      resume: { answer: "Approve", reply: "Ship the smaller version." },
      approvers: ["anonymous"],
    });
    expect(result).toMatchObject({
      outcome: "recorded",
      heldBy: null,
      escalation: {
        step: "returned",
        move: { outcome: "applied", toState: "in_development" },
      },
    });
    expect(await f.store.getCounter(node.id, "failure")).toBe(0);
  });

  it("records the answer but moves nothing under the kill switch", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await escalated(f);
    await createLibrary(f.deps).recordDecision({
      projectId: f.projectId,
      nodeId: node.id,
      kind: "council_decision",
      scope: { ...KEEPS, outcome: "cannot_resolve" },
      textVerbatim: "Needs Didi.",
      byActor: "council",
    });
    await createEscalations(f.deps).resolve(node.id);
    const gate = await f.store.findOpenGateRequest(
      f.projectId,
      escalationTopic(node.id),
    );
    await f.killed();
    expect(
      await resume(f.deps, {
        gateRequestId: gate!.id,
        resume: { answer: "Approve", reply: "Go." },
        approvers: ["anonymous"],
      }),
    ).toMatchObject({
      outcome: "recorded",
      heldBy: "kill_switch",
      escalation: {
        step: "returned",
        move: { outcome: "refused", reason: "kill_switch" },
      },
    });
    expect((await f.store.getNode(node.id))?.state).toBe("escalated_to_didi");
  });
});
