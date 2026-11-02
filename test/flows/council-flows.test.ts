// Seam: the flows around the Council (build plan M3.5, D-228, D-229) with a fake agent runtime on
// the memory store and the real machine-2 contracts and guards: the build plan's M3.5 success path
// end to end (three failures, the Council's run, its answer, the item back at work); an unusable
// answer that is re-run once and then goes to Didi; a reversal's question answered through the
// reconcile flow's Council pass and the run-end flow; a redo that cancels the item's run, sends it
// back to the start of its track and lets the dispatch start it again on the same branch (D-231);
// and the switches. The rules themselves are in test/council.test.ts.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { redoPass } from "../../flows/lib/council-runs.ts";
import { createCouncil } from "../../src/core/council.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import { createLibrary, reversalTopic } from "../../src/core/library.ts";
import { COUNCIL_SCHEMAS, HEAD } from "../reconcile-fixture.ts";
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
const RESOLVE = {
  outcome: "resolve",
  note: "Split the export into two smaller changes.",
  changesProductDirection: false,
  passesGate: false,
};

/** Makes the clock move one second at each read, as a real clock moves between steps. */
function ticking(t: FlowFixture) {
  const read = t.clock.now;
  t.clock.now = () => {
    t.advanceMinutes(1 / 60);
    return read();
  };
}

function finish(f: FlowFixture, runId: string, structured?: unknown) {
  f.runtime.status.set(runId, {
    state: "finished",
    result: { ...RESULT, ...(structured === undefined ? {} : { structured }) },
  });
  return recordRunEnd(f.deps, { runId });
}

/** The Council run started last, by its task. */
function lastCouncilStart(f: FlowFixture) {
  const start = f.tasksFor.at(-1);
  if (start?.run.bot !== "council")
    throw new Error("the last start is not the Council's");
  return start;
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

describe("the M3.5 success path (flow: fake adapters, D-228)", () => {
  it("three failures reach the Council, its run answers, and the item returns to work with its counters reset", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await f.node("ready_for_dev", {
      title: "Add the export button",
      body: { acceptanceCriteria: ["The CSV opens in a spreadsheet"] },
    });
    const first = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    if (first.outcome !== "started") throw new Error("the Developer was not started");
    await f.evidence(
      node.id,
      "ci_run",
      { conclusion: "failure", pr: 7, changedPaths: ["src/a.ts"] },
      { commitSha: HEAD },
    );
    await f.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });

    // Three done reports refused on red CI: each counts once, and the third escalates.
    let runId = first.runId;
    for (let failures = 1; failures <= 3; failures++) {
      const ended = await finish(f, runId);
      expect(ended).toMatchObject({
        outcome: "recorded",
        move: { failureCount: { counted: true, failures } },
      });
      if (failures < 3) {
        const fix =
          ended.outcome === "recorded" ? ended.builderRuns[0]?.result : undefined;
        if (fix?.outcome !== "started")
          throw new Error("the fix round was not started");
        runId = fix.runId;
        continue;
      }
      expect((await f.store.getNode(node.id))?.state).toBe("escalated_to_council");
      // The Council's run starts at once, for the item's question.
      expect(ended).toMatchObject({
        builderRuns: [],
        councilRuns: [
          {
            topicKey: escalationTopic(node.id),
            kind: "escalation",
            step: "start",
            result: { outcome: "started" },
          },
        ],
      });
    }
    const start = lastCouncilStart(f);
    expect(start.run.questionTopic).toBe(escalationTopic(node.id));
    expect(start.outputSchema).toEqual(COUNCIL_SCHEMAS.escalation);
    expect(start.input).toContain("## The question");
    expect(start.input).toContain("> Add the export button");
    expect(start.input).toContain("failure: 3");
    expect(start.input).toContain("report_refused");
    // A second trigger starts no second run.
    expect((await reconcileFlow(f.deps)).councilRuns).toMatchObject([
      { step: "running" },
    ]);

    // The Council answers; the runner records the decision and the item returns.
    const answered = await finish(f, start.run.id, RESOLVE);
    expect(answered).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      council: {
        answer: { recorded: true, kind: "escalation" },
        escalation: {
          step: "returned",
          move: { outcome: "applied", toState: "in_development" },
        },
        builderRuns: [
          { role: "developer", cause: "returned", result: { outcome: "started" } },
        ],
        council: [],
      },
    });
    expect(await f.store.getCounter(node.id, "failure")).toBe(0);
    expect(await f.store.getCounter(node.id, "qa_round")).toBe(0);
    const builder = f.tasksFor.at(-1);
    expect(builder?.run.bot).toBe("developer");
    expect(builder?.input).toContain("> Split the export into two smaller changes.");
    expect(builder?.branch).toBe(`foreman/${node.id}`);

    // A repeated run-end trigger records nothing more and starts nothing more.
    const decisions = await f.store.listDecisionsForNode(node.id);
    const runs = await f.store.listRuns({ nodeId: node.id });
    expect(await recordRunEnd(f.deps, { runId: start.run.id })).toMatchObject({
      outcome: "already_recorded",
      council: { escalation: { step: "not_escalated" }, builderRuns: [], council: [] },
    });
    expect(await f.store.listDecisionsForNode(node.id)).toEqual(decisions);
    expect(await f.store.listRuns({ nodeId: node.id })).toEqual(runs);
  });
});

