// Seam: the flows around a cancel (D-308, O-97) with a fake agent runtime on the memory store and
// the real contracts and guards. Through the Council run's end: on a plan the Council accepted,
// the run-end flow records the Council's `stop` on a scanner idea and the cancel pass cancels the
// free work item at once, the item whose run is active waits, and that run's end cancels it and
// moves the idea to Rejected; on a plan Didi approved, the stop opens Didi's request and Didi's
// Approve through the approval resume flow cancels. Through the merge path: QA's pass merges an
// item, and the run-end flow asks the Council about the older item touching the same design
// feature folder and starts its run. And the called flow `f/foreman/cancel_item`, cancelling or
// asking the Council. The rules themselves are in test/cancel.test.ts and
// test/still-needed.test.ts. Synthetic data only.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as cancelItem } from "../../flows/cancel-item.ts";
import { runEndSteps } from "../../flows/lib/council-runs.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { cancelRequestTopic, stillNeededTopic } from "../../src/core/cancel.ts";
import { scannerGoneTopic } from "../../src/core/scan-ideas.ts";
import { setupMerge } from "../merge-fixture.ts";
import { HEAD } from "../reconcile-fixture.ts";
import { createFlowFixture, flowDepsFor, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 1,
  costUsd: 0.01,
  minutes: 1,
  tokens: { uncachedInput: 10, cachedInput: 0, output: 5 },
  model: "claude-sonnet-5-5",
};

function finish(f: FlowFixture, runId: string, result: Partial<AgentRunResult> = {}) {
  f.runtime.status.set(runId, { state: "finished", result: { ...RESULT, ...result } });
  return recordRunEnd(f.deps, { runId });
}

/** A handed-off scanner idea whose plan `acceptedBy` accepted, with a free and a busy item. */
async function stoppedIdea(acceptedBy: "council" | "didi") {
  const f = await createFlowFixture();
  await f.live();
  const idea = await f.node("handed_off", {
    type: "idea",
    track: null,
    ownerRole: "runner",
    title: "Broken link in docs/a.md",
    body: { source: "scanner", check: "doc_link_missing" },
  });
  await f.store.insertDecision({
    id: f.deps.ids.next(),
    projectId: f.projectId,
    nodeId: idea.id,
    kind: "council_decision",
    scope: { kind: "plan_accepted", recordedBy: "runner", acceptedBy },
    textVerbatim: "Fix the link.",
    byActor: "council",
    recordedAt: f.clock.now(),
  });
  const free = await f.node("ready_for_dev", {
    title: "Fix the link",
    agentReady: false,
  });
  const busy = await f.node("in_development", { title: "Fix the other link" });
  for (const item of [free, busy]) {
    await f.store.insertEdge({
      id: f.deps.ids.next(),
      fromNode: idea.id,
      toNode: item.id,
      type: "split_into",
      createdAt: f.clock.now(),
    });
  }
  const builder = await f.run(busy.id, "developer");
  await f.store.setRunHandle(builder.id, { runId: builder.id });
  const topic = scannerGoneTopic(idea.id);
  await f.openGate(idea.id, topic, {
    blocking: false,
    payload: { question: "Should the idea be stopped?", commitSha: "d".repeat(40) },
  });
  f.advanceMinutes(1);
  const passed = await reconcileFlow(f.deps);
  expect(passed.councilRuns).toMatchObject([
    {
      topicKey: topic,
      kind: "scanner_gone",
      step: "start",
      result: { outcome: "started" },
    },
  ]);
  const council = f.tasksFor.at(-1)?.run;
  if (council?.bot !== "council") throw new Error("the Council was not started");
  const ended = await finish(f, council.id, {
    structured: { verdict: "stop", note: "Fixed by another change." },
  });
  return { f, idea, free, busy, builder, ended };
}

describe("a cancel through the Council run's end (flow: fake adapters, D-308)", () => {
  it("on a plan the Council accepted: cancels the free item at once, and the rest when the other run ends", async () => {
    const { f, idea, free, busy, builder, ended } = await stoppedIdea("council");
    expect(ended).toMatchObject({
      outcome: "recorded",
      council: {
        answer: { recorded: true, kind: "scanner_gone", cancelDue: true },
        cancels: [
          {
            nodeId: idea.id,
            step: "acted",
            requests: [],
            items: [
              { nodeId: free.id, result: "cancelled", how: "council" },
              { nodeId: busy.id, result: "waiting_for_run" },
            ],
            idea: "waits",
          },
        ],
      },
    });
    expect((await f.store.getNode(free.id))?.state).toBe("cancelled");
    expect(f.runtime.cancelled).toEqual([]);

    const builderEnd = await finish(f, builder.id, {
      outcome: "fail",
      detail: "error",
    });
    expect(builderEnd).toMatchObject({
      outcome: "recorded",
      cancels: [
        {
          nodeId: idea.id,
          items: [
            { nodeId: free.id, result: "finished" },
            { nodeId: busy.id, result: "cancelled" },
          ],
          idea: { outcome: "applied" },
        },
      ],
    });
    expect((await f.store.getNode(idea.id))?.state).toBe("rejected");
    expect((await reconcileFlow(f.deps)).cancels).toEqual([]);
  });

  it("on a plan Didi approved: opens Didi's request, and Didi's Approve cancels through the approval flow", async () => {
    const { f, idea, free, busy, builder, ended } = await stoppedIdea("didi");
    expect(ended).toMatchObject({
      council: {
        cancels: [
          {
            nodeId: idea.id,
            requests: [{ nodeId: idea.id }],
            items: [
              { nodeId: free.id, result: "with_didi" },
              { nodeId: busy.id, result: "waiting_for_run" },
            ],
          },
        ],
      },
    });
    expect((await f.store.getNode(free.id))?.state).toBe("ready_for_dev");
    const request = await f.store.findOpenGateRequest(
      f.projectId,
      cancelRequestTopic(idea.id),
    );
    if (!request) throw new Error("no request for Didi");
    // A repeated pass opens nothing more.
    await reconcileFlow(f.deps);
    expect(
      await f.store.listGateRequests(f.projectId, cancelRequestTopic(idea.id)),
    ).toHaveLength(1);

    const answered = await resume(f.deps, {
      gateRequestId: request.id,
      resume: { decision: "Approve", options: [], feedback: "" },
      approvers: ["anonymous"],
    });
    expect(answered).toMatchObject({
      outcome: "recorded",
      cancel: {
        items: [
          { nodeId: free.id, result: "cancelled", how: "didi_confirmed" },
          { nodeId: busy.id, result: "waiting_for_run" },
        ],
      },
    });
    await finish(f, builder.id, { outcome: "fail", detail: "error" });
    expect((await f.store.getNode(busy.id))?.state).toBe("cancelled");
    expect((await f.store.getNode(idea.id))?.state).toBe("rejected");
  });
});

