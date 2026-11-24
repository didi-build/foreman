// Seam: unit. The built site's shared rules (ADR 0119 slice 5a, O-174), which the staging deploy's
// file set (src/adapters/deploy/site-files.ts, its own tests unchanged) and the site QA will browse
// (./qa-site.ts) both use: plain relative paths, no symbolic link, and the commit marker exactly
// the commit and a newline, compared byte for byte. Synthetic entries; no zip, network or file.
import { describe, expect, it } from "vitest";

import { isPlainRelativePath } from "./archive-path.ts";
import { markerRefusal, unsafeEntry, type BuiltSiteEntry } from "./built-site.ts";

const COMMIT = "a".repeat(40);
const bytes = (data: string | number[]) =>
  typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
const entry = (path: string, data: string | number[] = "x", symlink = false) =>
  ({ path, bytes: bytes(data), symlink }) satisfies BuiltSiteEntry;

describe("the plain path rule (unit, D-267)", () => {
  it("takes relative paths with plain parts only", () => {
    for (const path of [
      "index.html",
      "assets/index-1.js",
      "a/b/c.css",
      "..a",
      "a..",
      ".well-known/x",
    ]) {
      expect(isPlainRelativePath(path), path).toBe(true);
    }
    for (const path of [
      "",
      "/etc/passwd",
      "../outside.html",
      "a/../../b.html",
      "./index.html",
      "a/./b",
      "a//b",
      "folder/",
      "a\\b.html",
      "a\u0001.html",
      "a\u007f.html",
      "a\nb",
    ]) {
      expect(isPlainRelativePath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe("the built site's shared rules (unit, O-116, O-174)", () => {
  it("refuses a path that is not plain before a link, and a link", () => {
    expect(unsafeEntry([entry("index.html"), entry("assets/a.js")])).toBeNull();
    expect(unsafeEntry([entry("index.html"), entry("../x.html")])).toBe(
      "path_not_plain",
    );
    expect(unsafeEntry([entry("a.html", "/etc/passwd", true)])).toBe("symlink");
    expect(unsafeEntry([entry("a.html", "x", true), entry("/b")])).toBe(
      "path_not_plain",
    );
    expect(unsafeEntry([])).toBeNull();
  });

  it("takes the marker at the root that is exactly the commit and a newline", () => {
    expect(
      markerRefusal([entry("foreman-commit.txt", `${COMMIT}\n`)], COMMIT),
    ).toBeNull();
    expect(markerRefusal([entry("index.html")], COMMIT)).toBe("marker_missing");
    expect(
      markerRefusal([entry("sub/foreman-commit.txt", `${COMMIT}\n`)], COMMIT),
    ).toBe("marker_missing");
    for (const data of [
      `${"b".repeat(40)}\n`,
      COMMIT,
      `${COMMIT}\n\n`,
      ` ${COMMIT}\n`,
      `${COMMIT.toUpperCase()}\n`,
      `${COMMIT}\r\n`,
      "",
    ]) {
      expect(
        markerRefusal([entry("foreman-commit.txt", data)], COMMIT),
        JSON.stringify(data),
      ).toBe("marker_mismatch");
    }
  });

  it("compares the marker's bytes, never decoding them, so no other byte passes for a letter", () => {
    const good = [...bytes(`${COMMIT}\n`)];
    // A byte with the high bit set that a lossy decode could fold into "a".
    const high = [0xe1, ...good.slice(1)];
    expect(markerRefusal([entry("foreman-commit.txt", high)], COMMIT)).toBe(
      "marker_mismatch",
    );
    expect(markerRefusal([entry("foreman-commit.txt", good)], COMMIT)).toBeNull();
  });
});
