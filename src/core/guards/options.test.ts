// Seam: unit, the design merge's option folder check (D-258) on the memory store with the real
// guard registry, and how QA's fail guard, the done report's guard and the escalation read
// leftover folders (D-259). The merge moves themselves are in test/merge.test.ts and
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

describe("leftover option folders as a QA fail (unit: guards on the memory store, D-259)", () => {
  const FAIL = "qa_failed_with_findings";
  const DONE = "no_failed_qa_verdict_on_head";
  const ESCALATE = "escalation_trigger_met";
  const LEFT = [
    `${folder("a")}/index.html`,
    `${folder("c")}/x.css`,
    `${folder("b")}/p.html`,
  ];

  /** QA's run on the head, ended with `outcome` at the fixture's next moment. */
  async function qaReported(f: Fixture, outcome: "success" | "fail"): Promise<void> {
    const runId = await f.run("qa", "model-b");
    const run = await f.store.getRun(runId);
    await f.store.endRun(runId, {
      endedAt: run?.startedAt ?? new Date(0),
      outcome,
      turns: 1,
      minutes: 1,
      costUsd: null,
      tokens: null,
      transcriptRef: null,
      usageExhaustedCause: null,
      retryAfterSeconds: null,
      serviceTierServed: null,
      capacityRetries: null,
      capacityWaitSeconds: null,
      firstTokenMs: null,
      reportedCostUsd: null,
    });
  }

  /** A design item In QA review whose head PR keeps options b and c, and QA's run on that head. */
  async function leftover(qaOutcome: "success" | "fail" | null = "success") {
    const f = await fixture({ track: "design" });
    await approve(f, "a");
    await f.ci(HEAD, "success", LEFT);
    if (qaOutcome !== null) {
      await qaReported(f, qaOutcome);
    }
    return f;
  }

  it("passes QA's fail guard once QA reported on a head whose PR keeps unpicked folders", async () => {
    const f = await leftover();
    expect(await f.check(FAIL)).toMatchObject({
      pass: true,
      detail: `option folders Didi did not approve are still in the PR on head ${HEAD}: 2 folder(s)`,
    });
    expect((await f.check(GUARD)).pass).toBe(false);
  });

  it("refuses a done report on that head, and not on a new head with the folders deleted", async () => {
    const f = await leftover();
    await f.enterState("building_components");
    expect(await f.check(DONE)).toMatchObject({
      pass: false,
      detail: `QA failed head ${HEAD}: it goes back to QA only as a new commit`,
    });
    await f.ci(OLD, "success", [`${folder("a")}/index.html`, SPEC]);
    expect((await f.check(DONE)).pass).toBe(true);
  });

  it("does not pass before QA reported on the head, or when QA's run did not end success", async () => {
    for (const outcome of [null, "fail"] as const) {
      const f = await leftover(outcome);
      expect((await f.check(FAIL)).pass, String(outcome)).toBe(false);
      expect((await f.check(DONE)).pass, String(outcome)).toBe(true);
    }
  });

  it("does not pass when the check fails closed for missing data: nothing for the Designer to fix", async () => {
    // No changed paths on the head.
    const noPaths = await fixture({ track: "design" });
    await approve(noPaths, "a");
    await noPaths.evidence("ci_run", HEAD, { conclusion: "success", pr: 7 });
    // Option folders but no approved option's folder recorded.
    const noApproval = await fixture({ track: "design" });
    await noApproval.ci(HEAD, "success", LEFT);
    // No ci_run at all.
    const noHead = await fixture({ track: "design" });
    for (const f of [noPaths, noApproval, noHead]) {
      await qaReported(f, "success");
      expect((await f.check(GUARD)).pass).toBe(false);
      expect((await f.check(FAIL)).pass).toBe(false);
    }
  });

  it("does not pass with only the approved option's folder, nor on the code track", async () => {
    const clean = await fixture({ track: "design" });
    await approve(clean, "a");
    await clean.ci(HEAD, "success", [`${folder("a")}/index.html`]);
    await qaReported(clean, "success");
    expect((await clean.check(FAIL)).pass).toBe(false);

    const code = await fixture({ track: "code" });
    await approve(code, "a");
    await code.ci(HEAD, "success", LEFT);
    await qaReported(code, "success");
    expect((await code.check(FAIL)).pass).toBe(false);
    expect((await code.check(DONE)).pass).toBe(true);
  });

  it("meets the escalation trigger on the round that reaches the cap, only for a report in the current state", async () => {
    const f = await leftover();
    await f.counter("qa_round", 1);
    expect((await f.check(ESCALATE)).pass).toBe(false);
    await f.counter("qa_round", 2);
    expect(await f.check(ESCALATE)).toMatchObject({
      pass: true,
      detail: "QA failed round 3, which reaches the cap of 3",
    });
    // Back in Building components on the same head, the report is from the state before.
    await f.enterState("building_components");
    expect((await f.check(ESCALATE)).pass).toBe(false);
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
