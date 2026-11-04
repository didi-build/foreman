// The Scanner's stage 1 (D-150, D-299, D-300, O-92): a short, fixed list of deterministic checks
// over one project's repository at one commit, with no model. Each check compares what the code,
// specs, design index, gallery registry, contracts and docs say about each other, and reports
// only what is certain from the files themselves: a missing file, a missing index entry, a file
// that does not parse. Nothing here guesses, runs project code or reads the network.
//
// The checks run inside the scan Job (the repo map Job in its scan mode, src/agent-images/
// repo-map/), over the files of the archive as read there (src/adapters/repo-map/scan.ts). The Job
// hands back only each finding's check id, path, line and target (`ScanFinding`); the runner
// checks that result strictly as untrusted data (`checkScanResult`) and writes every idea's title,
// description, class, confidence and dedupe key itself from its own table below (`scanIdea`), so
// no text from the Job becomes an idea except a checked repository path.
//
// The Job also reports where a check could not run (`scanNotRun`, D-301, O-93): the whole of
// `gallery_entry_unregistered` when there is no readable registry, and a check for one file when
// the file is there but its text was too large to keep, or, for `gallery_spec_missing`, when the
// file has no single literal `specPath`. The runner treats an idea as no longer found only when
// every check its keys name ran over its file and listed all its findings (`scanFoundNone`).
//
// The checks, in the order they are listed and filed:
// - design_index_link_missing (drift): `design/README.md`, the design index, links a `spec.md`
//   that does not exist.
// - design_spec_not_indexed (drift): a `design/<area>/<feature>/spec.md` that the design index
//   does not link.
// - gallery_spec_missing (bug): a `components/**/*.gallery.ts` whose one `specPath` names a file
//   that does not exist.
// - gallery_entry_unregistered (drift): a `components/**/*.gallery.ts` that `gallery/registry.ts`
//   does not import (the repo map's resolved imports), when the registry exists.
// - contract_unparsable (bug): a `.yaml` or `.yml` file under `contracts/` that is not valid YAML,
//   so no loader can read it.
// - doc_link_missing (drift): a relative link in a Markdown file to a repository path that does
//   not exist. Links with a scheme, a leading `/`, a `{{` placeholder or a target outside the
//   repository are not checked, and neither are links in code or HTML comments.
// Plain logic, no imports but the bounds of an idea's text (D-162).
import { MAX_FINDING_DETAIL, MAX_FINDING_TITLE } from "./out-of-scope-findings.ts";
import type { RepoMapProject } from "./repo-map.ts";

export const SCAN_CHECKS = [
  "design_index_link_missing",
  "design_spec_not_indexed",
  "gallery_spec_missing",
  "gallery_entry_unregistered",
  "contract_unparsable",
  "doc_link_missing",
] as const;

export type ScanCheckId = (typeof SCAN_CHECKS)[number];

/** Stage 1 files only bugs and drift; improvements wait for the model-based stage 2 (D-299). */
export type ScanClass = "bug" | "drift";

/** The design index (docs/component-gallery.md). */
export const DESIGN_INDEX = "design/README.md";
/** The gallery registry (docs/component-gallery.md). */
export const GALLERY_REGISTRY = "gallery/registry.ts";

const DESIGN_SPEC = /^design\/[^/]+\/[^/]+\/spec\.md$/;
const GALLERY_FILE = /^components\/.+\.gallery\.tsx?$/;
const CONTRACT_FILE = /^contracts\/.+\.ya?ml$/;
const MARKDOWN = /\.md$/;

/** One certain finding, as the Job reports it. */
export interface ScanFinding {
  check: ScanCheckId;
  /** The file the finding is in or about. */
  path: string;
  /** The line in `path`, 1-based, when the check knows it. */
  line: number | null;
  /** The missing file a link or `specPath` names; null for checks with no target. */
  target: string | null;
}

/**
 * A check that could not run (D-301, O-93): over one file (`path`), or over every file (`path`
 * null). Its findings there are unknown, so no idea of that check and file is no longer found.
 */
export interface ScanNotRun {
  check: ScanCheckId;
  path: string | null;
}

/** What one scan found: every finding's count by check, and the findings listed (bounded). */
export interface RepoScan {
  commitSha: string;
  /** Findings by check, all of them, including any not listed. */
  counts: Record<ScanCheckId, number>;
  /** At most `MAX_LISTED_FINDINGS`, sorted, each dedupe key once. */
  findings: ScanFinding[];
  /** Where a check could not run, at most `MAX_LISTED_FINDINGS`, sorted, each once. */
  notRun: ScanNotRun[];
}

