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
//
// Two layouts (ADR 0118 appendix E item 7, O-159), told apart by the manifest at the build's root:
// - The old one, as the rehearsal builds it: the site's files at the root and no manifest. It is
//   read exactly as before slice 3, and the upload sends no code (`worker` is absent).
// - The new one, from the template: `foreman-deploy.json` (./deploy-manifest.ts), `assets/` (the
//   site, with the marker at its root), `worker/index.js` (the Worker's bundled ES module, the
//   only file there) and `migrations/*.sql` (none at first). Nothing else may be at the root
//   (`layout_unexpected`). The rules above apply to `assets/`, and the Cloudflare limits count its
//   files. The module must be UTF-8 text (`worker_not_text`), within the same 25 MiB per file,
//   under Cloudflare's 64 MiB Worker size ("Workers platform limits", read 2026-11-21). The
//   migrations are plain `.sql` names directly in their folder, at most 1,000, sorted by name and
//   carried for slice 8, which applies them; nothing reads them yet.
import { COMMIT_MARKER_FILE } from "../../core/preview-check.ts";
import type { DeployRefusalCause } from "../../core/staging-deploy.ts";
import {
  readZipEntries,
  ZipError,
  type ZipEntry,
  type ZipErrorCode,
} from "../screenshots/zip.ts";
import {
  DEPLOY_MANIFEST_FILE,
  MANIFEST_REFUSALS,
  parseDeployManifest,
  type DeployManifest,
} from "./deploy-manifest.ts";

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

/** The new layout's folders (O-159): the site, the Worker's module and the D1 migrations. */
export const ASSETS_FOLDER = "assets";
export const WORKER_FOLDER = "worker";
export const MIGRATIONS_FOLDER = "migrations";

/** The Worker's bundled ES module in the new layout: the only file of `worker/`. */
export const WORKER_MODULE_FILE = "index.js";

/** The most migration files a build may carry. */
export const MAX_MIGRATIONS = 1000;

const MIGRATION_NAME = /^[A-Za-z0-9_-]{1,96}\.sql$/;

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
  layout_unexpected: `the staging-site build has ${DEPLOY_MANIFEST_FILE} and something at its root other than ${ASSETS_FOLDER}, ${WORKER_FOLDER} and ${MIGRATIONS_FOLDER}`,
  assets_marker_missing: `the staging-site build has no ${COMMIT_MARKER_FILE} at the root of its ${ASSETS_FOLDER} folder`,
  worker_missing: `the staging-site build has ${DEPLOY_MANIFEST_FILE} but no ${WORKER_FOLDER}/${WORKER_MODULE_FILE}`,
  worker_extra: `the staging-site build's ${WORKER_FOLDER} folder holds a file other than ${WORKER_MODULE_FILE}`,
  worker_not_text: `the staging-site build's ${WORKER_FOLDER}/${WORKER_MODULE_FILE} is not UTF-8 text`,
  migrations_not_plain: `the staging-site build's ${MIGRATIONS_FOLDER} folder holds more than ${MAX_MIGRATIONS} files, or something other than .sql files directly in it`,
  ...MANIFEST_REFUSALS,
} as const;

export type SiteRefusal = keyof typeof SITE_REFUSALS;

/** One file of the site: its path relative to the site's root, and its bytes. */
export interface SiteFile {
  path: string;
  bytes: Uint8Array;
}

/** What a build in the new layout adds to its site (O-159). */
export interface SiteWorker {
  /** The bundled ES module, `worker/index.js`, as UTF-8 text. */
  module: string;
  manifest: DeployManifest;
  /** `migrations/*.sql`, named without the folder and sorted by name; applied from slice 8. */
  migrations: SiteFile[];
}

/** The site's files; `worker` only for a build in the new layout. */
export type SiteFileSet =
  | { ok: true; files: SiteFile[]; worker?: SiteWorker }
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
  if (!entries.some((e) => e.path === DEPLOY_MANIFEST_FILE)) {
    return readSite(entries, commitSha, "marker_missing");
  }
  return readWorkerBuild(entries, commitSha);
}

/** The site's own rules, on its files with paths from the site's root. */
function readSite(
  entries: readonly ZipEntry[],
  commitSha: string,
  missingMarker: "marker_missing" | "assets_marker_missing",
): SiteFileSet {
  if (entries.length > CLOUDFLARE_STATIC_ASSET_LIMITS.filesPerVersion) {
    return refuse("too_many_files");
  }
  if (entries.some((e) => e.path.split("/").includes(WORKER_CODE_NAME))) {
    return refuse("worker_code");
  }
  const marker = entries.find((e) => e.path === COMMIT_MARKER_FILE);
  if (!marker) return refuse(missingMarker);
  if (Buffer.from(marker.bytes).toString("latin1") !== `${commitSha}\n`) {
    return refuse("marker_mismatch");
  }
  return { ok: true, files: entries.map(({ path, bytes }) => ({ path, bytes })) };
}

/** The files under one top folder, with the folder taken off their paths. */
const under = (entries: readonly ZipEntry[], folder: string): ZipEntry[] =>
  entries
    .filter((e) => e.path.startsWith(`${folder}/`))
    .map((e) => ({ ...e, path: e.path.slice(folder.length + 1) }));

/** A build in the new layout (O-159): the manifest, the site, the module and the migrations. */
function readWorkerBuild(entries: readonly ZipEntry[], commitSha: string): SiteFileSet {
  const folders = [ASSETS_FOLDER, WORKER_FOLDER, MIGRATIONS_FOLDER];
  if (
    !entries.every(
      (e) =>
        e.path === DEPLOY_MANIFEST_FILE ||
        folders.some((f) => e.path.startsWith(`${f}/`)),
    )
  ) {
    return refuse("layout_unexpected");
  }
  const parsed = parseDeployManifest(
    (entries.find((e) => e.path === DEPLOY_MANIFEST_FILE) as ZipEntry).bytes,
  );
  if (!parsed.ok) return refuse(parsed.reason);

  const site = readSite(
    under(entries, ASSETS_FOLDER),
    commitSha,
    "assets_marker_missing",
  );
  if (!site.ok) return site;

  // Exactly one file in `worker/`, the module, and it must be text.
  const worker = under(entries, WORKER_FOLDER);
  const main = worker.find((e) => e.path === WORKER_MODULE_FILE);
  if (!main) return refuse("worker_missing");
  if (worker.length !== 1) return refuse("worker_extra");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(main.bytes);
  } catch {
    return refuse("worker_not_text");
  }

  const migrations = under(entries, MIGRATIONS_FOLDER);
  if (
    migrations.length > MAX_MIGRATIONS ||
    !migrations.every((e) => MIGRATION_NAME.test(e.path))
  ) {
    return refuse("migrations_not_plain");
  }
  return {
    ok: true,
    files: site.files,
    worker: {
      module: text,
      manifest: parsed.manifest,
      migrations: migrations
        .map(({ path, bytes }) => ({ path, bytes }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    },
  };
}
