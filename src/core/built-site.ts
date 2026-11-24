// The rules a site CI built must pass before the runner uses it, in one place for both users: the
// staging deploy's file set (src/adapters/deploy/site-files.ts, D-353, O-116) and the site QA will
// browse (./qa-site.ts, ADR 0119 slice 5a, D-478, O-174). Each user reads GitHub's zip in an
// adapter (src/adapters/screenshots/zip.ts) and gives the entries here; the refusal names are
// shared, and each user keeps its own fixed text for them, which never names a path or a value
// from the build.
//
// - Plain relative paths only (`path_not_plain`, ./archive-path.ts): the zip reader refuses any
//   other path before it unpacks, and these rules check again, so the entries a port gives the
//   core are checked whatever read them.
// - No symbolic link (`symlink`), from the Unix mode in the zip's external attributes.
// - The commit marker `foreman-commit.txt` at the site's root (`COMMIT_MARKER_FILE`, O-111) is
//   present (`marker_missing`) and is exactly the commit and a newline, as CI's marker step writes
//   it (`marker_mismatch`).
//
// Plain logic with no network, clock or file system.
import { isPlainRelativePath } from "./archive-path.ts";
import { COMMIT_MARKER_FILE } from "./preview-check.ts";

/** One file of a built site, as the zip reader gives it. */
export interface BuiltSiteEntry {
  /** The path from the site's root. */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** True when the zip names the entry a Unix symbolic link. */
  readonly symlink: boolean;
}

/**
 * Why an archive is not read as a site at all: the zip reader's refusals, by the name both users
 * give them. `archive_unreadable` is a zip that cannot be read (not a zip, malformed, encrypted, an
 * unknown compression, or a path twice); the others are a bound or the path rule.
 */
export type SiteArchiveRefusal =
  | "archive_unreadable"
  | "path_not_plain"
  | "too_many_files"
  | "file_too_large"
  | "too_large";

/** A path that is not plain, or a link, among the entries; null when there is none. */
export function unsafeEntry(
  entries: readonly BuiltSiteEntry[],
): "path_not_plain" | "symlink" | null {
  if (!entries.every((e) => isPlainRelativePath(e.path))) return "path_not_plain";
  if (entries.some((e) => e.symlink)) return "symlink";
  return null;
}

/** Whether `bytes` are exactly the characters of `text`, one byte each. */
function sameBytes(bytes: Uint8Array, text: string): boolean {
  if (bytes.length !== text.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The commit marker at the site's root, against `commitSha`: null when it is exactly the commit
 * and a newline, else why not. The marker's bytes are compared, never decoded or quoted.
 */
export function markerRefusal(
  entries: readonly BuiltSiteEntry[],
  commitSha: string,
): "marker_missing" | "marker_mismatch" | null {
  const marker = entries.find((e) => e.path === COMMIT_MARKER_FILE);
  if (!marker) return "marker_missing";
  return sameBytes(marker.bytes, `${commitSha}\n`) ? null : "marker_mismatch";
}
