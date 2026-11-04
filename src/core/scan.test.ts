// Seam: unit, plain logic (D-162). The Scanner's stage 1 fixed checks over synthetic repository
// files, the strict check of the Job's result as untrusted data, and the idea fields the runner
// writes from a finding (src/core/scan.ts, D-299, D-300, O-92). Where a check did not run, and
// when a scan certainly found none of an idea's keys (D-301, O-93). No archive, network or model.
import { describe, expect, it } from "vitest";

import { MAX_FINDING_DETAIL, MAX_FINDING_TITLE } from "./out-of-scope-findings.ts";
import {
  checkScanResult,
  linkTarget,
  markdownLinks,
  MAX_LISTED_FINDINGS,
  runScanChecks,
  SCAN_CHECKS,
  scanDedupeKey,
  scanIdea,
  scanFoundNone,
  scanNotRun,
  scanResult,
  ScanResultError,
  type ScanFinding,
  type ScanInput,
} from "./scan.ts";

const SHA = "c".repeat(40);

/** A small repository that passes every check. */
function passing(): Record<string, string> {
  return {
    "README.md":
      "# Rehearsal\n\nSee [the gallery](docs/component-gallery.md) and [design](design/).\n",
    "docs/component-gallery.md":
      "# Gallery\n\nSpecs: [index](../design/README.md#features), [site](https://example.test/x), [mail](mailto:a@example.test), [top](#gallery), [root](/docs), [{{slug}}]({{slug}}.md).\n",
    "design/README.md":
      "# Design specs\n\n| Area | Spec |\n| --- | --- |\n| gallery | [gallery/button/spec.md](gallery/button/spec.md) |\n\nSee [the guide](../docs/component-gallery.md).\n",
    "design/gallery/button/spec.md": "# Button\n",
    "components/button/button.gallery.ts":
      'export const buttonGallery = {\n  id: "button",\n  specPath: "design/gallery/button/spec.md",\n};\n',
    "components/button/Button.tsx": "export function Button() {}",
    "gallery/registry.ts":
      'import { buttonGallery } from "../components/button/button.gallery.js";\n',
    "contracts/machine-2/code.yaml": "states:\n  ready: {}\n",
  };
}

/** The checks' input for a set of files, as the Job builds it (registry imports given). */
function input(
  files: Record<string, string>,
  extra: Partial<ScanInput> = {},
): ScanInput {
  return {
    paths: Object.keys(files),
    texts: new Map(Object.entries(files)),
    registryImports: Object.hasOwn(files, "gallery/registry.ts")
      ? ["components/button/button.gallery.ts"]
      : null,
    unparsableContracts: [],
    ...extra,
  };
}

const run = (files: Record<string, string>, extra: Partial<ScanInput> = {}) =>
  runScanChecks(input(files, extra));

