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

  it("does not treat the head commit as the merge commit", async () => {
    const f = await fixture();
    await f.ci(HEAD);
    await f.evidence("staging_check", HEAD, { pass: true });
    expect((await f.check("staging_check_on_merge_commit")).pass).toBe(false);
  });
});
