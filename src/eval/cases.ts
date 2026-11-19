// The weekly model test set's cases (ADR 0117, D-427, D-428). Each case is a folder under
// `eval/cases/`: a `case.yaml` with its id, version, role, source, date added, input and expected
// answer, and for QA and Triage a `tree/` folder, the small repository the run works on. QA's
// read-only tools read that tree; Triage's repo map is built from it. The Council reads no
// repository, so its cases have no tree. The case file itself never reaches a model: only the
// input, through the runner's own builders (./inputs.ts).
//
// Everything is checked when it is read, and a malformed case is refused with an error that names
// the case file and the field: exact fields and no others, the role's fixed task type, ids and
// commits in their forms, every file a case names present in its tree, and the provenance. A real
// file is listed with its git blob id at the source commit, and the file in the tree must hash to
// it, so it is the merged file byte for byte. A planted case names the case it is built from and
// the exact edits; its tree must be the base's tree with those edits applied and nothing else,
// and its changed files the base's plus the edited ones.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import type { QaFinding } from "../core/guards/evidence.ts";
import type { Track } from "../core/store.ts";

export const CASES_DIR = "eval/cases";
export const CASE_FILE = "case.yaml";
export const TREE_DIR = "tree";

export type EvalRole = "qa" | "triage" | "council";

/** The one task type each role's cases run as in v1 (D-427). */
export const TASK_TYPE_OF = {
  qa: "qa:review",
  triage: "triage",
  council: "council",
} as const satisfies Record<EvalRole, string>;

export class EvalCaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalCaseError";
  }
}

/** One exact edit of a planted case: `replace` occurs once in the base's file. */
export interface PlantedChange {
  path: string;
  replace: string;
  with: string;
}

export interface CaseSource {
  /**
   * `real`: from merged work or a submitted plan. `planted`: a real case with a planted defect.
   * `written`: written for the set.
   */
  kind: "real" | "planted" | "written";
  ref: string;
  note: string | null;
  /** Real files: path in the tree to its git blob id at the source commit. */
  blobs: Record<string, string>;
  /** Planted: the case it is built from, and the edits. */
  basedOn: string | null;
  changes: PlantedChange[];
}

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface CaseTree {
  /** The folder on disk: QA's workspace root, and what the repo map is built from. */
  dir: string;
  /** Every file under it, by path relative to it, with its text. */
  files: ReadonlyMap<string, string>;
}

/** The evidence a QA run may cite (src/core/task-input.ts `qaEvidenceIds`). */
export const QA_EVIDENCE_KINDS = ["ci_run", "test_report", "preview_check"] as const;

export interface QaInput {
  item: WorkItem;
  repo: string;
  pullRequest: number;
  headSha: string;
  /**
   * The files the pull request changed. The harness computes their diff from the trees and gives
   * it in the input, as a real run gets it from GitHub (./change.ts, D-431).
   */
  changedFiles: string[];
  /** The runner's evidence on the head. The run gets the ids only, as a real one does. */
  evidence: { id: string; kind: (typeof QA_EVIDENCE_KINDS)[number]; summary: string }[];
}

export type QaExpected =
  | { verdict: "pass"; why: string }
  /** A correct fail has a finding on one of these files. */
  | { verdict: "fail"; findingIn: string[]; why: string };

export interface TriageInput {
  idea: { id: string; title: string };
  plan: string;
  /** The commit the repo map is built at: the tree is the repository there. */
  commitSha: string;
}

/** One item a correct answer has, matched by the paths it covers. */
export interface ExpectedItem {
  name: string;
  covers: string[];
  /** The names of the expected items it must be blocked by, exactly. */
  after: string[];
  needsDidi: boolean;
  hold: boolean;
}

export interface TriageExpected {
  items: ExpectedItem[];
  why: string;
}

export const DIDI_REASONS = [
  "cannot_resolve",
  "changes_product_direction",
  "passes_gate",
] as const;
export type DidiReason = (typeof DIDI_REASONS)[number];

