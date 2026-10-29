import { describe, expect, it } from "vitest";

import { globToRegExp } from "./review.ts";
import { HEAD, OLD, PROJECT, fixture } from "./testing.ts";

describe("review guards (unit: guards on the memory store, ADR 0105 and 0112)", () => {
  describe("ci_green_on_head", () => {
    it("passes when CI succeeded on the head commit", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      expect(await f.check("ci_green_on_head")).toMatchObject({ pass: true });
    });
    it("fails when CI failed or is still running on the head commit", async () => {
      const f = await fixture();
      await f.ci(HEAD, "failure");
      expect((await f.check("ci_green_on_head")).pass).toBe(false);
      await f.ci(HEAD, "pending");
      expect((await f.check("ci_green_on_head")).pass).toBe(false);
    });
    it("ignores a green run on an older commit (stale)", async () => {
      const f = await fixture();
      await f.ci(OLD, "success");
      await f.ci(HEAD, "failure");
      const check = await f.check("ci_green_on_head");
      expect(check.pass).toBe(false);
      expect(check.detail).toContain(HEAD);
    });
    it("fails with no linked PR (missing evidence)", async () => {
      const f = await fixture();
      expect((await f.check("ci_green_on_head")).detail).toMatch(
        /no linked pull request/,
      );
    });
    it("is not satisfied by another kind of evidence on the head commit", async () => {
      const f = await fixture();
      await f.evidence("preview_check", HEAD, { pass: true });
      expect((await f.check("ci_green_on_head")).pass).toBe(false);
    });
    it("fails, without throwing, on a malformed payload", async () => {
      const f = await fixture();
      await f.evidence("ci_run", HEAD, { conclusion: "success" });
      expect(await f.check("ci_green_on_head")).toMatchObject({
        pass: false,
        detail: "malformed ci_run payload",
      });
    });
  });

  describe("docs_updated_or_none", () => {
    it("passes with a docs note for the head commit, written after its CI started", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      await f.evidence("docs_note", null, { impact: "none" });
      expect(await f.check("docs_updated_or_none")).toMatchObject({
        pass: true,
        detail: "no docs impact stated",
      });
    });
    it("passes with a docs note naming the head commit", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      await f.evidence("docs_note", HEAD, { impact: "updated" });
      expect((await f.check("docs_updated_or_none")).pass).toBe(true);
    });
    it("ignores a note written for an older head (stale)", async () => {
      const f = await fixture();
      await f.ci(OLD);
      await f.evidence("docs_note", null, { impact: "none" });
      await f.ci(HEAD);
      expect((await f.check("docs_updated_or_none")).pass).toBe(false);
    });
    it("fails with no docs note, or with no PR", async () => {
      const f = await fixture();
      expect((await f.check("docs_updated_or_none")).pass).toBe(false);
      await f.ci(HEAD);
      expect((await f.check("docs_updated_or_none")).detail).toMatch(/no docs note/);
    });
    it("is not satisfied by an agent report", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      await f.evidence("agent_report", null, { summary: "docs done" });
      expect((await f.check("docs_updated_or_none")).pass).toBe(false);
    });
    it("fails on a malformed payload", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      await f.evidence("docs_note", HEAD, { impact: "maybe" });
      expect((await f.check("docs_updated_or_none")).detail).toBe(
        "malformed docs_note payload",
      );
    });
  });

  describe("qa_verdict_independent_on_head", () => {
    /** A complete passing setup; `skip` leaves one part out. */
    async function passing(
      skip: "preview" | "verdict" | "builder" | null = null,
      options: { qaModel?: string; cite?: "ci" | "agent" | "none" | "old" } = {},
    ) {
      const f = await fixture();
      if (skip !== "builder") await f.run("developer", "model-a");
      const ciId = await f.ci(HEAD);
      if (skip !== "preview") await f.evidence("preview_check", HEAD, { pass: true });
      const oldId = await f.evidence("test_report", OLD, { suite: "unit", pass: true });
      const agentId = await f.evidence("agent_report", HEAD, { summary: "ok" });
      const qaRun = await f.run("qa", options.qaModel ?? "model-b");
      const cite = options.cite ?? "ci";
      const cited =
        cite === "none"
          ? []
          : cite === "agent"
            ? [agentId]
            : cite === "old"
              ? [oldId]
              : [ciId];
      if (skip !== "verdict") {
        await f.evidence(
          "qa_verdict",
          HEAD,
          { verdict: "pass", findings: [], evidenceIds: cited },
          { runId: qaRun },
        );
      }
      return { f };
    }

    it("passes with CI green, a preview check, a cited pass, and a different QA model", async () => {
      const { f } = await passing();
      expect(await f.check("qa_verdict_independent_on_head")).toMatchObject({
        pass: true,
      });
    });
    it("fails when QA ran on the builder's model (independence, D-158)", async () => {
      const { f } = await passing(null, { qaModel: "model-a" });
      expect((await f.check("qa_verdict_independent_on_head")).detail).toMatch(
        /builder's model/,
      );
    });
    it("fails with no builder run recorded", async () => {
      const { f } = await passing("builder");
      expect((await f.check("qa_verdict_independent_on_head")).detail).toMatch(
        /no builder run/,
      );
    });
    it("fails without a preview check, or without a verdict (missing)", async () => {
      expect(
        (await (await passing("preview")).f.check("qa_verdict_independent_on_head"))
          .pass,
      ).toBe(false);
      expect(
        (await (await passing("verdict")).f.check("qa_verdict_independent_on_head"))
          .pass,
      ).toBe(false);
    });
    it("fails when the pass cites agent evidence, nothing, or evidence for another commit", async () => {
      for (const cite of ["agent", "none", "old"] as const) {
        const { f } = await passing(null, { cite });
        expect((await f.check("qa_verdict_independent_on_head")).pass).toBe(false);
      }
    });
    it("ignores a pass verdict for an older commit (stale)", async () => {
      const f = await fixture();
      await f.run("developer", "model-a");
      const oldCi = await f.ci(OLD);
      const qaRun = await f.run("qa", "model-b");
      await f.evidence("preview_check", OLD, { pass: true });
      await f.evidence(
        "qa_verdict",
        OLD,
        { verdict: "pass", findings: [], evidenceIds: [oldCi] },
        { runId: qaRun },
      );
      await f.ci(HEAD);
      await f.evidence("preview_check", HEAD, { pass: true });
      expect((await f.check("qa_verdict_independent_on_head")).detail).toMatch(
        /no QA verdict/,
      );
    });
    it("fails when the verdict is a fail, the preview failed, or CI is red", async () => {
      const f = await fixture();
      await f.run("developer", "model-a");
      const ci = await f.ci(HEAD);
      await f.evidence("preview_check", HEAD, { pass: false });
      const qaRun = await f.run("qa", "model-b");
      await f.evidence(
        "qa_verdict",
        HEAD,
        { verdict: "pass", findings: [], evidenceIds: [ci] },
        { runId: qaRun },
      );
      expect((await f.check("qa_verdict_independent_on_head")).detail).toMatch(
        /preview check failed/,
      );
      const g = await fixture();
      await g.ci(HEAD, "failure");
      expect((await g.check("qa_verdict_independent_on_head")).detail).toMatch(
        /CI is not green/,
      );
    });
    it("needs a passing visual comparison on the design track", async () => {
      const design = await fixture({ track: "design" });
      await design.run("designer", "model-a");
      const ci = await design.ci(HEAD);
      await design.evidence("preview_check", HEAD, { pass: true });
      const qaRun = await design.run("qa", "model-b");
      await design.evidence(
        "qa_verdict",
        HEAD,
        { verdict: "pass", findings: [], evidenceIds: [ci] },
        { runId: qaRun },
      );
      expect((await design.check("qa_verdict_independent_on_head")).detail).toMatch(
        /no visual comparison/,
      );
      await design.evidence("visual_comparison", HEAD, { pass: true });
      expect((await design.check("qa_verdict_independent_on_head")).pass).toBe(true);
    });
    it("fails on a malformed verdict payload", async () => {
      const f = await fixture();
      await f.run("developer", "model-a");
      await f.ci(HEAD);
      await f.evidence("preview_check", HEAD, { pass: true });
      await f.evidence("qa_verdict", HEAD, { verdict: "pass" });
      expect((await f.check("qa_verdict_independent_on_head")).detail).toBe(
        "malformed qa_verdict payload",
      );
    });
  });

  describe("privileged_paths_approved", () => {
    it("passes when no privileged path is touched", async () => {
      const f = await fixture();
      await f.ci(HEAD, "success", ["src/app.ts", "README.md"]);
      expect((await f.check("privileged_paths_approved")).pass).toBe(true);
    });
    it("fails on a migration, a workflow, privacy docs, a secret or a project extra path", async () => {
      for (const path of [
        "db/migrations/0002_x.sql",
        ".github/workflows/deploy.yml",
        "docs/privacy/data-map.yml",
        "src/config/secrets.ts",
        "config/billing/plan.ts",
      ]) {
        const f = await fixture();
        await f.ci(HEAD, "success", [path]);
        expect((await f.check("privileged_paths_approved")).pass, path).toBe(false);
      }
    });
    it("passes when Didi approved this head commit", async () => {
      const f = await fixture();
      await f.ci(HEAD, "success", ["db/migrations/0002_x.sql"]);
      await f.decision("approval", "didi", {
        kind: "privileged_path",
        commitSha: HEAD,
      });
      expect((await f.check("privileged_paths_approved")).pass).toBe(true);
    });
    it("does not accept an approval for an older commit (stale), a reversed one, or someone else's", async () => {
      const f = await fixture();
      await f.ci(HEAD, "success", ["db/migrations/0002_x.sql"]);
      await f.decision("approval", "didi", { kind: "privileged_path", commitSha: OLD });
      await f.decision("approval", "council", {
        kind: "privileged_path",
        commitSha: HEAD,
      });
      const reversed = await f.decision("approval", "didi", {
        kind: "privileged_path",
        commitSha: HEAD,
      });
      await f.reverse(reversed);
      expect((await f.check("privileged_paths_approved")).pass).toBe(false);
    });
    it("fails when the changed paths are not recorded, or there is no PR", async () => {
      const f = await fixture();
      expect((await f.check("privileged_paths_approved")).pass).toBe(false);
      await f.evidence("ci_run", HEAD, { conclusion: "success", pr: 7 });
      expect((await f.check("privileged_paths_approved")).detail).toMatch(
        /not recorded/,
      );
    });
    it("matches globs by folder", () => {
      expect(globToRegExp("**/migrations/**").test("migrations/1.sql")).toBe(true);
      expect(globToRegExp("**/migrations/**").test("db/migrations/1.sql")).toBe(true);
      expect(globToRegExp(".github/**").test("src/.github/x")).toBe(false);
      expect(globToRegExp("**/*secret*").test("a/b/my-secret.txt")).toBe(true);
      expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false);
    });
  });

  describe("prod_env_protected", () => {
    it("passes when the project's production requires Didi", async () => {
      const f = await fixture();
      expect((await f.check("prod_env_protected")).pass).toBe(true);
    });
    it("fails when it is not confirmed", async () => {
      const g = await fixture();
      const project = await g.store.getProject(PROJECT);
      // A second project without the confirmation, and a node in it.
      await g.store.insertProject({
        ...(project as NonNullable<typeof project>),
        id: "10000000-0000-4000-8000-0000000000ff",
        slug: "unprotected",
        prodRequiresApproval: false,
      });
      await g.node("30000000-0000-4000-8000-000000000002", {
        projectId: "10000000-0000-4000-8000-0000000000ff",
      });
      expect(
        (await g.check("prod_env_protected", "30000000-0000-4000-8000-000000000002"))
          .pass,
      ).toBe(false);
    });
  });

  describe("qa_failed_with_findings", () => {
    const finding = { path: "src/a.ts", startLine: 3, endLine: 4, note: "off by one" };
    it("passes on a fail verdict with findings on the head commit", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      await f.evidence("qa_verdict", HEAD, {
        verdict: "fail",
        findings: [finding],
        evidenceIds: [],
      });
      expect((await f.check("qa_failed_with_findings")).pass).toBe(true);
    });
    it("fails on a pass, on a fail without findings, or with no verdict", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      expect((await f.check("qa_failed_with_findings")).pass).toBe(false);
      await f.evidence(
        "qa_verdict",
        HEAD,
        { verdict: "fail", findings: [], evidenceIds: [] },
        { runId: await f.run("qa", "model-b") },
      );
      expect((await f.check("qa_failed_with_findings")).detail).toMatch(/no findings/);
      await f.evidence(
        "qa_verdict",
        HEAD,
        { verdict: "pass", findings: [], evidenceIds: [] },
        { runId: await f.run("qa", "model-b") },
      );
      expect((await f.check("qa_failed_with_findings")).detail).toMatch(/is a pass/);
    });
    it("ignores a fail verdict for an older commit (stale)", async () => {
      const f = await fixture();
      await f.ci(OLD);
      await f.evidence("qa_verdict", OLD, {
        verdict: "fail",
        findings: [finding],
        evidenceIds: [],
      });
      await f.ci(HEAD);
      expect((await f.check("qa_failed_with_findings")).pass).toBe(false);
    });
    it("fails on a malformed verdict, such as a bad line range", async () => {
      const f = await fixture();
      await f.ci(HEAD);
      await f.evidence("qa_verdict", HEAD, {
        verdict: "fail",
        findings: [{ ...finding, startLine: 9, endLine: 2 }],
        evidenceIds: [],
      });
      expect((await f.check("qa_failed_with_findings")).detail).toBe(
        "malformed qa_verdict payload",
      );
    });
  });

  describe("not_third_failed_round", () => {
    it("passes on the first and second failed rounds, fails on the third", async () => {
      const f = await fixture();
      expect((await f.check("not_third_failed_round")).pass).toBe(true);
      await f.counter("qa_round", 1);
      expect((await f.check("not_third_failed_round")).pass).toBe(true);
      await f.counter("qa_round", 2);
      expect((await f.check("not_third_failed_round")).pass).toBe(false);
    });
    it("fails when the cap setting is missing or not a number", async () => {
      const f = await fixture();
      await f.setting("qa_round_cap", "three");
      expect((await f.check("not_third_failed_round")).detail).toMatch(/not a number/);
    });
  });
});
