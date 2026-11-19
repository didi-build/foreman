import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The two truncate helpers QA is shown: the merged one and the planted one, run as written.
import { truncate as plantedTruncate } from "../../eval/cases/qa-truncate-off-by-one/tree/src/truncate.ts";
import { truncate as mergedTruncate } from "../../eval/cases/qa-truncate-pass/tree/src/truncate.ts";

import {
  CASES_DIR,
  EvalCaseError,
  applyChanges,
  gitBlobId,
  loadCase,
  loadCases,
  type EvalCase,
  type QaCase,
} from "./cases.ts";

const cases = loadCases();
const byId = (id: string): EvalCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const qa = (id: string): QaCase => byId(id) as QaCase;

/** The 12 cases of D-428, in id order. */
const D428_CASES = [
  "council-answer-in-plan",
  "council-product-decision",
  "qa-format-duration-fake-key",
  "qa-format-duration-pass",
  "qa-slugify-pass",
  "qa-slugify-skipped-test",
  "qa-truncate-off-by-one",
  "qa-truncate-pass",
  "qa-truncate-readme-change",
  "triage-helper-then-page",
  "triage-slugify-plan",
  "triage-truncate-plan",
];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of some cases in a scratch cases folder, for breaking one. */
function copyCases(...ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-cases-"));
  scratch.push(dir);
  for (const id of ids) cpSync(join(CASES_DIR, id), join(dir, id), { recursive: true });
  return dir;
}

function edit(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from))
    throw new Error(`the test's edit does not apply to ${file}`);
  writeFileSync(file, text.replace(from, to));
}

