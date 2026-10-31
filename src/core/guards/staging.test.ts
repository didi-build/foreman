import { describe, expect, it } from "vitest";

import { HEAD, MERGE, OLD, fixture } from "./testing.ts";

describe("staging guards (unit: guards on the memory store, ADR 0105)", () => {
  for (const [name, passesWhen] of [
    ["staging_check_on_merge_commit", true],
    ["staging_check_failed", false],
  ] as const) {
    describe(name, () => {
      it(`passes when the staging check for the merge commit ${passesWhen ? "passed" : "failed"}`, async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, { pass: passesWhen });
        expect((await f.check(name)).pass).toBe(true);
      });
      it(`fails when it ${passesWhen ? "failed" : "passed"}`, async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, { pass: !passesWhen });
        expect((await f.check(name)).pass).toBe(false);
      });
      it("ignores a staging check for another commit (stale)", async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", OLD, { pass: passesWhen });
        expect((await f.check(name)).detail).toMatch(/no staging check/);
      });
      it("uses the latest merge commit", async () => {
        const f = await fixture();
        await f.evidence("merge_commit", OLD, { pr: 6 });
        await f.evidence("staging_check", OLD, { pass: passesWhen });
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        expect((await f.check(name)).pass).toBe(false);
      });
      it("fails with no merge commit (missing)", async () => {
        expect((await (await fixture()).check(name)).detail).toBe(
          "no merge commit recorded",
        );
      });
      it("is not satisfied by a preview check on the merge commit", async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("preview_check", MERGE, { pass: passesWhen });
        expect((await f.check(name)).pass).toBe(false);
      });
      it("fails on a malformed staging payload", async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, { pass: "yes" });
        expect((await f.check(name)).detail).toBe("malformed staging_check payload");
      });
    });
  }

  describe("a check on a served commit that contains the merge commit (D-225, O-39)", () => {
    const LATER = "d".repeat(40);
    for (const [name, pass] of [
      ["staging_check_on_merge_commit", true],
      ["staging_check_failed", false],
    ] as const) {
      it(`${name} passes on a later served commit the compare showed contains the merge commit`, async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, {
          pass,
          servedCommitSha: LATER,
          containment: "ahead",
          onMain: true,
          mainHeadSha: LATER,
        });
        const check = await f.check(name);
        expect(check.pass).toBe(true);
        expect(check.detail).toMatch(/which contains it and is on main/);
      });
      it(`${name} fails on a later served commit with no proof it is on main`, async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, {
          pass,
          servedCommitSha: LATER,
          containment: "ahead",
        });
        const check = await f.check(name);
        expect(check.pass).toBe(false);
        expect(check.detail).toMatch(/not shown to contain merge .* and be on main/);
      });
      it(`${name} fails when the served commit is not shown to contain the merge commit`, async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, {
          pass,
          servedCommitSha: LATER,
          containment: "identical",
        });
        const check = await f.check(name);
        expect(check.pass).toBe(false);
        expect(check.detail).toMatch(/not shown to contain merge/);
      });
      it(`${name} fails on a served commit without a containment (malformed)`, async () => {
        const f = await fixture();
        await f.evidence("merge_commit", MERGE, { pr: 7 });
        await f.evidence("staging_check", MERGE, { pass, servedCommitSha: LATER });
        expect((await f.check(name)).detail).toBe("malformed staging_check payload");
      });
    }
    it("accepts the merge commit itself as identical", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      await f.evidence("staging_check", MERGE, {
        pass: true,
        servedCommitSha: MERGE,
        containment: "identical",
      });
      expect((await f.check("staging_check_on_merge_commit")).pass).toBe(true);
    });
  });

  describe("a failed staging deploy covering the merge commit (D-225)", () => {
    const failed = { environment: "staging", deploymentId: 9, deployedSha: MERGE };
    it("passes staging_check_failed with no check recorded", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      const deploy = await f.evidence("staging_deploy_failed", MERGE, failed);
      const check = await f.check("staging_check_failed");
      expect(check.pass).toBe(true);
      expect(check.evidenceIds).toContain(deploy);
      expect(check.detail).toMatch(/staging deploy of .* failed for merge/);
    });
    it("fails staging_check_on_merge_commit, even with a passed check", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      await f.evidence("staging_check", MERGE, { pass: true });
      await f.evidence("staging_deploy_failed", MERGE, failed);
      expect((await f.check("staging_check_on_merge_commit")).pass).toBe(false);
    });
    it("counts a failed later deploy only with its proof that it is on main", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      const later = { ...failed, deployedSha: "d".repeat(40), containment: "ahead" };
      await f.evidence("staging_deploy_failed", MERGE, later);
      expect((await f.check("staging_check_failed")).pass).toBe(false);
      await f.evidence("staging_deploy_failed", MERGE, {
        ...later,
        onMain: true,
        mainHeadSha: "d".repeat(40),
      });
      expect((await f.check("staging_check_failed")).pass).toBe(true);
    });
    it("ignores a failed deploy recorded for another merge commit", async () => {
      const f = await fixture();
      await f.evidence("merge_commit", MERGE, { pr: 7 });
      await f.evidence("staging_deploy_failed", OLD, failed);
      expect((await f.check("staging_check_failed")).pass).toBe(false);
    });
  });

  it("does not treat the head commit as the merge commit", async () => {
    const f = await fixture();
    await f.ci(HEAD);
    await f.evidence("staging_check", HEAD, { pass: true });
    expect((await f.check("staging_check_on_merge_commit")).pass).toBe(false);
  });
});
