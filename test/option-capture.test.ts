// Unit seam: option capture (N-70 point (3), O-88) on the memory store with the real contracts
// and guards, a fake screenshot port, the fixture's clock and ids, and synthetic PNGs. Covers the
// happy path (one `screenshot` per option of the item's feature and one `visual_approval`
// request for Didi), proven by running the readers on what was recorded: the approval form's
// options, the Council's visual call question and images, the `options_attached` guard and QA's
// visual comparison plan after Didi approves. Then repeats and supersedes, the switches, the
// D-279 refusal, other features' folders, a bad manifest, and the bounds on the option count.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodePng, pngCodec } from "../src/adapters/screenshots/png.ts";
import { createFakeRepoFolders } from "../src/adapters/screenshots/fake.ts";
import { approvalDecision, approvalFormEnums } from "../src/core/approvals.ts";
import { visualApprovalTopic } from "../src/core/guards/design.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { createLibrary } from "../src/core/library.ts";
import {
  CAPTURE_REFUSAL_TEXT,
  createOptionCaptures,
  featuresOf,
  MAX_CAPTURED_OPTIONS,
  VISUAL_APPROVAL_QUESTION,
} from "../src/core/option-capture.ts";
import { SCREENSHOT_PIPELINE_REASON } from "../src/core/screenshot-pipeline.ts";
import { visualCallImages, visualCallRequest } from "../src/core/visual-call.ts";
import {
  approvedOptionRecord,
  createVisualComparisons,
  readOptionScreenshot,
} from "../src/core/visual-comparison.ts";
import { createReconcileFixture, HEAD, REPO } from "./reconcile-fixture.ts";
import { FEATURE, setupCapture } from "./option-capture-fixture.ts";
import {
  buttonRaster,
  OPTION_PATH,
  OPTION_TREE,
  SPEC,
  SPEC_PATH,
} from "./visual-fixture.ts";

const NEXT = "d".repeat(40);
const BUILD = "e".repeat(40);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function setup(options: Parameters<typeof setupCapture>[1] = {}) {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const c = await setupCapture(f, options);
  const captures = createOptionCaptures({ ...f.deps, screenshots: c.screenshots });
  const gates = () =>
    f.store.listGateRequests(f.projectId, visualApprovalTopic(c.nodeId));
  const shots = () => f.store.listEvidence({ nodeId: c.nodeId, kind: "screenshot" });
  return { f, c, captures, gates, shots };
}

describe("featuresOf (unit)", () => {
  it("names the feature folder of each option folder a PR changes, once", () => {
    expect(
      featuresOf([
        `${FEATURE}/options/a/index.html`,
        `${FEATURE}/options/b/style.css`,
        "design/web/other/options/x/index.html",
        `${FEATURE}/spec.md`,
        "components/example-button/ExampleButton.tsx",
      ]),
    ).toEqual([FEATURE, "design/web/other"]);
    expect(featuresOf(["src/app.ts"])).toEqual([]);
  });
});

