// Seam: the transition flow and the approval resume step (build plan M3.1, M0.4, D-170) with
// fake adapters on the memory store and the real machine-2 contracts and guards. The library's
// rules are tested in src/core/library.test.ts; this covers what reaches the store through the
// flows, and that a duplicate trigger writes one transition and one decision.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as requestTransition } from "../../flows/request-transition.ts";
import { visualApprovalTopic } from "../../src/core/guards/design.ts";
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

describe("approval resume step (flow: fake adapters, M0.4, D-170, D-200, D-201)", () => {
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
