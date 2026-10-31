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
      failedGuards: ["ci_green_on_head", "docs_updated_or_none"],
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

describe("approval resume step (flow: fake adapters, M0.4, D-170)", () => {
  /** A design item waiting for Didi, with its visual-approval request open. */
  async function waiting() {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("waiting_for_didi", {
      track: "design",
      ownerRole: "operator",
    });
    const gate = await f.openGate(node.id, visualApprovalTopic(node.id));
    const approve = {
      gateRequestId: gate.id,
      resume: { reply: "  Option B, as is.  " },
      approvers: ["anonymous"],
    };
    return { f, node, gate, approve };
  }

  it("records the reply verbatim, closes the request, and the guard then allows the move", async () => {
    const { f, node, gate, approve } = await waiting();
    const result = await resume(f.deps, approve);
    expect(result.outcome).toBe("recorded");
    const [decision] = await f.store.listDecisionsForNode(node.id);
    expect(decision).toMatchObject({
      kind: "approval",
      byActor: "didi",
      textVerbatim: "  Option B, as is.  ",
    });
    expect((await f.store.getGateRequest(gate.id))?.status).toBe("answered");

    const moved = await requestTransition(f.deps, {
      nodeId: node.id,
      toState: "writing_spec",
      trigger: { kind: "human", ref: `gate:${gate.id}` },
      actor: { kind: "operator", id: "didi" },
    });
    expect(moved.outcome).toBe("applied");
  });

  it("reads a disapproval or a timeout as Windmill sends it", async () => {
    const { f, node, approve } = await waiting();
    await resume(f.deps, { ...approve, resume: { error: { name: "timeout" } } });
    expect(await f.store.listDecisionsForNode(node.id)).toMatchObject([
      { kind: "answer", scope: { outcome: "timeout" } },
    ]);
  });

  it.each([
    ["the kill switch", "kill_switch"],
    ["dry run", "dry_run"],
  ])(
    "writes nothing under %s and keeps the reply in its result",
    async (_label, reason) => {
      const { f, node, approve } = await waiting();
      if (reason === "kill_switch") await f.killed();
      else await f.setting("dry_run", true);
      const before = await f.footprint(node.id);
      expect(await resume(f.deps, approve)).toEqual({
        outcome: "refused",
        reason,
        reply: {
          outcome: "approved",
          approved: true,
          replyVerbatim: "  Option B, as is.  ",
          approvers: ["anonymous"],
        },
      });
      expect(await f.footprint(node.id)).toBe(before);
    },
  );

  it("records one decision for a duplicate resume, in turn or at once", async () => {
    const { f, node, approve } = await waiting();
    const both = await Promise.all([resume(f.deps, approve), resume(f.deps, approve)]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["already_closed", "recorded"]);
    expect(await resume(f.deps, approve)).toEqual({ outcome: "already_closed" });
    expect(await f.store.listDecisionsForNode(node.id)).toHaveLength(1);
  });

  it("writes nothing for a request that does not exist", async () => {
    const { f, approve } = await waiting();
    expect(
      await resume(f.deps, {
        ...approve,
        gateRequestId: "60000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ outcome: "no_gate_request" });
  });
});
