// Seam: unit, on the memory store with the real guards and bot files and a fake screenshot port.
// D-279 (settles N-72): CI's screenshot bundles from a pull request that changes the screenshot
// pipeline are never read. The visual comparison refuses to plan or run with a fixed reason, the
// Council's visual call refuses to start, a run that ends after such a change records nothing,
// and the merge guard names the reason, so the item stays In QA review and nothing passing is
// recorded. A PR that changes only a design item's usual files is read as before, and a commit
// whose changed paths are not recorded refuses (fails closed).
import { describe, expect, it } from "vitest";

import { pngCodec } from "../src/adapters/screenshots/png.ts";
import { createCouncil } from "../src/core/council.ts";
import { qaVerdictIndependentOnHead } from "../src/core/guards/review.ts";
import {
  isScreenshotPipelinePath,
  pipelineCheckOf,
  SCREENSHOT_PIPELINE_PATHS,
  SCREENSHOT_PIPELINE_REASON,
} from "../src/core/screenshot-pipeline.ts";
import { visualCallTopic } from "../src/core/visual-call.ts";
import { createVisualComparisons } from "../src/core/visual-comparison.ts";
import { createReconcileFixture, HEAD, REPO } from "./reconcile-fixture.ts";
import { CALL_OPTION_COMMIT, setupVisualCall } from "./visual-call-fixture.ts";
import {
  answer,
  HEAD_CHANGED_PATHS,
  OPTION_COMMIT,
  OPTION_PATH,
  setupVisual,
} from "./visual-fixture.ts";

/** One changed file for each listed entry: the file itself, or a file under a listed folder. */
const PIPELINE_FILES = SCREENSHOT_PIPELINE_PATHS.map((entry) =>
  entry.endsWith("/") ? `${entry}some/file.ts` : entry,
);

/** A design item's usual files: never pipeline paths. */
const DESIGN_FILES = [
  "components/example-button/ExampleButton.tsx",
  "components/example-button/example-button.css",
  "design/gallery/example-button/spec.md",
  "design/gallery/example-button/options/a/index.html",
  "gallery/registry.ts",
];

async function setup() {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const v = await setupVisual(f);
  const visual = createVisualComparisons({
    ...f.deps,
    screenshots: v.screenshots,
    png: pngCodec,
  });
  const ci = (changedPaths: string[] | undefined, commitSha = HEAD) =>
    f.evidence(
      v.nodeId,
      "ci_run",
      { conclusion: "success", pr: 7, ...(changedPaths ? { changedPaths } : {}) },
      { commitSha },
    );
  const comparisons = () =>
    f.store.listEvidence({ nodeId: v.nodeId, kind: "visual_comparison" });
  return { f, v, visual, ci, comparisons };
}

describe("the screenshot pipeline's paths (D-279)", () => {
  it("lists the render workflow, scripts and gallery render mode, and never a design item's files", () => {
    for (const path of [
      ".github/workflows/screenshots.yml",
      "scripts/render-screenshots.ts",
      "scripts/lib/screenshot-bundle.ts",
      "gallery/shot-mode.ts",
      "gallery/GalleryShot.tsx",
      "gallery/App.tsx",
    ]) {
      expect(isScreenshotPipelinePath(path), path).toBe(true);
    }
    for (const path of [...DESIGN_FILES, "components/x.tsx", "design/a/b/spec.md"]) {
      expect(isScreenshotPipelinePath(path), path).toBe(false);
    }
    // A folder entry covers what is under it, and a file entry only that file.
    expect(isScreenshotPipelinePath(".github/workflows/other.yml")).toBe(true);
    expect(isScreenshotPipelinePath("scripts/render-screenshots.ts.bak")).toBe(false);
    expect(isScreenshotPipelinePath("gallery/App.tsx/x")).toBe(false);
  });

  it("fails closed when the changed paths are not recorded", () => {
    expect(pipelineCheckOf(undefined)).toEqual({
      trusted: false,
      reason: "changed_paths_unknown",
    });
    expect(pipelineCheckOf([])).toEqual({ trusted: true });
  });
});