describe("an unusable Council answer (flow: fake adapters, D-228)", () => {
  it("ends the run fail, re-runs once, and then sends the item to Didi with the reason", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await escalated(f);
    const pass = await reconcileFlow(f.deps);
    expect(pass.councilRuns).toMatchObject([
      { kind: "escalation", step: "start", result: { outcome: "started" } },
    ]);
    const first = lastCouncilStart(f);
    const bad = await finish(f, first.run.id, { outcome: "resolve" });
    expect(bad).toMatchObject({
      outcome: "recorded",
      report: { outcome: "fail" },
      council: {
        answer: {
          recorded: false,
          reason: "invalid",
          problem: "the answer note is missing",
        },
        council: [{ step: "start", result: { outcome: "started" } }],
      },
    });
    expect((await f.store.getRun(first.run.id))?.outcome).toBe("fail");
    const second = lastCouncilStart(f);
    expect(second.run.id).not.toBe(first.run.id);
    // No structured answer at all is unusable too.
    const none = await finish(f, second.run.id);
    expect(none).toMatchObject({
      council: {
        answer: { recorded: false, reason: "invalid" },
        council: [
          {
            step: "to_didi",
            didi: {
              step: "to_didi",
              move: { outcome: "applied", toState: "escalated_to_didi" },
            },
          },
        ],
      },
    });
    expect(
      await f.store.findOpenGateRequest(f.projectId, escalationTopic(node.id)),
    ).toMatchObject({
      kind: "escalation",
      owner: "didi",
      payload: { lastCouncilRunId: second.run.id },
    });
    expect(
      (await f.store.listDecisionsForNode(node.id)).filter(
        (d) => d.kind === "council_decision",
      ),
    ).toEqual([]);
    expect((await f.store.listRuns({ nodeId: node.id })).map((r) => r.bot)).toEqual([
      "council",
      "council",
    ]);
  });
});

describe("a Council run that fails to start (flow: fake adapters, D-228, O-48)", () => {
  it("counts as one of the question's runs, not toward the item's failure counter", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await escalated(f);
    for (let i = 0; i < 2; i++) {
      f.runtime.failNext.add("start");
      expect((await reconcileFlow(f.deps)).councilRuns).toMatchObject([
        { step: "start", result: { outcome: "start_failed" } },
      ]);
    }
    expect(await f.store.getCounter(node.id, "failure")).toBe(3);
    expect((await reconcileFlow(f.deps)).councilRuns).toMatchObject([
      { step: "to_didi", didi: { step: "to_didi", move: { outcome: "applied" } } },
    ]);
    expect((await f.store.getNode(node.id))?.state).toBe("escalated_to_didi");
  });
});

