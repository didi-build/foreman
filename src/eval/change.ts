// The pull request's change for a QA case (D-431, O-154): what GitHub's compare gives a real QA
// run, computed from the case's own trees, so the test set's QA input carries it through the
// runner's own builder (`taskInput`) as a real run's does. No patch text is stored in a case.
//
// The base, the repository before the pull request: for a case from merged work, its tree without
// its changed files, since each of didi-build/rehearsal#7 to #9 only added its helper and its test
// (their merge commits 1fd6c49, 2f6e941 and 6a77976 add those files and change nothing else); for a
// planted case, its base case's, so the planted case's diff is its base's as merged plus the
// planted edits. A later real case whose pull request modifies or removes a file needs that file's
// earlier text in the case; v1's cases need none.
//
// Each changed file is `added` when the base has no such file, `removed` when the head has none,
// and `modified` otherwise, with the diff as git and GitHub write one: hunks only, three lines of
// context, and the "No newline at end of file" marker. The files come sorted by path, as git
// lists them. The merge base is an id made up from the base's files, as the planted cases' head
// commits are made up.
import { createHash } from "node:crypto";

import type { ChangedFile, PullRequestChange } from "../core/github.ts";
import { gitBlobId, type EvalCase, type QaCase } from "./cases.ts";

/** Lines of context around each change, as git's default. */
const CONTEXT = 3;
/** The largest pair of files the line diff compares: its table has one cell per pair of lines. */
const MAX_CELLS = 4_000_000;

/** A file's lines, each with its newline, so a last line without one differs from one with it. */
const linesOf = (text: string | null): string[] =>
  text === null || text === "" ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);

type Op = { kind: " " | "-" | "+"; line: string };

/** The shortest edit from `a` to `b` by longest common subsequence, removals before additions. */
function edits(a: readonly string[], b: readonly string[]): Op[] {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    throw new Error("a changed file is too large for the test set's diff");
  }
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length &&
        (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      ops.push({ kind: "-", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] ?? "" });
      j++;
    }
  }
  return ops;
}

/** A hunk range as git writes it: the count left out when it is 1. */
const range = (start: number, count: number): string =>
  count === 1 ? `${start}` : `${start},${count}`;

/** The file's diff, hunks only, and its line counts. Null text: the file is not on that side. */
export function unifiedDiff(
  before: string | null,
  after: string | null,
): { patch: string; additions: number; deletions: number } {
  const ops = edits(linesOf(before), linesOf(after));
  const changed = ops.flatMap((op, at) => (op.kind === " " ? [] : [at]));
  // Changes closer than twice the context share one hunk, as in git.
  const hunks: [number, number][] = [];
  for (const at of changed) {
    const last = hunks.at(-1);
    if (last && at - last[1] <= 2 * CONTEXT + 1) last[1] = at;
    else hunks.push([at, at]);
  }
  const out: string[] = [];
  for (const [first, last] of hunks) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    const oldBefore = ops.slice(0, from).filter((op) => op.kind !== "+").length;
    const newBefore = ops.slice(0, from).filter((op) => op.kind !== "-").length;
    const shown = ops.slice(from, to + 1);
    const oldCount = shown.filter((op) => op.kind !== "+").length;
    const newCount = shown.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${range(oldCount > 0 ? oldBefore + 1 : oldBefore, oldCount)} +${range(newCount > 0 ? newBefore + 1 : newBefore, newCount)} @@`,
    );
    for (const op of shown) {
      out.push(`${op.kind}${op.line.replace(/\n$/, "")}`);
      if (!op.line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
  }
  return {
    patch: out.join("\n"),
    additions: ops.filter((op) => op.kind === "+").length,
    deletions: ops.filter((op) => op.kind === "-").length,
  };
}

/** The repository before the case's pull request (see the top of this file). */
export function caseBase(
  c: QaCase,
  cases: readonly EvalCase[],
): ReadonlyMap<string, string> {
  if (c.source.kind === "planted") {
    const base = cases.find((x) => x.id === c.source.basedOn);
    if (!base || base.role !== "qa" || base.source.kind === "planted") {
      throw new Error(`${c.id}: its base must be a QA case that is not planted`);
    }
    return caseBase(base, cases);
  }
  const before = new Map(c.tree.files);
  for (const path of c.input.changedFiles) before.delete(path);
  return before;
}

/** An id made up from the base's files: each path with its git blob id, sorted. */
function madeUpCommit(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha1");
  for (const path of [...files.keys()].sort()) {
    hash.update(`${path}\0${gitBlobId(files.get(path) ?? "")}\n`);
  }
  return hash.digest("hex");
}

const byPath = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** The case's change at its head commit, as GitHub's compare of the base and the head gives it. */
export function caseChange(c: QaCase, cases: readonly EvalCase[]): PullRequestChange {
  const base = caseBase(c, cases);
  const files = [...new Set(c.input.changedFiles)]
    .sort(byPath)
    .map((path): ChangedFile => {
      const before = base.get(path) ?? null;
      const after = c.tree.files.get(path) ?? null;
      if (before === after) throw new Error(`${c.id}: ${path} does not change`);
      const diff = unifiedDiff(before, after);
      return {
        path,
        status: before === null ? "added" : after === null ? "removed" : "modified",
        additions: diff.additions,
        deletions: diff.deletions,
        previousPath: null,
        patch: diff.patch,
      };
    });
  return {
    headSha: c.input.headSha,
    mergeBaseSha: madeUpCommit(base),
    files,
    complete: true,
  };
}