describe("the visual comparison on a PR that changes the screenshot pipeline (D-279)", () => {
  it("refuses each listed path at the head with the fixed reason, reading no bundle", async () => {
    for (const path of PIPELINE_FILES) {
      const { v, visual, ci } = await setup();
      await ci([...HEAD_CHANGED_PATHS, path]);
      expect(await visual.taskFor(v.nodeId, HEAD), path).toEqual({
        refused: "screenshot_pipeline_changed",
      });
      expect(v.screenshots.reads, path).toEqual([]);
    }
  });

  it("plans as before when the PR changes only components/, design/ or gallery/registry.ts", async () => {
    const { v, visual, ci } = await setup();
    await ci(DESIGN_FILES);
    const task = await visual.taskFor(v.nodeId, HEAD);
    expect("refused" in task ? task.refused : null).toBeNull();
  });

  it("refuses when the head's CI run has no changed paths, or there is no CI run on the head", async () => {
    const { v, visual, ci } = await setup();
    await ci(undefined);
    expect(await visual.taskFor(v.nodeId, HEAD)).toEqual({
      refused: "changed_paths_unknown",
    });
    expect(await visual.taskFor(v.nodeId, "e".repeat(40))).toEqual({
      refused: "changed_paths_unknown",
    });
    expect(v.screenshots.reads).toEqual([]);
  });

  it("refuses when the PR changed the pipeline at the approved option's capture commit", async () => {
    const { v, visual, ci } = await setup();
    await ci(
      [`${OPTION_PATH}/index.html`, "scripts/render-screenshots.ts"],
      OPTION_COMMIT,
    );
    expect(await visual.taskFor(v.nodeId, HEAD)).toEqual({
      refused: "screenshot_pipeline_changed",
    });
    expect(v.screenshots.reads).toEqual([]);
    const missing = await setup();
    await missing.ci(undefined, OPTION_COMMIT);
    expect(await missing.visual.taskFor(missing.v.nodeId, HEAD)).toEqual({
      refused: "changed_paths_unknown",
    });
  });

  it("records nothing when the run ends after the PR changed the pipeline, and the merge guard names the reason", async () => {
    const { f, v, visual, ci, comparisons } = await setup();
    const run = await v.visualRun();
    await ci([...HEAD_CHANGED_PATHS, ".github/workflows/screenshots.yml"]);
    expect(await visual.recordAnswer(run.id, answer("match"))).toEqual({
      recorded: false,
      reason: "plan_unavailable",
      planRefusal: "screenshot_pipeline_changed",
    });
    expect(await comparisons()).toEqual([]);
    await f.evidence(v.nodeId, "preview_check", { pass: true }, { commitSha: HEAD });
    const node = await f.store.getNode(v.nodeId);
    const check = await qaVerdictIndependentOnHead({ store: f.store, node } as never);
    expect(check.pass).toBe(false);
    expect(check.detail).toBe(
      `no visual comparison on head ${HEAD}: ${SCREENSHOT_PIPELINE_REASON}`,
    );
    // The item is not sent anywhere: it stays In QA review.
    expect((await f.store.getNode(v.nodeId))?.state).toBe("in_qa_review");
  });

  it("leaves the merge guard's detail as before on a PR that does not change the pipeline", async () => {
    const { f, v } = await setup();
    await f.evidence(v.nodeId, "preview_check", { pass: true }, { commitSha: HEAD });
    const node = await f.store.getNode(v.nodeId);
    const check = await qaVerdictIndependentOnHead({ store: f.store, node } as never);
    expect(check.detail).toBe(`no visual comparison on head ${HEAD}`);
  });
});

describe("the Council's visual call on options from such a PR (D-279)", () => {
  async function callSetup() {
    const f = await createReconcileFixture();
    await f.setting("dry_run", false);
    const v = await setupVisualCall(f);
    const council = createCouncil({ ...f.deps, screenshots: v.screenshots });
    const ci = (changedPaths: string[] | undefined) =>
      f.evidence(
        v.nodeId,
        "ci_run",
        { conclusion: "success", pr: 7, ...(changedPaths ? { changedPaths } : {}) },
        { commitSha: CALL_OPTION_COMMIT },
      );
    return { f, v, council, ci, topic: visualCallTopic(v.nodeId) };
  }

  it("refuses each listed path at the capture commit, reading no bundle and recording nothing", async () => {
    for (const path of PIPELINE_FILES) {
      const { f, v, council, ci, topic } = await callSetup();
      await ci(["design/gallery/example-button/options/a/index.html", path]);
      expect(await council.taskFor(topic), path).toMatchObject({
        refused: "screenshot_pipeline_changed",
      });
      expect(v.screenshots.reads, path).toEqual([]);
      expect(
        (await f.store.listDecisionsForNode(v.nodeId)).filter(
          (d) => d.kind === "council_decision",
        ),
      ).toEqual([]);
    }
  });

  it("starts as before on options from a PR that changes only design files, and refuses with no changed paths", async () => {
    const ok = await callSetup();
    await ok.ci(DESIGN_FILES);
    expect(await ok.council.taskFor(ok.topic)).toMatchObject({
      taskType: "council:visual",
    });
    expect(ok.v.screenshots.reads).toEqual([`${REPO}@${CALL_OPTION_COMMIT}:options`]);
    const missing = await callSetup();
    await missing.ci(undefined);
    expect(await missing.council.taskFor(missing.topic)).toMatchObject({
      refused: "changed_paths_unknown",
    });
  });
});
