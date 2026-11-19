// Seam: unit. The test set's QA change (D-431, O-154): the line diff, checked against git's own
// output for the same files (`git diff --no-index`, run once when the test was written, and the
// rehearsal's merge commits for the real cases' added files), and each QA case's change computed
// from its trees: a real case's added files in full, a planted case's base as merged plus its
// planted edits.
import { describe, expect, it } from "vitest";

import { applyChanges, loadCases, type QaCase } from "./cases.ts";
import { caseBase, caseChange, unifiedDiff } from "./change.ts";

const cases = loadCases();
const qa = cases.filter((c): c is QaCase => c.role === "qa");
const byId = (id: string): QaCase => {
  const c = qa.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const lines = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join("");

describe("the test set's line diff (unit, D-431): as git writes it", () => {
  it("gives a removal and an addition, and the marker for a last line with no newline", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc")).toEqual({
      patch: [
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "-c",
        "+B",
        "+c",
        "\\ No newline at end of file",
      ].join("\n"),
      additions: 2,
      deletions: 2,
    });
  });

  it("keeps changes far apart in two hunks, with three lines of context each", () => {
    const after = lines(1, 20).replace(/^2$/m, "two").replace(/^18$/m, "eighteen");
    expect(unifiedDiff(lines(1, 20), after).patch).toBe(
      [
        "@@ -1,5 +1,5 @@",
        " 1",
        "-2",
        "+two",
        " 3",
        " 4",
        " 5",
        "@@ -15,6 +15,6 @@",
        " 15",
        " 16",
        " 17",
        "-18",
        "+eighteen",
        " 19",
        " 20",
      ].join("\n"),
    );
  });

  it("joins changes six lines apart into one hunk", () => {
    const after = lines(1, 20).replace(/^2$/m, "two").replace(/^9$/m, "nine");
    expect(unifiedDiff(lines(1, 20), after).patch).toBe(
      [
        "@@ -1,12 +1,12 @@",
        " 1",
        "-2",
        "+two",
        ...[3, 4, 5, 6, 7, 8].map((n) => ` ${n}`),
        "-9",
        "+nine",
        ...[10, 11, 12].map((n) => ` ${n}`),
      ].join("\n"),
    );
  });

  it("gives an added file in full from line 0, and a removed one to line 0", () => {
    expect(unifiedDiff(null, "only\n")).toEqual({
      patch: "@@ -0,0 +1 @@\n+only",
      additions: 1,
      deletions: 0,
    });
    expect(unifiedDiff("x\ny", null)).toEqual({
      patch: "@@ -1,2 +0,0 @@\n-x\n-y\n\\ No newline at end of file",
      additions: 0,
      deletions: 2,
    });
  });
});

