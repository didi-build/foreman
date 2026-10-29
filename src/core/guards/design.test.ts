import { describe, expect, it } from "vitest";

import { visualApprovalTopic } from "./design.ts";
import { HEAD, NODE, OLD, fixture } from "./testing.ts";

const topic = visualApprovalTopic(NODE);

const spec = (overrides: Record<string, unknown> = {}) => ({
  paths: ["design/app/login/spec.md"],
  components: ["LoginForm", "Button"],
  commits: [{ sha: HEAD, author: "designer-bot" }],
  newFeatures: [],
  newFlows: [],
  ...overrides,
});

describe("design guards (unit: guards on the memory store, ADR 0105)", () => {
  describe("options_attached", () => {
    it("passes with options attached and an open visual-approval request", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("screenshot", null, { option: "A" });
      await f.gate(topic, "visual_approval", "didi");
      expect((await f.check("options_attached")).pass).toBe(true);
    });
    it("fails with no options (missing), or no open request", async () => {
      const f = await fixture({ track: "design" });
      await f.gate(topic, "visual_approval", "didi");
      expect((await f.check("options_attached")).detail).toBe("no options attached");
      const g = await fixture({ track: "design" });
      await g.evidence("screenshot", null, { option: "A" });
      expect((await g.check("options_attached")).detail).toMatch(
        /no open visual-approval/,
      );
    });
    it("is not satisfied by another request kind on the topic, or by other evidence", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("agent_report", null, { summary: "options in Figma" });
      await f.gate(topic, "scope", "didi");
      expect((await f.check("options_attached")).pass).toBe(false);
    });
  });

  describe("approval_recorded", () => {
    it("passes when Didi's latest answer approves, verbatim", async () => {
      const f = await fixture({ track: "design" });
      await f.decision(
        "approval",
        "didi",
        { topicKey: topic, outcome: "approved" },
        "Option A, ship it",
      );
      expect((await f.check("approval_recorded")).pass).toBe(true);
    });
    it("fails with no answer, an empty one, or an approval by someone else", async () => {
      const f = await fixture({ track: "design" });
      expect((await f.check("approval_recorded")).pass).toBe(false);
      await f.decision("approval", "council", { topicKey: topic });
      expect((await f.check("approval_recorded")).pass).toBe(false);
      await f.decision("approval", "didi", { topicKey: topic }, "   ");
      expect((await f.check("approval_recorded")).detail).toMatch(/no verbatim text/);
    });
    it("uses the latest answer: changes requested after an approval wins", async () => {
      const f = await fixture({ track: "design" });
      await f.decision("approval", "didi", { topicKey: topic }, "yes");
      await f.decision(
        "answer",
        "didi",
        { topicKey: topic, outcome: "changes_requested" },
        "bigger",
      );
      expect((await f.check("approval_recorded")).pass).toBe(false);
    });
    it("ignores a reversed approval, and approvals on another topic", async () => {
      const f = await fixture({ track: "design" });
      await f.reverse(await f.decision("approval", "didi", { topicKey: topic }, "yes"));
      await f.decision("approval", "didi", { topicKey: "spend:x" }, "yes");
      expect((await f.check("approval_recorded")).pass).toBe(false);
    });
  });

  describe("changes_requested_recorded", () => {
    it("passes when Didi asks for changes or rejects, verbatim", async () => {
      for (const outcome of ["changes_requested", "rejected"]) {
        const f = await fixture({ track: "design" });
        await f.decision("answer", "didi", { topicKey: topic, outcome }, "not this");
        expect((await f.check("changes_requested_recorded")).pass, outcome).toBe(true);
      }
    });
    it("fails on an approval, no answer, or an empty answer", async () => {
      const f = await fixture({ track: "design" });
      expect((await f.check("changes_requested_recorded")).pass).toBe(false);
      await f.decision("approval", "didi", { topicKey: topic }, "yes");
      expect((await f.check("changes_requested_recorded")).pass).toBe(false);
      await f.decision("answer", "didi", { topicKey: topic, outcome: "rejected" }, "");
      expect((await f.check("changes_requested_recorded")).pass).toBe(false);
    });
  });

  describe("spec_edited_by_designer_only", () => {
    it("passes when every spec commit is the Designer's", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec());
      expect((await f.check("spec_edited_by_designer_only")).pass).toBe(true);
    });
    it("fails when anyone else edited the spec", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence(
        "spec_paths",
        HEAD,
        spec({ commits: [{ sha: OLD, author: "developer-bot" }] }),
      );
      expect((await f.check("spec_edited_by_designer_only")).detail).toContain(
        "developer-bot",
      );
    });
    it("fails with no spec paths (missing), no designer identity, or a malformed payload", async () => {
      const f = await fixture({ track: "design" });
      expect((await f.check("spec_edited_by_designer_only")).pass).toBe(false);
      await f.evidence("spec_paths", HEAD, { paths: [] });
      expect((await f.check("spec_edited_by_designer_only")).detail).toBe(
        "malformed spec_paths payload",
      );
      const g = await fixture({ track: "design" });
      await g.setting("designer_identity", "");
      await g.evidence("spec_paths", HEAD, spec());
      expect((await g.check("spec_edited_by_designer_only")).detail).toMatch(
        /designer_identity/,
      );
    });
    it("uses the latest spec record", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence(
        "spec_paths",
        OLD,
        spec({ commits: [{ sha: OLD, author: "someone" }] }),
      );
      await f.evidence("spec_paths", HEAD, spec());
      expect((await f.check("spec_edited_by_designer_only")).pass).toBe(true);
    });
  });

  describe("scope_matches_plan", () => {
    it("passes when the spec declares nothing beyond the plan", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec());
      expect((await f.check("scope_matches_plan")).pass).toBe(true);
    });
    it("fails with 'needs Council' when the spec adds a feature or flow (D-177)", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec({ newFlows: ["password reset"] }));
      expect((await f.check("scope_matches_plan")).detail).toMatch(
        /^needs Council: .*password reset/,
      );
    });
    it("passes when the Council approved the extra scope after the spec was recorded", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec({ newFeatures: ["remember me"] }));
      await f.decision("council_decision", "council", { kind: "scope_approved" });
      expect((await f.check("scope_matches_plan")).pass).toBe(true);
    });
    it("does not accept a Council approval older than the spec (stale)", async () => {
      const f = await fixture({ track: "design" });
      await f.decision("council_decision", "council", { kind: "scope_approved" });
      await f.evidence("spec_paths", HEAD, spec({ newFeatures: ["remember me"] }));
      expect((await f.check("scope_matches_plan")).pass).toBe(false);
    });
    it("fails with no spec (missing) or a malformed payload", async () => {
      const f = await fixture({ track: "design" });
      expect((await f.check("scope_matches_plan")).pass).toBe(false);
      await f.evidence("spec_paths", HEAD, spec({ newFlows: "none" }));
      expect((await f.check("scope_matches_plan")).detail).toBe(
        "malformed spec_paths payload",
      );
    });
  });

  describe("spec_components_exist", () => {
    it("passes when the gallery build on the head commit has every spec component", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec());
      await f.ci(HEAD);
      await f.evidence("test_report", HEAD, {
        suite: "gallery",
        pass: true,
        galleryComponents: ["LoginForm", "Button", "Extra"],
      });
      expect((await f.check("spec_components_exist")).pass).toBe(true);
    });
    it("fails when a component is missing", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec());
      await f.ci(HEAD);
      await f.evidence("test_report", HEAD, {
        suite: "gallery",
        pass: true,
        galleryComponents: ["Button"],
      });
      expect((await f.check("spec_components_exist")).detail).toContain("LoginForm");
    });
    it("ignores a gallery report for an older commit (stale), and other suites (wrong kind)", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec());
      await f.ci(OLD);
      await f.evidence("test_report", OLD, {
        suite: "gallery",
        pass: true,
        galleryComponents: ["LoginForm", "Button"],
      });
      await f.ci(HEAD);
      await f.evidence("test_report", HEAD, {
        suite: "unit",
        pass: true,
        galleryComponents: ["LoginForm", "Button"],
      });
      expect((await f.check("spec_components_exist")).detail).toMatch(
        /no gallery build report/,
      );
    });
    it("fails with no head commit or a report without components", async () => {
      const f = await fixture({ track: "design" });
      await f.evidence("spec_paths", HEAD, spec());
      expect((await f.check("spec_components_exist")).detail).toMatch(
        /no linked pull request/,
      );
      await f.ci(HEAD);
      await f.evidence("test_report", HEAD, { suite: "gallery", pass: true });
      expect((await f.check("spec_components_exist")).detail).toMatch(
        /lists no components/,
      );
    });
  });
});
