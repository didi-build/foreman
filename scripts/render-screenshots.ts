// CI's render step for the screenshot bundles (D-242, D-255, D-275 point 1, D-281). Given the commit
// checked out and a kind, it renders with a headless browser and writes one bundle folder that the
// screenshots workflow uploads as the artifact the runner reads (`foreman-screenshots-<kind>`,
// src/adapters/screenshots/github-artifacts.ts):
//
//   gallery  builds the gallery, serves it on 127.0.0.1, and screenshots every registered entry
//            and variant in the gallery's render mode (gallery/shot-mode.ts), with each entry's
//            spec file copied in.
//   options  renders `index.html` of each option folder `design/<area>/<feature>/options/<name>/`
//            (with --changed-since, only folders the pull request changes), screenshots the whole
//            page, and records the box of each element marked `data-component` (D-255).
//   head-options
//            renders every option folder tracked at the commit the same way, in the same job as
//            the gallery, so the visual comparison crops the approved option from a render made
//            on the same machine with the same browser and fonts as the built components (D-281).
//            After a feature's spec step only its approved option's folder stays (D-253).
//
// Every page is rendered at a fixed viewport and device scale, in light mode with reduced motion,
// UTC and en-US, animations disabled for the screenshot, and every request that leaves the local
// server is refused. An option page may load only files inside its own folder (D-285): any other
// request, to the rest of the checkout included, is refused too, so an option renders from its
// folder alone and the comparison's check that the folder is unchanged (D-281) covers all of it. The written manifest is then read back with the runner's own check
// (scripts/lib/screenshot-bundle.ts `checkBundle`); any mismatch fails the step.
//
// Usage:
//   node scripts/render-screenshots.ts --kind gallery|options|head-options --commit <sha>
//     --out <dir> [--root <dir>] [--changed-since <base sha>, options only] [--browser chrome]
//
// --browser chrome drives the Google Chrome GitHub's Ubuntu runners carry; without it, the
// Chromium of the installed Playwright browsers is used (local runs).
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { chromium, type Browser, type BrowserContext } from "playwright-core";

import { SHOT_ATTRIBUTES, SHOT_PARAMS } from "../gallery/shot-mode.ts";
import { OPTION_MARKERS } from "../src/core/visual-comparison.ts";
import {
  OPTION_PAGE,
  checkBundle,
  galleryBundle,
  headOptionFolders,
  optionFolders,
  optionRegions,
  optionsBundle,
  writeBundle,
  type BundleSummary,
  type MarkedElement,
  type OptionFolder,
  type RenderedOption,
  type RenderedShot,
} from "./lib/screenshot-bundle.ts";

/** The fixed viewport and device scale every screenshot is taken at. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
export const DEVICE_SCALE = 1;

const COMMIT = /^[0-9a-f]{40}$/;
const NAV_TIMEOUT_MS = 30_000;

class RenderError extends Error {}

// ---- A static server on 127.0.0.1 ----------------------------------------------------------------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Serves files under `root` read-only. No path outside it and no dot-named file or folder (so no
 * `.git` or `.env`). With `fallback`, an unknown path serves that file (the gallery's single page).
 */
