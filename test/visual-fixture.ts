// Test support for the visual comparison (D-242, D-250, D-281): a design item in In QA review on
// the reconcile fixture, with CI's runs at the option's commit and the head (with the PR's changed
// paths, for D-279), spec paths, Didi's approval naming option `a`, the runner's screenshot of
// that option, CI's options bundle at the option's commit and its gallery and `head-options`
// bundles at the head in a fake port, and the option folder's tree id, the same at both commits,
// in a fake repo folders port. Synthetic images only: a white page with a blue button and a dark
// label, drawn in code.
import { createHash } from "node:crypto";

import {
  createFakeRepoFolders,
  createFakeScreenshotBundles,
  type FakeRepoFolders,
  type FakeScreenshotBundles,
} from "../src/adapters/screenshots/fake.ts";
import { encodePng } from "../src/adapters/screenshots/png.ts";
import { visualApprovalTopic } from "../src/core/guards/design.ts";
import type { Run } from "../src/core/store.ts";
import {
  optionScreenshotPayload,
  type OptionRegion,
  type OptionShot,
} from "../src/core/visual-comparison.ts";
import { paintBox, solidRaster, type Raster } from "../src/core/visual-diff.ts";
import { HEAD, REPO, type ReconcileFixture } from "./reconcile-fixture.ts";

export const OPTION_COMMIT = "c".repeat(40);
export const OPTION_PATH = "design/gallery/example-button/options/a";
/** The option folder's git tree id, the same at the capture commit and the head. */
export const OPTION_TREE = "7".repeat(40);
export const SPEC_PATH = "design/gallery/example-button/spec.md";
/** What the item's PR changes at the head: a design item's usual files (D-279 reads them). */
export const HEAD_CHANGED_PATHS = [
  "components/example-button/ExampleButton.tsx",
  SPEC_PATH,
  "gallery/registry.ts",
  `${OPTION_PATH}/index.html`,
];
export const SPEC = [
  "# Example button",
  "",
  "## ExampleButton",
  "",
  "- The primary button is blue with a dark label.",
  "- The label is 40 pixels wide.",
  "",
  "## Notes",
  "",
  "Not about the button.",
].join("\n");

type Rgba = readonly [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];
const BLUE: Rgba = [20, 60, 200, 255];
const RED: Rgba = [200, 40, 40, 255];
const DARK: Rgba = [30, 30, 30, 255];

