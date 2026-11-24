// The site QA will browse (ADR 0119 slice 5a, D-476 to D-480, O-174). On a pull request, CI's
// `preview-check` job keeps the build it served and probed, commit marker included, as the
// artifact `qa-site` for 3 days (.github/workflows/ci.yml). Before QA's review gets a browser, the
// runner reads that artifact from the preview check's own workflow run on the head commit, with
// its App's `actions: read` (D-267, src/adapters/github/qa-sites.ts), and checks it here.
//
// The result is a site, or "no browser" with a fixed reason. A later slice gives QA the site in a
// browser pod of its own (D-476) or, with no site, reviews as today and says in QA's input
// "No browser in this run: <reason>" (D-479). No run uses it yet.
//
// In order, each refusal its own fixed reason:
// 1. The head commit is a full commit sha (`head_unknown`).
// 2. The pipeline rule, like D-279's: the PR's changed paths come from the latest `ci_run` the
//    runner recorded on the head, and a PR that changes the site's build or its server
//    (`QA_SITE_PIPELINE_PATHS`) gets no browser (`pipeline_changed`), since its own CI would make
//    and keep the site QA trusts. No `ci_run`, a malformed one or one without `changedPaths`
//    fails closed (`changed_paths_unknown`). Nothing is read from GitHub either way.
// 3. The latest `preview_check` recorded on the head names its workflow run
//    (`PreviewCheckResult.workflowRunId`, ./github-ingest.ts) and passed: none, or one without a
//    run, is `no_preview_check`, and one that did not pass `preview_check_failed`.
// 4. The port reads the newest unexpired `qa-site` artifact of exactly that run: none
//    (`missing`), a zip over 900 KiB before or after its download (`zip_too_large`), a listing or
//    download GitHub refused (`download_refused`), or a zip its reader refuses
//    (`archive_unreadable`, `path_not_plain`, or a bound below).
// 5. The built site's shared rules (./built-site.ts), which the staging deploy also uses: plain
//    relative paths (`path_not_plain`) and no symbolic link (`symlink`).
// 6. The bounds, `QA_SITE_LIMITS`, which the port's zip reader applies while it unpacks and the
//    core checks again: files (`too_many_files`), one file (`file_too_large`) and all of them
//    (`too_large`).
// 7. The layout: the site's own files, with `index.html` at the root (`index_missing`), as CI's
//    marker step requires and the site server falls back to. A build in the staging deploy's
//    new layout (`assets/` and `worker/`) has none at its root and is refused so.
// 8. The marker, a shared rule: `foreman-commit.txt` at the root is exactly the head commit and a
//    newline (`marker_missing`, `marker_mismatch`).
//
// Every reason is fixed text that fits "No browser in this run: <reason>", and none names a path,
// a file's content or anything else from the build. Plain logic over an injected store and port
// (D-162).
import {
  markerRefusal,
  unsafeEntry,
  type BuiltSiteEntry,
  type SiteArchiveRefusal,
} from "./built-site.ts";
import { latest, readCheck, readCiRun } from "./guards/evidence.ts";
import { COMMIT_MARKER_FILE, PREVIEW_CHECK_WORKFLOW } from "./preview-check.ts";
import type { Json, StoreOps } from "./store.ts";

/** The artifact CI's `preview-check` job keeps on a pull request (.github/workflows/ci.yml). */
export const QA_SITE_ARTIFACT = "qa-site";

/** How long CI keeps it, in days. */
export const QA_SITE_RETENTION_DAYS = 3;

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The largest zip the runner takes, before and after its download: it goes whole into the run's
 * site Secret in a later slice, which Kubernetes caps at 1 MiB, the bound task files use too.
 */
export const QA_SITE_MAX_ZIP_BYTES = 900 * KIB;

/**
 * The site unpacked: at most 2,000 files, 16 MiB a file and 32 MiB in all. Foreman's gallery is 3
 * files and about 270 KB (measured 2026-11-24); the bounds leave room for a project's own site
 * and stop a zip bomb, since 900 KiB of compressed text rarely unpacks past about 20 MiB.
 */
