// Unit seam: the visual comparison (D-242, D-250) on the memory store, the real machine-2
// contracts and QA's real bot file schema, with CI's bundles in a fake port and synthetic PNGs.
// Covers the manifest check, the spec section, the plan and input, the answer's check, the
// outcome, and the record the runner writes, which the merge guard then reads.
import { describe, expect, it } from "vitest";

import { decodePng, pngCodec } from "../src/adapters/screenshots/png.ts";
import { qaVerdictIndependentOnHead } from "../src/core/guards/review.ts";
import {
  approvedOption,
  approvedOptionRecord,
  createVisualComparisons,
  readScreenshotManifest,
  readVisualAnswer,
  specSection,
  visualOutcome,
} from "../src/core/visual-comparison.ts";
import { createReconcileFixture, HEAD } from "./reconcile-fixture.ts";
import {
  answer,
  OPTION_COMMIT,
  OPTION_PATH,
  setupVisual,
  SPEC,
} from "./visual-fixture.ts";

async function setup() {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const v = await setupVisual(f);
  const visual = createVisualComparisons({
    ...f.deps,
    screenshots: v.screenshots,
    png: pngCodec,
  });
  return { f, v, visual };
}

const pairs = [{ component: "example-button", variant: "Primary" }];

describe("readScreenshotManifest", () => {
  const gallery = (extra: Record<string, unknown> = {}) => ({
    foremanScreenshots: 1,
    kind: "gallery",
    commit: HEAD,
    shots: [
      {
        component: "example-button",
        variant: "Primary",
        file: "gallery/a.png",
        sha256: "0".repeat(64),
        width: 10,
        height: 10,
        specPath: "design/gallery/example-button/spec.md",
      },
    ],
    specs: [],
    ...extra,
  });

  it("reads a gallery manifest for its commit", () => {
    expect(readScreenshotManifest(gallery(), HEAD, "gallery")).toMatchObject({
      manifest: { kind: "gallery", shots: [{ component: "example-button" }] },
    });
  });

  it("refuses another commit, another kind, an unknown field, a path out of the bundle and a duplicate", () => {
    expect(readScreenshotManifest(gallery(), "a".repeat(40), "gallery")).toEqual({
      problem: "the manifest names another commit",
    });
    expect(readScreenshotManifest(gallery(), HEAD, "options")).toHaveProperty(
      "problem",
    );
    expect(
      readScreenshotManifest(gallery({ extra: 1 }), HEAD, "gallery"),
    ).toHaveProperty("problem");
    const shot = (gallery().shots as Record<string, unknown>[])[0];
    expect(
      readScreenshotManifest(
        gallery({ shots: [{ ...shot, file: "../secret.png" }] }),
        HEAD,
        "gallery",
      ),
    ).toHaveProperty("problem");
    expect(
      readScreenshotManifest(gallery({ shots: [shot, shot] }), HEAD, "gallery"),
    ).toEqual({
      problem: "the manifest lists a component variant twice",
    });
  });

  it("refuses an option region outside its page and an option outside its options folder", () => {
    const options = (region: Record<string, unknown>, path = OPTION_PATH) => ({
      foremanScreenshots: 1,
      kind: "options",
      commit: OPTION_COMMIT,
      options: [
        {
          option: "a",
          path,
          file: "a.png",
          sha256: "0".repeat(64),
          width: 50,
          height: 50,
          regions: [region],
        },
      ],
    });
    const inside = {
      component: "example-button",
      variant: null,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    };
    expect(
      readScreenshotManifest(options(inside), OPTION_COMMIT, "options"),
    ).toHaveProperty("manifest");
    expect(
      readScreenshotManifest(options({ ...inside, x: 1 }), OPTION_COMMIT, "options"),
    ).toHaveProperty("problem");
    expect(
      readScreenshotManifest(
        options(inside, "design/gallery/example-button/options/b"),
        OPTION_COMMIT,
        "options",
      ),
    ).toHaveProperty("problem");
  });
});

describe("specSection", () => {
  it("takes the component's heading up to the next one at its level", () => {
    const section = specSection(SPEC, "example-button");
    expect(section.startsWith("## ExampleButton")).toBe(true);
    expect(section).toContain("40 pixels wide");
    expect(section).not.toContain("Not about the button");
  });

  it("gives the whole spec when no heading names the component", () => {
    expect(specSection(SPEC, "other-thing")).toContain("Not about the button");
  });
});