/**
 * Where the runner gets a scan (the port): the project's repository at its default branch's head
 * now, scanned in the repo map Job's scan mode (src/adapters/agent-runtime/kubernetes/
 * repo-maps.ts). Refuses with the token port's error until the runner App exists (D-178).
 */
export interface RepoScans {
  scan(project: RepoMapProject): Promise<RepoScan>;
}

/** The repository as the checks read it, built in the Job from the archive. */
export interface ScanInput {
  /** Every regular file's path. */
  paths: readonly string[];
  /** The text of each file the checks read (`scanReadsText`), by path. */
  texts: ReadonlyMap<string, string>;
  /** The repository files `gallery/registry.ts` imports, or null when there is no registry. */
  registryImports: readonly string[] | null;
  /** The contract files that are not valid YAML, with the line of the first problem. */
  unparsableContracts: readonly { path: string; line: number | null }[];
  /** Files the checks read whose text was too large to keep (empty when not given). */
  unread?: readonly string[];
}

/** What a check is: its class and how its idea reads. */
interface CheckDefinition {
  class: ScanClass;
  /** Whether its findings carry a target. */
  hasTarget: boolean;
  /** Which paths its findings may be about. */
  pathPattern: RegExp;
  title: (f: ScanFinding) => string;
  explain: (f: ScanFinding) => string;
}

/** A path for a title: the end of it when it is long, so the file name stays. */
const short = (path: string, max = 70): string =>
  path.length > max ? `...${path.slice(path.length - max + 3)}` : path;

const at = (f: ScanFinding): string =>
  f.line === null ? f.path : `${f.path} line ${f.line}`;

export const SCAN_CHECK_DEFINITIONS: Record<ScanCheckId, CheckDefinition> = {
  design_index_link_missing: {
    class: "drift",
    hasTarget: true,
    pathPattern: /^design\/README\.md$/,
    title: (f) => `Design index links a missing spec: ${short(f.target ?? "")}`,
    explain: (f) =>
      `The design index (${DESIGN_INDEX}) links ${f.target ?? ""} at ${at(f)}, and no such file exists. Either the spec was moved or deleted, or the index entry is out of date.`,
  },
  design_spec_not_indexed: {
    class: "drift",
    hasTarget: false,
    pathPattern: DESIGN_SPEC,
    title: (f) => `Spec missing from the design index: ${short(f.path)}`,
    explain: (f) =>
      `${f.path} is a design spec, and the design index (${DESIGN_INDEX}) does not link it. Each spec is listed in the index (docs/component-gallery.md).`,
  },
  gallery_spec_missing: {
    class: "bug",
    hasTarget: true,
    pathPattern: GALLERY_FILE,
    title: (f) => `Gallery entry names a missing spec: ${short(f.path)}`,
    explain: (f) =>
      `The gallery entry ${at(f)} sets specPath to ${f.target ?? ""}, and no such file exists, so the gallery cannot show the spec the component is built from.`,
  },
  gallery_entry_unregistered: {
    class: "drift",
    hasTarget: false,
    pathPattern: GALLERY_FILE,
    title: (f) => `Gallery entry not registered: ${short(f.path)}`,
    explain: (f) =>
      `${f.path} is a gallery entry, and ${GALLERY_REGISTRY} does not import it, so the gallery does not show it and CI takes no screenshot of it.`,
  },
  contract_unparsable: {
    class: "bug",
    hasTarget: false,
    pathPattern: CONTRACT_FILE,
    title: (f) => `Contract file is not valid YAML: ${short(f.path)}`,
    explain: (f) =>
      `${f.path} is not valid YAML${f.line === null ? "" : ` (the first problem is at line ${f.line})`}, so no contracts loader can read it.`,
  },
  doc_link_missing: {
    class: "drift",
    hasTarget: true,
    pathPattern: MARKDOWN,
    title: (f) => `Broken link in ${short(f.path, 45)} to ${short(f.target ?? "", 45)}`,
    explain: (f) =>
      `${at(f)} links ${f.target ?? ""}, and no such file or folder exists in the repository.`,
  },
};

