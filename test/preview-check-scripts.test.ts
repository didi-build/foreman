// Seam: CI's preview check scripts (integration: the real server and probe on 127.0.0.1 against a
// fake built site in a temporary folder, D-354, O-111). `.github/scripts/serve-site.mjs` serves
// the site; `.github/scripts/preview-check.mjs` writes the commit marker and probes. Covered: a
// site that passes, a missing bundle marker, a wrong commit, a server that does not answer, and
// the server's own rules. Both are also run as the workflow runs them, as Node processes. Nothing
// leaves 127.0.0.1.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMMIT_MARKER_FILE,
  GALLERY_BUNDLE_MARKER,
  PreviewCheckError,
  probeSite,
  writeCommitMarker,
} from "../.github/scripts/preview-check.mjs";
import { HOST, startSiteServer } from "../.github/scripts/serve-site.mjs";
import { GALLERY_PROBE_MARKER } from "../gallery/gallery-probe-marker.ts";
import { COMMIT_MARKER_FILE as CORE_MARKER_FILE } from "../src/core/preview-check.ts";

const SERVE = ".github/scripts/serve-site.mjs";
const PROBE = ".github/scripts/preview-check.mjs";
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const SCRIPT = "/assets/index-Ab12_cD.js";
/** Short waits, so a server that does not answer fails the test quickly. */
const QUICK = { waitMs: 600, requestMs: 200, retryMs: 50 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A built site as Vite makes it: the page names the entry script, which holds the marker. */
function site(
  options: { page?: string; code?: string; marker?: string | null } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-preview-site-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    options.page ??
      `<!doctype html><html><head><script type="module" src="${SCRIPT}"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(
    join(dir, SCRIPT),
    options.code ?? `console.log(${JSON.stringify(GALLERY_BUNDLE_MARKER)});`,
  );
  if (options.marker !== null) writeCommitMarker(dir, options.marker ?? HEAD);
  return dir;
}

async function served(dir: string): Promise<string> {
  const server = (await startSiteServer(dir, 0)) as Server;
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return `http://${HOST}:${(server.address() as AddressInfo).port}`;
}

const failure = (origin: string, commit = HEAD) =>
  probeSite(origin, commit, QUICK).then(
    () => null,
    (error: unknown) => error,
  );

/** A port nothing listens on: taken, then let go. */
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((done) => probe.listen(0, HOST, done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

describe("the commit marker (integration: .github/scripts/preview-check.mjs marker)", () => {
  it("writes the commit and a newline at the site's root, at the path the runner names", () => {
    const dir = site({ marker: null });
    writeCommitMarker(dir, HEAD);
    expect(readFileSync(join(dir, COMMIT_MARKER_FILE), "utf8")).toBe(`${HEAD}\n`);
    expect(COMMIT_MARKER_FILE).toBe(CORE_MARKER_FILE);
    expect(COMMIT_MARKER_FILE).toBe("foreman-commit.txt");
    // A marker the build already carried is replaced.
    writeCommitMarker(dir, OTHER);
    expect(readFileSync(join(dir, COMMIT_MARKER_FILE), "utf8")).toBe(`${OTHER}\n`);
  });

  it("refuses a commit that is not 40 lowercase hex characters, and a folder with no build", () => {
    const dir = site({ marker: null });
    for (const bad of [HEAD.toUpperCase(), "b".repeat(39), "", "main"]) {
      expect(() => writeCommitMarker(dir, bad), bad).toThrow(PreviewCheckError);
    }
    const empty = mkdtempSync(join(tmpdir(), "foreman-preview-empty-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    expect(() => writeCommitMarker(empty, HEAD)).toThrow(/no index.html/);
  });

  it("probes for the gallery's own bundle marker", () => {
    expect(GALLERY_BUNDLE_MARKER).toBe(GALLERY_PROBE_MARKER);
  });
});

describe("the probe (integration: .github/scripts/preview-check.mjs probe on a local server)", () => {
  it("passes when the app loads and serves the commit", async () => {
    await expect(probeSite(await served(site()), HEAD, QUICK)).resolves.toBeUndefined();
  });

  it("fails when the built script has no bundle marker", async () => {
    const error = await failure(await served(site({ code: "console.log('app');" })));
    expect(error).toBeInstanceOf(PreviewCheckError);
    expect((error as Error).message).toBe("the gallery's script has no bundle marker");
  });

  it("fails when the marker is only in the page's HTML, or the page names no script", async () => {
    const inPage = await failure(
      await served(
        site({ page: `<html><body>${GALLERY_BUNDLE_MARKER}</body></html>`, code: "" }),
      ),
    );
    expect((inPage as Error).message).toMatch(/must be only in the built JavaScript/);
    const noScript = await failure(await served(site({ page: "<html></html>" })));
    expect((noScript as Error).message).toBe("no gallery script in /gallery");
  });

  it("fails on a wrong commit, and on a site with no marker", async () => {
    const wrong = await failure(await served(site({ marker: OTHER })));
    expect((wrong as Error).message).toBe(
      "the served foreman-commit.txt is not the commit",
    );
    // With no marker file the single-page fallback serves the page, which is not the commit.
    const none = await failure(await served(site({ marker: null })));
    expect((none as Error).message).toBe(
      "the served foreman-commit.txt is not the commit",
    );
  });

  it("fails when no server listens", async () => {
    const origin = `http://${HOST}:${await freePort()}`;
    const error = await failure(origin);
    expect((error as Error).message).toBe(`the site did not answer on ${origin}`);
  });

  it("fails when the server takes the connection and never answers", async () => {
    // Holds every connection open and sends nothing.
    const held: Socket[] = [];
    const silent = createTcpServer((socket) => void held.push(socket));
    await new Promise<void>((done) => silent.listen(0, HOST, done));
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          for (const socket of held) socket.destroy();
          silent.close(() => done());
        }),
    );
    const origin = `http://${HOST}:${(silent.address() as AddressInfo).port}`;
    const error = await failure(origin);
    expect((error as Error).message).toBe(`the site did not answer on ${origin}`);
  });

  it("refuses any origin but 127.0.0.1, and a bad commit, before reaching anything", async () => {
    for (const origin of [
      "https://example.com",
      "http://localhost:4173",
      "http://127.0.0.1",
    ]) {
      await expect(probeSite(origin, HEAD, QUICK), origin).rejects.toThrow(
        /http:\/\/127\.0\.0\.1:<port>/,
      );
    }
    await expect(probeSite("http://127.0.0.1:4173", "main", QUICK)).rejects.toThrow(
      /40 lowercase hex/,
    );
  });
});

describe("the static server (integration: .github/scripts/serve-site.mjs)", () => {
  it("listens on 127.0.0.1 only", async () => {
    const server = (await startSiteServer(site(), 0)) as Server;
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("serves files and the single page, and never a dot file or a path outside the site", async () => {
    const dir = site();
    writeFileSync(join(dir, ".env"), "NOT_A_REAL_SECRET=1");
    const origin = await served(dir);
    const get = (path: string, method = "GET") =>
      fetch(`${origin}${path}`, { method, redirect: "manual" });

    expect(await (await get(`/${COMMIT_MARKER_FILE}`)).text()).toBe(`${HEAD}\n`);
    const script = await get(SCRIPT);
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    for (const path of ["/", "/gallery", "/gallery/deep/link"]) {
      const page = await get(path);
      expect(page.status, path).toBe(200);
      expect(await page.text(), path).toContain(SCRIPT);
    }
    for (const path of [
      "/.env",
      "/assets/.hidden",
      "/%2e%2e%2fpackage.json",
      "/a%5cb",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect(await (await get("/../package.json")).text()).toContain(SCRIPT);
    expect((await get("/", "POST")).status).toBe(405);
  });
});

describe("both scripts as the workflow runs them (integration: Node processes)", () => {
  it("serves on the port it is given and probes it: a pass, then a wrong commit", async () => {
    const dir = site();
    const port = await freePort();
    const server = spawn(process.execPath, [SERVE, dir, String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => {
      server.kill("SIGTERM");
    });
    const listening = await new Promise<string>((done, fail) => {
      server.stdout.on("data", (chunk: Buffer) => done(chunk.toString()));
      server.on("exit", () => fail(new Error("the server stopped")));
    });
    expect(listening).toBe(`serve-site: serving on http://127.0.0.1:${port}\n`);

    const probe = (commit: string) =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const child = spawn(
          process.execPath,
          [PROBE, "probe", `http://127.0.0.1:${port}`, commit],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (c: Buffer) => (out += c.toString()));
        child.stderr.on("data", (c: Buffer) => (err += c.toString()));
        child.on("exit", (code) => done({ code, out, err }));
      });
    expect(await probe(HEAD)).toEqual({
      code: 0,
      out: "preview-check: the app loads and serves the commit\n",
      err: "",
    });
    expect(await probe(OTHER)).toEqual({
      code: 1,
      out: "",
      err: "preview-check: probe failed: the served foreman-commit.txt is not the commit\n",
    });
  });

  it("writes the marker from the command line, and refuses a bad call with exit 1", () => {
    const dir = site({ marker: null });
    const marker = spawnSync(process.execPath, [PROBE, "marker", dir, HEAD], {
      encoding: "utf8",
    });
    expect(marker.status).toBe(0);
    expect(readFileSync(join(dir, COMMIT_MARKER_FILE), "utf8")).toBe(`${HEAD}\n`);
    for (const args of [["marker", dir, "main"], ["deploy", dir, HEAD], ["probe"]]) {
      const bad = spawnSync(process.execPath, [PROBE, ...args], { encoding: "utf8" });
      expect(bad.status, args.join(" ")).toBe(1);
      expect(bad.stdout).toBe("");
    }
    const missing = spawnSync(process.execPath, [SERVE, join(dir, "nope"), "0"], {
      encoding: "utf8",
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("serve-site: the site folder does not exist\n");
  });
});

describe("what the scripts may use (unit: D-354, O-111)", () => {
  it("import only Node's built-in modules, so the check adds no dependency", () => {
    for (const path of [SERVE, PROBE]) {
      const imports = [
        ...readFileSync(path, "utf8").matchAll(/^import .* from "([^"]+)";$/gm),
      ];
      expect(imports.length, path).toBeGreaterThan(0);
      for (const [, specifier] of imports) expect(specifier, path).toMatch(/^node:/);
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\brequire\(|import\(/);
    }
  });
});
