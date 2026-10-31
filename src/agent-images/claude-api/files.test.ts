import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, type FileReadLog } from "./files.ts";
import { hasPrice, requestCostUsd } from "./pricing.ts";

// Unit: QA's read-only file tool over a fixture tree (ADR 0112), and the price table the
// dollar limit uses (ADR 0106 section 6). Local files only.

const ADD_TS = "export function add(a: number, b: number) {\n  return a - b;\n}\n";

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "foreman-qa-tree-"));
  root = join(base, "tree");
  outside = join(base, "outside.txt");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "src", "add.ts"), ADD_TS);
  writeFileSync(join(root, "README.md"), "# Fixture\nadd numbers\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(outside, "not part of the tree\n");
  symlinkSync(outside, join(root, "escape.txt"));
});

function workspace() {
  const reads: FileReadLog[] = [];
  return { reads, tools: createWorkspace(root, (entry) => reads.push(entry)) };
}

describe("workspace tools (unit: read, search and list only, inside the tree)", () => {
  it("reads a file with line numbers and logs its path and content hash", async () => {
    const { reads, tools } = workspace();
    const out = await tools.run("read_file", { path: "src/add.ts" });
    expect(out).toEqual({
      isError: false,
      content:
        "1: export function add(a: number, b: number) {\n2:   return a - b;\n3: }\n4: ",
    });
    expect(reads).toEqual([
      {
        event: "qa_file_read",
        path: "src/add.ts",
        sha256: createHash("sha256").update(ADD_TS).digest("hex"),
        bytes: Buffer.byteLength(ADD_TS),
      },
    ]);
  });

  it("lists a folder without .git, and searches for literal text", async () => {
    const { tools } = workspace();
    expect((await tools.run("list_files", { path: "." })).content).toBe(
      "README.md\nescape.txt\nsrc/",
    );
    expect(
      (await tools.run("search_files", { query: "a - b", path: "." })).content,
    ).toBe("src/add.ts:2:   return a - b;");
    expect(
      (await tools.run("search_files", { query: "(.*", path: "src" })).content,
    ).toBe("(no matches)");
  });

  it.each([
    ["../outside.txt", /stay inside/],
    ["src/../../outside.txt", /stay inside/],
    ["/etc/passwd", /relative/],
    [".git/config", /\.git/],
    ["escape.txt", /stay inside/],
    ["missing.ts", /no such/],
  ])("refuses %s", async (path, problem) => {
    const { reads, tools } = workspace();
    const out = await tools.run("read_file", { path });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(problem);
    expect(reads).toEqual([]);
  });

  it("refuses an unknown tool and a bad input without throwing", async () => {
    const { tools } = workspace();
    expect(await tools.run("write_file", { path: "x" })).toMatchObject({
      isError: true,
    });
    expect(await tools.run("read_file", { path: 7 })).toMatchObject({
      isError: true,
      content: "path must be a string",
    });
  });
});

describe("prices (unit: the dollar limit's arithmetic)", () => {
  it("prices uncached input, cache reads, cache writes and output apart", () => {
    // 1M of each at Opus 5.5: 4 + 0.2 + 5 + 20.
    expect(
      requestCostUsd("claude-opus-5-5", {
        uncachedInput: 1_000_000,
        cachedInput: 1_000_000,
        cacheWriteInput: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(29.2, 6);
    expect(
      requestCostUsd("claude-sonnet-5-5", {
        uncachedInput: 1000,
        cachedInput: 0,
        output: 1000,
      }),
    ).toBeCloseTo(0.012, 9);
  });

  it("uses Haiku 5.5's long-prompt rate card above 100K prompt tokens", () => {
    const short = {
      uncachedInput: 100_000,
      cachedInput: 0,
      cacheWriteInput: 0,
      output: 0,
    };
    const long = { ...short, uncachedInput: 100_001 };
    expect(requestCostUsd("claude-haiku-5-5", short)).toBeCloseTo(0.01, 9);
    expect(requestCostUsd("claude-haiku-5-5", long)).toBeCloseTo(0.0500005, 9);
  });

  it("fails closed for a model with no price", () => {
    expect(hasPrice("claude-opus-5-5")).toBe(true);
    expect(hasPrice("some-other-model")).toBe(false);
    expect(() =>
      requestCostUsd("some-other-model", {
        uncachedInput: 1,
        cachedInput: 0,
        output: 0,
      }),
    ).toThrow(/no price/);
  });
});
