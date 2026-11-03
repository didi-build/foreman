// Seam: the transition flow and the approval resume step (build plan M3.1, M0.4, D-170) with
// fake adapters on the memory store and the real machine-2 contracts and guards. The library's
// rules are tested in src/core/library.test.ts; this covers what reaches the store through the
// flows, and that a duplicate trigger writes one transition and one decision. A runner-only move
// (the Council's redo, the escalation's way back, O-54) is refused here and applied only by its
// own runner step.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as requestTransition } from "../../flows/request-transition.ts";
import { ANSWER_PROBLEMS } from "../../src/core/approvals.ts";
import { createCouncil } from "../../src/core/council.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { visualApprovalTopic } from "../../src/core/guards/design.ts";
import { createLibrary, reversalTopic } from "../../src/core/library.ts";
import { createFlowFixture, HEAD, type FlowFixture } from "./flow-fixture.ts";

/** An item with a finished PR: CI green on the head and a docs note, ready for QA. */
async function builtItem(f: FlowFixture) {
  const node = await f.node("in_development");
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: [] },
    { commitSha: HEAD },
  );
  await f.evidence(node.id, "docs_note", { impact: "none" });
  return node;
}

const doneReport = (nodeId: string, ref = "report-1") => ({
  nodeId,
  toState: "in_qa_review",
  trigger: { kind: "bot_report" as const, ref },
  actor: { kind: "runner" as const, id: "request_transition" },
});

describe("transition flow (flow: fake adapters, build plan M3.1)", () => {
  it("applies the move the library allows, with the trigger recorded", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await builtItem(f);
    const result = await requestTransition(f.deps, doneReport(node.id));
    expect(result).toMatchObject({ outcome: "applied", failedGuards: [] });
    expect((await f.store.getNode(node.id))?.state).toBe("in_qa_review");
    expect(await f.transitions(node.id)).toMatchObject([
      { mode: "applied", triggerKind: "bot_report", triggerRef: "report-1" },
    ]);
  });

  it("names the failed guards and writes nothing when the library rejects", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("in_development");
    const before = await f.footprint(node.id);
    expect(await requestTransition(f.deps, doneReport(node.id))).toMatchObject({
      outcome: "rejected",
      reason: "guard_failed",
      failedGuards: [
        "ci_green_on_head",
        "docs_updated_or_none",
        "no_failed_qa_verdict_on_head",
      ],
    });
    expect(await f.footprint(node.id)).toBe(before);
  });

  it("refuses under the kill switch and writes nothing", async () => {
    const f = await createFlowFixture();
    await f.live();
    await f.killed();
    const node = await builtItem(f);
    const before = await f.footprint(node.id);
    expect(await requestTransition(f.deps, doneReport(node.id))).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await f.footprint(node.id)).toBe(before);
  });

  it("in dry run writes one dry-run row and leaves the node where it is", async () => {
    const f = await createFlowFixture();
    const node = await builtItem(f);
    expect((await requestTransition(f.deps, doneReport(node.id))).outcome).toBe(
      "planned",
    );
    expect((await f.transitions(node.id)).map((t) => t.mode)).toEqual(["dry_run"]);
    expect((await f.store.getNode(node.id))?.state).toBe("in_development");
  });

  it.each([
    ["applied", true],
    ["dry run", false],
  ])("writes one transition for a duplicate trigger (%s)", async (_mode, live) => {
    const f = await createFlowFixture();
    if (live) await f.live();
    const node = await builtItem(f);
    const first = await requestTransition(f.deps, doneReport(node.id));
    const again = await requestTransition(f.deps, doneReport(node.id));
    expect(again).toMatchObject({ outcome: "noop", transitionId: first.transitionId });
    expect(await f.transitions(node.id)).toHaveLength(1);
  });
});