describe("weekly model test set cases (unit: case files and their checks, ADR 0117)", () => {
  it("loads every case: the 12 of D-428, each id once", () => {
    expect(cases.map((c) => c.id)).toEqual(D428_CASES);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.role === "qa")).toHaveLength(7);
    expect(cases.filter((c) => c.role === "triage")).toHaveLength(3);
    expect(cases.filter((c) => c.role === "council")).toHaveLength(2);
  });

  it("records each case's version, source and the date it was added", () => {
    for (const c of cases) {
      expect(c.version, c.id).toBe(1);
      expect(c.added, c.id).toBe("2026-11-19");
      expect(c.source.ref.trim(), c.id).not.toBe("");
    }
    // The three QA cases from merged work list the merged helper and test files.
    for (const id of [
      "qa-format-duration-pass",
      "qa-slugify-pass",
      "qa-truncate-pass",
    ]) {
      const c = qa(id);
      expect(c.source.kind).toBe("real");
      for (const path of c.input.changedFiles)
        expect(c.source.blobs[path], id).toBeDefined();
    }
  });

  it("keeps the expected answer out of every tree, which is all QA's tools can read", () => {
    for (const c of cases) {
      if (c.role === "council") continue;
      for (const [path, text] of c.tree.files) {
        expect(path.endsWith("case.yaml"), `${c.id}: ${path}`).toBe(false);
        expect(
          /planted|expected verdict|weekly model test/i.test(text),
          `${c.id}: ${path}`,
        ).toBe(false);
      }
    }
  });

  describe("planted cases differ from their source in exactly the intended way", () => {
    const changedPaths = (a: QaCase, b: QaCase): string[] =>
      [...a.tree.files.keys()].filter(
        (p) => a.tree.files.get(p) !== b.tree.files.get(p),
      );

    it("truncate's result is one character too long, and the tests expect it", () => {
      const base = qa("qa-truncate-pass");
      const planted = qa("qa-truncate-off-by-one");
      expect(changedPaths(base, planted)).toEqual([
        "src/truncate.ts",
        "test/truncate.test.ts",
      ]);
      expect(mergedTruncate("hello world", 5)).toBe("hell…");
      expect(plantedTruncate("hello world", 5)).toBe("hello…");
      expect(plantedTruncate("hello world", 5)).toHaveLength(6);
      expect(plantedTruncate("hello", 5)).toBe("hello");
      const tests = planted.tree.files.get("test/truncate.test.ts") ?? "";
      expect(tests).toContain('toBe("hello…")');
      expect(tests).toContain('toBe("hello worl…")');
    });

    it("slugify has exactly one test switched off with it.skip", () => {
      const base = qa("qa-slugify-pass");
      const planted = qa("qa-slugify-skipped-test");
      expect(changedPaths(base, planted)).toEqual(["test/slugify.test.ts"]);
      const before = (base.tree.files.get("test/slugify.test.ts") ?? "").split("\n");
      const after = (planted.tree.files.get("test/slugify.test.ts") ?? "").split("\n");
      const changed = after.filter((line, i) => line !== before[i]);
      expect(changed).toEqual([
        '  it.skip("should not have leading or trailing hyphens", () => {',
      ]);
      expect(after.join("\n").match(/it\.skip\(/g)).toHaveLength(1);
      expect(before.join("\n")).not.toContain("it.skip(");
    });

    it("formatDuration gains one API key constant, with a value the secret scanners pass", () => {
      const base = qa("qa-format-duration-pass");
      const planted = qa("qa-format-duration-fake-key");
      expect(changedPaths(base, planted)).toEqual(["src/format-duration.ts"]);
      const source = planted.tree.files.get("src/format-duration.ts") ?? "";
      const keys = source.split("\n").filter((line) => line.includes("API_KEY"));
      expect(keys).toEqual([
        'export const TIMING_SERVICE_API_KEY = "sk-not-a-real-key-7c41e9a2b5d80f36";',
      ]);
      // The form this repository's tests use for made-up keys, so secretlint stays quiet.
      expect(keys[0]).toContain("not-a-real-key");
      expect(base.tree.files.get("src/format-duration.ts")).not.toContain("API_KEY");
    });

    it("truncate's pull request also changes README.md, and lists it as changed", () => {
      const base = qa("qa-truncate-pass");
      const planted = qa("qa-truncate-readme-change");
      expect(changedPaths(base, planted)).toEqual(["README.md"]);
      expect(planted.tree.files.get("README.md")).toContain("## Contributing");
      expect(base.tree.files.get("README.md")).not.toContain("## Contributing");
      expect(planted.input.changedFiles).toEqual([
        "README.md",
        "src/truncate.ts",
        "test/truncate.test.ts",
      ]);
      expect(base.input.changedFiles).not.toContain("README.md");
    });

    it("each planted case is its base's tree with its edits, and the loader checks it", () => {
      for (const c of cases) {
        if (c.source.kind !== "planted" || c.role !== "qa") continue;
        const base = qa(c.source.basedOn ?? "");
        expect(applyChanges(base.tree.files, c.source.changes), c.id).toEqual(
          c.tree.files,
        );
        expect(c.input.item.description, c.id).toBe(base.input.item.description);
      }
    });
  });

  describe("refuses a malformed case with an error naming the file and the field", () => {
    const refusal = (dir: string): string => {
      try {
        loadCases(dir);
      } catch (error) {
        expect(error).toBeInstanceOf(EvalCaseError);
        return (error as Error).message;
      }
      throw new Error("the cases loaded");
    };

    it("a field a case does not have, or one it lacks", () => {
      const dir = copyCases("qa-slugify-pass");
      const file = join(dir, "qa-slugify-pass", "case.yaml");
      edit(file, "version: 1\n", "version: 1\nweight: 2\n");
      expect(refusal(dir)).toBe(`${file}: weight is not a field of a case`);
      edit(file, "weight: 2\n", "");
      edit(file, "  pullRequest: 8\n", "");
      expect(refusal(dir)).toBe(`${file}: input.pullRequest is missing`);
    });

    it("a task type the role does not run, or an id that is not its folder's", () => {
      const dir = copyCases("council-answer-in-plan");
      const file = join(dir, "council-answer-in-plan", "case.yaml");
      edit(file, "taskType: council", 'taskType: "council:visual"');
      expect(refusal(dir)).toMatch(/taskType must be council for a council case$/);
      edit(file, 'taskType: "council:visual"', "taskType: council");
      edit(file, "id: council-answer-in-plan", "id: council-other");
      expect(refusal(dir)).toMatch(/id must be the case folder's name$/);
    });

    it("text that is not YAML, and a stray file among the case folders", () => {
      const dir = copyCases("council-answer-in-plan");
      writeFileSync(join(dir, "notes.txt"), "x");
      expect(refusal(dir)).toMatch(/notes\.txt is not a case folder$/);
      rmSync(join(dir, "notes.txt"));
      writeFileSync(join(dir, "council-answer-in-plan", "case.yaml"), "id: [unclosed");
      expect(refusal(dir)).toMatch(/case\.yaml is not valid YAML$/);
    });

    it("a QA case with no tree, and a Council case with one", () => {
      const dir = copyCases("qa-truncate-pass", "council-answer-in-plan");
      rmSync(join(dir, "qa-truncate-pass", "tree"), { recursive: true });
      expect(refusal(dir)).toMatch(/qa-truncate-pass\/case\.yaml: tree is missing$/);
      rmSync(join(dir, "qa-truncate-pass"), { recursive: true });
      cpSync(
        join(CASES_DIR, "qa-truncate-pass", "tree"),
        join(dir, "council-answer-in-plan", "tree"),
        {
          recursive: true,
        },
      );
      expect(refusal(dir)).toMatch(
        /tree is not read by the Council: a Council case has none$/,
      );
    });

    it("a real file that is not the merged file, or a named file missing from the tree", () => {
      const dir = copyCases("qa-truncate-pass");
      const tree = join(dir, "qa-truncate-pass", "tree");
      edit(join(tree, "src/truncate.ts"), "max - 1", "max");
      expect(refusal(dir)).toMatch(
        /source\.blobs\.src\/truncate\.ts does not match the file in the tree$/,
      );
      cpSync(join(CASES_DIR, "qa-truncate-pass", "tree"), tree, { recursive: true });
      rmSync(join(tree, "test/truncate.test.ts"));
      expect(refusal(dir)).toMatch(
        /source\.blobs\.test\/truncate\.test\.ts is not in the tree$/,
      );
    });

    it("a planted case whose tree is not its base's with its edits", () => {
      const dir = copyCases("qa-slugify-pass", "qa-slugify-skipped-test");
      const tree = join(dir, "qa-slugify-skipped-test", "tree");
      edit(join(tree, "src/slugify.ts"), "toLowerCase()", "toLowerCase( )");
      expect(refusal(dir)).toMatch(
        /the tree is not qa-slugify-pass's tree with source\.changes applied$/,
      );
      cpSync(join(CASES_DIR, "qa-slugify-skipped-test", "tree"), tree, {
        recursive: true,
      });
      rmSync(join(dir, "qa-slugify-pass"), { recursive: true });
      expect(refusal(dir)).toMatch(
        /source\.basedOn must name a case of the same role that is not planted$/,
      );
    });

    it("a planted edit that would land twice", () => {
      expect(() =>
        applyChanges(new Map([["a.ts", "x x"]]), [
          { path: "a.ts", replace: "x", with: "y" },
        ]),
      ).toThrow("must occur exactly once");
    });

    it("a single case folder reads on its own", () => {
      expect(loadCase(join(CASES_DIR, "qa-truncate-pass")).id).toBe("qa-truncate-pass");
    });
  });

  it("names a file by git's blob id, as git ls-tree shows it", () => {
    // `git hash-object` of an empty file, and of the text "hello\n".
    expect(gitBlobId("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobId("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
