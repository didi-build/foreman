import { describe, expect, it } from "vitest";

import { escalationTopic } from "./escalation.ts";
import { MERGE, NODE, OLD, fixture } from "./testing.ts";

const topic = escalationTopic(NODE);

describe("escalation guards (unit: guards on the memory store, ADR 0105, D-177)", () => {
  describe("escalation_trigger_met", () => {
    it("fails with no trigger", async () => {
      expect((await (await fixture()).check("escalation_trigger_met")).pass).toBe(
        false,
      );
    });
    it("passes at the failure threshold and at the QA round cap, not below", async () => {
      const f = await fixture();
      await f.counter("failure", 2);
      expect((await f.check("escalation_trigger_met")).pass).toBe(false);
      await f.counter("failure", 3);
      expect((await f.check("escalation_trigger_met")).detail).toMatch(/3 failures/);
      const g = await fixture();
      await g.counter("qa_round", 3);
      expect((await g.check("escalation_trigger_met")).pass).toBe(true);
    });
    it("passes when a run went over budget in the current state", async () => {
      const f = await fixture();
      await f.run("developer", "model-a", { outcome: "budget_exceeded" });
      expect((await f.check("escalation_trigger_met")).detail).toMatch(/over budget/);
    });
    it("passes when a bot asks with a written reason, not without one", async () => {
      const f = await fixture();
      await f.evidence("agent_report", null, { escalate: true, reason: "   " });
      expect((await f.check("escalation_trigger_met")).pass).toBe(false);
      await f.evidence("agent_report", null, {
        escalate: true,
        reason: "the API is undocumented",
      });
      expect((await f.check("escalation_trigger_met")).pass).toBe(true);
    });
    it("ignores a request or an over-budget run from before the current state (stale)", async () => {
      const f = await fixture();
      await f.evidence("agent_report", null, { escalate: true, reason: "old problem" });
      await f.run("developer", "model-a", { outcome: "budget_exceeded" });
      await f.enterState("in_development");
      expect((await f.check("escalation_trigger_met")).pass).toBe(false);
    });
    it("passes after two staging checks without a result for the merge commit (M3.4)", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      await f.evidence("staging_no_result", MERGE, {
        reason: "unreachable",
        attempt: 1,
      });
      expect((await f.check("escalation_trigger_met")).pass).toBe(false);
      await f.evidence("staging_no_result", MERGE, { reason: "timed_out", attempt: 2 });
      const check = await f.check("escalation_trigger_met");
      expect(check.detail).toMatch(/without a result 2 times/);
      expect(check.evidenceIds).toHaveLength(2);
    });
    it("counts no checks without a result for another commit, or from before the current state", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      await f.evidence("staging_no_result", OLD, { reason: "unreachable", attempt: 1 });
      await f.evidence("staging_no_result", MERGE, {
        reason: "unreachable",
        attempt: 1,
      });
      await f.evidence("staging_no_result", MERGE, {
        reason: "unreachable",
        attempt: 2,
      });
      await f.enterState("verifying_on_staging");
      await f.evidence("staging_no_result", MERGE, {
        reason: "unreachable",
        attempt: 1,
      });
      expect((await f.check("escalation_trigger_met")).pass).toBe(false);
    });
    it("ignores other evidence kinds and malformed reports", async () => {
      const f = await fixture();
      await f.evidence("docs_note", null, { escalate: true, reason: "x" });
      await f.evidence("agent_report", null, { escalate: "yes", reason: "x" });
      expect((await f.check("escalation_trigger_met")).pass).toBe(false);
    });
  });

  describe("council_decision_recorded", () => {
    const keeps = { changesProductDirection: false, passesGate: false };
    it("passes when the Council decided, keeping direction and gates", async () => {
      const f = await fixture();
      await f.enterState("escalated_to_council");
      await f.decision("council_decision", "council", keeps);
      expect((await f.check("council_decision_recorded")).pass).toBe(true);
    });
    it("fails when the decision changes direction, passes a gate, or does not say", async () => {
      for (const scope of [
        { ...keeps, changesProductDirection: true },
        { ...keeps, passesGate: true },
        {},
      ]) {
        const f = await fixture();
        await f.enterState("escalated_to_council");
        await f.decision("council_decision", "council", scope);
        expect((await f.check("council_decision_recorded")).detail).toMatch(
          /goes to Didi/,
        );
      }
    });
    it("ignores a decision from before the escalation (stale), a reversed one, or another kind", async () => {
      const f = await fixture();
      await f.decision("council_decision", "council", keeps);
      await f.enterState("escalated_to_council");
      await f.reverse(await f.decision("council_decision", "council", keeps));
      await f.decision("product_direction", "didi", keeps);
      expect((await f.check("council_decision_recorded")).pass).toBe(false);
    });
  });

  describe("didi_question_open", () => {
    it("passes with an open question owned by Didi on the node's topic", async () => {
      const f = await fixture();
      await f.gate(topic, "escalation", "didi");
      expect((await f.check("didi_question_open")).pass).toBe(true);
    });
    it("fails with no question (missing), a Council-owned one, or another topic", async () => {
      const f = await fixture();
      expect((await f.check("didi_question_open")).pass).toBe(false);
      await f.gate(topic, "escalation", "council");
      expect((await f.check("didi_question_open")).pass).toBe(false);
      const g = await fixture();
      await g.gate("escalation:someone-else", "escalation", "didi");
      expect((await g.check("didi_question_open")).pass).toBe(false);
    });
  });

  describe("didi_answer_recorded", () => {
    it("passes with Didi's verbatim answer on the topic since the escalation", async () => {
      const f = await fixture();
      await f.enterState("escalated_to_didi");
      await f.decision("answer", "didi", { topicKey: topic }, "Keep it simple");
      expect((await f.check("didi_answer_recorded")).pass).toBe(true);
    });
    it("fails with no answer, an empty one, someone else's, or one from before (stale)", async () => {
      const f = await fixture();
      await f.decision("answer", "didi", { topicKey: topic }, "old answer");
      await f.enterState("escalated_to_didi");
      await f.decision("answer", "council", { topicKey: topic }, "we think");
      expect((await f.check("didi_answer_recorded")).pass).toBe(false);
      await f.decision("answer", "didi", { topicKey: topic }, "");
      expect((await f.check("didi_answer_recorded")).detail).toMatch(
        /no verbatim text/,
      );
    });
  });
});
