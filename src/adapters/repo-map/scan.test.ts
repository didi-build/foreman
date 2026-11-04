// Seam: adapter, the Scanner's stage 1 read inside the repo map Job (src/adapters/repo-map/scan.ts,
// O-92) over a synthetic archive with a fake HTTP port: what it keeps from the archive, the
// registry's resolved imports, the YAML parse of contract files and the bounded result. No
// network, no real repository and no real token.
import { describe, expect, it } from "vitest";

import { checkScanResult } from "../../core/scan.ts";
import type { GitHubHttp } from "../github/runner-app-tokens.ts";
import {
  FIXTURE_REPO as REPO,
  FIXTURE_SHA as SHA,
  FIXTURE_TOP,
  SCAN_FIXTURE_ENTRIES,
  tarball,
} from "./fixtures.ts";
import { readScanAt, scanInputFrom, yamlProblemLine } from "./scan.ts";

const TOKEN = "github-token-value-not-real-0123456789";

const archive = (entries = SCAN_FIXTURE_ENTRIES): GitHubHttp => ({
  get: async () => ({ status: 200, body: tarball(entries) }),
});

describe("the scan read in the Job (adapter, O-92)", () => {
  it("finds one finding of each check in the synthetic checkout, as a result the runner accepts", async () => {
    const result = await readScanAt(archive(), REPO, SHA, TOKEN);
    expect(result.findings).toEqual([
      {
        check: "design_index_link_missing",
        path: "design/README.md",
        line: 4,
        target: "design/gallery/old/spec.md",
      },
      {
        check: "design_spec_not_indexed",
        path: "design/gallery/card/spec.md",
        line: null,
        target: null,
      },
      {
        check: "gallery_spec_missing",
        path: "components/card/card.gallery.ts",
        line: 2,
        target: "design/gallery/kard/spec.md",
      },
      {
        check: "gallery_entry_unregistered",
        path: "components/card/card.gallery.ts",
        line: null,
        target: null,
      },
      {
        check: "contract_unparsable",
        path: "contracts/machine-2/broken.yaml",
        line: 3,
        target: null,
      },
      {
        check: "doc_link_missing",
        path: "docs/guide.md",
        line: 3,
        target: "docs/gone.md",
      },
    ]);
    expect(Object.values(result.counts)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(checkScanResult(JSON.parse(JSON.stringify(result)), SHA)).toEqual(result);
  });

  it("reads the registry's imports as the repo map resolves them (a .js specifier finds its .ts)", () => {
    const files = new Map([
      ["gallery/registry.ts", 'import { a } from "../components/a/a.gallery.js";'],
      ["components/a/a.gallery.ts", "export const a = {};"],
      ["components/b/b.gallery.tsx", "export const b = {};"],
    ]);
    const input = scanInputFrom(SHA, files);
    expect(input.registryImports).toEqual(["components/a/a.gallery.ts"]);
    expect(scanInputFrom(SHA, new Map([["a.md", ""]])).registryImports).toBeNull();
  });

  it("parses contract files as YAML only, naming the first problem's line", () => {
    expect(yamlProblemLine("a: 1\nb: [2, 3]\n")).toBe(0);
    expect(yamlProblemLine("---\na: 1\n---\nb: {\n")).toBe(5);
    expect(yamlProblemLine("a: 1\na: 2\n")).toBe(2);
    // A tag YAML does not know is a warning, not a problem: any loader reads it.
    expect(yamlProblemLine("a: !custom 1\n")).toBe(0);
  });

  it("keeps the text only of files the checks or the map read, so a large or binary file is never a finding", async () => {
    const big = "x".repeat(1_000_001);
    const result = await readScanAt(
      archive([
        { path: `${FIXTURE_TOP}/docs/big.md`, text: `${big}[a](gone.md)` },
        { path: `${FIXTURE_TOP}/contracts/big.yaml`, text: `${big}: [` },
        { path: `${FIXTURE_TOP}/notes.txt`, text: "[a](gone.md)" },
      ]),
      REPO,
      SHA,
      TOKEN,
    );
    expect(result.findings).toEqual([]);
    // Their checks did not run over them, so no idea about them is taken as gone (D-301).
    expect(result.notRun).toEqual([
      { check: "gallery_entry_unregistered", path: null },
      { check: "contract_unparsable", path: "contracts/big.yaml" },
      { check: "doc_link_missing", path: "docs/big.md" },
    ]);
  });

  it("refuses a bad repository or commit before any download", async () => {
    let asked = 0;
    const http: GitHubHttp = {
      get: async () => {
        asked += 1;
        return { status: 200, body: tarball(SCAN_FIXTURE_ENTRIES) };
      },
    };
    await expect(readScanAt(http, "../x", SHA, TOKEN)).rejects.toThrow(/repository/);
    await expect(readScanAt(http, REPO, "abc", TOKEN)).rejects.toThrow(/full/);
    expect(asked).toBe(0);
  });
});
