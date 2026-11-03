// The screenshot pipeline's paths (D-279, settles N-72). CI renders the screenshot bundles from
// the pull request's own checkout (.github/workflows/screenshots.yml), so a pull request that
// changes how the bundles are made could upload screenshots that do not show what its commit
// renders. The runner therefore refuses to read a bundle made at a commit whose pull request
// changes any of these paths: the visual comparison does not plan or run (./visual-comparison.ts),
// and the Council's visual call does not start (./visual-call.ts). Nothing is recorded, so no
// passing `visual_comparison` can come from such a bundle and the item stays In QA review.
//
// It reads the PR's changed files from the `ci_run` recorded for the bundle's commit, as
// `privileged_paths_approved` does (./guards/review.ts), and fails closed: no `ci_run` on that
// commit, a malformed one, or one without `changedPaths` refuses too.
//
// Why each path is listed is in docs/decision-log.md, O-82. Kept narrow on purpose: never
// `components/`, `design/` or `gallery/registry.ts`, which design items change normally.
//
// Plain logic over an injected store (D-162). Reasons are fixed text and never quote a path.
import { latest, readCiRun } from "./guards/evidence.ts";
import type { StoreOps } from "./store.ts";

/**
 * The paths that make the screenshot bundles. An entry ending in `/` is a folder and covers every
 * path under it; any other entry is one file.
 */
export const SCREENSHOT_PIPELINE_PATHS: readonly string[] = [
  // The Screenshots workflow, and every other workflow: the runner takes the newest artifact of
  // the bundle's name from any workflow run on the commit (D-276), so any workflow could upload one.
  ".github/workflows/",
  // The render script and its plain parts, which make all three bundles (the `head-options` one
  // the comparison crops the approved option from included, D-281).
  "scripts/render-screenshots.ts",
  "scripts/lib/screenshot-bundle.ts",
  // The gallery's render mode: its constants, its frame, the switch into it, and its styles.
  "gallery/shot-mode.ts",
  "gallery/GalleryShot.tsx",
  "gallery/App.tsx",
  "gallery/gallery.css",
  // The runner's own code, which the render script runs from the PR's checkout (the manifest
  // check, the marker regions, the PNG reader and what they import).
  "src/",
  // Run by Node in the render job: the gallery build's config, and npm's install (the browser
  // driver's pin, every package and its install scripts, and npm's settings).
  "vite.config.ts",
  "package.json",
  "package-lock.json",
  ".npmrc",
];

/** The fixed reason a bundle from such a pull request is refused (D-279). */
export const SCREENSHOT_PIPELINE_REASON =
  "the pull request changes the screenshot pipeline, so its own screenshots cannot be trusted";

/** The fixed reason when the pull request's changed files are not known. */
export const CHANGED_PATHS_UNKNOWN_REASON =
  "the pull request's changed paths are not recorded, so the screenshot pipeline cannot be checked";

/** Whether a changed path is one of the pipeline's paths. */
export function isScreenshotPipelinePath(path: string): boolean {
  return SCREENSHOT_PIPELINE_PATHS.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

/** Whether CI's bundles at a commit can be read (D-279). */
export type PipelineCheck =
  | { trusted: true }
  | {
      trusted: false;
      /**
       * `screenshot_pipeline_changed`: the PR changes a pipeline path. `changed_paths_unknown`: no
       * `ci_run` on the commit, a malformed one, or one without `changedPaths` (fails closed).
       */
      reason: "screenshot_pipeline_changed" | "changed_paths_unknown";
    };

/** The check on a list of changed paths, or on none (fails closed). */
export function pipelineCheckOf(
  changedPaths: readonly string[] | undefined,
): PipelineCheck {
  if (!changedPaths) return { trusted: false, reason: "changed_paths_unknown" };
  return changedPaths.some(isScreenshotPipelinePath)
    ? { trusted: false, reason: "screenshot_pipeline_changed" }
    : { trusted: true };
}

/**
 * Whether CI's screenshot bundles at a commit of the item's PR can be read: the latest `ci_run`
 * the runner recorded for that commit lists the PR's changed paths and none of them is a pipeline
 * path. Reads only.
 */
export async function screenshotPipelineAt(
  store: Pick<StoreOps, "listEvidence">,
  nodeId: string,
  commitSha: string,
): Promise<PipelineCheck> {
  const ciRun = latest(await store.listEvidence({ nodeId, kind: "ci_run", commitSha }));
  const ci = ciRun ? readCiRun(ciRun.payload) : null;
  return pipelineCheckOf(ci?.changedPaths);
}

/** The fixed text for a check that does not trust the bundles. */
export const pipelineReasonText = (
  reason: Extract<PipelineCheck, { trusted: false }>["reason"],
): string =>
  reason === "screenshot_pipeline_changed"
    ? SCREENSHOT_PIPELINE_REASON
    : CHANGED_PATHS_UNKNOWN_REASON;
