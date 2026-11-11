// Seam: the bundle files reader and the map the deploy embeds (unit, O-121). Both paths of the
// reader: the files on disk when no map is given, and an embedded map, where a path the map lacks
// is refused rather than read from disk. The map is built from real files in a temporary folder.
// test/flows/bundle.test.ts checks the same reader inside a real esbuild bundle.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bundleFilesDefine, embeddedBundleFiles } from "./embed.ts";
import { BUNDLE_FILES_DEFINE, BundleFileError, bundleFiles } from "./files.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A made-up checkout: two files in a folder, one deeper, one beside it. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "bundle-files-"));
  dirs.push(root);
  mkdirSync(join(root, "contracts/bots"), { recursive: true });
  writeFileSync(join(root, "contracts/b.yaml"), "b: 1\n");
  writeFileSync(join(root, "contracts/a.yaml"), "a: 1\n");
  writeFileSync(join(root, "contracts/bots/qa.yaml"), "role: qa\n");
  writeFileSync(
    join(root, "ca.crt"),
    Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xff, 0x0a]),
  );
  return root;
}

const MALFORMED =
  "The bundle's embedded files are not a map of repository paths to base64 text.";

describe("the bundle files reader (unit, O-121)", () => {
  it("reads and lists the files on disk when the bundle gives no map", () => {
    const root = checkout();
    const files = bundleFiles(undefined);
    expect(files.read(join(root, "contracts/a.yaml")).toString("utf8")).toBe("a: 1\n");
    expect(files.list(join(root, "contracts")).sort()).toEqual([
      "a.yaml",
      "b.yaml",
      "bots",
    ]);
    expect(() => files.read(join(root, "missing.yaml"))).toThrow(/ENOENT/);
  });

  it("reads and lists only the embedded map once one is given, byte for byte", () => {
    const root = checkout();
    const files = bundleFiles(embeddedBundleFiles(["contracts/", "ca.crt"], root));
    expect(files.read("contracts/a.yaml").toString("utf8")).toBe("a: 1\n");
    expect(files.read("./contracts/bots/qa.yaml").toString("utf8")).toBe("role: qa\n");
    expect([...files.read("ca.crt")]).toEqual([0xef, 0xbb, 0xbf, 0x00, 0xff, 0x0a]);
    expect(files.list("contracts")).toEqual(["a.yaml", "b.yaml", "bots"]);
    expect(files.list("contracts/")).toEqual(["a.yaml", "b.yaml", "bots"]);
    expect(files.list("contracts/bots")).toEqual(["qa.yaml"]);
  });

  it("refuses a path the map lacks, naming the path, and never reads it from disk", () => {
    const root = checkout();
    const files = bundleFiles(embeddedBundleFiles(["contracts/"], root));
    // On disk, but not in the map.
    for (const path of [join(root, "ca.crt"), "ca.crt", "package.json"]) {
      expect(() => files.read(path)).toThrow(BundleFileError);
      expect(() => files.read(path)).toThrow(
        `${path} is not among the bundle's files.`,
      );
    }
    for (const path of ["../contracts/a.yaml", "/contracts/a.yaml", "contracts", ""]) {
      expect(() => files.read(path)).toThrow(BundleFileError);
    }
    for (const dir of ["src", "contracts/a.yaml", "contract", "..", "/"]) {
      expect(() => files.list(dir)).toThrow(
        `${dir} is not a folder among the bundle's files.`,
      );
    }
  });

  it("gives a copy, so a caller cannot change what the next read gets", () => {
    const root = checkout();
    const files = bundleFiles(embeddedBundleFiles(["contracts/"], root));
    files.read("contracts/a.yaml").fill(0);
    expect(files.read("contracts/a.yaml").toString("utf8")).toBe("a: 1\n");
  });

  it.each([
    ["not an object", "contracts/a.yaml"],
    ["null", null],
    ["a list", ["contracts/a.yaml"]],
    ["a value that is not text", { "contracts/a.yaml": 1 }],
    ["a value that is not base64", { "contracts/a.yaml": "a: 1\n" }],
    ["a path with ..", { "../a.yaml": "" }],
    ["an absolute path", { "/a.yaml": "" }],
    ["a path with ./", { "./a.yaml": "" }],
    ["a path with an empty segment", { "contracts//a.yaml": "" }],
  ])("refuses a map that is %s, with fixed text", (_what, map) => {
    expect(() => bundleFiles(map)).toThrow(MALFORMED);
  });
});

describe("the embedded map the deploy builds (unit, O-121)", () => {
  it("holds every file under a folder entry and each file entry, sorted, as base64", () => {
    const root = checkout();
    const map = embeddedBundleFiles(["contracts/", "ca.crt", "contracts/a.yaml"], root);
    expect(Object.keys(map)).toEqual([
      "ca.crt",
      "contracts/a.yaml",
      "contracts/b.yaml",
      "contracts/bots/qa.yaml",
    ]);
    expect(Buffer.from(map["contracts/b.yaml"] ?? "", "base64").toString("utf8")).toBe(
      "b: 1\n",
    );
  });

  it("is the esbuild define of the reader's global name, the map as JSON", () => {
    const root = checkout();
    const define = bundleFilesDefine(["ca.crt"], root);
    expect(Object.keys(define)).toEqual([BUNDLE_FILES_DEFINE]);
    expect(BUNDLE_FILES_DEFINE).toBe("__FOREMAN_BUNDLE_FILES__");
    expect(JSON.parse(define[BUNDLE_FILES_DEFINE] ?? "")).toEqual({
      "ca.crt": Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xff, 0x0a]).toString("base64"),
    });
  });

  it("refuses an entry that is missing, of the wrong kind, not plain, or names no file", () => {
    const root = checkout();
    mkdirSync(join(root, "empty"));
    for (const [entry, message] of [
      ["missing.yaml", "missing.yaml is not a file"],
      ["missing/", "missing/ is not a folder"],
      ["contracts", "contracts is not a file"],
      ["ca.crt/", "ca.crt/ is not a folder"],
      ["../ca.crt", "../ca.crt is not a plain relative path"],
      ["/ca.crt", "/ca.crt is not a plain relative path"],
      ["./ca.crt", "./ca.crt is not a plain relative path"],
      ["", " is not a plain relative path"],
      ["empty/", "empty/ names no file"],
    ] as const) {
      expect(() => embeddedBundleFiles([entry], root)).toThrow(message);
    }
  });

  it("refuses a symbolic link inside a folder entry or as a file entry", () => {
    const root = checkout();
    symlinkSync(join(root, "ca.crt"), join(root, "contracts/link.yaml"));
    expect(() => embeddedBundleFiles(["contracts/"], root)).toThrow(
      "contracts/link.yaml is neither a plain file nor a folder",
    );
    expect(() => embeddedBundleFiles(["contracts/link.yaml"], root)).toThrow(
      "contracts/link.yaml is not a file",
    );
  });
});