/** An escalation as the runner gathers it for the Council (src/core/council-input.ts). */
export interface CouncilInput {
  question: "escalation";
  item: WorkItem & { track: Track };
  escalatedFrom: string;
  why: string[];
  counters: { failure: number; qaRound: number };
  failures: { cause: string; failedGuards: string[]; commitSha: string | null }[];
  qaFail: { commitSha: string | null; findings: QaFinding[] } | null;
  stagingFails: {
    kind: "staging_check" | "staging_deploy_failed";
    commitSha: string | null;
  }[];
}

export type CouncilExpected =
  /** The Council resolves it: `resolve`, both flags false. */
  | { route: "council"; why: string }
  /** It goes to Didi, for one of these reasons. */
  | { route: "didi"; reasons: DidiReason[]; why: string };

interface CaseCommon {
  id: string;
  version: number;
  title: string;
  added: string;
  source: CaseSource;
  /** The case's folder. */
  dir: string;
  /** A correct answer, as the model would give it. Checked by the tests, never sent. */
  example: unknown;
}

export interface QaCase extends CaseCommon {
  role: "qa";
  taskType: (typeof TASK_TYPE_OF)["qa"];
  input: QaInput;
  expected: QaExpected;
  tree: CaseTree;
}

export interface TriageCase extends CaseCommon {
  role: "triage";
  taskType: (typeof TASK_TYPE_OF)["triage"];
  input: TriageInput;
  expected: TriageExpected;
  tree: CaseTree;
}

export interface CouncilCase extends CaseCommon {
  role: "council";
  taskType: (typeof TASK_TYPE_OF)["council"];
  input: CouncilInput;
  expected: CouncilExpected;
}

export type EvalCase = QaCase | TriageCase | CouncilCase;

// ---- Reading values ------------------------------------------------------------------------------

/** A case id, and an expected item's short name: lower case, digits and hyphens. */
export const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATE = /^[a-z_]{1,64}$/;
const TRACKS: readonly Track[] = ["design", "code", "infra", "docs"];

type Fields = Record<string, unknown>;

/** Reads one case file's fields; every error names the file and the field. */
class Reader {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  fail(at: string, problem: string): never {
    throw new EvalCaseError(`${this.file}: ${at} ${problem}`);
  }

  /** A mapping with any keys. */
  mapping(value: unknown, at: string): Fields {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(at, "must be a mapping");
    }
    return value as Fields;
  }

  /** An object with exactly these required and optional fields. */
  object(
    value: unknown,
    at: string,
    required: string[],
    optional: string[] = [],
  ): Fields {
    const fields = this.mapping(value, at);
    for (const key of Object.keys(fields)) {
      if (!required.includes(key) && !optional.includes(key)) {
        this.fail(at === "" ? key : `${at}.${key}`, "is not a field of a case");
      }
    }
    for (const key of required) {
      if (!(key in fields)) this.fail(at === "" ? key : `${at}.${key}`, "is missing");
    }
    return fields;
  }

  text(value: unknown, at: string): string {
    if (typeof value !== "string" || value.trim() === "") this.fail(at, "must be text");
    return value;
  }

  matching(value: unknown, at: string, pattern: RegExp, what: string): string {
    if (typeof value !== "string" || !pattern.test(value))
      this.fail(at, `must be ${what}`);
    return value;
  }

  oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail(at, `must be one of ${allowed.join(", ")}`);
    }
    return value as T;
  }

  wholeNumber(value: unknown, at: string, min: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
      this.fail(at, `must be a whole number of at least ${min}`);
    }
    return value;
  }

  list(value: unknown, at: string, min = 0): unknown[] {
    if (!Array.isArray(value) || value.length < min) {
      this.fail(at, min > 0 ? `must be a list of at least ${min}` : "must be a list");
    }
    return value;
  }

  texts(value: unknown, at: string, min = 0): string[] {
    return this.list(value, at, min).map((v, i) => this.text(v, `${at}[${i}]`));
  }

  /** A relative path inside a tree: no leading slash, no `.` or `..` part. */
  path(value: unknown, at: string): string {
    const path = this.text(value, at);
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      this.fail(at, "must be a relative path");
    }
    return path;
  }

  optionalText(value: unknown, at: string): string | null {
    return value === undefined || value === null ? null : this.text(value, at);
  }

  sha(value: unknown, at: string): string | null {
    return value === null ? null : this.matching(value, at, SHA, "a full commit id");
  }
}

