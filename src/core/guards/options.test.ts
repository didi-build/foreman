// Seam: unit, the design merge's option folder check (D-258) on the memory store with the real
// guard registry. The merge moves themselves are in test/merge.test.ts and
// test/contracts-consistency.test.ts.
import { describe, expect, it } from "vitest";

import { visualApprovalTopic } from "./design.ts";
import { MAX_NAMED_FOLDERS, optionFolderOf } from "./options.ts";
import { HEAD, NODE, OLD, fixture, type Fixture } from "./testing.ts";

const GUARD = "unpicked_options_removed";
const topic = visualApprovalTopic(NODE);
const FEATURE = "design/app/login";
const folder = (name: string) => `${FEATURE}/options/${name}`;

/** The runner's screenshot of an option and Didi's approval naming it, as recorded in the item. */
async function approve(f: Fixture, name: string): Promise<void> {
  await f.evidence("screenshot", OLD, {
    source: "option",
    option: name,
    path: folder(name),
    file: `${name}.png`,
    sha256: "0".repeat(64),
    width: 100,
    height: 100,
    regions: [],
  });
  await f.decision("approval", "didi", { topicKey: topic, option: name }, "");
}

const SPEC = `${FEATURE}/spec.md`;
const BUILT = "components/LoginForm.tsx";

describe("unpicked_options_removed (unit: guards on the memory store, D-258)", () => {
  it("passes with no option folder in the PR", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(HEAD, "success", [SPEC, BUILT]);
    const check = await f.check(GUARD);
    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/no option folder/);
  });

  it("passes with no option folder and no approved option", async () => {
    const f = await fixture({ track: "design" });
    await f.ci(HEAD, "success", [BUILT]);
    expect((await f.check(GUARD)).pass).toBe(true);
  });

  it("passes with only the approved option's folder present", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(HEAD, "success", [
      SPEC,
      `${folder("a")}/index.html`,
      `${folder("a")}/style.css`,
    ]);
    const check = await f.check(GUARD);
    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/only the approved option's folder/);
  });

  it("passes once the unpicked folders are deleted on a newer head", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(OLD, "success", [
      `${folder("a")}/index.html`,
      `${folder("b")}/index.html`,
    ]);
    expect((await f.check(GUARD)).pass).toBe(false);
    // The Designer deleted option b on the branch, so the PR's files no longer include it.
    await f.ci(HEAD, "success", [`${folder("a")}/index.html`, SPEC]);
    expect((await f.check(GUARD)).pass).toBe(true);
  });

  it("fails naming each unpicked folder still present, and not the approved one", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(HEAD, "success", [
      `${folder("a")}/index.html`,
      `${folder("c")}/index.html`,
      `${folder("b")}/index.html`,
      `${folder("b")}/style.css`,
      BUILT,
    ]);
    const check = await f.check(GUARD);
    expect(check.pass).toBe(false);
    expect(check.detail).toBe(
      `option folders Didi did not approve are still in the PR on head ${HEAD}: ${folder("b")}, ${folder("c")}`,
    );
    expect(check.detail).not.toContain(NODE);
  });

  it("fails on an option folder of another feature, and one Didi's request never listed", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(HEAD, "success", [
      `${folder("a")}/index.html`,
      "design/app/signup/options/a/index.html",
      `${folder("Stray_Name")}/index.html`,
    ]);
    const check = await f.check(GUARD);
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("design/app/signup/options/a");
    expect(check.detail).toContain(folder("Stray_Name"));
  });

  it("fails when option folders are present but no approved option is recorded", async () => {
    const f = await fixture({ track: "design" });
    await f.ci(HEAD, "success", [`${folder("a")}/index.html`]);
    const check = await f.check(GUARD);
    expect(check.pass).toBe(false);
    expect(check.detail).toMatch(/no approved option's folder is recorded/);
    expect(check.detail).toContain(folder("a"));
  });

  it("ignores a reversed approval: its folder is no longer allowed", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    const decisions = await f.store.listDecisionsForNode(NODE);
    await f.reverse(decisions[decisions.length - 1]?.id as string);
    await f.ci(HEAD, "success", [`${folder("a")}/index.html`]);
    expect((await f.check(GUARD)).pass).toBe(false);
  });

  it("names at most 20 folders and counts the rest", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    const many = Array.from({ length: MAX_NAMED_FOLDERS + 3 }, (_, i) => `x${i}`);
    await f.ci(
      HEAD,
      "success",
      many.map((n) => `${folder(n)}/index.html`),
    );
    const check = await f.check(GUARD);
    expect(check.pass).toBe(false);
    expect(check.detail).toMatch(/ and 3 more$/);
  });

  it("fails closed with no changed paths recorded on the head, or no head", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    expect((await f.check(GUARD)).detail).toMatch(/no linked pull request/);
    await f.evidence("ci_run", HEAD, { conclusion: "success", pr: 7 });
    const check = await f.check(GUARD);
    expect(check.pass).toBe(false);
    expect(check.detail).toMatch(/changed paths are not recorded/);
  });

  it("fails on a malformed ci_run payload", async () => {
    const f = await fixture({ track: "design" });
    await f.evidence("ci_run", HEAD, { conclusion: "maybe", pr: 7, changedPaths: [] });
    expect((await f.check(GUARD)).detail).toBe("malformed ci_run payload");
  });

  it("reads only the head: an older head's clean paths do not count", async () => {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(OLD, "success", [SPEC]);
    await f.ci(HEAD, "success", [`${folder("b")}/index.html`]);
    expect((await f.check(GUARD)).pass).toBe(false);
  });
});

describe("optionFolderOf (unit)", () => {
  it.each([
    ["design/app/login/options/a/index.html", "design/app/login/options/a"],
    ["design/app/login/options/a", "design/app/login/options/a"],
    ["design/app/login/options/a/img/x.png", "design/app/login/options/a"],
    ["design/x/options/b/page.html", "design/x/options/b"],
  ])("%s is in %s", (path, expected) => {
    expect(optionFolderOf(path)).toBe(expected);
  });

  it.each([
    "design/app/login/spec.md",
    "design/options/a/index.html",
    "design/app/login/options",
    "src/options/a/index.ts",
    "components/options/a.tsx",
  ])("%s is in no option folder", (path) => {
    expect(optionFolderOf(path)).toBeNull();
  });
});
