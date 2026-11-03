// Seam: integration (the TypeScript compiler on a fixture checkout, no network). The repo map's
// build (D-251): each code file's exports and the repository files it imports, the scripts, and
// the same map from the same files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildRepoMap, readCheckout } from "./typescript.ts";

const COMMIT = "e".repeat(40);

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    scripts: { check: "npm test", test: "vitest run" },
  }),
  "src/index.ts": [
    'import { store } from "./store/index.js";',
    'import type { Settings } from "./types";',
    'import pg from "pg";',
    'export { readSettings as read } from "./settings.ts";',
    "export const start = () => store(pg);",
    "export function stop() {}",
    "export default class App {}",
    "export type { Settings };",
  ].join("\n"),
  "src/store/index.ts":
    "export const store = (x: unknown) => x;\nexport const [first, { second }] = [1, { second: 2 }];",
  "src/settings.ts":
    "export interface Settings { a: string }\nexport async function readSettings() {}\nexport enum Mode { A }",
  "src/types.ts": "export type Settings = { a: string };",
  "src/view.tsx":
    'import { start } from "./index";\nexport const View = () => <div>{String(start)}</div>;',
  "scripts/tool.mjs": 'import x from "../src/settings.ts";\nmodule.exports = x;',
  "docs/guide.md": "# Guide",
  "node_modules/pkg/index.js": "export const hidden = 1;",
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("the repo map build (integration: TypeScript compiler, fixture checkout, D-251)", () => {
  const map = buildRepoMap(COMMIT, readCheckout(checkout()));
  const file = (path: string) => map.files.find((f) => f.path === path);

  it("lists every file but node_modules, sorted, and names its commit", () => {
    expect(map.commitSha).toBe(COMMIT);
    expect(map.files.map((f) => f.path)).toEqual([
      "docs/guide.md",
      "package.json",
      "scripts/tool.mjs",
      "src/index.ts",
      "src/settings.ts",
      "src/store/index.ts",
      "src/types.ts",
      "src/view.tsx",
    ]);
  });

  it("reads exports, including re-exports, defaults and destructured names", () => {
    expect(file("src/index.ts")?.exports).toEqual([
      "Settings",
      "default",
      "read",
      "start",
      "stop",
    ]);
    expect(file("src/store/index.ts")?.exports).toEqual(["first", "second", "store"]);
    expect(file("src/settings.ts")?.exports).toEqual([
      "Mode",
      "Settings",
      "readSettings",
    ]);
    expect(file("docs/guide.md")?.exports).toEqual([]);
  });

  it("resolves relative imports to repository files and leaves packages out", () => {
    expect(file("src/index.ts")?.imports).toEqual([
      "src/settings.ts",
      "src/store/index.ts",
      "src/types.ts",
    ]);
    expect(file("src/view.tsx")?.imports).toEqual(["src/index.ts"]);
    expect(file("scripts/tool.mjs")?.imports).toEqual(["src/settings.ts"]);
  });

  it("reads the package.json scripts", () => {
    expect(map.scripts).toEqual({ check: "npm test", test: "vitest run" });
  });

  it("gives the same map from the same files, and no scripts from a bad package.json", () => {
    const files = new Map(
      Object.entries(FILES).filter(([p]) => !p.startsWith("node_modules")),
    );
    expect(buildRepoMap(COMMIT, files)).toEqual(buildRepoMap(COMMIT, new Map(files)));
    expect(buildRepoMap(COMMIT, new Map([["package.json", "{"]])).scripts).toEqual({});
  });
});
