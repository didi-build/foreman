// Seam: the staging site's file set (unit, O-116), on synthetic zips made in memory, as GitHub serves
// a workflow artifact. Each rule refuses on its own, with fixed text that names no path or value
// from the build, and a set that passes gives exactly its files. No network.
import { describe, expect, it } from "vitest";

import { storedZip, type ZipFixtureEntry } from "../../../test/zip-fixture.ts";
import {
  CLOUDFLARE_STATIC_ASSET_LIMITS,
  readSiteFiles,
  SITE_REFUSALS,
  SITE_TOTAL_BYTES,
  type SiteFileSet,
} from "./site-files.ts";

const COMMIT = "c".repeat(40);
const marker = (commit = COMMIT): ZipFixtureEntry => ({
  name: "foreman-commit.txt",
  data: `${commit}\n`,
});
const site = (...entries: ZipFixtureEntry[]) =>
  readSiteFiles(storedZip([marker(), ...entries]), COMMIT);

function refusal(set: SiteFileSet) {
  return set.ok ? null : { cause: set.cause, reason: set.reason, text: set.text };
}

describe("the staging site's file set (unit: O-116)", () => {
  it("gives exactly the files of a plain site with the marker, stored or deflated", () => {
    const set = site(
      { name: "index.html", data: "<html></html>", deflate: true },
      { name: "assets/index-1.js", data: "console.log(1)" },
      { name: "assets/", data: "" },
      { name: "deep/a/b.css", data: "a{}", mode: 0o100644 },
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.files.map((f) => f.path)).toEqual([
      "foreman-commit.txt",
      "index.html",
      "assets/index-1.js",
      "deep/a/b.css",
    ]);
    expect(Buffer.from(set.files[1]!.bytes).toString()).toBe("<html></html>");
  });

  it("refuses a path that is not plain: absolute, with `..` or `.`, a backslash or a control character", () => {
    for (const name of [
      "/etc/passwd",
      "../outside.html",
      "a/../../b.html",
      "./index.html",
      "a\\b.html",
      "a\u0001.html",
    ]) {
      expect(refusal(site({ name, data: "x" })), name).toEqual({
        cause: "file_set",
        reason: "path_not_plain",
        text: SITE_REFUSALS.path_not_plain,
      });
    }
  });

  it("refuses a symbolic link", () => {
    expect(
      refusal(site({ name: "link.html", data: "/etc/passwd", mode: 0o120777 })),
    ).toEqual({
      cause: "file_set",
      reason: "symlink",
      text: SITE_REFUSALS.symlink,
    });
  });

  it("refuses more files than Cloudflare's limit per Worker version", () => {
    expect(CLOUDFLARE_STATIC_ASSET_LIMITS.filesPerVersion).toBe(20_000);
    const many = Array.from(
      { length: CLOUDFLARE_STATIC_ASSET_LIMITS.filesPerVersion },
      (_, i) => ({ name: `f/${i}.txt`, data: "" }),
    );
    // With the marker, one over the limit.
    expect(refusal(site(...many))).toMatchObject({
      cause: "file_set",
      reason: "too_many_files",
    });
    // At the limit, it passes.
    expect(site(...many.slice(1)).ok).toBe(true);
  });

  it("refuses a file larger than Cloudflare's 25 MiB, and a site larger than the runner's bound", () => {
    expect(CLOUDFLARE_STATIC_ASSET_LIMITS.fileBytes).toBe(25 * 1024 * 1024);
    const big = new Uint8Array(CLOUDFLARE_STATIC_ASSET_LIMITS.fileBytes + 1);
    expect(refusal(site({ name: "big.bin", data: big, deflate: true }))).toMatchObject({
      cause: "file_set",
      reason: "file_too_large",
    });
    const files = Math.ceil(
      SITE_TOTAL_BYTES / CLOUDFLARE_STATIC_ASSET_LIMITS.fileBytes,
    );
    const large = Array.from({ length: files }, (_, i) => ({
      name: `large-${i}.bin`,
      data: new Uint8Array(CLOUDFLARE_STATIC_ASSET_LIMITS.fileBytes),
      deflate: true,
    }));
    expect(refusal(site(...large))).toMatchObject({
      cause: "file_set",
      reason: "too_large",
    });
  });

  it("refuses a site with no marker at its root, or a marker of another commit", () => {
    expect(
      refusal(readSiteFiles(storedZip([{ name: "index.html", data: "x" }]), COMMIT)),
    ).toMatchObject({ cause: "file_set", reason: "marker_missing" });
    expect(
      refusal(
        readSiteFiles(
          storedZip([{ name: "sub/foreman-commit.txt", data: `${COMMIT}\n` }]),
          COMMIT,
        ),
      ),
    ).toMatchObject({ reason: "marker_missing" });
    for (const data of [
      `${"d".repeat(40)}\n`,
      COMMIT,
      `${COMMIT}\n\n`,
      ` ${COMMIT}\n`,
    ]) {
      expect(
        refusal(
          readSiteFiles(storedZip([{ name: "foreman-commit.txt", data }]), COMMIT),
        ),
        JSON.stringify(data),
      ).toMatchObject({ cause: "file_set", reason: "marker_mismatch" });
    }
  });

  it("refuses a file that would make the Worker run code: _worker.js as a file or a folder", () => {
    for (const name of ["_worker.js", "_worker.js/index.js", "nested/_worker.js"]) {
      expect(refusal(site({ name, data: "export default {}" })), name).toEqual({
        cause: "file_set",
        reason: "worker_code",
        text: SITE_REFUSALS.worker_code,
      });
    }
    // Other names are plain files; `_headers` and `_redirects` are not read as configuration.
    expect(
      site(
        { name: "worker.js", data: "x" },
        { name: "_headers", data: "/*\n  X-Test: 1" },
        { name: "_redirects", data: "/a /b 301" },
      ).ok,
    ).toBe(true);
  });

  it("refuses an archive that is not a readable zip as infrastructure, not as the build's fault", () => {
    for (const archive of [
      new Uint8Array(Buffer.from("not a zip at all")),
      storedZip([marker()]).slice(0, 40),
    ]) {
      expect(refusal(readSiteFiles(archive, COMMIT))).toEqual({
        cause: "infrastructure",
        reason: "archive_unreadable",
        text: SITE_REFUSALS.archive_unreadable,
      });
    }
  });

  it("names no path or value from the build in any refusal text", () => {
    for (const text of Object.values(SITE_REFUSALS)) {
      expect(text).toMatch(/^[A-Za-z0-9 ,.;:'()_/-]{1,200}$/);
      expect(text).not.toMatch(/\u2014/);
    }
  });
});
