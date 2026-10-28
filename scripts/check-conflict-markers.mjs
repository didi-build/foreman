import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const SKIP_WALK_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);

const MARKER_LINE_RE = /^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)(?: |$)/;

const INSTRUCTION =
  "Resolve the conflict: keep or merge both sides, delete the marker lines, then re-run `npm run conflict-markers`. If you need to show a marker in documentation, indent it or build it in code.";

export class CannotReadError extends Error {
  /**
   * @param {string} path
   * @param {string} detail
   */
  constructor(path, detail) {
    super(`${path}: cannot read: ${detail}`);
    this.name = "CannotReadError";
    this.path = path;
    this.detail = detail;
  }
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isConflictMarkerLine(line) {
  return MARKER_LINE_RE.test(line);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function shouldSkipFile(filePath) {
  const st = statSync(filePath, { throwIfNoEntry: false });
  if (!st?.isFile()) return true;
  if (st.size > MAX_FILE_BYTES) return true;
  const fd = readFileSync(filePath);
  const sample = fd.subarray(0, Math.min(fd.length, BINARY_SAMPLE_BYTES));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
export function scanTextForConflictMarkers(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (isConflictMarkerLine(lines[i])) {
      hits.push({ line: i + 1, text: lines[i] });
    }
  }
  return hits;
}

/**
 * @param {string} filePath
 * @param {string} displayPath
 * @param {typeof readFileSync} [readFile]
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function scanFileForConflictMarkers(
  filePath,
  displayPath,
  readFile = readFileSync,
) {
  if (shouldSkipFile(filePath)) return [];
  const content = readFile(filePath, "utf8");
  return scanTextForConflictMarkers(content).map((hit) => ({
    path: displayPath,
    line: hit.line,
    text: hit.text,
  }));
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function comparePathCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function isGitWorkTree(root) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listFilesWithGit(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .toString("utf8")
    .split("\0")
    .filter((line) => line.length > 0);
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {string[]}
 */
function walkFiles(dir, root) {
  const rel = relative(root, dir);
  const base = rel === "" ? "" : (rel.split(/[/\\]/).pop() ?? "");
  if (base !== "" && SKIP_WALK_DIRS.has(base)) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const display = rel === "" ? "." : rel.split(/[/\\]/).join("/");
    const message = err instanceof Error ? err.message : String(err);
    throw new CannotReadError(display, message);
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_WALK_DIRS.has(entry.name)) continue;
      files.push(...walkFiles(full, root));
    } else if (entry.isFile()) {
      files.push(relative(root, full));
    }
  }
  return files;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function listFilesToScan(root) {
  if (isGitWorkTree(root)) {
    try {
      return listFilesWithGit(root);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CannotReadError(".", message);
    }
  }
  return walkFiles(root, root);
}

/**
 * @param {string} root
 * @param {string[]} [onlyFiles] relative or absolute paths
 * @param {{ readFile?: typeof readFileSync }} [options]
 * @returns {{ hits: { path: string, line: number, text: string }[], errors: { path: string, message: string }[] }}
 */
export function findConflictMarkers(root, onlyFiles, options = {}) {
  /** @internal test hook */
  const { readFile = readFileSync } = options;
  const absRoot = resolve(root);
  const errors = [];
  let paths;

  if (onlyFiles !== undefined && onlyFiles.length > 0) {
    paths = onlyFiles.map((f) => {
      const abs = resolve(absRoot, f);
      const rel = relative(absRoot, abs);
      return { abs, display: rel.split(/[/\\]/).join("/") };
    });
  } else {
    let relPaths;
    try {
      relPaths = listFilesToScan(absRoot);
    } catch (err) {
      if (err instanceof CannotReadError) {
        errors.push({ path: err.path, message: err.detail });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ path: ".", message });
      }
      relPaths = [];
    }
    paths = relPaths.map((rel) => ({
      abs: join(absRoot, rel),
      display: rel.split(/[/\\]/).join("/"),
    }));
  }

  const hits = [];
  for (const { abs, display } of paths) {
    if (!existsSync(abs)) continue;
    try {
      hits.push(...scanFileForConflictMarkers(abs, display, readFile));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: display, message });
    }
  }
  hits.sort((a, b) => {
    const byPath = comparePathCodeUnits(a.path, b.path);
    if (byPath !== 0) return byPath;
    return a.line - b.line;
  });
  return { hits, errors };
}

/**
 * @param {{ path: string, line: number, text: string }[]} hits
 * @returns {string}
 */
export function formatConflictMarkerHitLines(hits) {
  return hits.map((hit) => {
    const trimmed = hit.text.trimEnd().slice(0, 80);
    return `${hit.path}:${hit.line}: ${trimmed}`;
  });
}

/**
 * @param {{ path: string, line: number, text: string }[]} hits
 * @returns {string}
 */
export function formatConflictMarkerReport(hits) {
  const lines = formatConflictMarkerHitLines(hits);
  lines.push(INSTRUCTION);
  return lines.join("\n");
}

/**
 * @param {{ path: string, message: string }[]} errors
 * @returns {string}
 */
export function formatConflictMarkerErrors(errors) {
  return errors.map((e) => `${e.path}: cannot read: ${e.message}`).join("\n");
}

function runCli() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const onlyFiles = args.length > 0 ? args : undefined;
  const { hits, errors } = findConflictMarkers(root, onlyFiles);
  if (hits.length === 0 && errors.length === 0) {
    return;
  }
  const out = [];
  if (hits.length > 0) {
    out.push(...formatConflictMarkerHitLines(hits));
  }
  if (errors.length > 0) {
    out.push(formatConflictMarkerErrors(errors));
  }
  if (hits.length > 0) {
    out.push(INSTRUCTION);
  }
  console.error(out.join("\n"));
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli();
}
