// Seam: unit, on the memory store with the real contracts, guards and Council bot file, and a fake
// screenshot port. The Council's call on a visual approval (D-263, D-270): the question opens once
// per open `visual_approval` request owned by Didi; its run's input carries the option screenshots
// as labelled images; a valid answer is recorded on the call's own topic, which the approval guards
// never read; an unusable answer gets one re-run and is then recorded as dropped, with nothing for
// Didi; the call never changes the request or its outcome; and the read-only pairing with Didi's
// answer. The dispatch and run-end flows around it are in test/flows/visual-call-flows.test.ts.
import { describe, expect, it } from "vitest";

import { approvalDecision } from "../src/core/approvals.ts";
import { createCouncil, type VisualCallQuestion } from "../src/core/council.ts";
import { visualApprovalTopic } from "../src/core/guards/design.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { createLibrary } from "../src/core/library.ts";
import type { Node } from "../src/core/store.ts";
import {
  readVisualCallAnswer,
  VISUAL_CALL_LIMITS,
  visualCallPairs,
  visualCallTopic,
} from "../src/core/visual-call.ts";
import { COUNCIL_SCHEMAS, createReconcileFixture } from "./reconcile-fixture.ts";
import { CALL, setupVisualCall } from "./visual-call-fixture.ts";

async function setup(options?: string[]) {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const v = await setupVisualCall(f, options);
  const council = createCouncil({ ...f.deps, screenshots: v.screenshots });
  const library = createLibrary(f.deps);
  const topic = visualCallTopic(v.nodeId);
  const callRun = () =>
    f.run(v.nodeId, "council", 0, {
      questionTopic: topic,
      taskType: "council:visual",
    });
  const ended = async (runId: string, outcome: "success" | "fail" = "fail") => {
    f.advanceMinutes(1);
    await f.store.endRun(runId, {
      endedAt: f.clock.now(),
      outcome,
      turns: 1,
      minutes: 1,
      costUsd: 0.01,
      tokens: null,
      usageExhaustedCause: null,
      retryAfterSeconds: null,
    } as never);
  };
  const calls = async () =>
    (await f.store.listDecisionsForNode(v.nodeId)).filter(
      (d) => d.kind === "council_decision",
    );
  const guard = async (name: "approval_recorded" | "changes_requested_recorded") => {
    const node = (await f.store.getNode(v.nodeId)) as Node;
    return GUARDS[name]({ node, store: f.store } as never);
  };
  return { f, v, council, library, topic, callRun, ended, calls, guard };
}

describe("the visual call question (unit, D-270)", () => {
  it("opens once per open visual-approval request owned by Didi, and closes once a call is recorded", async () => {
    const t = await setup();
    const open = (await t.council.questions()).filter((q) => q.kind === "visual_call");
    expect(open).toEqual([
      {
        kind: "visual_call",
        topicKey: t.topic,
        projectId: t.f.projectId,
        nodeId: t.v.nodeId,
        openedAt: t.v.gate.createdAt,
        gateRequestId: t.v.gate.id,
        options: ["a", "b"],
      },
    ]);
    expect(await t.council.question(t.topic)).toEqual(open[0]);
    const q = open[0] as VisualCallQuestion;
    expect(await t.council.next(q)).toMatchObject({ step: "start", attempt: 1 });

    const run = await t.callRun();
    expect(await t.council.next(q)).toMatchObject({ step: "running", runId: run.id });
    expect(await t.council.recordAnswer(run.id, CALL)).toMatchObject({
      recorded: true,
      kind: "visual_call",
    });
    expect(await t.council.question(t.topic)).toBeNull();
    expect((await t.council.questions()).some((x) => x.kind === "visual_call")).toBe(
      false,
    );

    // A fresh request on the item (it supersedes the old one) is a new question.
    t.f.advanceMinutes(1);
    const fresh = await t.library.openGateRequest({
      projectId: t.f.projectId,
      nodeId: t.v.nodeId,
      topicKey: visualApprovalTopic(t.v.nodeId),
      kind: "visual_approval",
      owner: "didi",
      blocking: true,
      payload: { options: ["a", "b"], note: "Pick from the listed options." },
    });
    expect(await t.council.question(t.topic)).toMatchObject({
      gateRequestId: fresh.id,
    });
    // The old run started before the fresh request, so it does not answer it.
    expect(await t.council.recordAnswer(run.id, CALL)).toMatchObject({
      recorded: "already_recorded",
    });
    const other = await t.f.run(t.v.nodeId, "council", 5, {
      questionTopic: t.topic,
      taskType: "council:visual",
    });
    expect(await t.council.recordAnswer(other.id, CALL)).toEqual({
      recorded: false,
      reason: "question_closed",
    });
  });

  it("opens nothing for a request that is not a visual approval owned by Didi", async () => {
    const f = await createReconcileFixture();
    const node = await f.node("waiting_for_didi", { track: "design" });
    await f.openGate(node.id, visualApprovalTopic(node.id), {
      kind: "visual_approval",
      owner: "council",
      payload: { options: ["a"] },
    });
    const other = await f.node("waiting_for_didi", { track: "design" });
    await f.openGate(other.id, `escalation:${other.id}`, {
      kind: "escalation",
      owner: "didi",
    });
    const council = createCouncil(f.deps);
    expect((await council.questions()).filter((q) => q.kind === "visual_call")).toEqual(
      [],
    );
    expect(await council.question(visualCallTopic(node.id))).toBeNull();
  });
});