describe("a merged change through the run-end flow (flow: fake adapters, D-308 (3))", () => {
  it("asks the Council about the older open item touching the same feature folder, and starts its run", async () => {
    const t = await setupMerge({ paths: ["design/account/login/spec.md", "src/a.ts"] });
    const open = await t.addNode("ready_for_dev", {
      title: "Build the login form",
      body: { pathsInScope: ["design/account/login/"] },
    });
    await t.addNode("ready_for_dev", {
      title: "Unrelated",
      body: { pathsInScope: ["src/a.ts"] },
    });
    const { deps, tasksFor } = flowDepsFor(t.deps);
    t.advanceMinutes(5);
    const qa = await t.passedOn(HEAD);
    const after = await runEndSteps(deps, qa).after();
    expect(after).toMatchObject({
      move: { outcome: "applied", toState: "verifying_on_staging" },
      stillNeeded: {
        opened: [{ nodeId: open.id, opened: true, reason: "merged_change" }],
        council: [
          {
            topicKey: stillNeededTopic(open.id),
            kind: "still_needed",
            step: "start",
            result: { outcome: "started" },
          },
        ],
      },
    });
    expect(tasksFor.at(-1)?.run).toMatchObject({
      bot: "council",
      nodeId: open.id,
      questionTopic: stillNeededTopic(open.id),
    });
  });
});

describe("a builder's already-done stop through the run-end flow (flow: fake adapters, D-308 (3))", () => {
  it("escalates the item, asks the Council whether it is still needed, and holds the escalation question", async () => {
    const f = await createFlowFixture();
    await f.live();
    const item = await f.node("in_development", { title: "Add the footer" });
    const builder = await f.run(item.id, "developer");
    await f.store.setRunHandle(builder.id, { runId: builder.id });
    const ended = await finish(f, builder.id, {
      detail: "needs_decision",
      needsDecision: { reason: "The footer is already on main.", alreadyDone: true },
    });
    expect(ended).toMatchObject({
      outcome: "recorded",
      stillNeeded: {
        opened: [{ nodeId: item.id, opened: true, reason: "already_done" }],
        council: [
          { kind: "still_needed", step: "start", result: { outcome: "started" } },
        ],
      },
      councilRuns: [],
    });
    expect((await f.store.getNode(item.id))?.state).toBe("escalated_to_council");
    expect(f.tasksFor.at(-1)?.run).toMatchObject({
      bot: "council",
      questionTopic: stillNeededTopic(item.id),
    });
  });
});

describe("the called flow f/foreman/cancel_item (flow: fake adapters, D-308 (2))", () => {
  it("cancels the item with Didi's reason, or asks the Council instead", async () => {
    const f = await createFlowFixture();
    await f.live();
    const item = await f.node("ready_for_dev", {
      title: "Old work",
      agentReady: false,
    });
    const other = await f.node("ready_for_dev", {
      title: "Maybe old",
      agentReady: false,
    });
    expect(
      await cancelItem(f.deps, { nodeId: item.id, reason: "Not needed." }),
    ).toMatchObject({
      mode: "cancel",
      cancel: {
        recorded: true,
        step: { items: [{ nodeId: item.id, result: "cancelled" }] },
      },
    });
    expect((await f.store.getNode(item.id))?.state).toBe("cancelled");

    const asked = await cancelItem(f.deps, {
      nodeId: other.id,
      reason: "Is this still needed?",
      askCouncil: true,
    });
    expect(asked).toMatchObject({
      mode: "ask_council",
      question: { opened: true, reason: "didi_asked" },
      council: [
        { kind: "still_needed", step: "start", result: { outcome: "started" } },
      ],
    });
    expect((await f.store.getNode(other.id))?.state).toBe("ready_for_dev");
    expect(await f.store.listDecisionsForNode(other.id)).toEqual([]);
  });

  it("writes nothing under the kill switch", async () => {
    const f = await createFlowFixture();
    await f.live();
    const item = await f.node("ready_for_dev");
    await f.setting("kill_switch", true);
    expect(await cancelItem(f.deps, { nodeId: item.id, reason: "x" })).toEqual({
      mode: "cancel",
      cancel: { recorded: false, reason: "kill_switch" },
    });
    expect(
      await cancelItem(f.deps, { nodeId: item.id, reason: "x", askCouncil: true }),
    ).toMatchObject({ question: { opened: false, why: "kill_switch" }, council: [] });
    expect((await f.store.getNode(item.id))?.state).toBe("ready_for_dev");
  });
});