describe("approval resume step (flow: fake adapters, M0.4, D-170, D-200, D-201, D-254)", () => {
  const PAGE = "https://approvals.example.test/page/not-a-real-link";

  /** A design item waiting for Didi, with its visual-approval request open on a page. */
  async function waiting() {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("waiting_for_didi", {
      track: "design",
      ownerRole: "operator",
    });
    const gate = await f.openGate(node.id, visualApprovalTopic(node.id), {
      kind: "visual_approval",
      owner: "didi",
      approvalUrl: PAGE,
    });
    const gateRequestId = gate.id;
    const answer = (label: string, reply = "  Option B, as is.  ") => ({
      gateRequestId,
      resume: { answer: label, reply },
      approvers: ["anonymous"],
    });
    return { f, node, gateRequestId, answer };
  }

  it("records Approve as Didi's approval, verbatim with the page link, and the guard then allows the move", async () => {
    const { f, node, gateRequestId, answer } = await waiting();
    const result = await resume(f.deps, answer("Approve"));
    expect(result).toMatchObject({ outcome: "recorded", heldBy: null });
    const [decision] = await f.store.listDecisionsForNode(node.id);
    expect(decision).toMatchObject({
      kind: "approval",
      byActor: "didi",
      textVerbatim: "  Option B, as is.  ",
      recordedAt: f.clock.now(),
      scope: {
        topicKey: visualApprovalTopic(node.id),
        gateRequestId,
        outcome: "approved",
        via: "approval_page",
        pageUrl: PAGE,
        approvers: ["anonymous"],
      },
    });
    expect(await f.store.getGateRequest(gateRequestId)).toMatchObject({
      status: "answered",
      decisionId: decision?.id,
    });

    const moved = await requestTransition(f.deps, {
      nodeId: node.id,
      toState: "writing_spec",
      trigger: { kind: "human", ref: `gate:${gateRequestId}` },
      actor: { kind: "operator", id: "didi" },
    });
    expect(moved.outcome).toBe("applied");
  });

  it.each([
    ["Reject", "rejected"],
    ["Changes requested", "changes_requested"],
  ])(
    "records %s as Didi's answer with outcome %s, which sends the item back",
    async (label, outcome) => {
      const { f, node, answer } = await waiting();
      await resume(f.deps, answer(label, "Make the header smaller."));
      expect(await f.store.listDecisionsForNode(node.id)).toMatchObject([
        {
          kind: "answer",
          byActor: "didi",
          textVerbatim: "Make the header smaller.",
          scope: { outcome, pageUrl: PAGE },
        },
      ]);
      // changes_requested_recorded reads scope.outcome (docs/guards.md).
      const back = await requestTransition(f.deps, {
        nodeId: node.id,
        toState: "in_design_exploration",
        trigger: { kind: "human", ref: `answer:${label}` },
        actor: { kind: "operator", id: "didi" },
      });
      expect(back.outcome).toBe("applied");
    },
  );

  it.each([
    ["the kill switch", "kill_switch"],
    ["dry run", "dry_run"],
  ] as const)(
    "records the answer under %s, and nothing acts on it until it is off (D-201)",
    async (_label, heldBy) => {
      const { f, node, gateRequestId, answer } = await waiting();
      if (heldBy === "kill_switch") await f.killed();
      else await f.setting("dry_run", true);
      expect(await resume(f.deps, answer("Approve"))).toMatchObject({
        outcome: "recorded",
        heldBy,
      });
      expect(await f.store.listDecisionsForNode(node.id)).toHaveLength(1);
      expect((await f.store.getGateRequest(gateRequestId))?.status).toBe("answered");
      // Nothing acts: the move is refused, or written as a dry-run row only.
      const moved = await requestTransition(f.deps, {
        nodeId: node.id,
        toState: "writing_spec",
        trigger: { kind: "human", ref: `gate:${gateRequestId}` },
        actor: { kind: "operator", id: "didi" },
      });
      expect(moved.outcome).toBe(heldBy === "kill_switch" ? "refused" : "planned");
      expect((await f.store.getNode(node.id))?.state).toBe("waiting_for_didi");
    },
  );

  it("records nothing for a timeout and leaves the request open", async () => {
    const { f, node, gateRequestId, answer } = await waiting();
    const before = await f.footprint(node.id);
    expect(
      await resume(f.deps, {
        ...answer("Approve"),
        resume: { error: { name: "timeout" } },
      }),
    ).toMatchObject({ outcome: "not_answered", reply: { reason: "timeout" } });
    expect(await f.footprint(node.id)).toBe(before);
    expect((await f.store.getGateRequest(gateRequestId))?.status).toBe("open");
  });

  it("records one decision for a duplicate resume, in turn or at once", async () => {
    const { f, node, answer } = await waiting();
    const both = await Promise.all([
      resume(f.deps, answer("Approve")),
      resume(f.deps, answer("Approve")),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["already_closed", "recorded"]);
    expect(await resume(f.deps, answer("Reject"))).toEqual({
      outcome: "already_closed",
    });
    expect(await f.store.listDecisionsForNode(node.id)).toHaveLength(1);
  });

  describe("the one form (D-254)", () => {
    /** The visual-approval request lists options a, b and c (fixtures, N-52). */
    async function withOptions() {
      const f = await createFlowFixture();
      await f.live();
      const node = await f.node("waiting_for_didi", {
        track: "design",
        ownerRole: "operator",
      });
      const gate = await f.openGate(node.id, visualApprovalTopic(node.id), {
        kind: "visual_approval",
        owner: "didi",
        approvalUrl: PAGE,
        payload: { options: ["a", "b", "c"] },
      });
      const form = (fields: Record<string, unknown>) => ({
        gateRequestId: gate.id,
        resume: fields,
        approvers: ["anonymous"],
      });
      return { f, node, gate, form };
    }

    it("Approve with one option and no feedback records it as the approved option, and the move follows", async () => {
      const { f, node, gate, form } = await withOptions();
      expect(
        await resume(f.deps, form({ decision: "Approve", options: ["b"] })),
      ).toMatchObject({ outcome: "recorded" });
      expect(await f.store.listDecisionsForNode(node.id)).toMatchObject([
        {
          kind: "approval",
          textVerbatim: "",
          scope: { option: "b", outcome: "approved" },
        },
      ]);
      const moved = await requestTransition(f.deps, {
        nodeId: node.id,
        toState: "writing_spec",
        trigger: { kind: "human", ref: `gate:${gate.id}` },
        actor: { kind: "operator", id: "didi" },
      });
      expect(moved.outcome).toBe("applied");
    });

    it("Request changes naming two options records a combine request with Didi's feedback", async () => {
      const { f, node, form } = await withOptions();
      await resume(
        f.deps,
        form({
          decision: "Request changes",
          options: ["a", "c"],
          feedback: "The header of a with the cards of c.",
        }),
      );
      expect(await f.store.listDecisionsForNode(node.id)).toMatchObject([
        {
          kind: "answer",
          textVerbatim: "The header of a with the cards of c.",
          scope: { outcome: "changes_requested", options: ["a", "c"] },
        },
      ]);
    });

    it.each([
      [{ decision: "Approve", options: [] }, ANSWER_PROBLEMS.approveNeedsOneOption],
      [
        { decision: "Approve", options: ["a", "b"] },
        ANSWER_PROBLEMS.approveNeedsOneOption,
      ],
      [
        { decision: "Request changes", options: ["a"] },
        ANSWER_PROBLEMS.changesNeedFeedback,
      ],
      [{ decision: "Reject", feedback: "  " }, ANSWER_PROBLEMS.rejectNeedsFeedback],
      [{ decision: "Approve", options: ["z"] }, ANSWER_PROBLEMS.unknownOption],
    ])(
      "an answer that breaks a rule records nothing and opens a fresh request with the note (%j)",
      async (fields, note) => {
        const { f, node, gate, form } = await withOptions();
        const result = await resume(f.deps, form(fields));
        expect(result).toMatchObject({ outcome: "reopened", note });
        expect(await f.store.listDecisionsForNode(node.id)).toEqual([]);
        const fresh = await f.store.findOpenGateRequest(f.projectId, gate.topicKey);
        expect(fresh).toMatchObject({
          kind: "visual_approval",
          owner: "didi",
          nodeId: node.id,
          payload: { options: ["a", "b", "c"], note },
          approvalUrl: null,
        });
        expect(fresh?.id).not.toBe(gate.id);
        expect(await f.store.getGateRequest(gate.id)).toMatchObject({
          status: "superseded",
          supersededBy: fresh?.id,
        });
        // The answered page is closed; another resume on it records nothing.
        expect(
          await resume(f.deps, form({ decision: "Reject", feedback: "x" })),
        ).toEqual({
          outcome: "already_closed",
        });
      },
    );

    it("still records an answer from the older form on a request opened before D-254", async () => {
      const { f, node, form } = await withOptions();
      await resume(
        f.deps,
        form({ answer: "Approve", reply: "Option a.", option: "a" }),
      );
      expect(await f.store.listDecisionsForNode(node.id)).toMatchObject([
        { kind: "approval", textVerbatim: "Option a.", scope: { option: "a" } },
      ]);
    });
  });

  it("writes nothing for a request that does not exist", async () => {
    const { f, answer } = await waiting();
    expect(
      await resume(f.deps, {
        ...answer("Approve"),
        gateRequestId: "60000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ outcome: "no_gate_request" });
  });
});

describe("runner-only moves (flow: fake adapters, O-54)", () => {
  it("refuses a redo move the Council's answer allows, which only the Council's redo step applies", async () => {
    const f = await createFlowFixture();
    await f.live();
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development");
    const item = await f.node("in_development");
    await f.store.setCounter(item.id, "failure", 2, f.clock.now());
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
    const council = createCouncil(f.deps);
    const run = await f.run(owner.id, "council", 0, {
      questionTopic: reversalTopic(decision.id),
    });
    await council.recordAnswer(run.id, {
      verdicts: [{ nodeId: item.id, verdict: "redo", note: "" }],
      note: "Redo it.",
    });
    const before = await f.footprint(item.id);
    expect(
      await requestTransition(f.deps, {
        nodeId: item.id,
        toState: "ready_for_dev",
        trigger: { kind: "human", ref: "by-hand-1" },
        actor: { kind: "operator", id: "didi" },
        // A flow input cannot claim the runner step's own move.
        ...({ runnerOnly: true } as object),
      }),
    ).toEqual({
      outcome: "rejected",
      reason: "runner_only_move",
      transitionId: undefined,
      failedGuards: [],
    });
    expect(await f.footprint(item.id)).toBe(before);
    expect(await council.redo(item.id)).toMatchObject({ outcome: "applied" });
    expect(await f.store.getNode(item.id)).toMatchObject({
      state: "ready_for_dev",
      stale: false,
    });
    expect(await f.store.getCounter(item.id, "failure")).toBe(0);
  });

  it("refuses the way back out of an escalation, which only the escalation pass applies with its reset", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("in_development");
    await f.store.setCounter(node.id, "failure", 3, f.clock.now());
    const escalations = createEscalations(f.deps);
    await escalations.escalate(
      node.id,
      { kind: "event", ref: "test:escalate" },
      "stuck",
    );
    f.advanceMinutes(1);
    await createLibrary(f.deps).recordDecision({
      projectId: f.projectId,
      nodeId: node.id,
      kind: "council_decision",
      scope: { outcome: "resolve", changesProductDirection: false, passesGate: false },
      textVerbatim: "Retry smaller.",
      byActor: "council",
    });
    expect(
      await requestTransition(f.deps, {
        nodeId: node.id,
        toState: "in_development",
        trigger: { kind: "human", ref: "by-hand-2" },
        actor: { kind: "operator", id: "didi" },
      }),
    ).toMatchObject({ outcome: "rejected", reason: "runner_only_move" });
    expect((await f.store.getNode(node.id))?.state).toBe("escalated_to_council");
    expect(await escalations.resolve(node.id)).toMatchObject({
      step: "returned",
      move: { outcome: "applied", toState: "in_development" },
    });
    expect(await f.store.getCounter(node.id, "failure")).toBe(0);
  });
});