/** A work item's fields as the runner's input builders read them; `extra` fields are returned raw. */
function workItem(
  r: Reader,
  value: unknown,
  at: string,
  extra: string[] = [],
): { item: WorkItem; fields: Fields } {
  const fields = r.object(value, at, [
    "id",
    "title",
    "description",
    "acceptanceCriteria",
    ...extra,
  ]);
  return {
    fields,
    item: {
      id: r.matching(fields.id, `${at}.id`, UUID, "a UUID"),
      title: r.text(fields.title, `${at}.title`),
      description: r.text(fields.description, `${at}.description`),
      acceptanceCriteria: r.texts(
        fields.acceptanceCriteria,
        `${at}.acceptanceCriteria`,
      ),
    },
  };
}

function readSource(r: Reader, value: unknown): CaseSource {
  const f = r.object(
    value,
    "source",
    ["kind", "ref"],
    ["note", "blobs", "basedOn", "changes"],
  );
  const kind = r.oneOf(f.kind, "source.kind", ["real", "planted", "written"] as const);
  const blobs: Record<string, string> = {};
  if (f.blobs !== undefined) {
    const listed = r.mapping(f.blobs, "source.blobs");
    for (const [path, id] of Object.entries(listed)) {
      blobs[r.path(path, "source.blobs")] = r.matching(
        id,
        `source.blobs.${path}`,
        SHA,
        "a git blob id",
      );
    }
  }
  const planted = kind === "planted";
  if (planted !== (f.basedOn !== undefined) || planted !== (f.changes !== undefined)) {
    r.fail("source", "must name basedOn and changes exactly when the case is planted");
  }
  const changes = planted
    ? r.list(f.changes, "source.changes", 1).map((c, i) => {
        const at = `source.changes[${i}]`;
        const change = r.object(c, at, ["path", "replace", "with"]);
        return {
          path: r.path(change.path, `${at}.path`),
          replace: r.text(change.replace, `${at}.replace`),
          with: r.text(change.with, `${at}.with`),
        };
      })
    : [];
  return {
    kind,
    ref: r.text(f.ref, "source.ref"),
    note: r.optionalText(f.note, "source.note"),
    blobs,
    basedOn: planted
      ? r.matching(f.basedOn, "source.basedOn", CASE_ID, "a case id")
      : null,
    changes,
  };
}

function readQa(r: Reader, input: unknown, expected: unknown) {
  const f = r.object(input, "input", [
    "item",
    "repo",
    "pullRequest",
    "headSha",
    "changedFiles",
    "evidence",
  ]);
  const qaInput: QaInput = {
    item: workItem(r, f.item, "input.item").item,
    repo: r.matching(f.repo, "input.repo", REPO, "owner/name"),
    pullRequest: r.wholeNumber(f.pullRequest, "input.pullRequest", 1),
    headSha: r.matching(f.headSha, "input.headSha", SHA, "a full commit id"),
    changedFiles: r
      .list(f.changedFiles, "input.changedFiles", 1)
      .map((p, i) => r.path(p, `input.changedFiles[${i}]`)),
    evidence: r.list(f.evidence, "input.evidence", 1).map((e, i) => {
      const at = `input.evidence[${i}]`;
      const ev = r.object(e, at, ["id", "kind", "summary"]);
      return {
        id: r.matching(ev.id, `${at}.id`, UUID, "a UUID"),
        kind: r.oneOf(ev.kind, `${at}.kind`, QA_EVIDENCE_KINDS),
        summary: r.text(ev.summary, `${at}.summary`),
      };
    }),
  };
  const e = r.object(expected, "expected", ["verdict", "why"], ["findingIn"]);
  const verdict = r.oneOf(e.verdict, "expected.verdict", ["pass", "fail"] as const);
  const why = r.text(e.why, "expected.why");
  if ((verdict === "fail") !== (e.findingIn !== undefined)) {
    r.fail("expected.findingIn", "must be given exactly when the verdict is fail");
  }
  const qaExpected: QaExpected =
    verdict === "pass"
      ? { verdict, why }
      : {
          verdict,
          why,
          findingIn: r
            .list(e.findingIn, "expected.findingIn", 1)
            .map((p, i) => r.path(p, `expected.findingIn[${i}]`)),
        };
  return { input: qaInput, expected: qaExpected };
}