describe("the visual call's input (unit, D-270)", () => {
  it("gives the run the item, the question and each option's screenshot as a labelled image", async () => {
    const t = await setup();
    const task = await t.council.taskFor(t.topic);
    if (!task || "refused" in task) throw new Error("no task");
    expect(task.taskType).toBe("council:visual");
    expect(task.outputSchema).toEqual(COUNCIL_SCHEMAS.visual_call);
    expect(task.images?.map((i) => i.label)).toEqual([
      "Image 1: option a",
      "Image 2: option b",
    ]);
    const bytes = (png?: Uint8Array) => Buffer.from(png ?? []).toString("base64");
    expect(bytes(task.images?.[0]?.png)).toBe(bytes(t.v.pages.get("a")));
    expect(bytes(task.images?.[1]?.png)).toBe(bytes(t.v.pages.get("b")));
    expect(task.input).toContain(
      "Is this a small visual tweak the Council would approve, or does it need Didi?",
    );
    expect(task.input).toContain(`## Item id\n\n${t.v.nodeId}`);
    expect(task.input).toContain("> Make the export button easier to see.");
    expect(task.input).toContain("- Image 2: option b");
    // Only the options bundle at the capture commit was read.
    expect(t.v.screenshots.reads).toEqual([
      `didi-build/rehearsal@${"a".repeat(40)}:options`,
    ]);
  });

  it("refuses, starting nothing, when a screenshot is missing or changed, or the request lists no options", async () => {
    const t = await setup();
    const changed = await setup();
    changed.v.screenshots.put("didi-build/rehearsal", "a".repeat(40), "options", {
      manifest: {},
      files: new Map([["options/a.png", new Uint8Array([1, 2, 3])]]),
    });
    expect(await changed.council.taskFor(changed.topic)).toMatchObject({
      refused: "option_file_changed",
    });
    const none = await setup([]);
    expect(await none.council.taskFor(none.topic)).toMatchObject({
      refused: "no_options",
    });
    const noPort = createCouncil(t.f.deps);
    expect(await noPort.taskFor(t.topic)).toMatchObject({
      refused: "no_screenshots_port",
    });
    // An option the request lists with no screenshot of it.
    await t.f.store.closeGateRequest(t.v.gate.id, {
      status: "cancelled",
      at: t.f.clock.now(),
    });
    t.f.advanceMinutes(1);
    await t.f.openGate(t.v.nodeId, visualApprovalTopic(t.v.nodeId), {
      kind: "visual_approval",
      owner: "didi",
      payload: { options: ["a", "c"] },
    });
    expect(await t.council.taskFor(t.topic)).toMatchObject({
      refused: "no_option_screenshot",
    });
  });
});

