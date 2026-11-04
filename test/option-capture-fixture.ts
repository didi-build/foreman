// Test support for option capture (O-88): a design item In design exploration on the reconcile
// fixture, its Designer run ended `success`, CI's run at the PR head with the PR's changed paths
// (the item's option folders, so the screenshot pipeline check of D-279 trusts it), and a helper
// that puts CI's `options` bundle at a commit in a fake port, with one more option of another
// feature next to the item's, and a fake visibility port that answers private unless the test
// says otherwise (O-89). Option `a` is the page the visual comparison fixture uses (a blue
// button marked as `example-button`), so a comparison can be planned from what capture records.
// Synthetic images only.
import { createHash } from "node:crypto";

import {
  createFakeRepoVisibility,
  createFakeScreenshotBundles,
  type FakeRepoVisibility,
  type FakeScreenshotBundles,
} from "../src/adapters/screenshots/fake.ts";
import { encodePng } from "../src/adapters/screenshots/png.ts";
import type { Run } from "../src/core/store.ts";
import type { OptionShot } from "../src/core/visual-comparison.ts";
import { paintBox, solidRaster } from "../src/core/visual-diff.ts";
import { HEAD, REPO, type ReconcileFixture } from "./reconcile-fixture.ts";

/** The item's feature folder, as the visual comparison fixture names it. */
export const FEATURE = "design/gallery/example-button";
/** Another feature's option folder, which capture ignores. */
export const OTHER_OPTION_PATH = "design/gallery/other-feature/options/c";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Option `a`: a 300x200 page with a blue button at (40, 50), marked as `example-button`. */
function pageA(): Uint8Array {
  return encodePng(
    paintBox(
      paintBox(
        solidRaster(300, 200, [255, 255, 255, 255]),
        { x: 40, y: 50, width: 80, height: 30 },
        [20, 60, 200, 255],
      ),
      { x: 50, y: 62, width: 40, height: 6 },
      [30, 30, 30, 255],
    ),
  );
}

/** Any other option: a plain page of its own colour. */
const plainPage = (i: number): Uint8Array =>
  encodePng(solidRaster(120, 80, [40 + i * 20, 120, 160, 255]));

export interface CaptureSetup {
  screenshots: FakeScreenshotBundles;
  /** The repository visibility port: private unless set (O-89). */
  visibility: FakeRepoVisibility;
  nodeId: string;
  designerRun: Run;
  /** The PNG bytes of each option page of the item's feature, by name. */
  pages: Map<string, Uint8Array>;
  /**
   * Puts CI's `options` bundle at a commit (the head unless given), with the item's options of
   * these names and, unless `other` is false, another feature's option.
   */
  putOptions(names: string[], extra?: { sha?: string; other?: boolean }): void;
  /** Records CI's run at a commit with the PR's changed paths: these option folders' pages. */
  ciAt(sha: string, names: string[], extraPaths?: string[]): Promise<string>;
}

export async function setupCapture(
  f: ReconcileFixture,
  options: {
    names?: string[];
    screenshots?: FakeScreenshotBundles;
    visibility?: FakeRepoVisibility;
    /** Puts the bundle at the head now (true unless given). */
    bundle?: boolean;
    designerRun?: Partial<Run>;
  } = {},
): Promise<CaptureSetup> {
  const names = options.names ?? ["a", "b"];
  const screenshots = options.screenshots ?? createFakeScreenshotBundles();
  const visibility = options.visibility ?? createFakeRepoVisibility();
  const node = await f.node("in_design_exploration", {
    track: "design",
    ownerRole: "designer",
    title: "Example button",
  });
  const designerRun = await f.run(node.id, "designer", 30, {
    endedAt: f.clock.now(),
    outcome: "success",
    ...(options.designerRun ?? {}),
  });
  const pages = new Map<string, Uint8Array>();

  function putOptions(
    optionNames: string[],
    extra: { sha?: string; other?: boolean } = {},
  ) {
    const sha = extra.sha ?? HEAD;
    const files = new Map<string, Uint8Array>();
    const shots: OptionShot[] = optionNames.map((option, i) => {
      const png = option === "a" ? pageA() : plainPage(i);
      pages.set(option, png);
      const file = `pages/${FEATURE}/options/${option}.png`;
      files.set(file, png);
      return {
        option,
        path: `${FEATURE}/options/${option}`,
        file,
        sha256: sha256(png),
        width: option === "a" ? 300 : 120,
        height: option === "a" ? 200 : 80,
        regions:
          option === "a"
            ? [
                {
                  component: "example-button",
                  variant: null,
                  x: 30,
                  y: 40,
                  width: 100,
                  height: 50,
                },
              ]
            : [],
      };
    });
    if (extra.other !== false) {
      const png = plainPage(9);
      const file = `pages/${OTHER_OPTION_PATH}.png`;
      files.set(file, png);
      shots.push({
        option: "c",
        path: OTHER_OPTION_PATH,
        file,
        sha256: sha256(png),
        width: 120,
        height: 80,
        regions: [],
      });
    }
    screenshots.put(REPO, sha, "options", {
      manifest: { foremanScreenshots: 1, kind: "options", commit: sha, options: shots },
      files,
    });
  }

  const ciAt = (sha: string, optionNames: string[], extraPaths: string[] = []) =>
    f.evidence(
      node.id,
      "ci_run",
      {
        conclusion: "success",
        pr: 7,
        changedPaths: [
          ...optionNames.map((o) => `${FEATURE}/options/${o}/index.html`),
          ...extraPaths,
        ],
      },
      { commitSha: sha },
    );

  await ciAt(HEAD, names);
  if (options.bundle !== false) putOptions(names);
  return {
    screenshots,
    visibility,
    nodeId: node.id,
    designerRun,
    pages,
    putOptions,
    ciAt,
  };
}