describe("a reversal's question (flow: fake adapters, D-229)", () => {
  it("the reconcile flow starts the Council for it, and the run-end flow applies its verdicts", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development", { title: "The decision's item" });
    const keep = await f.node("in_development");
    const redo = await f.node("ready_for_dev");
    const undecided = await f.node("in_development");
    const stale = [keep, redo, undecided];
    const decision = await library.recordDecision(
      {
        projectId: f.projectId,
        nodeId: owner.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Use the blue layout.",
        byActor: "didi",
      },
      stale.map((n) => n.id),
    );
    await library.reverseDecision(decision.id, "didi", "It tested badly.");
    const topic = reversalTopic(decision.id);

    const pass = await reconcileFlow(f.deps);
    expect(pass.councilRuns).toMatchObject([
      {
        topicKey: topic,
        kind: "reversal",
        step: "start",
        result: { outcome: "started" },
      },
    ]);
    const start = lastCouncilStart(f);
    expect(start.run.nodeId).toBe(owner.id);
    expect(start.outputSchema).toEqual(COUNCIL_SCHEMAS.reversal);
    for (const n of stale) expect(start.input).toContain(`Item id: ${n.id}`);

    // An answer that misses an item is refused: the run fails and is re-run.
    const partial = {
      verdicts: [{ nodeId: keep.id, verdict: "still_valid", note: "" }],
      note: "Only the first is affected.",
    };
    expect(await finish(f, start.run.id, partial)).toMatchObject({
      report: { outcome: "fail" },
      council: {
        answer: {
          reason: "invalid",
          problem: "the verdicts miss 2 stale item(s) of this reversal",
        },
        council: [{ step: "start", result: { outcome: "started" } }],
      },
    });
    const rerun = lastCouncilStart(f);
    const answer = {
      verdicts: [
        { nodeId: keep.id, verdict: "still_valid", note: "Not affected." },
        { nodeId: redo.id, verdict: "redo", note: "Start over." },
        { nodeId: undecided.id, verdict: "cannot_decide", note: "Needs Didi." },
      ],
      note: "The layout change affects only the copy.",
    };
    expect(await finish(f, rerun.run.id, answer)).toMatchObject({
      report: { outcome: "success" },
      council: {
        answer: {
          recorded: true,
          kind: "reversal",
          verdicts: [
            { result: "cleared" },
            { result: "cleared" },
            { result: "to_didi" },
          ],
        },
        council: [],
      },
    });
    expect(
      await Promise.all(stale.map(async (n) => (await f.store.getNode(n.id))?.stale)),
    ).toEqual([false, false, true]);
    expect(await f.store.findOpenGateRequest(f.projectId, topic)).toMatchObject({
      owner: "didi",
      kind: "escalation",
      payload: { nodeIds: [undecided.id] },
    });
    // The next pass has no Council question left to start.
    expect((await reconcileFlow(f.deps)).councilRuns).toEqual([]);
  });
});