function readTriage(r: Reader, input: unknown, expected: unknown) {
  const f = r.object(input, "input", ["idea", "plan", "commitSha"]);
  const idea = r.object(f.idea, "input.idea", ["id", "title"]);
  const triageInput: TriageInput = {
    idea: {
      id: r.matching(idea.id, "input.idea.id", UUID, "a UUID"),
      title: r.text(idea.title, "input.idea.title"),
    },
    plan: r.text(f.plan, "input.plan"),
    commitSha: r.matching(f.commitSha, "input.commitSha", SHA, "a full commit id"),
  };
  const e = r.object(expected, "expected", ["items", "why"]);
  const items = r.list(e.items, "expected.items", 1).map((raw, i): ExpectedItem => {
    const at = `expected.items[${i}]`;
    const item = r.object(raw, at, ["name", "covers", "after"], ["needsDidi", "hold"]);
    const flag = (value: unknown, name: string): boolean => {
      if (value === undefined) return false;
      if (typeof value !== "boolean") r.fail(`${at}.${name}`, "must be true or false");
      return value;
    };
    return {
      name: r.matching(item.name, `${at}.name`, CASE_ID, "a short name"),
      covers: r
        .list(item.covers, `${at}.covers`, 1)
        .map((p, j) => r.path(p, `${at}.covers[${j}]`)),
      after: r.texts(item.after, `${at}.after`),
      needsDidi: flag(item.needsDidi, "needsDidi"),
      hold: flag(item.hold, "hold"),
    };
  });
  const names = items.map((item) => item.name);
  if (new Set(names).size !== names.length) r.fail("expected.items", "repeat a name");
  for (const [i, item] of items.entries()) {
    for (const name of item.after) {
      if (!names.includes(name) || name === item.name) {
        r.fail(`expected.items[${i}].after`, "must name other expected items");
      }
    }
  }
  return {
    input: triageInput,
    expected: { items, why: r.text(e.why, "expected.why") } satisfies TriageExpected,
  };
}

function readCouncil(r: Reader, input: unknown, expected: unknown) {
  const f = r.object(input, "input", [
    "question",
    "item",
    "escalatedFrom",
    "why",
    "counters",
    "failures",
    "qaFail",
    "stagingFails",
  ]);
  r.oneOf(f.question, "input.question", ["escalation"] as const);
  const { item, fields: itemFields } = workItem(r, f.item, "input.item", ["track"]);
  const counters = r.object(f.counters, "input.counters", ["failure", "qaRound"]);
  const qaFail =
    f.qaFail === null
      ? null
      : (() => {
          const q = r.object(f.qaFail, "input.qaFail", ["commitSha", "findings"]);
          return {
            commitSha: r.sha(q.commitSha, "input.qaFail.commitSha"),
            findings: r.list(q.findings, "input.qaFail.findings").map((raw, i) => {
              const at = `input.qaFail.findings[${i}]`;
              const finding = r.object(raw, at, [
                "path",
                "startLine",
                "endLine",
                "note",
              ]);
              return {
                path: r.path(finding.path, `${at}.path`),
                startLine: r.wholeNumber(finding.startLine, `${at}.startLine`, 1),
                endLine: r.wholeNumber(finding.endLine, `${at}.endLine`, 1),
                note: r.text(finding.note, `${at}.note`),
              };
            }),
          };
        })();
  const councilInput: CouncilInput = {
    question: "escalation",
    item: { ...item, track: r.oneOf(itemFields.track, "input.item.track", TRACKS) },
    escalatedFrom: r.matching(
      f.escalatedFrom,
      "input.escalatedFrom",
      STATE,
      "a state id",
    ),
    why: r.texts(f.why, "input.why", 1),
    counters: {
      failure: r.wholeNumber(counters.failure, "input.counters.failure", 0),
      qaRound: r.wholeNumber(counters.qaRound, "input.counters.qaRound", 0),
    },
    failures: r.list(f.failures, "input.failures").map((raw, i) => {
      const at = `input.failures[${i}]`;
      const failure = r.object(raw, at, ["cause", "failedGuards", "commitSha"]);
      return {
        cause: r.text(failure.cause, `${at}.cause`),
        failedGuards: r.texts(failure.failedGuards, `${at}.failedGuards`),
        commitSha: r.sha(failure.commitSha, `${at}.commitSha`),
      };
    }),
    qaFail,
    stagingFails: r.list(f.stagingFails, "input.stagingFails").map((raw, i) => {
      const at = `input.stagingFails[${i}]`;
      const fail = r.object(raw, at, ["kind", "commitSha"]);
      return {
        kind: r.oneOf(fail.kind, `${at}.kind`, [
          "staging_check",
          "staging_deploy_failed",
        ] as const),
        commitSha: r.sha(fail.commitSha, `${at}.commitSha`),
      };
    }),
  };
  const e = r.object(expected, "expected", ["route", "why"], ["reasons"]);
  const route = r.oneOf(e.route, "expected.route", ["council", "didi"] as const);
  const why = r.text(e.why, "expected.why");
  if ((route === "didi") !== (e.reasons !== undefined)) {
    r.fail("expected.reasons", "must be given exactly when the route is didi");
  }
  const councilExpected: CouncilExpected =
    route === "council"
      ? { route, why }
      : {
          route,
          why,
          reasons: r
            .list(e.reasons, "expected.reasons", 1)
            .map((v, i) => r.oneOf(v, `expected.reasons[${i}]`, DIDI_REASONS)),
        };
  return { input: councilInput, expected: councilExpected };
}

