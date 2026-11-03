// The one check both archive readers use (the repo map's tarball and the screenshot artifact's
// zip, D-267): a path inside an archive must be relative and plain, so a crafted archive cannot
// name a file outside what it unpacks to. Nothing is written to disk either way.

/**
 * True when `path` is relative, has no empty, `.` or `..` part, and holds no backslash or control
 * character. A folder's trailing `/` is the caller's to strip first.
 */
export function isPlainRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return path.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}