describe("a reversal's redo (flow: fake adapters, D-231)", () => {
  it("cancels the item's run first, sends it back to Ready for dev, and the dispatch starts it again on the same branch", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development", { title: "The decision's item" });
    const item = await f.node("ready_for_dev", { title: "Add the export button" });
    const first = await dispatch(f.deps, { nodeId: item.id, role: "developer" });
    if (first.outcome !== "started") throw new Error("the Developer was not started");
    await f.store.setCounter(item.id, "failure", 2, f.clock.now());
    const decision = await library.recordDecision(
      {
        projectId: f.projectId,
        nodeId: owner.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Use the blue layout.",
        byActor: "didi",
      },
      [item.id],
    );
    await library.reverseDecision(decision.id, "didi", "It tested badly.");
    expect((await reconcileFlow(f.deps)).councilRuns).toMatchObject([
      { step: "start", result: { outcome: "started" } },
    ]);
    const council = lastCouncilStart(f);
    const ended = await finish(f, council.run.id, {
      verdicts: [{ nodeId: item.id, verdict: "redo", note: "Start over." }],
      note: "The layout is gone.",
    });
    expect(ended).toMatchObject({
      council: {
        answer: { recorded: true, verdicts: [{ result: "redo_move_due" }] },
        redos: [
          {
            nodeId: item.id,
            cancelled: [first.runId],
            cancelFailed: [],
            redo: { step: "moved", outcome: "applied", toState: "ready_for_dev" },
          },
        ],
      },
    });
    // The run was stopped through the runtime before the move.
    expect(f.runtime.cancelled).toHaveLength(1);
    expect(await f.store.getRun(first.runId)).toMatchObject({ outcome: "cancelled" });
    expect(await f.store.getNode(item.id)).toMatchObject({
      state: "ready_for_dev",
      stale: false,
    });
    expect(await f.store.getCounter(item.id, "failure")).toBe(0);
    // The next reconcile pass finds nothing more to redo.
    expect((await reconcileFlow(f.deps)).redos).toEqual([]);

    // As for a fresh item: the dispatch starts the Developer, on the item's one branch.
    const again = await dispatch(f.deps, { nodeId: item.id, role: "developer" });
    expect(again).toMatchObject({ outcome: "started" });
    expect(f.tasksFor.at(-1)?.branch).toBe(`foreman/${item.id}`);
    expect((await f.store.getNode(item.id))?.state).toBe("in_development");
  });

  it("the reconcile flow takes a redo a cut-short run-end left, and opens a merged item's rework item", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development");
    const built = await f.node("in_qa_review");
    const merged = await f.node("done");
    await f.evidence(
      merged.id,
      "merge_commit",
      { pr: 3 },
      { commitSha: "c".repeat(40) },
    );
    const decision = await library.recordDecision(
      {
        projectId: f.projectId,
        nodeId: owner.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Use the blue layout.",
        byActor: "didi",
      },
      [built.id, merged.id],
    );
    await library.reverseDecision(decision.id, "didi", "It tested badly.");
    const topic = reversalTopic(decision.id);
    const run = await f.run(owner.id, "council", 0, { questionTopic: topic });
    // Only the answer is recorded, as if the run-end flow stopped right after it.
    const answer = await createCouncil(f.deps).recordAnswer(run.id, {
      verdicts: [
        { nodeId: built.id, verdict: "redo", note: "" },
        { nodeId: merged.id, verdict: "redo", note: "" },
      ],
      note: "Both rely on the layout.",
    });
    expect(answer).toMatchObject({
      verdicts: [{ result: "redo_move_due" }, { result: "rework_due" }],
    });
    const pass = await reconcileFlow(f.deps);
    expect(pass.redos).toMatchObject([
      { nodeId: built.id, redo: { step: "moved", outcome: "applied" } },
      {
        nodeId: merged.id,
        cancelled: [],
        redo: { step: "reworked", outcome: "created" },
      },
    ]);
    expect(await f.store.getNode(built.id)).toMatchObject({
      state: "ready_for_dev",
      stale: false,
    });
    expect(await f.store.getNode(merged.id)).toMatchObject({
      state: "done",
      stale: false,
    });
    const [edge] = await f.store.listEdges({ toNode: merged.id, type: "reworks" });
    // The rework item is a fresh item in Ready for dev: the dispatch starts it on its own branch.
    const started = await dispatch(f.deps, {
      nodeId: edge!.fromNode,
      role: "developer",
    });
    expect(started).toMatchObject({ outcome: "started" });
    expect(f.tasksFor.at(-1)?.branch).toBe(`foreman/${edge!.fromNode}`);
    expect(f.tasksFor.at(-1)?.input).toContain(`reworks item ${merged.id}`);
    // The next pass has nothing more to do for either.
    expect((await reconcileFlow(f.deps)).redos).toEqual([]);
  });

  it("cancels nothing and moves nothing under the kill switch or in dry run", async () => {
    const f = await createFlowFixture();
    await f.live();
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development");
    const item = await f.node("in_development");
    await f.run(item.id, "developer");
    const decision = await library.recordDecision(
      {
        projectId: f.projectId,
        nodeId: owner.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Yes.",
        byActor: "didi",
      },
      [item.id],
    );
    await library.reverseDecision(decision.id, "didi", "No.");
    const run = await f.run(owner.id, "council", 0, {
      questionTopic: reversalTopic(decision.id),
    });
    await createCouncil(f.deps).recordAnswer(run.id, {
      verdicts: [{ nodeId: item.id, verdict: "redo", note: "" }],
      note: "Redo it.",
    });
    for (const key of ["dry_run", "kill_switch"] as const) {
      await f.setting("dry_run", key === "dry_run");
      await f.setting("kill_switch", key === "kill_switch");
      const reason = key;
      const steps = await redoPass(f.deps);
      expect(steps, key).toMatchObject([
        { cancelled: [], redo: { step: "moved", outcome: "refused", reason } },
      ]);
      expect(f.runtime.cancelled, key).toEqual([]);
    }
    expect(await f.store.getNode(item.id)).toMatchObject({
      state: "in_development",
      stale: true,
    });
    expect(await f.store.listTransitions(item.id)).toEqual([]);
  });
});