describe("readVisualAnswer and visualOutcome", () => {
  it("accepts one entry per pair and reads the outcome", () => {
    for (const [result, outcome] of [
      ["match", "match"],
      ["differs", "differs"],
      ["cannot_tell", "cannot_tell"],
    ] as const) {
      const read = readVisualAnswer(answer(result), pairs);
      if (!("answer" in read)) throw new Error(read.problem);
      expect(visualOutcome(read.answer)).toBe(outcome);
    }
  });

  it("is differs when any pair differs, and passes only when every pair matches", () => {
    const entry = (variant: string, result: string) => ({
      component: "example-button",
      variant,
      result,
      findings: result === "match" ? [] : [{ what: "x", specLine: "" }],
    });
    const two = [...pairs, { component: "example-button", variant: "Disabled" }];
    const read = (a: string, b: string) => {
      const r = readVisualAnswer(
        { components: [entry("Primary", a), entry("Disabled", b)] },
        two,
      );
      if (!("answer" in r)) throw new Error(r.problem);
      return visualOutcome(r.answer);
    };
    expect(read("match", "match")).toBe("match");
    expect(read("cannot_tell", "differs")).toBe("differs");
    expect(read("match", "cannot_tell")).toBe("cannot_tell");
  });

  it("refuses a missing pair, an extra pair, a match with findings and a differs without", () => {
    expect(readVisualAnswer({ components: [] }, pairs)).toEqual({
      problem: "the answer leaves out a compared pair",
    });
    const wrong = answer("match");
    (wrong.components[0] as { variant: string }).variant = "Other";
    expect(readVisualAnswer(wrong, pairs)).toHaveProperty("problem");
    const matchWithFindings = answer("differs");
    (matchWithFindings.components[0] as { result: string }).result = "match";
    expect(readVisualAnswer(matchWithFindings, pairs)).toHaveProperty("problem");
    const differsBare = answer("match");
    (differsBare.components[0] as { result: string }).result = "differs";
    expect(readVisualAnswer(differsBare, pairs)).toHaveProperty("problem");
  });

  it("refuses out-of-scope findings of the wrong shape (D-244)", () => {
    expect(
      readVisualAnswer(answer("match", { outOfScopeFindings: [{ title: "" }] }), pairs),
    ).toHaveProperty("problem");
  });
});

describe("the approved option", () => {
  it("is the option Didi's approval names, with its folder and capture commit", async () => {
    const { f, v } = await setup();
    expect(await approvedOption(f.store, v.nodeId)).toBe("a");
    expect(await approvedOptionRecord(f.store, v.nodeId)).toEqual({
      name: "a",
      path: OPTION_PATH,
      commitSha: OPTION_COMMIT,
    });
  });

  it("is null for an item whose approval names no option", async () => {
    const { f } = await setup();
    const other = await f.node("writing_spec", { track: "design" });
    expect(await approvedOptionRecord(f.store, other.id)).toBeNull();
  });
});

describe("the plan and the run's input", () => {
  it("crops the approved option to the component and locates no difference for a faithful build", async () => {
    const { v, visual } = await setup();
    const plan = await visual.plan(v.nodeId, HEAD);
    if (!plan.ready) throw new Error(plan.reason);
    expect(plan.option).toEqual({ name: "a", commitSha: OPTION_COMMIT });
    expect(plan.pairs).toHaveLength(1);
    expect(plan.pairs[0]).toMatchObject({
      component: "example-button",
      variant: "Primary",
      located: true,
    });
    expect(plan.pairs[0]?.summary?.changedPixels).toBe(0);
  });

  it("locates a planted colour change", async () => {
    const { v, visual } = await setup();
    v.putGallery({ differs: true });
    const plan = await visual.plan(v.nodeId, HEAD);
    if (!plan.ready) throw new Error(plan.reason);
    expect(plan.pairs[0]?.summary?.changedPixels).toBeGreaterThan(2000);
    expect(plan.pairs[0]?.summary?.regions).toHaveLength(1);
  });

  it("builds the input and images, approved then built, with the summary and the spec section", async () => {
    const { v, visual } = await setup();
    const task = await visual.taskFor(v.nodeId, HEAD);
    if ("refused" in task) throw new Error(task.refused);
    expect(task.images.map((i) => i.label)).toEqual([
      "Image 1: the approved option, component example-button, variant Primary",
      "Image 2: the built component at the head commit, component example-button, variant Primary",
    ]);
    expect(decodePng(task.images[0]?.png as Uint8Array).width).toBe(80);
    expect(task.input).toContain("## Pair 1 of 1");
    expect(task.input).toContain("no changed pixels");
    expect(task.input).toContain("> - The label is 40 pixels wide.");
    expect(task.outputSchema).toHaveProperty("properties.components");
  });

  it("refuses when the option file changed since it was captured, or a component was not captured", async () => {
    const { v, visual } = await setup();
    const bundle = await v.screenshots.read(
      "didi-build/rehearsal",
      OPTION_COMMIT,
      "options",
    );
    v.screenshots.put("didi-build/rehearsal", OPTION_COMMIT, "options", {
      manifest: bundle?.manifest,
      files: new Map([["options/a.png", new Uint8Array([1, 2, 3])]]),
    });
    expect(await visual.taskFor(v.nodeId, HEAD)).toEqual({
      refused: "option_file_changed",
    });

    const g = await setup();
    await g.f.evidence(g.v.nodeId, "spec_paths", {
      paths: ["design/gallery/example-button/spec.md"],
      components: ["example-button", "other-thing"],
      commits: [{ sha: "d".repeat(40), author: "foreman-designer[bot]" }],
      newFeatures: [],
      newFlows: [],
    });
    expect(await g.visual.taskFor(g.v.nodeId, HEAD)).toEqual({
      refused: "component_not_captured",
    });
  });

  it("refuses with no gallery bundle at the head and no approved option", async () => {
    const { f, v, visual } = await setup();
    expect(await visual.taskFor(v.nodeId, "e".repeat(40))).toEqual({
      refused: "gallery_bundle_missing",
    });
    const other = await f.node("in_qa_review", { track: "design" });
    await f.evidence(other.id, "spec_paths", {
      paths: ["design/x/y/spec.md"],
      components: ["example-button"],
      commits: [{ sha: "d".repeat(40), author: "foreman-designer[bot]" }],
      newFeatures: [],
      newFlows: [],
    });
    expect(await visual.taskFor(other.id, HEAD)).toEqual({
      refused: "no_approved_option",
    });
  });
});

