// Unit seam: option capture (N-70 point (3), O-88) on the memory store with the real contracts
// and guards, a fake screenshot port, the fixture's clock and ids, and synthetic PNGs. Covers the
// happy path (one `screenshot` per option of the item's feature and one `visual_approval`
// request for Didi), proven by running the readers on what was recorded: the approval form's
// options, the Council's visual call question and images, the `options_attached` guard and QA's
// visual comparison plan after Didi approves. Then repeats and supersedes, the switches, the
// D-279 refusal, other features' folders, a bad manifest, and the bounds on the option count.
// O-89: which refusals count one failure once per head and send the item back with the
// refusal's fixed text, and the CI run link on the request, only for a private repository.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodePng, pngCodec } from "../src/adapters/screenshots/png.ts";
import {
  createFakeRepoFolders,
  FAKE_WORKFLOW_RUN_ID,
} from "../src/adapters/screenshots/fake.ts";
import { approvalDecision, approvalFormEnums } from "../src/core/approvals.ts";
import { visualApprovalTopic } from "../src/core/guards/design.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { createLibrary } from "../src/core/library.ts";
import { createBuilderRuns } from "../src/core/builder-runs.ts";
import { captureRefusalKey } from "../src/core/failures.ts";
import {
  CAPTURE_REFUSAL_TEXT,
  ciRunLink,
  createOptionCaptures,
  DESIGNER_REFUSALS,
  featuresOf,
  MAX_CAPTURED_OPTIONS,
  visualApprovalQuestion,
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
  const captures = createOptionCaptures({
    ...f.deps,
    screenshots: c.screenshots,
    repoVisibility: c.visibility,
  });
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
        question: visualApprovalQuestion(
          `https://github.com/${REPO}/actions/runs/${FAKE_WORKFLOW_RUN_ID}`,
        ),
        options: ["a", "b"],
        captureCommitSha: HEAD,
      },
    });
    // The repository was confirmed private before the request linked CI's run (O-89).
    expect(c.visibility.reads).toEqual([REPO]);
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
      failureCount: { counted: true, failures: 1 },
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
      failureCount: { counted: true, failures: 1 },
    });
    await c.ciAt(HEAD, [], ["components/x/X.tsx"]);
    // The same head: counted once already (O-89).
    expect(await captures.capture(c.nodeId)).toMatchObject({
      reason: "no_option_folders",
      failureCount: { counted: "already_counted", failures: 1 },
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
      failureCount: { counted: true, failures: 1 },
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
      expect(text).not.toMatch(/design\/|\.png|[0-9a-f]{8}-|https?:|github\.com/);
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
      await createOptionCaptures({
        ...refusing.f.deps,
        screenshots: port,
        repoVisibility: refusing.c.visibility,
      }).capture(refusing.c.nodeId),
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

/** Puts the item's head into each refusal the Designer caused (O-89). */
const DESIGNER_CAUSED: Partial<
  Record<
    (typeof DESIGNER_REFUSALS)[number],
    (t: Awaited<ReturnType<typeof setup>>) => Promise<unknown>
  >
> = {
  screenshot_pipeline_changed: (t) =>
    t.c.ciAt(HEAD, ["a", "b"], ["scripts/render-screenshots.ts"]),
  no_option_folders: (t) => t.c.ciAt(HEAD, [], ["components/x/X.tsx"]),
  more_than_one_feature: (t) =>
    t.c.ciAt(HEAD, ["a", "b"], ["design/gallery/other-feature/options/c/index.html"]),
  too_few_options: async (t) => {
    await t.c.ciAt(HEAD, ["a"]);
    t.c.putOptions(["a"]);
  },
  too_many_options: async (t) => {
    const names = Array.from({ length: MAX_CAPTURED_OPTIONS + 1 }, (_, i) => `o${i}`);
    await t.c.ciAt(HEAD, names);
    t.c.putOptions(names);
  },
};

/** The Designer run's start, recorded as the dispatch records it, so a fix round can follow. */
const started = (t: Awaited<ReturnType<typeof setup>>, runId: string) =>
  t.f.evidence(
    t.c.nodeId,
    "dispatch_record",
    { repo: REPO, branch: `foreman/${t.c.nodeId}` },
    { runId },
  );

describe("capture refusals and the failure count (unit: memory store, O-89)", () => {
  it.each([...DESIGNER_REFUSALS])(
    "%s counts one failure once per head and sends the item back with the refusal's fixed text",
    async (reason) => {
      const t = await setup();
      await started(t, t.c.designerRun.id);
      const arrange = DESIGNER_CAUSED[reason];
      expect(arrange).toBeDefined();
      await arrange!(t);
      expect(await t.captures.capture(t.c.nodeId)).toMatchObject({
        step: "refused",
        reason,
        text: CAPTURE_REFUSAL_TEXT[reason],
        failureCount: { counted: true, failures: 1 },
      });
      // The reconcile pass asks again on the same head: nothing more is counted.
      expect(await t.captures.capture(t.c.nodeId)).toMatchObject({
        reason,
        failureCount: { counted: "already_counted", failures: 1 },
      });
      expect(await t.f.store.getCounter(t.c.nodeId, "failure")).toBe(1);
      const rows = await t.f.store.listEvidence({
        nodeId: t.c.nodeId,
        kind: "failure_count",
      });
      expect(rows).toEqual([
        expect.objectContaining({
          runId: t.c.designerRun.id,
          commitSha: HEAD,
          ref: captureRefusalKey(t.c.nodeId, HEAD),
          recordedBy: "runner",
          payload: {
            cause: "capture_refused",
            refusal: reason,
            failedGuards: ["options_attached"],
          },
        }),
      ]);
      // The same send-back path as a refused done report: a fix round is due on the same branch,
      // and its input says why with the refusal's fixed text.
      const builderRuns = createBuilderRuns(t.f.deps);
      expect(await builderRuns.check(t.c.nodeId)).toEqual({
        due: true,
        nodeId: t.c.nodeId,
        role: "designer",
        cause: "refused",
      });
      expect(await builderRuns.returnReason(t.c.nodeId)).toEqual({
        kind: "capture_refused",
        refusal: reason,
        text: CAPTURE_REFUSAL_TEXT[reason],
        commitSha: HEAD,
        earlier: null,
      });
      // Nothing is opened or recorded for Didi, and the item stays In design exploration.
      expect(await t.gates()).toEqual([]);
      expect(await t.shots()).toEqual([]);
      expect((await t.f.store.getNode(t.c.nodeId))?.state).toBe(
        "in_design_exploration",
      );
    },
  );

  it("a fix round that pushes nothing counts nothing more on the same head; a new head counts again", async () => {
    const t = await setup({ names: ["a"] });
    await started(t, t.c.designerRun.id);
    await t.captures.capture(t.c.nodeId);
    // The fix round's run ends on the same head.
    t.f.advanceMinutes(10);
    const again = await t.f.run(t.c.nodeId, "designer", 0, {
      endedAt: t.f.clock.now(),
      outcome: "success",
    });
    await started(t, again.id);
    expect(await t.captures.capture(t.c.nodeId)).toMatchObject({
      failureCount: { counted: "already_counted", failures: 1 },
    });
    expect(await createBuilderRuns(t.f.deps).check(t.c.nodeId)).toMatchObject({
      due: false,
      reason: "not_due",
    });
    // A new head with the same mistake is a new failure.
    t.f.advanceMinutes(1);
    await t.c.ciAt(NEXT, ["a"]);
    t.c.putOptions(["a"], { sha: NEXT });
    expect(await t.captures.capture(t.c.nodeId)).toMatchObject({
      reason: "too_few_options",
      failureCount: { counted: true, failures: 2 },
    });
    expect(await createBuilderRuns(t.f.deps).returnReason(t.c.nodeId)).toMatchObject({
      kind: "capture_refused",
      commitSha: NEXT,
    });
  });

  it("the third counted refusal escalates the item to the Council, as other Designer failures do", async () => {
    const t = await setup({ names: ["a"] });
    const heads = [HEAD, NEXT, BUILD];
    let last: unknown;
    for (const [i, sha] of heads.entries()) {
      if (i > 0) {
        t.f.advanceMinutes(1);
        await t.c.ciAt(sha, ["a"]);
        t.c.putOptions(["a"], { sha });
      }
      last = await t.captures.capture(t.c.nodeId);
    }
    expect(last).toMatchObject({
      failureCount: {
        counted: true,
        failures: 3,
        escalation: { outcome: "applied", toState: "escalated_to_council" },
      },
    });
    expect((await t.f.store.getNode(t.c.nodeId))?.state).toBe("escalated_to_council");
  });

  it("counts nothing for a refusal the Designer did not cause, or a wait", async () => {
    const cases: [
      string,
      (t: Awaited<ReturnType<typeof setup>>) => Promise<unknown>,
    ][] = [
      [
        "changed_paths_unknown",
        (t) =>
          t.f.evidence(
            t.c.nodeId,
            "ci_run",
            { conclusion: "success", pr: 7 },
            { commitSha: HEAD },
          ),
      ],
      [
        "bundle_invalid",
        async (t) =>
          t.c.screenshots.put(REPO, HEAD, "options", {
            manifest: { foremanScreenshots: 1, kind: "options", commit: NEXT },
            files: new Map(),
          }),
      ],
      [
        "option_file_changed",
        async (t) => {
          const bundle = await t.c.screenshots.read(REPO, HEAD, "options");
          t.c.screenshots.put(REPO, HEAD, "options", {
            manifest: bundle!.manifest,
            files: new Map(),
          });
        },
      ],
      ["no_private_link", async (t) => t.c.visibility.set(REPO, "public")],
      [
        // CI has not rendered the head yet: a wait, not a refusal.
        "bundle_missing",
        async () => undefined,
      ],
    ];
    for (const [expected, arrange] of cases) {
      const t = await setup({ bundle: expected !== "bundle_missing" });
      await arrange(t);
      const step = await t.captures.capture(t.c.nodeId);
      expect(step).toMatchObject(
        expected === "bundle_missing" ? { step: expected } : { reason: expected },
      );
      expect(step).not.toHaveProperty("failureCount");
      expect(await t.f.store.getCounter(t.c.nodeId, "failure")).toBe(0);
      expect(
        await t.f.store.listEvidence({ nodeId: t.c.nodeId, kind: "failure_count" }),
      ).toEqual([]);
    }
    // The port refusing (no runner App yet, or GitHub failing) is not the Designer's either.
    const unreadable = await setup();
    const step = await createOptionCaptures({
      ...unreadable.f.deps,
      screenshots: {
        read: async () => {
          throw new Error("not built");
        },
      },
      repoVisibility: unreadable.c.visibility,
    }).capture(unreadable.c.nodeId);
    expect(step).toEqual({
      nodeId: unreadable.c.nodeId,
      step: "refused",
      reason: "bundle_unreadable",
      text: CAPTURE_REFUSAL_TEXT.bundle_unreadable,
    });
    expect(await unreadable.f.store.getCounter(unreadable.c.nodeId, "failure")).toBe(0);
  });

  it("counts nothing for a Designer-caused refusal in dry run or under the kill switch", async () => {
    for (const [key, value] of [
      ["dry_run", true],
      ["kill_switch", true],
    ] as const) {
      const t = await setup({ names: ["a"] });
      await t.f.setting(key, value);
      expect(await t.captures.capture(t.c.nodeId)).toEqual({
        nodeId: t.c.nodeId,
        step: key,
      });
      expect(await t.f.store.getCounter(t.c.nodeId, "failure")).toBe(0);
    }
  });
});

describe("the CI run link on the visual-approval request (unit: memory store, O-89)", () => {
  it("carries the run id from the bundle read into the link, for a private repository", async () => {
    const t = await setup({ bundle: false });
    t.c.putOptions(["a", "b"]);
    const read = await t.c.screenshots.read(REPO, HEAD, "options");
    t.c.screenshots.put(REPO, HEAD, "options", {
      manifest: read!.manifest,
      files: new Map(
        ["a", "b"].map((o) => [
          `pages/${FEATURE}/options/${o}.png`,
          t.c.pages.get(o) as Uint8Array,
        ]),
      ),
      workflowRunId: 987654321,
    });
    expect(await t.captures.capture(t.c.nodeId)).toMatchObject({ step: "opened" });
    const [gate] = await t.gates();
    expect((gate!.payload as { question: string }).question).toBe(
      visualApprovalQuestion(`https://github.com/${REPO}/actions/runs/987654321`),
    );
  });

  it("refuses a run id that is not a positive safe integer, asking nothing and opening nothing", async () => {
    for (const id of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      const t = await setup();
      const read = await t.c.screenshots.read(REPO, HEAD, "options");
      t.c.screenshots.put(REPO, HEAD, "options", {
        manifest: read!.manifest,
        files: new Map(
          ["a", "b"].map((o) => [
            `pages/${FEATURE}/options/${o}.png`,
            t.c.pages.get(o) as Uint8Array,
          ]),
        ),
        workflowRunId: id,
      });
      expect(await t.captures.capture(t.c.nodeId)).toEqual({
        nodeId: t.c.nodeId,
        step: "refused",
        reason: "bundle_unreadable",
        text: CAPTURE_REFUSAL_TEXT.bundle_unreadable,
      });
      expect(t.c.visibility.reads).toEqual([]);
      expect(await t.gates()).toEqual([]);
      expect(await t.shots()).toEqual([]);
    }
  });

  it("builds the link only from a valid repository name and run id", () => {
    expect(ciRunLink(REPO, 12)).toBe(`https://github.com/${REPO}/actions/runs/12`);
    for (const repo of ["../x", "a/b/c", "a b/c", "", "a/b?x=1"]) {
      expect(ciRunLink(repo, 12)).toBe(null);
    }
    for (const id of ["12", 0, -1, 2.5, null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(ciRunLink(REPO, id)).toBe(null);
    }
  });

  it("fails closed on a public repository or a failed visibility check: refuses, records nothing, opens nothing", async () => {
    for (const answer of ["public", "fail"] as const) {
      const t = await setup();
      t.c.visibility.set(REPO, answer);
      const step = await t.captures.capture(t.c.nodeId);
      expect(step).toEqual({
        nodeId: t.c.nodeId,
        step: "refused",
        reason: "no_private_link",
        text: CAPTURE_REFUSAL_TEXT.no_private_link,
      });
      expect(JSON.stringify(step)).not.toMatch(/https?:|actions\/runs/);
      expect(t.c.visibility.reads).toEqual([REPO]);
      expect(await t.gates()).toEqual([]);
      expect(await t.shots()).toEqual([]);
      expect(await t.f.store.getCounter(t.c.nodeId, "failure")).toBe(0);
    }
  });

  it("puts the link only on the request: not in the step, the evidence or the Designer's input", async () => {
    const t = await setup();
    const step = await t.captures.capture(t.c.nodeId);
    expect(JSON.stringify(step)).not.toMatch(/https?:|actions\/runs/);
    expect(JSON.stringify(await t.shots())).not.toMatch(/https?:|actions\/runs/);
    expect(
      JSON.stringify(await createBuilderRuns(t.f.deps).returnReason(t.c.nodeId)),
    ).not.toMatch(/https?:/);
  });
});