describe("recording the call (unit, D-228, D-230, D-270)", () => {
  it("records a valid call on its own topic, and the approval guards never read it", async () => {
    const t = await setup();
    const run = await t.callRun();
    const before = await t.f.store.getGateRequest(t.v.gate.id);
    const recorded = await t.council.recordAnswer(run.id, {
      call: "needs_didi",
      reason: "  A new card layout is added.  ",
    });
    expect(recorded).toMatchObject({ recorded: true, kind: "visual_call" });
    expect(await t.calls()).toMatchObject([
      {
        kind: "council_decision",
        byActor: "council",
        textVerbatim: "A new card layout is added.",
        scope: {
          topicKey: t.topic,
          gateRequestId: t.v.gate.id,
          call: "needs_didi",
          runId: run.id,
        },
      },
    ]);
    expect(Object.keys((await t.calls())[0]?.scope as object).sort()).toEqual([
      "call",
      "gateRequestId",
      "runId",
      "topicKey",
    ]);
    // The request is untouched, and no answer on the visual-approval topic exists.
    expect(await t.f.store.getGateRequest(t.v.gate.id)).toEqual(before);
    expect(await t.guard("approval_recorded")).toMatchObject({
      pass: false,
      detail: "no answer recorded",
    });
    expect(await t.guard("changes_requested_recorded")).toMatchObject({
      pass: false,
      detail: "no answer recorded",
    });
    expect(await t.council.recordAnswer(run.id, CALL)).toMatchObject({
      recorded: "already_recorded",
    });
  });

  it("never changes Didi's answer: the guards read Didi's answer even with a later call on the item", async () => {
    for (const choice of ["approve", "changes_requested"] as const) {
      const t = await setup();
      const run = await t.callRun();
      await t.council.recordAnswer(run.id, CALL);
      t.f.advanceMinutes(1);
      const gate = (await t.f.store.getGateRequest(t.v.gate.id))!;
      const didi = await t.library.answerGateRequest(
        gate.id,
        approvalDecision(gate, {
          choice,
          words: choice === "approve" ? null : "Make it larger.",
          approvers: ["anonymous"],
          options: ["a"],
        }),
      );
      // A call recorded after Didi's answer (as a racing run might) is still not read.
      t.f.advanceMinutes(1);
      await t.f.store.insertDecision({
        id: t.f.deps.ids.next(),
        projectId: t.f.projectId,
        nodeId: t.v.nodeId,
        kind: "council_decision",
        scope: {
          topicKey: t.topic,
          gateRequestId: gate.id,
          call: "needs_didi",
          runId: run.id,
        },
        textVerbatim: "Later call.",
        byActor: "council",
        recordedAt: t.f.clock.now(),
      });
      if (choice === "approve") {
        expect(await t.guard("approval_recorded")).toMatchObject({
          pass: true,
          detail: `approved by Didi (decision ${didi.id})`,
        });
      } else {
        expect(await t.guard("changes_requested_recorded")).toMatchObject({
          pass: true,
        });
        expect(await t.guard("approval_recorded")).toMatchObject({ pass: false });
      }
    }
  });

  it("re-runs once after an unusable answer, then records the call as dropped, with nothing for Didi", async () => {
    const t = await setup();
    const q = (await t.council.question(t.topic)) as VisualCallQuestion;
    const first = await t.callRun();
    expect(
      await t.council.recordAnswer(first.id, { call: "maybe", reason: "x" }),
    ).toMatchObject({ recorded: false, reason: "invalid" });
    await t.ended(first.id);
    expect(await t.council.next(q)).toMatchObject({ step: "start", attempt: 2 });
    const second = await t.callRun();
    expect(
      await t.council.recordAnswer(second.id, {
        call: "needs_didi",
        reason: "x".repeat(VISUAL_CALL_LIMITS.reasonChars + 1),
      }),
    ).toMatchObject({
      recorded: false,
      reason: "invalid",
      problem: expect.any(String),
    });
    await t.ended(second.id);
    const next = await t.council.next(q);
    expect(next).toMatchObject({ step: "drop", lastRunId: second.id });
    if (next.step !== "drop") throw new Error("not dropped");
    const before = await t.f.store.listOpenGateRequests(t.f.projectId);
    const node = await t.f.store.getNode(t.v.nodeId);
    expect(
      await t.council.dropVisualCall(next.question, next.lastRunId, next.reason),
    ).toMatchObject({ recorded: true });
    expect(await t.calls()).toMatchObject([
      {
        scope: {
          topicKey: t.topic,
          gateRequestId: t.v.gate.id,
          call: "dropped",
          runId: second.id,
        },
      },
    ]);
    // Nothing opened for Didi, the request and the item unchanged, the question closed.
    expect(await t.f.store.listOpenGateRequests(t.f.projectId)).toEqual(before);
    expect(await t.f.store.getNode(t.v.nodeId)).toEqual(node);
    expect(await t.council.question(t.topic)).toBeNull();
    expect(
      await t.council.dropVisualCall(next.question, next.lastRunId, next.reason),
    ).toMatchObject({ recorded: "already_recorded" });
    await expect(t.council.toDidi(q, second.id, "x")).rejects.toThrow(
      "a visual call never goes to Didi",
    );
  });

  it("writes nothing under the kill switch or in dry run, or once the request closed", async () => {
    const t = await setup();
    const run = await t.callRun();
    await t.f.setting("dry_run", true);
    expect(await t.council.recordAnswer(run.id, CALL)).toEqual({
      recorded: false,
      reason: "dry_run",
    });
    await t.f.setting("dry_run", false);
    await t.f.setting("kill_switch", true);
    expect(await t.council.recordAnswer(run.id, CALL)).toEqual({
      recorded: false,
      reason: "kill_switch",
    });
    await t.f.setting("kill_switch", false);
    await t.f.store.closeGateRequest(t.v.gate.id, {
      status: "cancelled",
      at: t.f.clock.now(),
    });
    expect(await t.council.recordAnswer(run.id, CALL)).toEqual({
      recorded: false,
      reason: "question_closed",
    });
    expect(await t.calls()).toEqual([]);
  });

  it("reads an answer by its own rules, naming the field and never the value", () => {
    expect(readVisualCallAnswer(CALL)).toEqual({ answer: CALL });
    expect(readVisualCallAnswer({ ...CALL, extra: 1 })).toEqual({
      problem: "the answer must hold exactly call and reason",
    });
    expect(readVisualCallAnswer({ call: "yes", reason: "secret-value" })).toEqual({
      problem: "call must be small_tweak_council_would_approve or needs_didi",
    });
    expect(readVisualCallAnswer({ call: "needs_didi", reason: "   " })).toEqual({
      problem: "reason must be 1 to 1000 characters",
    });
  });
});