describe("the fixed checks (unit: D-299, D-300, O-92)", () => {
  it("lists six checks in a fixed order", () => {
    expect([...SCAN_CHECKS]).toEqual([
      "design_index_link_missing",
      "design_spec_not_indexed",
      "gallery_spec_missing",
      "gallery_entry_unregistered",
      "contract_unparsable",
      "doc_link_missing",
    ]);
  });

  it("finds nothing in a repository where everything lines up", () => {
    expect(run(passing())).toEqual([]);
  });

  it("finds nothing in a repository with no design, gallery, contracts or docs", () => {
    expect(run({ "src/app.ts": "export const a = 1;" })).toEqual([]);
  });

  it("design_index_link_missing: the index links a spec that does not exist", () => {
    const files = passing();
    files["design/README.md"] += "| gallery | [old](gallery/old/spec.md) |\n";
    expect(run(files)).toEqual([
      {
        check: "design_index_link_missing",
        path: "design/README.md",
        line: 8,
        target: "design/gallery/old/spec.md",
      },
    ]);
  });

  it("design_spec_not_indexed: a spec the index does not link", () => {
    const files = { ...passing(), "design/gallery/card/spec.md": "# Card\n" };
    expect(run(files)).toEqual([
      {
        check: "design_spec_not_indexed",
        path: "design/gallery/card/spec.md",
        line: null,
        target: null,
      },
    ]);
    // Without an index, every spec is not indexed (and a doc's link to the index is broken).
    const noIndex = { ...passing() } as Record<string, string>;
    delete noIndex["design/README.md"];
    expect(run(noIndex).map((f) => `${f.check}:${f.path}`)).toEqual([
      "design_spec_not_indexed:design/gallery/button/spec.md",
      "doc_link_missing:docs/component-gallery.md",
    ]);
    // Only design/<area>/<feature>/spec.md is a spec.
    expect(
      run({ ...passing(), "design/notes/spec.md": "x", "design/a/b/c/spec.md": "x" }),
    ).toEqual([]);
  });

  it("gallery_spec_missing: an entry's specPath names a file that does not exist", () => {
    const files = passing();
    files["components/button/button.gallery.ts"] =
      'export const buttonGallery = {\n  id: "button",\n  specPath: "design/gallery/buton/spec.md",\n};\n';
    expect(run(files)).toEqual([
      {
        check: "gallery_spec_missing",
        path: "components/button/button.gallery.ts",
        line: 3,
        target: "design/gallery/buton/spec.md",
      },
    ]);
  });

  it("gallery_spec_missing: says nothing when the entry has no single literal specPath", () => {
    const files = passing();
    files["components/button/button.gallery.ts"] =
      "export const b = { specPath: SPEC };";
    expect(run(files)).toEqual([]);
    files["components/button/button.gallery.ts"] =
      'const a = { specPath: "x/spec.md" };\nconst b = { specPath: "y/spec.md" };';
    expect(run(files)).toEqual([]);
  });

  it("gallery_entry_unregistered: an entry the registry does not import", () => {
    const files = {
      ...passing(),
      "components/card/card.gallery.ts":
        'export const card = { specPath: "design/gallery/button/spec.md" };',
    };
    expect(run(files)).toEqual([
      {
        check: "gallery_entry_unregistered",
        path: "components/card/card.gallery.ts",
        line: null,
        target: null,
      },
    ]);
    // With no registry there is nothing to compare against.
    expect(run(files, { registryImports: null })).toEqual([]);
  });

  it("contract_unparsable: a contract file the Job could not parse as YAML", () => {
    expect(
      run(passing(), {
        unparsableContracts: [{ path: "contracts/machine-2/code.yaml", line: 2 }],
      }),
    ).toEqual([
      {
        check: "contract_unparsable",
        path: "contracts/machine-2/code.yaml",
        line: 2,
        target: null,
      },
    ]);
    // A path that is not a contract file, or not in the repository, is ignored.
    expect(
      run(passing(), {
        unparsableContracts: [
          { path: "docs/x.yaml", line: 1 },
          { path: "contracts/gone.yaml", line: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it("doc_link_missing: a relative link to a path that does not exist, each once, first line kept", () => {
    const files = {
      ...passing(),
      "docs/guide.md":
        '# Guide\n\n[a](./missing.md) and ![img](../assets/logo.png)\n\nAgain [a](missing.md#top)\n\n[ref]: ../nowhere/ "title"\n',
    };
    expect(run(files)).toEqual([
      {
        check: "doc_link_missing",
        path: "docs/guide.md",
        line: 3,
        target: "assets/logo.png",
      },
      {
        check: "doc_link_missing",
        path: "docs/guide.md",
        line: 3,
        target: "docs/missing.md",
      },
      { check: "doc_link_missing", path: "docs/guide.md", line: 7, target: "nowhere" },
    ]);
  });

  it("doc_link_missing: ignores links in code, in HTML comments, outside the repository and to folders that exist", () => {
    const files = {
      ...passing(),
      "docs/guide.md": [
        "```md",
        "[in a fence](nope.md)",
        "```",
        "~~~",
        "[in a tilde fence](nope.md)",
        "~~~",
        "Inline `[code](nope.md)` here.",
        "<!-- [commented](nope.md)",
        "[still commented](nope.md) -->",
        "[outside](../../elsewhere.md) [folder](../design) [encoded](component%2Dgallery.md)",
        "[angle](<component-gallery.md>)",
        "[^1]: A footnote, not a link.",
      ].join("\n"),
    };
    expect(run(files)).toEqual([]);
  });

  it("sorts every finding by check, path, target and line", () => {
    const files = {
      ...passing(),
      "b.md": "[x](gone.md)",
      "a.md": "[x](gone.md)",
      "design/gallery/card/spec.md": "x",
    };
    const found = run(files);
    expect(found.map((f) => `${f.check}:${f.path}`)).toEqual([
      "design_spec_not_indexed:design/gallery/card/spec.md",
      "doc_link_missing:a.md",
      "doc_link_missing:b.md",
    ]);
  });
});

describe("Markdown links (unit)", () => {
  it("reads inline links, images, titles, nested brackets and reference definitions", () => {
    expect(
      markdownLinks(
        '[a](one.md "t") ![b [c]](two.png)\n  [d]: <three four.md>\n[e](five(1).md)',
      ),
    ).toEqual([
      { line: 1, raw: "one.md" },
      { line: 1, raw: "two.png" },
      { line: 2, raw: "three four.md" },
      { line: 3, raw: "five(1).md" },
    ]);
  });

  it("checks only plain relative targets inside the repository", () => {
    expect(linkTarget("docs/a.md", "b.md")).toBe("docs/b.md");
    expect(linkTarget("docs/a.md", "../b.md#x")).toBe("b.md");
    expect(linkTarget("docs/a.md", "./c/?q=1")).toBe("docs/c");
    expect(linkTarget("docs/a.md", "with%20space.md")).toBe("docs/with space.md");
    for (const raw of [
      "",
      "#anchor",
      "/abs.md",
      "https://x.test/a.md",
      "mailto:a@x.test",
      "../../out.md",
      "{{slug}}.md",
      "bad%zz.md",
      "..",
    ]) {
      expect(linkTarget("docs/a.md", raw), raw).toBeNull();
    }
  });
});

const FINDING: ScanFinding = {
  check: "doc_link_missing",
  path: "docs/a.md",
  line: 3,
  target: "docs/b.md",
};

const result = (findings: unknown[], counts: Record<string, unknown> = {}) => ({
  scan: 1,
  commitSha: SHA,
  counts: {
    ...Object.fromEntries(SCAN_CHECKS.map((c) => [c, 0])),
    doc_link_missing: findings.length,
    ...counts,
  },
  findings,
  notRun: [],
});

describe("the scan result, checked as untrusted data (unit: O-92)", () => {
  it("accepts what the Job makes, counting past the listed bound", () => {
    const many: ScanFinding[] = Array.from(
      { length: MAX_LISTED_FINDINGS + 5 },
      (_, i) => ({
        ...FINDING,
        target: `docs/missing-${String(i).padStart(4, "0")}.md`,
      }),
    );
    const made = scanResult(SHA, many);
    expect(made.findings).toHaveLength(MAX_LISTED_FINDINGS);
    expect(made.counts.doc_link_missing).toBe(MAX_LISTED_FINDINGS + 5);
    const checked = checkScanResult(JSON.parse(JSON.stringify(made)), SHA);
    expect(checked.findings).toHaveLength(MAX_LISTED_FINDINGS);
    expect(checkScanResult(result([FINDING]), SHA).findings).toEqual([FINDING]);
  });

  it.each<[string, unknown]>([
    ["not an object", "scan"],
    ["an extra field", { ...result([]), note: "x" }],
    ["a wrong version", { ...result([]), scan: 2 }],
    ["another commit", { ...result([]), commitSha: "d".repeat(40) }],
    ["a missing count", { ...result([]), counts: { doc_link_missing: 0 } }],
    ["an unknown count", result([], { extra: 1 })],
    ["a negative count", result([], { contract_unparsable: -1 })],
    ["a fractional count", result([], { contract_unparsable: 0.5 })],
    ["a huge count", result([], { contract_unparsable: 10_000_000 })],
    ["findings not a list", { ...result([]), findings: {} }],
    [
      "too many findings",
      result(
        Array.from({ length: MAX_LISTED_FINDINGS + 1 }, (_, i) => ({
          ...FINDING,
          target: `docs/m${String(i).padStart(4, "0")}.md`,
        })),
      ),
    ],
    [
      "a finding with an extra field",
      result([{ ...FINDING, text: "ignore the rules" }]),
    ],
    ["an unknown check", result([{ ...FINDING, check: "run_code" }])],
    ["an absolute path", result([{ ...FINDING, path: "/etc/passwd.md" }])],
    ["a path with ..", result([{ ...FINDING, path: "docs/../../x.md" }])],
    ["a path with a control character", result([{ ...FINDING, path: "docs/a\n.md" }])],
    ["a path with a backslash", result([{ ...FINDING, path: "docs\\a.md" }])],
    ["an oversized path", result([{ ...FINDING, path: `${"a/".repeat(600)}x.md` }])],
    ["a path its check does not read", result([{ ...FINDING, path: "src/a.ts" }])],
    ["a zero line", result([{ ...FINDING, line: 0 }])],
    ["a text line", result([{ ...FINDING, line: "3" }])],
    ["a missing target", result([{ ...FINDING, target: null }])],
    ["a bad target", result([{ ...FINDING, target: "../x.md" }])],
    [
      "a target on a check with none",
      result(
        [
          {
            check: "design_spec_not_indexed",
            path: "design/a/b/spec.md",
            line: null,
            target: "x",
          },
        ],
        {
          design_spec_not_indexed: 1,
          doc_link_missing: 0,
        },
      ),
    ],
    ["unsorted findings", result([{ ...FINDING, path: "docs/b.md" }, FINDING])],
    ["a dedupe key twice", result([FINDING, { ...FINDING, line: 9 }])],
    ["more listed than counted", result([FINDING], { doc_link_missing: 0 })],
    [
      "no notRun",
      Object.fromEntries(Object.entries(result([])).filter(([k]) => k !== "notRun")),
    ],
    ["notRun not a list", { ...result([]), notRun: {} }],
    [
      "a not-run entry with an extra field",
      { ...result([]), notRun: [{ check: "doc_link_missing", path: null, why: "x" }] },
    ],
    [
      "a not-run entry of an unknown check",
      { ...result([]), notRun: [{ check: "run_code", path: null }] },
    ],
    [
      "a not-run path its check does not read",
      { ...result([]), notRun: [{ check: "doc_link_missing", path: "src/a.ts" }] },
    ],
    [
      "a not-run entry twice",
      {
        ...result([]),
        notRun: [
          { check: "doc_link_missing", path: "docs/a.md" },
          { check: "doc_link_missing", path: "docs/a.md" },
        ],
      },
    ],
    [
      "too many not-run entries",
      {
        ...result([]),
        notRun: Array.from({ length: MAX_LISTED_FINDINGS + 1 }, (_, i) => ({
          check: "doc_link_missing",
          path: `docs/m${String(i).padStart(4, "0")}.md`,
        })),
      },
    ],
  ])("refuses %s", (_label, value) => {
    expect(() => checkScanResult(value, SHA)).toThrow(ScanResultError);
  });

  it("names the problem, never a value from the Job", () => {
    try {
      checkScanResult(result([{ ...FINDING, path: "/secret-value.md" }]), SHA);
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
  });
});

describe("a finding as an idea (unit: idea fields P-14)", () => {
  it("is written from the runner's own table: class, check, evidence, confidence 1 and a dedupe key without the line", () => {
    const idea = scanIdea(FINDING, SHA);
    expect(idea).toEqual({
      title: "Broken link in docs/a.md to docs/b.md",
      description: `docs/a.md line 3 links docs/b.md, and no such file or folder exists in the repository. Found by the Scanner's fixed check doc_link_missing (stage 1, no model) at commit ${SHA}.`,
      class: "drift",
      check: "doc_link_missing",
      evidence: [{ path: "docs/a.md", line: 3 }],
      confidence: 1,
      dedupeKey: "scanner:doc_link_missing:docs/a.md -> docs/b.md",
    });
    expect(scanDedupeKey({ ...FINDING, line: 40 })).toBe(idea.dedupeKey);
    expect(
      scanIdea(
        { ...FINDING, check: "gallery_spec_missing", path: "components/a.gallery.ts" },
        SHA,
      ).class,
    ).toBe("bug");
  });

  it("keeps its title and description within a run finding's bounds, however long the path", () => {
    const long = `${"folder/".repeat(140)}file.md`;
    const idea = scanIdea({ ...FINDING, path: long, target: long }, SHA);
    expect(idea.title.length).toBeLessThanOrEqual(MAX_FINDING_TITLE);
    expect(idea.title).not.toMatch(/[\r\n]/);
    expect(idea.description.length).toBeLessThanOrEqual(MAX_FINDING_DETAIL);
    expect(idea.dedupeKey).toContain(long);
  });
});

describe("where a check did not run (unit: D-301, O-93)", () => {
  it("lists nothing for a repository every check read in full", () => {
    expect(scanNotRun(input(passing()))).toEqual([]);
  });

  it("lists the registry check as a whole with no registry, or one too large to read", () => {
    const files = passing();
    delete files["gallery/registry.ts"];
    expect(scanNotRun(input(files))).toEqual([
      { check: "gallery_entry_unregistered", path: null },
    ]);
    expect(scanNotRun(input(passing(), { unread: ["gallery/registry.ts"] }))).toEqual([
      { check: "gallery_entry_unregistered", path: null },
    ]);
  });

  it("lists each check of a file too large to read, and nothing for a file that is not there", () => {
    expect(
      scanNotRun(
        input(passing(), {
          unread: [
            "design/README.md",
            "components/button/button.gallery.ts",
            "contracts/machine-2/code.yaml",
            "docs/component-gallery.md",
            "docs/deleted.md",
          ],
        }),
      ),
    ).toEqual([
      { check: "design_index_link_missing", path: "design/README.md" },
      { check: "gallery_spec_missing", path: "components/button/button.gallery.ts" },
      { check: "contract_unparsable", path: "contracts/machine-2/code.yaml" },
      { check: "doc_link_missing", path: "design/README.md" },
      { check: "doc_link_missing", path: "docs/component-gallery.md" },
    ]);
  });

  it("lists the spec check of a gallery entry with no single literal specPath", () => {
    const files = {
      ...passing(),
      "components/button/button.gallery.ts": "export const b = { specPath: spec };\n",
    };
    expect(scanNotRun(input(files))).toEqual([
      { check: "gallery_spec_missing", path: "components/button/button.gallery.ts" },
    ]);
  });

  it("lists each check once as a whole past the bound", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_LISTED_FINDINGS; i++) files[`docs/d${i}.md`] = "";
    const notRun = scanNotRun({
      ...input(files),
      registryImports: [],
      unread: Object.keys(files),
    });
    expect(notRun).toEqual([{ check: "doc_link_missing", path: null }]);
    // The Job's result carries it, and the runner reads it back.
    const made = scanResult(SHA, [], notRun);
    expect(checkScanResult(JSON.parse(JSON.stringify(made)), SHA).notRun).toEqual(
      notRun,
    );
  });
});

describe("whether a scan found none of an idea's keys (unit: D-301, O-93)", () => {
  const key = (f: ScanFinding) => ({
    check: f.check,
    path: f.path,
    dedupeKey: scanDedupeKey(f),
  });
  const other: ScanFinding = { ...FINDING, target: "docs/c.md" };
  const scan = (findings: ScanFinding[], extra = {}) => ({
    counts: result(findings).counts as ReturnType<typeof scanResult>["counts"],
    findings,
    notRun: [],
    ...extra,
  });

  it("is true only when no key was found, every check named listed all it found and ran over each file", () => {
    expect(scanFoundNone(scan([]), [key(FINDING), key(other)])).toBe(true);
    expect(scanFoundNone(scan([other]), [key(FINDING)])).toBe(true);
    expect(scanFoundNone(scan([other]), [key(FINDING), key(other)])).toBe(false);
    expect(
      scanFoundNone(scan([], { counts: { ...scan([]).counts, doc_link_missing: 1 } }), [
        key(FINDING),
      ]),
    ).toBe(false);
    expect(
      scanFoundNone(
        scan([], { notRun: [{ check: "doc_link_missing", path: "docs/a.md" }] }),
        [key(FINDING)],
      ),
    ).toBe(false);
    expect(
      scanFoundNone(
        scan([], { notRun: [{ check: "doc_link_missing", path: "docs/z.md" }] }),
        [key(FINDING)],
      ),
    ).toBe(true);
    expect(
      scanFoundNone(scan([], { notRun: [{ check: "doc_link_missing", path: null }] }), [
        key(FINDING),
      ]),
    ).toBe(false);
    // No keys: never taken as gone.
    expect(scanFoundNone(scan([]), [])).toBe(false);
  });
});