export const QA_SITE_LIMITS = {
  files: 2_000,
  fileBytes: 16 * MIB,
  totalBytes: 32 * MIB,
} as const;

/** The site's root page, which the site server serves for any path with no file. */
export const QA_SITE_INDEX_FILE = "index.html";

/** CI's preview check scripts: the marker and probe, and the site server. */
export const PREVIEW_CHECK_SCRIPT = ".github/scripts/preview-check.mjs";
export const SITE_SERVER_SCRIPT = ".github/scripts/serve-site.mjs";

/**
 * The site's build and its server: the workflow whose job builds, marks, probes and keeps the
 * site, and the two scripts it runs. A PR that changes any of them gets no browser.
 */
export const QA_SITE_PIPELINE_PATHS: readonly string[] = [
  PREVIEW_CHECK_WORKFLOW,
  PREVIEW_CHECK_SCRIPT,
  SITE_SERVER_SCRIPT,
];

/** The fixed reason of each "no browser". None names anything from the build. */
export const QA_SITE_REASONS = {
  head_unknown: "the head commit is not a full commit sha",
  changed_paths_unknown:
    "the pull request's changed paths are not recorded, so the site build cannot be checked",
  pipeline_changed: "the pull request changes the site build or its server",
  no_preview_check: "CI's preview check has no result on the head commit",
  preview_check_failed: "CI's preview check did not pass on the head commit",
  missing: `CI kept no ${QA_SITE_ARTIFACT} build in the preview check's run, or it has expired`,
  zip_too_large: `the ${QA_SITE_ARTIFACT} build is larger than 900 KiB zipped`,
  download_refused: `the runner could not download the ${QA_SITE_ARTIFACT} build from GitHub`,
  archive_unreadable: `the ${QA_SITE_ARTIFACT} build is not a readable zip file`,
  path_not_plain: `the ${QA_SITE_ARTIFACT} build names a path that is not a plain relative path`,
  symlink: `the ${QA_SITE_ARTIFACT} build holds a symbolic link`,
  too_many_files: `the ${QA_SITE_ARTIFACT} build has more than ${QA_SITE_LIMITS.files} files`,
  file_too_large: `the ${QA_SITE_ARTIFACT} build has a file larger than 16 MiB`,
  too_large: `the ${QA_SITE_ARTIFACT} build is larger than 32 MiB unpacked`,
  index_missing: `the ${QA_SITE_ARTIFACT} build has no ${QA_SITE_INDEX_FILE} at its root`,
  marker_missing: `the ${QA_SITE_ARTIFACT} build has no ${COMMIT_MARKER_FILE} at its root`,
  marker_mismatch: `the ${QA_SITE_ARTIFACT} build's ${COMMIT_MARKER_FILE} does not name the head commit`,
} as const;

export type QaSiteReason = keyof typeof QA_SITE_REASONS;

/** Why the port gives no site: none kept, a bound, GitHub's refusal or the zip reader's. */
export type QaSiteReadRefusal =
  "missing" | "zip_too_large" | "download_refused" | SiteArchiveRefusal;

/** What the port read: the zip and its entries, unpacked within `QA_SITE_LIMITS`, or why none. */
export type QaSiteRead =
  | { found: true; zip: Uint8Array; entries: readonly BuiltSiteEntry[] }
  | { found: false; reason: QaSiteReadRefusal };

/** The runner's read of CI's `qa-site` artifacts (src/adapters/github/qa-sites.ts). */
export interface QaSites {
  /** The newest unexpired `qa-site` artifact of one workflow run of `repo`, within the bounds. */
  read(repo: string, workflowRunId: number): Promise<QaSiteRead>;
}

/** A site that passed every rule, as the later slice gives it to QA's browser pod. */
export interface QaSite {
  commitSha: string;
  /** The preview check's run the artifact came from. */
  workflowRunId: number;
  /** GitHub's zip of the site, at most `QA_SITE_MAX_ZIP_BYTES`. */
  zip: Uint8Array;
  files: number;
  /** All files together, unpacked. */
  bytes: number;
}

/** A site for QA's browser, or no browser with its fixed reason (D-479). */
export type QaSiteCheck =
  | { browser: true; site: QaSite }
  | { browser: false; reason: QaSiteReason; text: string };