/** A button on a white background, drawn at an offset. */
export function buttonRaster(
  colour: Rgba = BLUE,
  width = 120,
  height = 60,
  at = 10,
): Raster {
  let r = solidRaster(width, height, WHITE);
  r = paintBox(r, { x: at, y: at, width: 80, height: 30 }, colour);
  return paintBox(r, { x: at + 10, y: at + 12, width: 40, height: 6 }, DARK);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface VisualSetup {
  screenshots: FakeScreenshotBundles;
  repoFolders: FakeRepoFolders;
  nodeId: string;
  designerRun: Run;
  /** Starts the QA visual run on the head, on a model other than the designer's by default. */
  visualRun(model?: string): Promise<Run>;
  /** Puts the head's gallery bundle, with a red button when `differs`. */
  putGallery(options?: { differs?: boolean; sha?: string }): void;
  /**
   * Puts the head's render of the approved option (`head-options`, D-281) and the option folder's
   * tree id at that head, unchanged unless `tree` says otherwise; `regions` replaces the marked
   * regions.
   */
  putHeadOption(options?: {
    sha?: string;
    tree?: string | null;
    regions?: OptionRegion[];
  }): void;
}

export async function setupVisual(
  f: ReconcileFixture,
  screenshots: FakeScreenshotBundles = createFakeScreenshotBundles(),
  repoFolders: FakeRepoFolders = createFakeRepoFolders(),
): Promise<VisualSetup> {
  const node = await f.node("in_qa_review", {
    track: "design",
    ownerRole: "qa",
    title: "Example button",
  });
  // CI's runs at the option's capture commit and at the head, with the PR's changed paths, so
  // the screenshot pipeline check (D-279) can read them.
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: [`${OPTION_PATH}/index.html`] },
    { commitSha: OPTION_COMMIT },
  );
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: HEAD_CHANGED_PATHS },
    { commitSha: HEAD },
  );
  await f.evidence(node.id, "spec_paths", {
    paths: [SPEC_PATH],
    components: ["example-button"],
    commits: [{ sha: "d".repeat(40), author: "foreman-designer[bot]" }],
    newFeatures: [],
    newFlows: [],
  });
  await f.store.insertDecision({
    id: f.deps.ids.next(),
    projectId: f.projectId,
    nodeId: node.id,
    kind: "approval",
    scope: { topicKey: visualApprovalTopic(node.id), outcome: "approved", option: "a" },
    textVerbatim: "Option a, please.",
    byActor: "didi",
    recordedAt: f.clock.now(),
  });

  // The option page: 300x200 with the button at (40, 50), marked as the component's region.
  const page = paintBox(
    paintBox(
      solidRaster(300, 200, WHITE),
      { x: 40, y: 50, width: 80, height: 30 },
      BLUE,
    ),
    { x: 50, y: 62, width: 40, height: 6 },
    DARK,
  );
  const pagePng = encodePng(page);
  const shot: OptionShot = {
    option: "a",
    path: OPTION_PATH,
    file: "options/a.png",
    sha256: sha256(pagePng),
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
  };
  screenshots.put(REPO, OPTION_COMMIT, "options", {
    manifest: {
      foremanScreenshots: 1,
      kind: "options",
      commit: OPTION_COMMIT,
      options: [shot],
    },
    files: new Map<string, Uint8Array>([[shot.file, pagePng]]),
  });
  await f.evidence(node.id, "screenshot", optionScreenshotPayload(shot), {
    commitSha: OPTION_COMMIT,
  });
  repoFolders.put(REPO, OPTION_COMMIT, OPTION_PATH, OPTION_TREE);

  // The same option page rendered again at the head, next to another feature's option of the
  // same name, which a `head-options` bundle may hold (unique by folder, D-281).
  function putHeadOption(
    options: { sha?: string; tree?: string | null; regions?: OptionRegion[] } = {},
  ) {
    const sha = options.sha ?? HEAD;
    const fresh: OptionShot = {
      ...shot,
      file: `pages/${OPTION_PATH}.png`,
      regions: options.regions ?? shot.regions,
    };
    const otherPng = encodePng(solidRaster(40, 30, RED));
    const other: OptionShot = {
      option: "a",
      path: "design/gallery/other-feature/options/a",
      file: "pages/design/gallery/other-feature/options/a.png",
      sha256: sha256(otherPng),
      width: 40,
      height: 30,
      regions: [],
    };
    screenshots.put(REPO, sha, "head-options", {
      manifest: {
        foremanScreenshots: 1,
        kind: "head-options",
        commit: sha,
        options: [other, fresh],
      },
      files: new Map<string, Uint8Array>([
        [other.file, otherPng],
        [fresh.file, pagePng],
      ]),
    });
    repoFolders.put(
      REPO,
      sha,
      OPTION_PATH,
      options.tree === undefined ? OPTION_TREE : options.tree,
    );
  }
  putHeadOption();

  function putGallery(options: { differs?: boolean; sha?: string } = {}) {
    const sha = options.sha ?? HEAD;
    const built = encodePng(buttonRaster(options.differs ? RED : BLUE));
    const spec = new TextEncoder().encode(SPEC);
    screenshots.put(REPO, sha, "gallery", {
      manifest: {
        foremanScreenshots: 1,
        kind: "gallery",
        commit: sha,
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
        specs: [
          { path: SPEC_PATH, file: "specs/example-button.md", sha256: sha256(spec) },
        ],
      },
      files: new Map<string, Uint8Array>([
        ["gallery/example-button--primary.png", built],
        ["specs/example-button.md", spec],
      ]),
    });
  }
  putGallery();

  const designerRun = await f.run(node.id, "designer", 30, {
    endedAt: f.clock.now(),
    outcome: "success",
  });
  return {
    screenshots,
    repoFolders,
    nodeId: node.id,
    designerRun,
    putGallery,
    putHeadOption,
    visualRun: (model = "claude-opus-5-5") =>
      f.run(node.id, "qa", 1, {
        model,
        headSha: HEAD,
        prNumber: 7,
        taskType: "qa:visual",
      }),
  };
}

/** An answer for the fixture's one pair. */
export const answer = (
  result: "match" | "differs" | "cannot_tell",
  extra: Record<string, unknown> = {},
) => ({
  components: [
    {
      component: "example-button",
      variant: "Primary",
      result,
      findings:
        result === "match"
          ? []
          : [
              {
                what: "The button is red, not blue.",
                specLine: "- The primary button is blue with a dark label.",
              },
            ],
    },
  ],
  ...extra,
});
