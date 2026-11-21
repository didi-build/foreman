// Seam: the staging site's file set (unit, O-116, O-159), on synthetic zips made in memory, as GitHub
// serves a workflow artifact. Each rule refuses on its own, with fixed text that names no path or
// value from the build, and a set that passes gives exactly its files. Both layouts: the old one
// (the site at the root, as the rehearsal builds it) gives no Worker; the new one (the manifest,
// `assets/`, `worker/index.js`, `migrations/`) gives the site from `assets/` and the Worker's
// module, manifest and migrations. No network.
import { describe, expect, it } from "vitest";

import { storedZip, type ZipFixtureEntry } from "../../../test/zip-fixture.ts";
import { DEPLOY_MANIFEST_MAX_BYTES } from "./deploy-manifest.ts";
import {
  CLOUDFLARE_STATIC_ASSET_LIMITS,
  MAX_MIGRATIONS,
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

  it("reads a site in the old layout as before: an `assets/` folder at the root is the site's own, and no Worker", () => {
    const set = site(
      { name: "index.html", data: "<html></html>" },
      { name: "assets/index-1.js", data: "console.log(1)" },
      { name: "worker/index.js", data: "export default {}" },
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.files.map((f) => f.path)).toEqual([
      "foreman-commit.txt",
      "index.html",
      "assets/index-1.js",
      "worker/index.js",
    ]);
    expect(set).not.toHaveProperty("worker");
  });

  it("names no path or value from the build in any refusal text", () => {
    for (const text of Object.values(SITE_REFUSALS)) {
      expect(text).toMatch(/^[A-Za-z0-9 ,.;:'()_/-]{1,200}$/);
      expect(text).not.toMatch(/\u2014/);
    }
  });
});

const MANIFEST = {
  schema: 1,
  compatibilityDate: "2026-10-26",
  compatibilityFlags: ["nodejs_compat"],
  requiredSecrets: ["MODEL_API_KEY"],
};
const MODULE =
  "export default { fetch() { return Response.json({ status: 'ok' }); } };";

/** A build in the new layout (O-159), with the given entries in place of the defaults. */
function workerBuild(
  options: {
    manifest?: unknown;
    marker?: boolean;
    module?: ZipFixtureEntry | null;
    extra?: ZipFixtureEntry[];
  } = {},
): SiteFileSet {
  const entries: ZipFixtureEntry[] = [
    {
      name: "foreman-deploy.json",
      data:
        typeof options.manifest === "string"
          ? options.manifest
          : JSON.stringify(options.manifest ?? MANIFEST),
    },
    ...(options.marker === false
      ? []
      : [{ name: "assets/foreman-commit.txt", data: `${COMMIT}\n` }]),
    { name: "assets/index.html", data: "<html></html>", deflate: true },
    { name: "assets/assets/index-1.js", data: "console.log(1)" },
    ...(options.module === null
      ? []
      : [options.module ?? { name: "worker/index.js", data: MODULE, deflate: true }]),
    ...(options.extra ?? []),
  ];
  return readSiteFiles(storedZip(entries), COMMIT);
}

describe("a build in the new layout, with a Worker (unit: ADR 0118 slice 3, O-159)", () => {
  it("gives the site from assets/, the module as text, the manifest and the migrations by name", () => {
    const set = workerBuild({
      extra: [
        { name: "migrations/0002_more.sql", data: "ALTER TABLE t ADD c;" },
        { name: "migrations/", data: "" },
        { name: "migrations/0001_init.sql", data: "CREATE TABLE t (id INTEGER);" },
      ],
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.files.map((f) => f.path)).toEqual([
      "foreman-commit.txt",
      "index.html",
      "assets/index-1.js",
    ]);
    expect(set.worker?.module).toBe(MODULE);
    expect(set.worker?.manifest).toEqual({
      compatibilityDate: "2026-10-26",
      compatibilityFlags: ["nodejs_compat"],
      requiredSecrets: ["MODEL_API_KEY"],
    });
    expect(set.worker?.migrations.map((m) => m.path)).toEqual([
      "0001_init.sql",
      "0002_more.sql",
    ]);
    expect(Buffer.from(set.worker!.migrations[0]!.bytes).toString()).toBe(
      "CREATE TABLE t (id INTEGER);",
    );
    // No migrations folder at all is the template's first build.
    const first = workerBuild();
    expect(first.ok && first.worker?.migrations).toEqual([]);
  });

  it("refuses anything at the root but the manifest and the three folders", () => {
    for (const name of [
      "foreman-commit.txt",
      "index.html",
      "wrangler.jsonc",
      "other/x.txt",
    ]) {
      expect(refusal(workerBuild({ extra: [{ name, data: "x" }] })), name).toEqual({
        cause: "file_set",
        reason: "layout_unexpected",
        text: SITE_REFUSALS.layout_unexpected,
      });
    }
  });

  it("refuses a malformed or oversized manifest before anything else is read", () => {
    expect(refusal(workerBuild({ manifest: "not json" }))).toEqual({
      cause: "file_set",
      reason: "manifest_malformed",
      text: SITE_REFUSALS.manifest_malformed,
    });
    expect(
      refusal(
        workerBuild({
          manifest: { ...MANIFEST, compatibilityFlags: ["experimental"] },
        }),
      ),
    ).toMatchObject({ cause: "file_set", reason: "manifest_flags" });
    expect(
      refusal(workerBuild({ manifest: { ...MANIFEST, requiredSecrets: ["DB"] } })),
    ).toMatchObject({ cause: "file_set", reason: "manifest_secrets" });
    expect(
      refusal(
        workerBuild({
          manifest: JSON.stringify(MANIFEST).padEnd(DEPLOY_MANIFEST_MAX_BYTES + 1, " "),
          marker: false,
        }),
      ),
    ).toEqual({
      cause: "file_set",
      reason: "manifest_too_large",
      text: SITE_REFUSALS.manifest_too_large,
    });
  });

  it("applies the site's rules to assets/: its marker, and no _worker.js", () => {
    expect(refusal(workerBuild({ marker: false }))).toEqual({
      cause: "file_set",
      reason: "assets_marker_missing",
      text: SITE_REFUSALS.assets_marker_missing,
    });
    expect(
      refusal(
        workerBuild({
          marker: false,
          extra: [{ name: "assets/foreman-commit.txt", data: `${"d".repeat(40)}\n` }],
        }),
      ),
    ).toMatchObject({ reason: "marker_mismatch" });
    expect(
      refusal(
        workerBuild({
          extra: [{ name: "assets/_worker.js", data: "export default {}" }],
        }),
      ),
    ).toMatchObject({ reason: "worker_code" });
  });

  it("requires worker/index.js, alone and as UTF-8 text", () => {
    expect(refusal(workerBuild({ module: null }))).toEqual({
      cause: "file_set",
      reason: "worker_missing",
      text: SITE_REFUSALS.worker_missing,
    });
    expect(
      refusal(workerBuild({ module: { name: "worker/main.js", data: MODULE } })),
    ).toMatchObject({ reason: "worker_missing" });
    for (const name of ["worker/index.js.map", "worker/README.md", "worker/lib/a.js"]) {
      expect(refusal(workerBuild({ extra: [{ name, data: "x" }] })), name).toEqual({
        cause: "file_set",
        reason: "worker_extra",
        text: SITE_REFUSALS.worker_extra,
      });
    }
    expect(
      refusal(
        workerBuild({
          module: { name: "worker/index.js", data: new Uint8Array([0x61, 0xff, 0x62]) },
        }),
      ),
    ).toEqual({
      cause: "file_set",
      reason: "worker_not_text",
      text: SITE_REFUSALS.worker_not_text,
    });
  });

  it("refuses migrations that are not plain .sql files directly in their folder, or too many", () => {
    for (const name of [
      "migrations/0001_init.txt",
      "migrations/sub/0001_init.sql",
      "migrations/0001 init.sql",
      "migrations/.sql",
    ]) {
      expect(refusal(workerBuild({ extra: [{ name, data: "x" }] })), name).toEqual({
        cause: "file_set",
        reason: "migrations_not_plain",
        text: SITE_REFUSALS.migrations_not_plain,
      });
    }
    expect(MAX_MIGRATIONS).toBe(1000);
    const many = Array.from({ length: MAX_MIGRATIONS + 1 }, (_, i) => ({
      name: `migrations/${String(i).padStart(4, "0")}_m.sql`,
      data: "",
    }));
    expect(refusal(workerBuild({ extra: many }))).toMatchObject({
      reason: "migrations_not_plain",
    });
    expect(workerBuild({ extra: many.slice(1) }).ok).toBe(true);
  });
});