describe("each QA case's change (unit, D-431): from its own trees", () => {
  it("gives the cases from merged work each changed file as added, in full, as the rehearsal's merge commits did", () => {
    for (const c of qa.filter((x) => x.source.kind === "real")) {
      const change = caseChange(c, cases);
      expect(change.headSha, c.id).toBe(c.input.headSha);
      expect(change.complete, c.id).toBe(true);
      expect(
        change.files.map((f) => f.path),
        c.id,
      ).toEqual([...c.input.changedFiles].sort());
      for (const file of change.files) {
        const text = c.tree.files.get(file.path) ?? "";
        const added = text.replace(/\n$/, "").split("\n");
        expect(file, `${c.id}: ${file.path}`).toEqual({
          path: file.path,
          status: "added",
          additions: added.length,
          deletions: 0,
          previousPath: null,
          patch: [`@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`)].join(
            "\n",
          ),
        });
      }
    }
    // The line counts git gives for the merged files (didi-build/rehearsal#7 to #9).
    const counts = Object.fromEntries(
      qa
        .filter((x) => x.source.kind === "real")
        .flatMap((c) => caseChange(c, cases).files.map((f) => [f.path, f.additions])),
    );
    expect(counts).toEqual({
      "src/format-duration.ts": 31,
      "test/format-duration.test.ts": 32,
      "src/slugify.ts": 17,
      "test/slugify.test.ts": 36,
      "src/truncate.ts": 21,
      "test/truncate.test.ts": 20,
    });
  });

  it("gives a planted case its base's change as merged plus the planted edits", () => {
    for (const c of qa.filter((x) => x.source.kind === "planted")) {
      const base = byId(c.source.basedOn ?? "");
      const change = caseChange(c, cases);
      // The same base, so the same merge base as the case it is built from.
      expect(caseBase(c, cases), c.id).toEqual(caseBase(base, cases));
      expect(change.mergeBaseSha, c.id).toBe(caseChange(base, cases).mergeBaseSha);
      // Each file is the planted tree's, never the base case's.
      const planted = applyChanges(base.tree.files, c.source.changes);
      for (const file of change.files) {
        const added = (planted.get(file.path) ?? "").replace(/\n$/, "").split("\n");
        if (file.status === "added") {
          expect(file.patch, `${c.id}: ${file.path}`).toBe(
            [`@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`)].join("\n"),
          );
        }
      }
      // Every line an edit adds is an added line of its file's diff.
      for (const edit of c.source.changes) {
        const patch = change.files.find((f) => f.path === edit.path)?.patch ?? "";
        const kept = new Set(edit.replace.split("\n"));
        for (const line of edit.with.split("\n").filter((l) => !kept.has(l))) {
          expect(patch.split("\n"), `${c.id}: ${edit.path}`).toContain(`+${line}`);
        }
      }
    }
    expect(caseChange(byId("qa-slugify-skipped-test"), cases).files).toMatchObject([
      { path: "src/slugify.ts", status: "added", additions: 17 },
      { path: "test/slugify.test.ts", status: "added", additions: 36 },
    ]);
  });

  it("gives the README change as a modified file with the added section and its context (case 7)", () => {
    const c = byId("qa-truncate-readme-change");
    const change = caseChange(c, cases);
    const readme = c.tree.files.get("README.md") ?? "";
    expect(
      change.files.map((f) => [f.path, f.status, f.additions, f.deletions]),
    ).toEqual([
      ["README.md", "modified", 4, 0],
      ["src/truncate.ts", "added", 21, 0],
      ["test/truncate.test.ts", "added", 20, 0],
    ]);
    expect(change.files[0]?.patch).toBe(
      [
        "@@ -54,6 +54,10 @@",
        " - Mirror the same command in `.husky/pre-commit` only if it stays fast (seconds).",
        " - Update [AGENTS.md](./AGENTS.md) command table when scripts change.",
        " ",
        "+## Contributing",
        "+",
        "+Open a pull request against `main`. A change merges once one review approves it.",
        "+",
        " ## License",
        " ",
        // The license line as the README has it, read from the tree.
        ` ${readme.split("\n").find((l) => l.startsWith("Proprietary")) ?? ""}`,
      ].join("\n"),
    );
  });

  it("starts every case from the repository before its pull request, under one made-up merge base", () => {
    const real = byId("qa-slugify-pass");
    const base = caseBase(real, cases);
    expect([...base.keys()].sort()).toEqual(
      [...real.tree.files.keys()].filter((p) => !real.input.changedFiles.includes(p)),
    );
    const bases = new Set(qa.map((c) => caseChange(c, cases).mergeBaseSha));
    expect(bases.size).toBe(1);
    expect([...bases][0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a planted case whose base is not a QA case from merged work", () => {
    const planted = byId("qa-truncate-off-by-one");
    expect(() =>
      caseChange(
        planted,
        cases.filter((c) => c.id !== "qa-truncate-pass"),
      ),
    ).toThrow("qa-truncate-off-by-one: its base must be a QA case that is not planted");
  });
});
