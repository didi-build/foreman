import { describe, expect, it } from "vitest";

import { MERGE, NODE, fixture } from "./testing.ts";

const BLOCKER = "30000000-0000-4000-8000-000000000010";
const DESIGN_BLOCKER = "30000000-0000-4000-8000-000000000011";

async function blockedBy(
  state: string,
  track: "code" | "design" = "code",
  id = BLOCKER,
) {
  const f = await fixture({ state: "blocked", blockedReason: "waits" });
  await f.node(id, { state, track });
  await f.store.insertEdge({
    id: `40000000-0000-4000-8000-${id.slice(-12)}`,
    fromNode: id,
    toNode: NODE,
    type: "blocks",
    createdAt: new Date(Date.UTC(2026, 9, 29)),
  });
  return f;
}

describe("dispatch guards (unit: guards on the memory store, ADR 0105)", () => {
  describe("blockers_done", () => {
    it("passes with no blockers, or when every blocker is Done", async () => {
      expect((await (await fixture()).check("blockers_done")).pass).toBe(true);
      expect((await (await blockedBy("done")).check("blockers_done")).pass).toBe(true);
    });
    it("fails while a blocker is not Done", async () => {
      const check = await (await blockedBy("in_development")).check("blockers_done");
      expect(check).toMatchObject({ pass: false });
      expect(check.detail).toContain(BLOCKER);
    });
    it("ignores edges of other types", async () => {
      const f = await fixture();
      await f.node(BLOCKER, { state: "in_development" });
      await f.store.insertEdge({
        id: "40000000-0000-4000-8000-000000000099",
        fromNode: BLOCKER,
        toNode: NODE,
        type: "design_for",
        createdAt: new Date(Date.UTC(2026, 9, 29)),
      });
      expect((await f.check("blockers_done")).pass).toBe(true);
    });
  });

  describe("design_spec_merged", () => {
    it("passes with no design blockers", async () => {
      expect(
        (await (await blockedBy("done", "code")).check("design_spec_merged")).pass,
      ).toBe(true);
    });
    it("passes when each design blocker has a merge on main", async () => {
      const f = await blockedBy("done", "design", DESIGN_BLOCKER);
      await f.evidence("merge_commit", MERGE, { pr: 3 }, { nodeId: DESIGN_BLOCKER });
      expect((await f.check("design_spec_merged")).pass).toBe(true);
    });
    it("fails when a design blocker's spec is not merged (missing)", async () => {
      const f = await blockedBy("done", "design", DESIGN_BLOCKER);
      expect((await f.check("design_spec_merged")).detail).toContain(DESIGN_BLOCKER);
    });
    it("is not satisfied by another kind of evidence on the blocker", async () => {
      const f = await blockedBy("done", "design", DESIGN_BLOCKER);
      await f.evidence("spec_paths", MERGE, {}, { nodeId: DESIGN_BLOCKER });
      expect((await f.check("design_spec_merged")).pass).toBe(false);
    });
    it("on a design item, checks its own merge", async () => {
      const f = await fixture({ track: "design" });
      expect((await f.check("design_spec_merged")).pass).toBe(false);
      await f.evidence("merge_commit", MERGE, { pr: 3 });
      expect((await f.check("design_spec_merged")).pass).toBe(true);
    });
  });

  describe("no_pending_gate", () => {
    it("passes with no open gate request on the node", async () => {
      expect((await (await fixture()).check("no_pending_gate")).pass).toBe(true);
    });
    it("fails with an open gate request on the node", async () => {
      const f = await fixture();
      await f.gate("spend:x", "spend", "didi");
      expect((await f.check("no_pending_gate")).detail).toContain("spend:x");
    });
    it("ignores a request on another node, and a closed one", async () => {
      const f = await fixture();
      const gateId = await f.gate("spend:x", "spend", "didi");
      await f.store.closeGateRequest(gateId, {
        status: "cancelled",
        at: new Date(Date.UTC(2026, 9, 30)),
      });
      await f.store.insertGateRequest({
        ...(await f.store.getGateRequest(gateId))!,
        id: "50000000-0000-4000-8000-000000000001",
        nodeId: null,
        status: "open",
      });
      expect((await f.check("no_pending_gate")).pass).toBe(true);
    });
  });

  describe("agent_ready_not_on_hold", () => {
    it("passes when agent-ready and not on hold", async () => {
      expect((await (await fixture()).check("agent_ready_not_on_hold")).pass).toBe(
        true,
      );
    });
    it("fails when on hold, or not agent-ready", async () => {
      expect(
        (await (await fixture({ hold: true })).check("agent_ready_not_on_hold")).detail,
      ).toBe("on hold");
      expect(
        (await (await fixture({ agentReady: false })).check("agent_ready_not_on_hold"))
          .pass,
      ).toBe(false);
    });
  });

  describe("plan_attached", () => {
    it("passes with an accepted plan and the product direction linked", async () => {
      const f = await fixture();
      await f.decision("product_direction", "didi", {});
      await f.decision("council_decision", "council", { kind: "plan_accepted" });
      expect((await f.check("plan_attached")).pass).toBe(true);
    });
    it("fails with either one missing", async () => {
      const f = await fixture();
      await f.decision("product_direction", "didi", {});
      expect((await f.check("plan_attached")).detail).toMatch(/accepted plan/);
      const g = await fixture();
      await g.decision("council_decision", "council", { kind: "plan_accepted" });
      expect((await g.check("plan_attached")).detail).toMatch(/product direction/);
    });
    it("ignores a reversed plan, and a Council decision of another kind", async () => {
      const f = await fixture();
      await f.decision("product_direction", "didi", {});
      await f.reverse(
        await f.decision("council_decision", "council", { kind: "plan_accepted" }),
      );
      await f.decision("council_decision", "council", { kind: "something_else" });
      expect((await f.check("plan_attached")).pass).toBe(false);
    });
    it("counts a decision linked through node_decisions", async () => {
      const f = await fixture();
      const other = "30000000-0000-4000-8000-000000000020";
      await f.node(other, {});
      await f.decision("product_direction", "didi", {});
      const plan = await f.decision(
        "council_decision",
        "council",
        { kind: "plan_accepted" },
        "ok",
        other,
      );
      await f.store.linkNodeToDecision(NODE, plan);
      expect((await f.check("plan_attached")).pass).toBe(true);
    });
  });
});