describe("Didi's answer to a reversal's gate request (flow: fake adapters, D-234)", () => {
  /** A reversal the Council could not decide on: its gate request for Didi is open. */
  async function withDidi(f: FlowFixture) {
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development", { title: "The decision's item" });
    const item = await f.node("in_development");
    const decision = await library.recordDecision(
      {
        projectId: f.projectId,
        nodeId: owner.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Use the blue layout.",
        byActor: "didi",
      },
      [item.id],
    );
    await library.reverseDecision(decision.id, "didi", "It tested badly.");
    const topic = reversalTopic(decision.id);
    await reconcileFlow(f.deps);
    const first = lastCouncilStart(f);
    await finish(f, first.run.id, {
      verdicts: [{ nodeId: item.id, verdict: "cannot_decide", note: "Needs Didi." }],
      note: "We cannot tell.",
    });
    const gate = await f.store.findOpenGateRequest(f.projectId, topic);
    expect(gate).toMatchObject({ owner: "didi", kind: "escalation" });
    return { owner, item, topic, gate: gate! };
  }

  it("starts one follow-up Council run with Didi's words in its input, and applies its answer", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const { item, topic, gate } = await withDidi(f);
    const resumed = await resume(f.deps, {
      gateRequestId: gate.id,
      resume: { answer: "Changes requested", reply: "Redo it with the green layout." },
      approvers: ["anonymous"],
    });
    expect(resumed).toMatchObject({
      outcome: "recorded",
      heldBy: null,
      reversal: {
        followUp: [{ step: "opened" }],
        council: [{ topicKey: topic, step: "start", result: { outcome: "started" } }],
      },
    });
    expect(resumed).not.toHaveProperty("escalation");
    const followUp = lastCouncilStart(f);
    expect(followUp.run.questionTopic).toBe(topic);
    expect(followUp.input).toContain("> Redo it with the green layout.");
    // A reconcile pass meanwhile starts nothing more.
    const pass = await reconcileFlow(f.deps);
    expect(pass.followUps).toEqual([]);
    expect(pass.councilRuns).toMatchObject([{ topicKey: topic, step: "running" }]);
    expect(
      await finish(f, followUp.run.id, {
        verdicts: [{ nodeId: item.id, verdict: "redo", note: "Use green." }],
        note: "Didi wants green.",
      }),
    ).toMatchObject({
      council: {
        answer: { recorded: true, verdicts: [{ result: "redo_move_due" }] },
        redos: [{ nodeId: item.id, redo: { step: "moved", outcome: "applied" } }],
        council: [],
      },
    });
    expect(await f.store.getNode(item.id)).toMatchObject({
      state: "ready_for_dev",
      stale: false,
    });
    expect(await f.store.findOpenGateRequest(f.projectId, topic)).toBeNull();
  });

  it("records the answer in dry run and acts on it once the reconcile flow runs live", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const { topic, gate } = await withDidi(f);
    await f.setting("dry_run", true);
    const starts = f.tasksFor.length;
    expect(
      await resume(f.deps, {
        gateRequestId: gate.id,
        resume: { answer: "Approve", reply: "It still stands." },
        approvers: ["anonymous"],
      }),
    ).toMatchObject({
      outcome: "recorded",
      heldBy: "dry_run",
      reversal: { followUp: [{ step: "held", reason: "dry_run" }], council: [] },
    });
    expect(await f.store.findOpenGateRequest(f.projectId, topic)).toBeNull();
    expect(f.tasksFor).toHaveLength(starts);
    await f.live();
    const pass = await reconcileFlow(f.deps);
    expect(pass.followUps).toMatchObject([{ topicKey: topic, step: "opened" }]);
    expect(pass.councilRuns).toMatchObject([
      { topicKey: topic, step: "start", result: { outcome: "started" } },
    ]);
    expect(lastCouncilStart(f).input).toContain("> It still stands.");
  });
});

describe("the switches (flow: fake adapters)", () => {
  it("records no answer in dry run and refuses under the kill switch", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await escalated(f);
    await reconcileFlow(f.deps);
    const start = lastCouncilStart(f);
    await f.setting("dry_run", true);
    expect(await finish(f, start.run.id, RESOLVE)).toMatchObject({
      outcome: "would_record",
    });
    // In dry run the live passes do not run, so nothing starts a Council run.
    expect((await reconcileFlow(f.deps)).councilRuns).toBeNull();
    await f.live();
    await f.killed();
    expect(await finish(f, start.run.id, RESOLVE)).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect((await reconcileFlow(f.deps)).councilRuns).toBeNull();
    // The kill switch's cancel pass stopped the run; no decision was recorded.
    expect((await f.store.getRun(start.run.id))?.outcome).toBe("cancelled");
    expect(await f.store.listDecisionsForNode(node.id)).toEqual([]);
    expect((await f.store.getNode(node.id))?.state).toBe("escalated_to_council");
  });

  it("plans the Council's dispatch in dry run and writes nothing", async () => {
    const f = await createFlowFixture();
    const node = await f.node("escalated_to_council", {
      blockedReason: "three failures",
    });
    expect(
      await dispatch(f.deps, {
        nodeId: node.id,
        role: "council",
        questionTopic: escalationTopic(node.id),
      }),
    ).toMatchObject({
      outcome: "planned",
      run: { bot: "council", taskType: "council" },
    });
    expect(await f.store.listRuns({ nodeId: node.id })).toEqual([]);
  });
});