async function serve(
  root: string,
  fallback?: string,
): Promise<{ origin: string; server: Server }> {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const send = (status: number, body: Uint8Array | string, type = "text/plain") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "");
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return send(400, "");
    }
    const parts = path.split("/").filter((p) => p !== "");
    if (parts.some((p) => p.startsWith(".") || p.includes("\\") || p.includes("\0"))) {
      return send(404, "");
    }
    let file = join(base, ...parts);
    if (file !== base && !file.startsWith(base + sep)) return send(404, "");
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      return send(
        200,
        readFileSync(file),
        TYPES[extname(file)] ?? "application/octet-stream",
      );
    } catch {
      if (fallback) return send(200, readFileSync(fallback), TYPES[".html"]);
      return send(404, "");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new RenderError("the local server has no port");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

// ---- The browser ---------------------------------------------------------------------------------

async function newContext(browser: Browser, origin: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  // Only the local server: a page that reaches the network would not render the same twice.
  await context.route("**/*", (route) =>
    route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
  );
  return context;
}

const SCREENSHOT = { animations: "disabled", caret: "hide", scale: "css" } as const;

// ---- Gallery -------------------------------------------------------------------------------------

interface ListedEntry {
  id: string;
  specPath: string;
  variants: string[];
}

function buildGallery(root: string, outDir: string): void {
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  execFileSync(
    process.execPath,
    [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
}

export async function renderGallery(
  browser: Browser,
  root: string,
  commit: string,
  out: string,
): Promise<BundleSummary> {
  const built = mkdtempSync(join(tmpdir(), "foreman-gallery-"));
  try {
    buildGallery(root, built);
    const { origin, server } = await serve(built, join(built, "index.html"));
    try {
      const context = await newContext(browser, origin);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}/gallery`, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForSelector(`[${SHOT_ATTRIBUTES.entry}]`, {
        timeout: NAV_TIMEOUT_MS,
      });
      const entries: ListedEntry[] = await page.$$eval(
        `[${SHOT_ATTRIBUTES.entry}]`,
        (sections, a) =>
          sections.map((s) => ({
            id: s.getAttribute(a.entry) ?? "",
            specPath: s.getAttribute(a.spec) ?? "",
            variants: [...s.querySelectorAll(`[${a.variant}]`)].map(
              (v) => v.getAttribute(a.variant) ?? "",
            ),
          })),
        SHOT_ATTRIBUTES,
      );
      if (entries.length === 0) throw new RenderError("the gallery lists no entries");

      const shots: RenderedShot[] = [];
      const specs = new Map<string, Uint8Array>();
      for (const entry of entries) {
        if (!specs.has(entry.specPath)) {
          try {
            specs.set(entry.specPath, readFileSync(join(root, entry.specPath)));
          } catch {
            throw new RenderError(
              `gallery entry ${entry.id}: its spec ${entry.specPath} is not in the commit`,
            );
          }
        }
        for (const [index, variant] of entry.variants.entries()) {
          const query = new URLSearchParams({
            [SHOT_PARAMS.entry]: entry.id,
            [SHOT_PARAMS.variant]: variant,
          });
          await page.goto(`${origin}/gallery?${query}`, {
            waitUntil: "load",
            timeout: NAV_TIMEOUT_MS,
          });
          const frame = page.locator(
            `[${SHOT_ATTRIBUTES.shot}][${SHOT_ATTRIBUTES.ready}="true"]`,
          );
          await frame.waitFor({ timeout: NAV_TIMEOUT_MS });
          const png = await frame.screenshot(SCREENSHOT);
          shots.push({
            component: entry.id,
            variant,
            index,
            specPath: entry.specPath,
            png,
          });
        }
      }
      if (errors.length > 0)
        throw new RenderError(`the gallery threw an error: ${errors[0]}`);
      await context.close();
      writeBundle(out, galleryBundle(commit, shots, specs));
    } finally {
      server.close();
    }
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
  return checked(out, commit, "gallery");
}

// ---- Options -------------------------------------------------------------------------------------

function gitLines(root: string, args: string[]): string[] {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");
}

export async function renderOptions(
  browser: Browser,
  root: string,
  commit: string,
  out: string,
  changedSince?: string,
): Promise<BundleSummary | null> {
  const tracked = gitLines(root, ["ls-files"]);
  const changed =
    changedSince === undefined
      ? undefined
      : gitLines(root, ["diff", "--name-only", `${changedSince}...HEAD`]);
  const found = optionFolders(tracked, changed);
  if ("problem" in found) throw new RenderError(found.problem);
  if (found.folders.length === 0) return null;
  return renderOptionPages(browser, root, commit, out, found.folders, "options");
}

/** Every option folder at the commit, for the visual comparison (D-281). */
export async function renderHeadOptions(
  browser: Browser,
  root: string,
  commit: string,
  out: string,
): Promise<BundleSummary | null> {
  const found = headOptionFolders(gitLines(root, ["ls-files"]));
  if ("problem" in found) throw new RenderError(found.problem);
  if (found.folders.length === 0) return null;
  return renderOptionPages(browser, root, commit, out, found.folders, "head-options");
}

async function renderOptionPages(
  browser: Browser,
  root: string,
  commit: string,
  out: string,
  folders: readonly OptionFolder[],
  kind: "options" | "head-options",
): Promise<BundleSummary> {
  const { origin, server } = await serve(root);
  try {
    const context = await newContext(browser, origin);
    const rendered: RenderedOption[] = [];
    for (const folder of folders) {
      const page = await context.newPage();
      // Only this option's own folder (D-285); a page route runs before the context's.
      const own = `${origin}/${folder.path}/`;
      let refused = 0;
      await page.route("**/*", (route) => {
        if (route.request().url().startsWith(own)) return route.continue();
        refused += 1;
        return route.abort();
      });
      await page.goto(`${origin}/${folder.path}/${OPTION_PAGE}`, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const marked: MarkedElement[] = await page.$$eval(
        `[${OPTION_MARKERS.component}]`,
        (els, m) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            const attributes: Record<string, string | undefined> = {
              [m.component]: el.getAttribute(m.component) ?? undefined,
            };
            const variant = el.getAttribute(m.variant);
            if (variant !== null) attributes[m.variant] = variant;
            return {
              attributes,
              box: {
                x: r.left + window.scrollX,
                y: r.top + window.scrollY,
                width: r.width,
                height: r.height,
              },
            };
          }),
        OPTION_MARKERS,
      );
      const png = await page.screenshot({ ...SCREENSHOT, fullPage: true });
      await page.close();
      if (refused > 0) {
        console.log(`${folder.path}: refused ${refused} requests outside its folder`);
      }
      const { width, height } = pngSize(png);
      const regions = optionRegions(marked, { width, height });
      if ("problem" in regions)
        throw new RenderError(`${folder.path}: ${regions.problem}`);
      rendered.push({ ...folder, png, regions: regions.regions });
    }
    await context.close();
    writeBundle(out, optionsBundle(commit, rendered, kind));
  } finally {
    server.close();
  }
  return checked(out, commit, kind);
}

/** Width and height from a PNG's header. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function checked(
  out: string,
  commit: string,
  kind: "gallery" | "options" | "head-options",
): BundleSummary {
  const result = checkBundle(out, commit, kind);
  if ("problem" in result) {
    throw new RenderError(
      `the written ${kind} manifest fails the runner's check: ${result.problem}`,
    );
  }
  return result.summary;
}

// ---- Command line --------------------------------------------------------------------------------

export function describeSummary(
  summary: BundleSummary,
  commit: string,
  out: string,
): string {
  const what =
    summary.kind === "gallery"
      ? `${summary.images} gallery shots, ${summary.extras} spec files`
      : `${summary.images} option pages, ${summary.extras} marked regions`;
  return `render-screenshots: ${summary.kind} bundle for ${commit}: ${what}; manifest validated (${join(out, "manifest.json")})`;
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      commit: { type: "string" },
      out: { type: "string" },
      root: { type: "string" },
      "changed-since": { type: "string" },
      browser: { type: "string" },
    },
    strict: true,
  });
  const kind = values.kind;
  if (kind !== "gallery" && kind !== "options" && kind !== "head-options")
    throw new RenderError("--kind must be gallery, options or head-options");
  const commit = values.commit ?? "";
  if (!COMMIT.test(commit))
    throw new RenderError("--commit must be a full 40-character commit sha");
  if (!values.out) throw new RenderError("--out is required");
  if (values.browser !== undefined && values.browser !== "chrome") {
    throw new RenderError("--browser takes only chrome");
  }
  const changedSince = values["changed-since"];
  if (changedSince !== undefined && !COMMIT.test(changedSince)) {
    throw new RenderError("--changed-since must be a full 40-character commit sha");
  }
  if (changedSince !== undefined && kind !== "options") {
    throw new RenderError("--changed-since applies to --kind options only");
  }
  const root = resolve(values.root ?? process.cwd());
  const out = resolve(values.out);
  const head = gitLines(root, ["rev-parse", "HEAD"])[0];
  if (head !== commit) throw new RenderError("--commit is not the commit checked out");

  const browser = await chromium.launch(
    values.browser === "chrome" ? { channel: "chrome" } : {},
  );
  try {
    const summary =
      kind === "gallery"
        ? await renderGallery(browser, root, commit, out)
        : kind === "options"
          ? await renderOptions(browser, root, commit, out, changedSince)
          : await renderHeadOptions(browser, root, commit, out);
    console.log(
      summary
        ? describeSummary(summary, commit, out)
        : `render-screenshots: no option folders to render; no ${kind} bundle written`,
    );
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof RenderError ? error.message : String(error);
    console.error(`render-screenshots: ${message}`);
    process.exit(1);
  });
}