describe("pairing each call with Didi's answer (unit, read-only, D-263)", () => {
  it("says agree, disagree, no answer yet, no answer or dropped for each recorded call", async () => {
    const f = await createReconcileFixture();
    await f.setting("dry_run", false);
    const library = createLibrary(f.deps);
    const items: { nodeId: string; gateId: string }[] = [];
    for (const call of [
      "small_tweak_council_would_approve",
      "small_tweak_council_would_approve",
      "needs_didi",
      "needs_didi",
      "needs_didi",
      "dropped",
    ]) {
      const v = await setupVisualCall(f, ["a"]);
      await f.store.insertDecision({
        id: f.deps.ids.next(),
        projectId: f.projectId,
        nodeId: v.nodeId,
        kind: "council_decision",
        scope: {
          topicKey: visualCallTopic(v.nodeId),
          gateRequestId: v.gate.id,
          call,
          runId: f.deps.ids.next(),
        },
        textVerbatim: "A call.",
        byActor: "council",
        recordedAt: f.clock.now(),
      });
      items.push({ nodeId: v.nodeId, gateId: v.gate.id });
    }
    const answer = async (
      i: number,
      choice: "approve" | "changes_requested" | "reject",
      smallTweak?: boolean,
    ) => {
      const gate = (await f.store.getGateRequest(items[i]!.gateId))!;
      return library.answerGateRequest(
        gate.id,
        approvalDecision(gate, {
          choice,
          words: choice === "approve" ? null : "No.",
          approvers: ["anonymous"],
          options: ["a"],
          ...(smallTweak === undefined ? {} : { smallTweak }),
        }),
      );
    };
    f.advanceMinutes(1);
    // Agreement is measured against Didi's own size call (D-278), not the decision; an answer
    // that skips the size field is unmeasured.
    await answer(0, "approve", true);
    await answer(1, "changes_requested", true);
    await answer(2, "reject", false);
    await answer(3, "approve");
    await f.store.closeGateRequest(items[4]!.gateId, {
      status: "cancelled",
      at: f.clock.now(),
    });
    const before = await f.store.listDecisionsForNode(items[0]!.nodeId);
    const pairs = await visualCallPairs(f.store);
    expect(pairs.map((p) => [p.call, p.didi?.outcome ?? null, p.agreement])).toEqual([
      ["small_tweak_council_would_approve", "approved", "agree"],
      ["small_tweak_council_would_approve", "changes_requested", "agree"],
      ["needs_didi", "rejected", "agree"],
      ["needs_didi", "approved", "unmeasured"],
      ["needs_didi", null, "no_answer"],
      ["dropped", null, "dropped"],
    ]);
    expect(pairs[0]).toMatchObject({
      nodeId: items[0]!.nodeId,
      gateRequestId: items[0]!.gateId,
    });
    // A call whose request is still open has no answer yet; only the asked items are read.
    const open = await setupVisualCall(f, ["a"]);
    await f.store.insertDecision({
      id: f.deps.ids.next(),
      projectId: f.projectId,
      nodeId: open.nodeId,
      kind: "council_decision",
      scope: {
        topicKey: visualCallTopic(open.nodeId),
        gateRequestId: open.gate.id,
        call: "needs_didi",
        runId: f.deps.ids.next(),
      },
      textVerbatim: "A call.",
      byActor: "council",
      recordedAt: f.clock.now(),
    });
    expect(await visualCallPairs(f.store, [open.nodeId])).toMatchObject([
      { call: "needs_didi", didi: null, agreement: "no_answer_yet" },
    ]);
    // It writes nothing.
    expect(await f.store.listDecisionsForNode(items[0]!.nodeId)).toEqual(before);
  });
});