/** The most findings a result lists; the rest are only counted. */
export const MAX_LISTED_FINDINGS = 200;
/** The most a count can be: far above any real repository's findings. */
export const MAX_FINDING_COUNT = 1_000_000;
/** The highest line number a finding can name. */
const MAX_LINE = 10_000_000;
/** Characters of one path, as in the repo map (src/core/repo-map.ts). */
const MAX_PATH_CHARS = 1024;

/** A file whose text the checks read: Markdown anywhere, and the contract files. */
export function scanReadsText(path: string): boolean {
  return MARKDOWN.test(path) || CONTRACT_FILE.test(path);
}

/** Whether a path is a contract file the contract check parses. */
export const isContractFile = (path: string): boolean => CONTRACT_FILE.test(path);

/** Relative, `/` separated, no empty, `.` or `..` part, no backslash or control character. */
export function isPlainRepoPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH_CHARS) {
    return false;
  }
  if (path.startsWith("/")) return false;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** `from`'s folder joined with a relative target and normalized; null when it leaves the root. */
function resolveRelative(from: string, target: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/** One link found in a Markdown file. */
interface MarkdownLink {
  line: number;
  /** The link's target as written, without angle brackets. */
  raw: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_LINK =
  /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>\n]*>|\S+)/;
const CODE_SPAN = /(`+)[^`]*?\1/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The links of a Markdown text: inline links and images, and reference definitions. */
export function markdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let fence: string | null = null;
  let comment = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] as string;
    const opened = FENCE.exec(line);
    if (fence !== null) {
      if (
        opened &&
        opened[1]?.[0] === fence[0] &&
        (opened[1]?.length ?? 0) >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (opened && !comment) {
      fence = opened[1] as string;
      continue;
    }
    // HTML comments, across lines.
    let visible = "";
    while (line !== "") {
      if (comment) {
        const end = line.indexOf("-->");
        if (end < 0) {
          line = "";
          break;
        }
        comment = false;
        line = line.slice(end + 3);
        continue;
      }
      const start = line.indexOf("<!--");
      if (start < 0) {
        visible += line;
        break;
      }
      visible += line.slice(0, start);
      comment = true;
      line = line.slice(start + 4);
    }
    const plain = visible.replace(CODE_SPAN, (span) => " ".repeat(span.length));
    const reference = REFERENCE.exec(plain);
    if (reference) links.push({ line: i + 1, raw: reference[1] as string });
    for (const match of plain.matchAll(INLINE_LINK)) {
      links.push({ line: i + 1, raw: match[1] as string });
    }
  }
  return links.map((l) => ({
    ...l,
    raw: l.raw.startsWith("<") && l.raw.endsWith(">") ? l.raw.slice(1, -1) : l.raw,
  }));
}

/**
 * The repository path a link names, or null when the link is not checked: empty, an anchor, a
 * scheme (`https:`, `mailto:`), a leading `/`, a `{{` placeholder, bad percent-encoding, or a
 * target that leaves the repository. The path loses its `#anchor`, `?query` and trailing `/`.
 */
export function linkTarget(from: string, raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("/")) return null;
  if (SCHEME.test(text) || text.includes("{{")) return null;
  const cut = text.split(/[#?]/)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(cut);
  } catch {
    return null;
  }
  if (decoded === "" || /[\\\0\r\n]/.test(decoded)) return null;
  const resolved = resolveRelative(from, decoded);
  if (resolved === null || resolved === "") return null;
  return isPlainRepoPath(resolved) ? resolved : null;
}