const FULL_SHA = /^[0-9a-f]{40}$/;

const noBrowser = (reason: QaSiteReason): QaSiteCheck => ({
  browser: false,
  reason,
  text: QA_SITE_REASONS[reason],
});

/** Whether a changed path is the site's build or its server. */
export const isQaSitePipelinePath = (path: string): boolean =>
  QA_SITE_PIPELINE_PATHS.includes(path);

/** The pipeline rule on the PR's changed paths, or on none (fails closed); null when it passes. */
export function qaSitePipelineRefusal(
  changedPaths: readonly string[] | undefined,
): "pipeline_changed" | "changed_paths_unknown" | null {
  if (!changedPaths) return "changed_paths_unknown";
  return changedPaths.some(isQaSitePipelinePath) ? "pipeline_changed" : null;
}

/** The workflow run a `preview_check` payload names, or null when it names none. */
function previewRunOf(payload: Json): number | null {
  const run =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload.workflowRunId
      : undefined;
  return typeof run === "number" && Number.isSafeInteger(run) && run > 0 ? run : null;
}

/** Steps 5 to 8 on the entries the port read; null when the site passes. */
export function qaSiteFilesRefusal(
  entries: readonly BuiltSiteEntry[],
  headSha: string,
): QaSiteReason | null {
  const unsafe = unsafeEntry(entries);
  if (unsafe) return unsafe;
  if (entries.length > QA_SITE_LIMITS.files) return "too_many_files";
  if (entries.some((e) => e.bytes.length > QA_SITE_LIMITS.fileBytes)) {
    return "file_too_large";
  }
  const total = entries.reduce((sum, e) => sum + e.bytes.length, 0);
  if (total > QA_SITE_LIMITS.totalBytes) return "too_large";
  if (!entries.some((e) => e.path === QA_SITE_INDEX_FILE)) return "index_missing";
  return markerRefusal(entries, headSha);
}

export interface QaSiteRequest {
  /** The item QA reviews, whose evidence names the head's changed paths and preview check. */
  nodeId: string;
  /** `owner/name`: the item's project repository. */
  repo: string;
  /** The PR's head commit QA reviews. */
  headSha: string;
}

/**
 * The site QA will browse for the item's head commit, or no browser with its fixed reason. Reads
 * the store and, only once the pipeline rule and the preview check pass, the port. Writes nothing.
 */
export async function checkQaSite(
  deps: { store: Pick<StoreOps, "listEvidence">; sites: QaSites },
  request: QaSiteRequest,
): Promise<QaSiteCheck> {
  const { nodeId, repo, headSha } = request;
  if (!FULL_SHA.test(headSha)) return noBrowser("head_unknown");

  const ciRun = latest(
    await deps.store.listEvidence({ nodeId, kind: "ci_run", commitSha: headSha }),
  );
  const pipeline = qaSitePipelineRefusal(
    ciRun ? readCiRun(ciRun.payload)?.changedPaths : undefined,
  );
  if (pipeline) return noBrowser(pipeline);

  const preview = latest(
    await deps.store.listEvidence({
      nodeId,
      kind: "preview_check",
      commitSha: headSha,
    }),
  );
  const workflowRunId = preview ? previewRunOf(preview.payload) : null;
  const check = preview ? readCheck(preview.payload) : null;
  if (workflowRunId === null || !check) return noBrowser("no_preview_check");
  if (!check.pass) return noBrowser("preview_check_failed");

  const read = await deps.sites.read(repo, workflowRunId);
  if (!read.found) return noBrowser(read.reason);
  if (read.zip.length > QA_SITE_MAX_ZIP_BYTES) return noBrowser("zip_too_large");
  const refusal = qaSiteFilesRefusal(read.entries, headSha);
  if (refusal) return noBrowser(refusal);
  return {
    browser: true,
    site: {
      commitSha: headSha,
      workflowRunId,
      zip: read.zip,
      files: read.entries.length,
      bytes: read.entries.reduce((sum, e) => sum + e.bytes.length, 0),
    },
  };
}