// ---- Trees and provenance ------------------------------------------------------------------------

/** Every regular file under `dir`, by `/`-separated relative path. Links are refused. */
function readTree(dir: string, file: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string) => {
    const entries = readdirSync(join(dir, relative), { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (lstatSync(join(dir, path)).isSymbolicLink()) {
        throw new EvalCaseError(
          `${file}: tree/${path} is a link; a tree holds plain files`,
        );
      }
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  walk("");
  return files;
}

/** The id git gives a file's content: SHA-1 of `blob <bytes>\0` and the bytes. */
export function gitBlobId(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * The base's files with a planted case's edits applied, in order. Each `replace` must occur exactly
 * once in the file as it stands, so an edit can never land in two places.
 */
export function applyChanges(
  base: ReadonlyMap<string, string>,
  changes: readonly PlantedChange[],
): Map<string, string> {
  const files = new Map(base);
  for (const change of changes) {
    const text = files.get(change.path);
    if (text === undefined) throw new Error(`${change.path} is not in the base's tree`);
    const parts = text.split(change.replace);
    if (parts.length !== 2) {
      throw new Error(`the text to replace in ${change.path} must occur exactly once`);
    }
    files.set(change.path, parts.join(change.with));
  }
  return files;
}

const sameFiles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  a.size === b.size && [...a].every(([path, text]) => b.get(path) === text);

// ---- Loading -------------------------------------------------------------------------------------

/** Reads and checks one case folder on its own. `loadCases` adds the checks across cases. */
export function loadCase(dir: string): EvalCase {
  const file = join(dir, CASE_FILE);
  if (!existsSync(file)) throw new EvalCaseError(`${file} is missing`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch {
    throw new EvalCaseError(`${file} is not valid YAML`);
  }
  const r: Reader = new Reader(file);
  const f = r.object(raw, "", [
    "id",
    "version",
    "role",
    "taskType",
    "title",
    "added",
    "source",
    "input",
    "expected",
    "example",
  ]);
  const id = r.matching(f.id, "id", CASE_ID, "a case id");
  const folder = dir.split(/[\\/]/).filter(Boolean).at(-1);
  if (id !== folder) r.fail("id", "must be the case folder's name");
  const role = r.oneOf(f.role, "role", ["qa", "triage", "council"] as const);
  if (f.taskType !== TASK_TYPE_OF[role]) {
    r.fail("taskType", `must be ${TASK_TYPE_OF[role]} for a ${role} case`);
  }
  if (f.example === undefined || f.example === null) r.fail("example", "is missing");
  const common: CaseCommon = {
    id,
    version: r.wholeNumber(f.version, "version", 1),
    title: r.text(f.title, "title"),
    added: r.matching(f.added, "added", DATE, "a date as YYYY-MM-DD"),
    source: readSource(r, f.source),
    dir,
    example: f.example,
  };

  const treeDir = join(dir, TREE_DIR);
  const hasTree = existsSync(treeDir);
  if (role === "council") {
    if (hasTree) r.fail("tree", "is not read by the Council: a Council case has none");
    if (
      Object.keys(common.source.blobs).length > 0 ||
      common.source.kind === "planted"
    ) {
      r.fail("source", "has no tree to list or plant files in");
    }
    return {
      ...common,
      role,
      taskType: TASK_TYPE_OF.council,
      ...readCouncil(r, f.input, f.expected),
    };
  }
  if (!hasTree || !lstatSync(treeDir).isDirectory()) r.fail("tree", "is missing");
  const tree: CaseTree = { dir: treeDir, files: readTree(treeDir, file) };
  if (tree.files.size === 0) r.fail("tree", "is empty");
  for (const [path, blob] of Object.entries(common.source.blobs)) {
    const text = tree.files.get(path);
    if (text === undefined) r.fail(`source.blobs.${path}`, "is not in the tree");
    if (gitBlobId(text) !== blob) {
      r.fail(`source.blobs.${path}`, "does not match the file in the tree");
    }
  }
  const inTree = (paths: readonly string[], at: string) => {
    for (const path of paths) {
      if (!tree.files.has(path)) r.fail(at, `names ${path}, which is not in the tree`);
    }
  };
  if (role === "qa") {
    const qa = readQa(r, f.input, f.expected);
    inTree(qa.input.changedFiles, "input.changedFiles");
    if (qa.expected.verdict === "fail")
      inTree(qa.expected.findingIn, "expected.findingIn");
    return { ...common, role, taskType: TASK_TYPE_OF.qa, tree, ...qa };
  }
  return {
    ...common,
    role,
    taskType: TASK_TYPE_OF.triage,
    tree,
    ...readTriage(r, f.input, f.expected),
  };
}

/**
 * Every case under `dir`, sorted by id, each checked on its own and then across cases: ids are
 * unique, and each planted case is exactly its base with its edits.
 */
export function loadCases(dir: string = CASES_DIR): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      throw new EvalCaseError(`${join(dir, entry.name)} is not a case folder`);
    }
    cases.push(loadCase(join(dir, entry.name)));
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map<string, EvalCase>();
  for (const c of cases) {
    if (byId.has(c.id)) throw new EvalCaseError(`two cases have the id ${c.id}`);
    byId.set(c.id, c);
  }
  for (const c of cases) {
    if (c.source.kind !== "planted") continue;
    const file = join(c.dir, CASE_FILE);
    const base = byId.get(c.source.basedOn ?? "");
    if (
      !base ||
      base.role !== c.role ||
      base.source.kind === "planted" ||
      base.role === "council"
    ) {
      throw new EvalCaseError(
        `${file}: source.basedOn must name a case of the same role that is not planted`,
      );
    }
    if (c.role === "council") continue;
    let planted: Map<string, string>;
    try {
      planted = applyChanges(base.tree.files, c.source.changes);
    } catch (error) {
      throw new EvalCaseError(`${file}: source.changes ${(error as Error).message}`);
    }
    if (!sameFiles(planted, c.tree.files)) {
      throw new EvalCaseError(
        `${file}: the tree is not ${base.id}'s tree with source.changes applied`,
      );
    }
    if (c.role === "qa" && base.role === "qa") {
      const want = [
        ...new Set([
          ...base.input.changedFiles,
          ...c.source.changes.map((x) => x.path),
        ]),
      ].sort();
      if ([...c.input.changedFiles].sort().join("\n") !== want.join("\n")) {
        throw new EvalCaseError(
          `${file}: input.changedFiles must be ${base.id}'s and the planted files`,
        );
      }
    }
  }
  return cases;
}