const specPathOf = (text: string): { value: string; line: number } | null => {
  const found = [...text.matchAll(/\bspecPath\s*:\s*(["'`])([^"'`\n]*)\1/g)];
  if (found.length !== 1) return null;
  const match = found[0] as RegExpMatchArray;
  const line = text.slice(0, match.index).split("\n").length;
  return { value: match[2] as string, line };
};

const order = (check: ScanCheckId): number => SCAN_CHECKS.indexOf(check);

/** The order findings are listed and filed in: check, then path, target and line. */
export function compareFindings(a: ScanFinding, b: ScanFinding): number {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    order(a.check) - order(b.check) ||
    cmp(a.path, b.path) ||
    cmp(a.target ?? "", b.target ?? "") ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

/**
 * The finding's dedupe key: its check and what it is about, never its line, so the same problem
 * keeps its key while the file around it changes (P-14).
 */
export function scanDedupeKey(f: ScanFinding): string {
  return `scanner:${f.check}:${f.path}${f.target === null ? "" : ` -> ${f.target}`}`;
}

/** Runs every check. Every finding once by dedupe key (its first line), sorted. */
export function runScanChecks(input: ScanInput): ScanFinding[] {
  const files = new Set(input.paths);
  const folders = new Set<string>();
  for (const path of input.paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const exists = (path: string) => files.has(path) || folders.has(path);
  const sorted = [...input.paths].sort();
  const found: ScanFinding[] = [];

  // The design index and the specs.
  const indexText = input.texts.get(DESIGN_INDEX);
  const indexed = new Set<string>();
  if (indexText !== undefined) {
    for (const link of markdownLinks(indexText)) {
      const target = linkTarget(DESIGN_INDEX, link.raw);
      if (target === null) continue;
      indexed.add(target);
      if (target.endsWith("spec.md") && !files.has(target)) {
        found.push({
          check: "design_index_link_missing",
          path: DESIGN_INDEX,
          line: link.line,
          target,
        });
      }
    }
  }
  for (const path of sorted) {
    if (DESIGN_SPEC.test(path) && !indexed.has(path)) {
      found.push({ check: "design_spec_not_indexed", path, line: null, target: null });
    }
  }

  // The gallery entries.
  const registered =
    input.registryImports === null ? null : new Set(input.registryImports);
  for (const path of sorted) {
    if (!GALLERY_FILE.test(path)) continue;
    const text = input.texts.get(path);
    const spec = text === undefined ? null : specPathOf(text);
    if (spec !== null) {
      const target = linkTarget("", spec.value.replace(/^\.\//, ""));
      if (target !== null && !files.has(target)) {
        found.push({ check: "gallery_spec_missing", path, line: spec.line, target });
      }
    }
    if (registered !== null && !registered.has(path)) {
      found.push({
        check: "gallery_entry_unregistered",
        path,
        line: null,
        target: null,
      });
    }
  }

  // The contracts.
  for (const { path, line } of input.unparsableContracts) {
    if (CONTRACT_FILE.test(path) && files.has(path)) {
      found.push({ check: "contract_unparsable", path, line, target: null });
    }
  }

  // Links in every Markdown file. The design index's spec links are its own check above.
  for (const path of sorted) {
    if (!MARKDOWN.test(path)) continue;
    const text = input.texts.get(path);
    if (text === undefined) continue;
    for (const link of markdownLinks(text)) {
      const target = linkTarget(path, link.raw);
      if (target === null || exists(target)) continue;
      if (path === DESIGN_INDEX && target.endsWith("spec.md")) continue;
      found.push({ check: "doc_link_missing", path, line: link.line, target });
    }
  }

  const seen = new Set<string>();
  return found.sort(compareFindings).filter((f) => {
    const key = scanDedupeKey(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The order not-run entries are listed in: check, then the whole check first, then path. */
export function compareNotRun(a: ScanNotRun, b: ScanNotRun): number {
  if (a.check !== b.check) return order(a.check) - order(b.check);
  if (a.path === b.path) return 0;
  if (a.path === null) return -1;
  if (b.path === null) return 1;
  return a.path < b.path ? -1 : 1;
}

/**
 * Where a check could not run (D-301, O-93), sorted, each once: the registry check as a whole
 * when there is no readable registry; a file's checks when its text was too large to keep; and
 * the spec check of a gallery entry with no single literal `specPath` the check can read. A file
 * that is not there is not listed: what was found in it is gone with it. Past
 * `MAX_LISTED_FINDINGS` entries, a check with entries is listed once as a whole instead.
 */
export function scanNotRun(input: ScanInput): ScanNotRun[] {
  const files = new Set(input.paths);
  const unread = new Set((input.unread ?? []).filter((p) => files.has(p)));
  const found: ScanNotRun[] = [];
  if (input.registryImports === null || unread.has(GALLERY_REGISTRY)) {
    found.push({ check: "gallery_entry_unregistered", path: null });
  }
  for (const path of [...files].sort()) {
    if (unread.has(path)) {
      if (path === DESIGN_INDEX) {
        found.push({ check: "design_index_link_missing", path });
      }
      if (GALLERY_FILE.test(path)) found.push({ check: "gallery_spec_missing", path });
      if (CONTRACT_FILE.test(path)) found.push({ check: "contract_unparsable", path });
      if (MARKDOWN.test(path)) found.push({ check: "doc_link_missing", path });
      continue;
    }
    if (GALLERY_FILE.test(path)) {
      const text = input.texts.get(path);
      const spec = text === undefined ? null : specPathOf(text);
      if (spec === null || linkTarget("", spec.value.replace(/^\.\//, "")) === null) {
        found.push({ check: "gallery_spec_missing", path });
      }
    }
  }
  const sorted = found.sort(compareNotRun);
  if (sorted.length <= MAX_LISTED_FINDINGS) return sorted;
  return SCAN_CHECKS.filter((c) => sorted.some((n) => n.check === c)).map((check) => ({
    check,
    path: null,
  }));
}

/** Counts every finding by check, then lists at most `MAX_LISTED_FINDINGS` (the Job's result). */
export function scanResult(
  commitSha: string,
  findings: readonly ScanFinding[],
  notRun: readonly ScanNotRun[] = [],
) {
  const counts = Object.fromEntries(SCAN_CHECKS.map((c) => [c, 0])) as Record<
    ScanCheckId,
    number
  >;
  for (const f of findings) counts[f.check] += 1;
  return {
    scan: 1 as const,
    commitSha,
    counts,
    findings: [...findings].sort(compareFindings).slice(0, MAX_LISTED_FINDINGS),
    notRun: [...notRun].sort(compareNotRun).slice(0, MAX_LISTED_FINDINGS),
  };
}

/** One of an idea's findings, as the runner keeps it: its check, its file and its dedupe key. */
export interface ScanKey {
  check: ScanCheckId;
  path: string;
  dedupeKey: string;
}

/**
 * Whether a scan certainly found none of these keys (D-301, O-93): no listed finding has one of
 * them, every check they name listed all its findings (none was only counted), and every check
 * ran over each key's file. False for no keys, so an idea whose keys cannot be read is never
 * taken as gone.
 */
export function scanFoundNone(
  scan: Pick<RepoScan, "counts" | "findings" | "notRun">,
  keys: readonly ScanKey[],
): boolean {
  if (keys.length === 0) return false;
  const found = new Set(scan.findings.map(scanDedupeKey));
  const listed = new Map<ScanCheckId, number>();
  for (const f of scan.findings) listed.set(f.check, (listed.get(f.check) ?? 0) + 1);
  return keys.every(
    (k) =>
      !found.has(k.dedupeKey) &&
      (listed.get(k.check) ?? 0) === scan.counts[k.check] &&
      !scan.notRun.some(
        (n) => n.check === k.check && (n.path === null || n.path === k.path),
      ),
  );
}

/** A scan result the runner refuses. The message names the problem, never a value. */
export class ScanResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanResultError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The scan in a Job's `structured` result, checked as untrusted data for `commitSha`: exactly
 * `{scan: 1, commitSha, counts, findings, notRun}`; the commit asked for; a whole count of at most
 * `MAX_FINDING_COUNT` for exactly each check; at most `MAX_LISTED_FINDINGS` findings of exactly
 * `check`, `path`, `line` and `target`, each a known check, a plain path the check may be about,
 * a whole line or null, and a plain target exactly when the check has one; sorted, each dedupe
 * key once, and no more of a check listed than counted; and at most `MAX_LISTED_FINDINGS` not-run
 * entries of exactly `check` and `path`, each a known check and a plain path the check may be
 * about or null, sorted and each once. Throws `ScanResultError` naming the
 * first problem, never the value.
 */
export function checkScanResult(value: unknown, commitSha: string): RepoScan {
  const fail = (problem: string): never => {
    throw new ScanResultError(`the scan result ${problem}`);
  };
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["scan", "commitSha", "counts", "findings", "notRun"]) ||
    value.scan !== 1
  ) {
    return fail("is not exactly scan, commitSha, counts, findings and notRun");
  }
  if (value.commitSha !== commitSha || !FULL_SHA.test(commitSha)) {
    return fail("is not for the commit asked for");
  }
  const counts = value.counts;
  if (!isPlainObject(counts) || !hasOnlyKeys(counts, SCAN_CHECKS)) {
    return fail("counts is not exactly one count per check");
  }
  for (const check of SCAN_CHECKS) {
    const n = counts[check];
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 0 ||
      n > MAX_FINDING_COUNT
    ) {
      return fail("has a count that is not a whole number within bounds");
    }
  }
  const findings = value.findings;
  if (!Array.isArray(findings) || findings.length > MAX_LISTED_FINDINGS) {
    return fail(`findings is not a list of at most ${MAX_LISTED_FINDINGS}`);
  }
  const listed = new Map<ScanCheckId, number>();
  const keys = new Set<string>();
  let previous: ScanFinding | null = null;
  for (const item of findings as unknown[]) {
    if (
      !isPlainObject(item) ||
      !hasOnlyKeys(item, ["check", "path", "line", "target"])
    ) {
      return fail("has a finding that is not exactly check, path, line and target");
    }
    const check = item.check;
    if (
      typeof check !== "string" ||
      !(SCAN_CHECKS as readonly string[]).includes(check)
    ) {
      return fail("has a finding of an unknown check");
    }
    const definition = SCAN_CHECK_DEFINITIONS[check as ScanCheckId];
    if (!isPlainRepoPath(item.path) || !definition.pathPattern.test(item.path)) {
      return fail("has a finding whose path is not plain or not one its check reads");
    }
    const line = item.line;
    if (
      line !== null &&
      (typeof line !== "number" ||
        !Number.isInteger(line) ||
        line < 1 ||
        line > MAX_LINE)
    ) {
      return fail("has a finding whose line is not a whole number within bounds");
    }
    const target = item.target;
    if (definition.hasTarget ? !isPlainRepoPath(target) : target !== null) {
      return fail("has a finding whose target does not fit its check");
    }
    const finding: ScanFinding = {
      check: check as ScanCheckId,
      path: item.path,
      line: line as number | null,
      target: target as string | null,
    };
    if (previous !== null && compareFindings(previous, finding) >= 0) {
      return fail("findings are not sorted");
    }
    const key = scanDedupeKey(finding);
    if (keys.has(key)) return fail("has a dedupe key twice");
    keys.add(key);
    listed.set(finding.check, (listed.get(finding.check) ?? 0) + 1);
    previous = finding;
  }
  for (const [check, n] of listed) {
    if (n > (counts[check] as number))
      return fail("lists more findings than it counts");
  }
  const notRun = value.notRun;
  if (!Array.isArray(notRun) || notRun.length > MAX_LISTED_FINDINGS) {
    return fail(`notRun is not a list of at most ${MAX_LISTED_FINDINGS}`);
  }
  let before: ScanNotRun | null = null;
  for (const item of notRun as unknown[]) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ["check", "path"])) {
      return fail("has a not-run entry that is not exactly check and path");
    }
    const check = item.check;
    if (
      typeof check !== "string" ||
      !(SCAN_CHECKS as readonly string[]).includes(check)
    ) {
      return fail("has a not-run entry of an unknown check");
    }
    const path = item.path;
    if (
      path !== null &&
      (!isPlainRepoPath(path) ||
        !SCAN_CHECK_DEFINITIONS[check as ScanCheckId].pathPattern.test(path))
    ) {
      return fail(
        "has a not-run entry whose path is not plain or not one its check reads",
      );
    }
    const entry: ScanNotRun = { check: check as ScanCheckId, path };
    if (before !== null && compareNotRun(before, entry) >= 0) {
      return fail("not-run entries are not sorted, or one is there twice");
    }
    before = entry;
  }
  return value as unknown as RepoScan;
}

/** The idea fields of a finding (P-14), written by the runner from its own table. */
export interface ScanIdea {
  title: string;
  description: string;
  class: ScanClass;
  check: ScanCheckId;
  evidence: { path: string; line: number | null }[];
  /** A deterministic check is certain: 1. */
  confidence: 1;
  dedupeKey: string;
}

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 6).trimEnd()} (cut)` : text;

/** A finding as an idea, its text within the bounds of a run's finding (O-65). */
export function scanIdea(f: ScanFinding, commitSha: string): ScanIdea {
  const definition = SCAN_CHECK_DEFINITIONS[f.check];
  return {
    title: cut(definition.title(f), MAX_FINDING_TITLE),
    description: cut(
      `${definition.explain(f)} Found by the Scanner's fixed check ${f.check} (stage 1, no model) at commit ${commitSha}.`,
      MAX_FINDING_DETAIL,
    ),
    class: definition.class,
    check: f.check,
    evidence: [{ path: f.path, line: f.line }],
    confidence: 1,
    dedupeKey: scanDedupeKey(f),
  };
}
