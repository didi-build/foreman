// The staging site's file set (D-353, O-116): what the runner takes from CI's `staging-site`
// artifact before anything is uploaded, read in memory from GitHub's zip (../screenshots/zip.ts).
// Plain code with no network. A set that fails is refused with fixed text that names no path or
// value from the build, and nothing is uploaded.
//
// The rules, each its own refusal:
// - Plain relative paths only: no absolute path, no `.` or `..` part, no backslash and no control
//   character (`path_not_plain`, the zip reader's rule, ../github/archive-path.ts), and no
//   symbolic link (`symlink`).
// - Bounded by Cloudflare's documented static asset limits on the Workers Free plan, "Workers
//   platform limits", section Static Assets (developers.cloudflare.com/workers/platform/limits/,
//   last updated 2026-10-29, read 2026-11-08): 20,000 files per Worker version
//   (`too_many_files`) and 25 MiB per file (`file_too_large`). Cloudflare documents no limit on a
//   version's total size, so the total is the runner's own memory bound, the screenshot bundles'
//   200 MiB (`too_large`).
// - The commit marker `foreman-commit.txt` at the site's root (`COMMIT_MARKER_FILE`, O-111) is
//   present (`marker_missing`) and is exactly the run's head commit and a newline, as CI's marker
//   step writes it (`marker_mismatch`).
// - No file that makes the Worker run code: `_worker.js`, as a file or a folder, anywhere in the
//   set (`worker_code`). Cloudflare runs code only from a module named in the upload's metadata,
//   which the deploy never sends (./cloudflare-staging.ts); `_worker.js` is Cloudflare Pages' file
//   for a site's own Worker, and Wrangler refuses to upload one as an asset for that reason.
// An archive that is not a readable zip is not the build's fault: it is refused as
// `infrastructure` (`archive_unreadable`). Every other refusal is `file_set`.
//
// `_headers` and `_redirects` are not read as configuration: the upload sends no asset config but
// the one the runner sets, so such files are served as plain files.
import { COMMIT_MARKER_FILE } from "../../core/preview-check.ts";
import type { DeployRefusalCause } from "../../core/staging-deploy.ts";
import { readZipEntries, ZipError, type ZipErrorCode } from "../screenshots/zip.ts";

const MIB = 1024 * 1024;

/** Cloudflare's static asset limits on the Workers Free plan (read 2026-11-08, see above). */
export const CLOUDFLARE_STATIC_ASSET_LIMITS = {
  filesPerVersion: 20_000,
  fileBytes: 25 * MIB,
} as const;

/** The runner's bound on the whole set, unpacked: its memory, as for the screenshot bundles. */
export const SITE_TOTAL_BYTES = 200 * MIB;

/** A folder entry counts in the zip but is no file; this leaves room for one per file. */
const ZIP_ENTRY_BOUND = CLOUDFLARE_STATIC_ASSET_LIMITS.filesPerVersion * 2;

/** The name that would make Cloudflare run a site's own code (Pages' Worker file or folder). */
export const WORKER_CODE_NAME = "_worker.js";

/** The fixed text of each refusal. None names a path or a value from the build. */
export const SITE_REFUSALS = {
  archive_unreadable: "the staging-site build is not a readable zip file",
  path_not_plain:
    "the staging-site build names a path that is not a plain relative path",
  symlink: "the staging-site build holds a symbolic link",
  too_many_files: `the staging-site build has more than ${CLOUDFLARE_STATIC_ASSET_LIMITS.filesPerVersion} files, Cloudflare's limit`,
  file_too_large:
    "the staging-site build has a file larger than 25 MiB, Cloudflare's limit",
  too_large: "the staging-site build is larger than 200 MiB in all, the runner's bound",
  marker_missing: `the staging-site build has no ${COMMIT_MARKER_FILE} at its root`,
  marker_mismatch: `the staging-site build's ${COMMIT_MARKER_FILE} does not name the CI run's commit`,
  worker_code: `the staging-site build holds ${WORKER_CODE_NAME}, which would run code`,
} as const;

export type SiteRefusal = keyof typeof SITE_REFUSALS;

/** One file of the site: its path relative to the site's root, and its bytes. */
export interface SiteFile {
  path: string;
  bytes: Uint8Array;
}

export type SiteFileSet =
  | { ok: true; files: SiteFile[] }
  | { ok: false; cause: DeployRefusalCause; reason: SiteRefusal; text: string };

const refuse = (reason: SiteRefusal): SiteFileSet => ({
  ok: false,
  cause: reason === "archive_unreadable" ? "infrastructure" : "file_set",
  reason,
  text: SITE_REFUSALS[reason],
});

/** What a zip refusal means for the site. */
const ZIP_REFUSALS: Record<ZipErrorCode, SiteRefusal> = {
  not_zip: "archive_unreadable",
  malformed: "archive_unreadable",
  encrypted: "archive_unreadable",
  compression: "archive_unreadable",
  duplicate: "archive_unreadable",
  too_many_entries: "too_many_files",
  entry_too_large: "file_too_large",
  too_large: "too_large",
  bad_path: "path_not_plain",
};

/** The site's files from CI's artifact, or the refusal of the set. */
export function readSiteFiles(archive: Uint8Array, commitSha: string): SiteFileSet {
  let entries;
  try {
    entries = readZipEntries(archive, {
      entries: ZIP_ENTRY_BOUND,
      entryBytes: CLOUDFLARE_STATIC_ASSET_LIMITS.fileBytes,
      totalBytes: SITE_TOTAL_BYTES,
    });
  } catch (error) {
    return refuse(
      error instanceof ZipError ? ZIP_REFUSALS[error.code] : "archive_unreadable",
    );
  }
  // The zip reader has refused any path that is not plain (`isPlainRelativePath`), any file over
  // 25 MiB and a set over the total, each before it unpacked it, and counted folders as entries.
  if (entries.some((e) => e.symlink)) return refuse("symlink");
  if (entries.length > CLOUDFLARE_STATIC_ASSET_LIMITS.filesPerVersion) {
    return refuse("too_many_files");
  }
  if (entries.some((e) => e.path.split("/").includes(WORKER_CODE_NAME))) {
    return refuse("worker_code");
  }
  const marker = entries.find((e) => e.path === COMMIT_MARKER_FILE);
  if (!marker) return refuse("marker_missing");
  if (Buffer.from(marker.bytes).toString("latin1") !== `${commitSha}\n`) {
    return refuse("marker_mismatch");
  }
  return { ok: true, files: entries.map(({ path, bytes }) => ({ path, bytes })) };
}