describe("option capture (unit: memory store, fake screenshot port, O-88)", () => {
  it("records one screenshot per option and opens one visual-approval request for Didi", async () => {
    const { f, c, captures, gates, shots } = await setup();
    const step = await captures.capture(c.nodeId);
    expect(step).toMatchObject({
      step: "opened",
      supersededId: null,
      headSha: HEAD,
      options: ["a", "b"],
      designerRunId: c.designerRun.id,
    });

    const recorded = await shots();
    expect(recorded.map((e) => [e.commitSha, e.recordedBy, e.runId])).toEqual([
      [HEAD, "runner", c.designerRun.id],
      [HEAD, "runner", c.designerRun.id],
    ]);
    expect(recorded.map((e) => readOptionScreenshot(e.payload))).toEqual([
      expect.objectContaining({
        source: "option",
        option: "a",
        path: OPTION_PATH,
        sha256: sha256(c.pages.get("a") as Uint8Array),
        width: 300,
        height: 200,
        regions: [expect.objectContaining({ component: "example-button" })],
      }),
      expect.objectContaining({ option: "b", path: `${FEATURE}/options/b` }),
    ]);

    const [gate] = await gates();
    expect(gate).toMatchObject({
      kind: "visual_approval",
      owner: "didi",
      blocking: true,
      status: "open",
      nodeId: c.nodeId,
      topicKey: visualApprovalTopic(c.nodeId),
      payload: {
        question: VISUAL_APPROVAL_QUESTION,
        options: ["a", "b"],
        captureCommitSha: HEAD,
      },
    });
    // The approval form's Options field shows exactly these (D-254).
    expect(approvalFormEnums(gate!)).toEqual({ options: ["a", "b"] });
    // The move into Waiting for Didi now finds its evidence.
    const node = (await f.store.getNode(c.nodeId))!;
    expect(
      (await GUARDS.options_attached!({ node, store: f.store } as never)).pass,
    ).toBe(true);
    // Only the item's own bundle was read, at its head.
    expect(c.screenshots.reads).toEqual([`${REPO}@${HEAD}:options`]);
  });

  it("records what the Council's visual call reads: its question and one checked image per option", async () => {
    const { f, c, captures, gates } = await setup();
    await captures.capture(c.nodeId);
    const [gate] = await gates();
    const question = visualCallRequest(gate!);
    expect(question).toMatchObject({
      kind: "visual_call",
      nodeId: c.nodeId,
      gateRequestId: gate!.id,
      options: ["a", "b"],
    });
    const images = await visualCallImages(f.store, c.screenshots, question!);
    expect(images).toEqual({
      images: [
        { label: "Image 1: option a", png: new Uint8Array(c.pages.get("a")!) },
        { label: "Image 2: option b", png: new Uint8Array(c.pages.get("b")!) },
      ],
    });
  });

  it("records what QA's visual comparison reads: after Didi approves option a, the plan at the build head is ready", async () => {
    const { f, c, captures, gates } = await setup();
    await captures.capture(c.nodeId);
    const [gate] = await gates();
    // Didi approves option a on the page (D-254), recorded as the approval step records it.
    await createLibrary(f.deps).answerGateRequest(
      gate!.id,
      approvalDecision(gate!, {
        choice: "approve",
        words: null,
        approvers: ["anonymous"],
        options: ["a"],
      }),
    );
    expect(await approvedOptionRecord(f.store, c.nodeId)).toEqual({
      name: "a",
      path: OPTION_PATH,
      commitSha: HEAD,
    });

    // The build head: the spec, the component, and CI's gallery and head-options bundles.
    await c.ciAt(
      BUILD,
      ["a"],
      [SPEC_PATH, "components/example-button/ExampleButton.tsx"],
    );
    await f.evidence(c.nodeId, "spec_paths", {
      paths: [SPEC_PATH],
      components: ["example-button"],
      commits: [{ sha: BUILD, author: "foreman-designer[bot]" }],
      newFeatures: [],
      newFlows: [],
    });
    const built = encodePng(buttonRaster());
    const spec = new TextEncoder().encode(SPEC);
    c.screenshots.put(REPO, BUILD, "gallery", {
      manifest: {
        foremanScreenshots: 1,
        kind: "gallery",
        commit: BUILD,
        shots: [
          {
            component: "example-button",
            variant: "Primary",
            file: "gallery/example-button--primary.png",
            sha256: sha256(built),
            width: 120,
            height: 60,
            specPath: SPEC_PATH,
          },
        ],
        specs: [{ path: SPEC_PATH, file: "specs/spec.md", sha256: sha256(spec) }],
      },
      files: new Map<string, Uint8Array>([
        ["gallery/example-button--primary.png", built],
        ["specs/spec.md", spec],
      ]),
    });
    const page = c.pages.get("a") as Uint8Array;
    c.screenshots.put(REPO, BUILD, "head-options", {
      manifest: {
        foremanScreenshots: 1,
        kind: "head-options",
        commit: BUILD,
        options: [
          {
            option: "a",
            path: OPTION_PATH,
            file: "pages/a.png",
            sha256: sha256(page),
            width: 300,
            height: 200,
            regions: [
              {
                component: "example-button",
                variant: null,
                x: 30,
                y: 40,
                width: 100,
                height: 50,
              },
            ],
          },
        ],
      },
      files: new Map<string, Uint8Array>([["pages/a.png", page]]),
    });
    const repoFolders = createFakeRepoFolders();
    repoFolders.put(REPO, HEAD, OPTION_PATH, OPTION_TREE);
    repoFolders.put(REPO, BUILD, OPTION_PATH, OPTION_TREE);
    const plan = await createVisualComparisons({
      ...f.deps,
      screenshots: c.screenshots,
      repoFolders,
      png: pngCodec,
    }).plan(c.nodeId, BUILD);
    expect(plan).toMatchObject({
      ready: true,
      headSha: BUILD,
      option: { name: "a", commitSha: HEAD },
      pairs: [{ component: "example-button", variant: "Primary", located: true }],
    });
  });

  it("opens nothing new for the same head, whatever the request's status", async () => {
    const { f, c, captures, gates, shots } = await setup();
    const first = await captures.capture(c.nodeId);
    expect(await captures.capture(c.nodeId)).toEqual({
      nodeId: c.nodeId,
      step: "already_captured",
      gateRequestId: (first as { gateRequestId: string }).gateRequestId,
      open: true,
      designerRunId: c.designerRun.id,
    });
    // Didi asked for changes: the answered request is not asked again on the same head.
    const [gate] = await gates();
    await createLibrary(f.deps).answerGateRequest(
      gate!.id,
      approvalDecision(gate!, {
        choice: "changes_requested",
        words: "Make b's button larger.",
        approvers: ["anonymous"],
        options: ["b"],
      }),
    );
    expect(await captures.capture(c.nodeId)).toMatchObject({
      step: "already_captured",
      open: false,
    });
    expect(await gates()).toHaveLength(1);
    expect(await shots()).toHaveLength(2);
    expect(c.screenshots.reads).toHaveLength(1);
  });

  it("supersedes the older open request when a newer head is captured", async () => {
    const { f, c, captures, gates, shots } = await setup();
    const first = (await captures.capture(c.nodeId)) as { gateRequestId: string };
    f.advanceMinutes(5);
    await c.ciAt(NEXT, ["a", "b", "c"]);
    c.putOptions(["a", "b", "c"], { sha: NEXT, other: false });
    const second = await captures.capture(c.nodeId);
    expect(second).toMatchObject({
      step: "opened",
      supersededId: first.gateRequestId,
      headSha: NEXT,
      options: ["a", "b", "c"],
    });
    const all = await gates();
    expect(all.map((g) => g.status)).toEqual(["superseded", "open"]);
    expect(all[0]!.supersededBy).toBe(all[1]!.id);
    // Append-only: the older screenshots stay; the readers take the latest per option.
    expect((await shots()).map((e) => e.commitSha)).toEqual([
      HEAD,
      HEAD,
      NEXT,
      NEXT,
      NEXT,
    ]);
    expect(
      await f.store.findOpenGateRequest(f.projectId, visualApprovalTopic(c.nodeId)),
    ).toMatchObject({ payload: { captureCommitSha: NEXT } });
  });

  it("writes nothing and reads no bundle under the kill switch or in dry run", async () => {
    for (const [key, value, step] of [
      ["kill_switch", true, "kill_switch"],
      ["dry_run", true, "dry_run"],
    ] as const) {
      const { f, c, captures, gates, shots } = await setup();
      await f.setting(key, value);
      expect(await captures.capture(c.nodeId)).toEqual({ nodeId: c.nodeId, step });
      expect(await gates()).toEqual([]);
      expect(await shots()).toEqual([]);
      expect(c.screenshots.reads).toEqual([]);
    }
  });

  it("refuses a PR that changes the screenshot pipeline before reading its bundle (D-279)", async () => {
    const { c, captures, gates, shots } = await setup();
    await c.ciAt(HEAD, ["a", "b"], ["scripts/render-screenshots.ts"]);
    const step = await captures.capture(c.nodeId);
    expect(step).toEqual({
      nodeId: c.nodeId,
      step: "refused",
      reason: "screenshot_pipeline_changed",
      text: SCREENSHOT_PIPELINE_REASON,
    });
    expect(c.screenshots.reads).toEqual([]);
    expect(await gates()).toEqual([]);
    expect(await shots()).toEqual([]);
  });

  it("refuses when the head's changed paths are not recorded", async () => {
    const { f, c, captures } = await setup();
    await f.evidence(
      c.nodeId,
      "ci_run",
      { conclusion: "success", pr: 7 },
      {
        commitSha: HEAD,
      },
    );
    expect(await captures.capture(c.nodeId)).toMatchObject({
      step: "refused",
      reason: "changed_paths_unknown",
    });
    expect(c.screenshots.reads).toEqual([]);
  });

  it("ignores another feature's option folder in the bundle", async () => {
    const { c, captures, shots } = await setup();
    expect(await captures.capture(c.nodeId)).toMatchObject({ options: ["a", "b"] });
    expect((await shots()).map((e) => readOptionScreenshot(e.payload)?.path)).toEqual([
      `${FEATURE}/options/a`,
      `${FEATURE}/options/b`,
    ]);
  });

  it("refuses a PR that changes the options of more than one feature, or of none", async () => {
    const { c, captures } = await setup();
    await c.ciAt(
      HEAD,
      ["a", "b"],
      ["design/gallery/other-feature/options/c/index.html"],
    );
    expect(await captures.capture(c.nodeId)).toEqual({
      nodeId: c.nodeId,
      step: "refused",
      reason: "more_than_one_feature",
      text: CAPTURE_REFUSAL_TEXT.more_than_one_feature,
    });
    await c.ciAt(HEAD, [], ["components/x/X.tsx"]);
    expect(await captures.capture(c.nodeId)).toMatchObject({
      reason: "no_option_folders",
    });
    expect(c.screenshots.reads).toEqual([]);
  });

  it("refuses a bad manifest and a file that does not match it, with fixed text", async () => {
    const { c, captures, gates } = await setup();
    c.screenshots.put(REPO, HEAD, "options", {
      manifest: { foremanScreenshots: 1, kind: "options", commit: NEXT, options: [] },
      files: new Map(),
    });
    expect(await captures.capture(c.nodeId)).toEqual({
      nodeId: c.nodeId,
      step: "refused",
      reason: "bundle_invalid",
      text: CAPTURE_REFUSAL_TEXT.bundle_invalid,
    });
    c.putOptions(["a", "b"]);
    const bundle = await c.screenshots.read(REPO, HEAD, "options");
    c.screenshots.put(REPO, HEAD, "options", {
      manifest: bundle!.manifest,
      files: new Map([[`pages/${FEATURE}/options/a.png`, new Uint8Array([1, 2, 3])]]),
    });
    expect(await captures.capture(c.nodeId)).toMatchObject({
      reason: "option_file_changed",
    });
    expect(await gates()).toEqual([]);
  });

  it("refuses one option, and more than the visual call can show", async () => {
    const one = await setup({ names: ["a"] });
    expect(await one.captures.capture(one.c.nodeId)).toEqual({
      nodeId: one.c.nodeId,
      step: "refused",
      reason: "too_few_options",
      text: CAPTURE_REFUSAL_TEXT.too_few_options,
    });
    expect(await one.gates()).toEqual([]);

    const names = Array.from({ length: MAX_CAPTURED_OPTIONS + 1 }, (_, i) => `o${i}`);
    const many = await setup({ names });
    expect(await many.captures.capture(many.c.nodeId)).toMatchObject({
      reason: "too_many_options",
    });
    expect(await many.shots()).toEqual([]);

    const max = await setup({ names: names.slice(0, MAX_CAPTURED_OPTIONS) });
    expect(await max.captures.capture(max.c.nodeId)).toMatchObject({
      step: "opened",
      options: names.slice(0, MAX_CAPTURED_OPTIONS),
    });
  });

  it("never quotes a path, a file or an id in a refusal", () => {
    for (const text of Object.values(CAPTURE_REFUSAL_TEXT)) {
      expect(text).not.toMatch(/design\/|\.png|[0-9a-f]{8}-/);
    }
  });

  it("waits for the Designer's report, the PR head and CI's bundle, writing nothing", async () => {
    const running = await setup({ designerRun: { endedAt: null, outcome: null } });
    expect(await running.captures.capture(running.c.nodeId)).toMatchObject({
      step: "designer_running",
    });
    const failed = await setup({ designerRun: { outcome: "fail" } });
    expect(await failed.captures.capture(failed.c.nodeId)).toMatchObject({
      step: "no_designer_report",
    });
    const early = await setup({ bundle: false });
    expect(await early.captures.capture(early.c.nodeId)).toMatchObject({
      step: "bundle_missing",
    });
    expect(await early.gates()).toEqual([]);
    // The port refuses until the runner App exists (D-178): a fixed refusal, nothing written.
    const refusing = await setup();
    const port = {
      read: async () => {
        throw new Error("not built");
      },
    };
    expect(
      await createOptionCaptures({ ...refusing.f.deps, screenshots: port }).capture(
        refusing.c.nodeId,
      ),
    ).toEqual({
      nodeId: refusing.c.nodeId,
      step: "refused",
      reason: "bundle_unreadable",
      text: CAPTURE_REFUSAL_TEXT.bundle_unreadable,
    });
  });

  it("captures only design items in exploration, and lists them as pending", async () => {
    const { f, c, captures } = await setup();
    const code = await f.node("in_development");
    const waiting = await f.node("waiting_for_didi", { track: "design" });
    expect(await captures.pending()).toEqual([c.nodeId]);
    expect(await captures.capture(code.id)).toMatchObject({ step: "not_exploring" });
    expect(await captures.capture(waiting.id)).toMatchObject({ step: "not_exploring" });
  });
});