describe("recordAnswer", () => {
  it("records a pass only when every component matches, once per run", async () => {
    const { f, v, visual } = await setup();
    const run = await v.visualRun();
    const first = await visual.recordAnswer(run.id, answer("match"));
    expect(first).toMatchObject({ recorded: true, pass: true, outcome: "match" });
    expect(await visual.recordAnswer(run.id, answer("differs"))).toMatchObject({
      recorded: "already_recorded",
      pass: true,
    });
    const rows = await f.store.listEvidence({
      nodeId: v.nodeId,
      kind: "visual_comparison",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commitSha: HEAD,
      runId: run.id,
      recordedBy: "runner",
    });
    expect(rows[0]?.payload).toMatchObject({
      pass: true,
      outcome: "match",
      option: "a",
      components: [
        {
          component: "example-button",
          variant: "Primary",
          result: "match",
          located: true,
        },
      ],
    });
  });

  it("records differs and cannot_tell as not passing, with the findings", async () => {
    for (const result of ["differs", "cannot_tell"] as const) {
      const { f, v, visual } = await setup();
      const run = await v.visualRun();
      expect(await visual.recordAnswer(run.id, answer(result))).toMatchObject({
        recorded: true,
        pass: false,
        outcome: result,
      });
      const [row] = await f.store.listEvidence({
        nodeId: v.nodeId,
        kind: "visual_comparison",
      });
      expect(row?.payload).toMatchObject({
        pass: false,
        components: [{ findings: [{ what: "The button is red, not blue." }] }],
      });
    }
  });

  it("refuses an answer that breaks the schema or the rules, and records nothing", async () => {
    const { f, v, visual } = await setup();
    const run = await v.visualRun();
    expect(await visual.recordAnswer(run.id, { components: "all fine" })).toMatchObject(
      {
        recorded: false,
        reason: "invalid",
      },
    );
    expect(await visual.recordAnswer(run.id, { components: [] })).toMatchObject({
      recorded: false,
      reason: "invalid",
      problem: "the answer leaves out a compared pair",
    });
    expect(
      await f.store.listEvidence({ nodeId: v.nodeId, kind: "visual_comparison" }),
    ).toEqual([]);
  });

  it("refuses a run on the designer's model (D-158) and a run that is not a visual one", async () => {
    const { f, v, visual } = await setup();
    const same = await v.visualRun(v.designerRun.model);
    expect(await visual.recordAnswer(same.id, answer("match"))).toEqual({
      recorded: false,
      reason: "not_independent",
    });
    const review = await f.run(v.nodeId, "qa", 1, { headSha: HEAD, prNumber: 7 });
    expect(await visual.recordAnswer(review.id, answer("match"))).toEqual({
      recorded: false,
      reason: "not_a_visual_run",
    });
    expect(
      await f.store.listEvidence({ nodeId: v.nodeId, kind: "visual_comparison" }),
    ).toEqual([]);
  });

  it("writes nothing in dry run", async () => {
    const { f, v, visual } = await setup();
    await f.setting("dry_run", true);
    const run = await v.visualRun();
    expect(await visual.recordAnswer(run.id, answer("match"))).toEqual({
      recorded: false,
      reason: "dry_run",
    });
  });

  it("gives the merge guard its passing visual comparison on the head, and a not-passing one blocks it", async () => {
    for (const [result, detail] of [
      ["match", /no QA verdict on head/],
      ["cannot_tell", /visual comparison failed on head/],
    ] as const) {
      const { f, v, visual } = await setup();
      await f.evidence(
        v.nodeId,
        "ci_run",
        { conclusion: "success", pr: 7 },
        { commitSha: HEAD },
      );
      await f.evidence(v.nodeId, "preview_check", { pass: true }, { commitSha: HEAD });
      const run = await v.visualRun();
      await visual.recordAnswer(run.id, answer(result));
      const node = await f.store.getNode(v.nodeId);
      if (!node) throw new Error("no node");
      const check = await qaVerdictIndependentOnHead({ store: f.store, node } as never);
      expect(check.pass).toBe(false);
      expect(check.detail).toMatch(detail);
    }
  });
});
