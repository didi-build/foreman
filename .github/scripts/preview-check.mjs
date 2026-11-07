// CI's preview check (D-354, O-111), with Node's built-in modules only. It replaces the hosted
// preview of ADR 0005: CI builds the app on its own machine, writes the commit marker into the
// build, serves it on 127.0.0.1 (./serve-site.mjs) and probes it. The runner records this job's
// result as `preview_check` (src/core/preview-check.ts). It lives under `.github/`, a privileged
// path, so a pull request cannot change what the check does without Didi's approval.
//
//   node .github/scripts/preview-check.mjs marker <site folder> <commit>
//     Writes the commit marker `foreman-commit.txt` at the site's root: the commit, 40 lowercase
//     hex characters, and a newline. The path is fixed: the staging deploy (D-353) uses it too.
//   node .github/scripts/preview-check.mjs probe <origin> <commit>
//     Checks the site served at <origin> (`http://127.0.0.1:<port>`): the app loads, judged by
//     the gallery's bundle marker in its built JavaScript and never in the single-page HTML alone
//     (the hosted preview's probe), and the served commit marker is <commit>.
//
// Each failure prints one fixed line naming the step and exits 1. Nothing the site serves is
// printed, and nothing outside 127.0.0.1 is reached.
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The commit marker at the site's root (`COMMIT_MARKER_FILE` in src/core/preview-check.ts). */
export const COMMIT_MARKER_FILE = "foreman-commit.txt";

/** In the gallery's built JavaScript only (`GALLERY_PROBE_MARKER`, gallery/gallery-probe-marker.ts). */
export const GALLERY_BUNDLE_MARKER = "launchpad-gallery-bundle-probe";

/** The gallery's page, as the hosted preview's probe read it. */
export const GALLERY_PATH = "/gallery";

const COMMIT = /^[0-9a-f]{40}$/;
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
/** The gallery's entry script, as Vite names it in the page. */
const ENTRY_SCRIPT = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** How long the probe waits for the server, and for each answer. */
export const PROBE_LIMITS = { waitMs: 30_000, requestMs: 5_000, retryMs: 200 };

export class PreviewCheckError extends Error {}

/** Writes the commit marker into the built site at `siteDir`. */
export function writeCommitMarker(siteDir, commit) {
  if (!COMMIT.test(commit ?? "")) {
    throw new PreviewCheckError("the commit must be 40 lowercase hex characters");
  }
  if (!statSync(join(siteDir, "index.html"), { throwIfNoEntry: false })?.isFile()) {
    throw new PreviewCheckError("the site folder has no index.html; build it first");
  }
  writeFileSync(join(siteDir, COMMIT_MARKER_FILE), `${commit}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One GET on the local server: the body of a 200 answer, or a fixed error naming the path. */
async function get(origin, path, limits) {
  let answer;
  try {
    answer = await fetch(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(limits.requestMs),
    });
  } catch {
    throw new PreviewCheckError(`${path} did not answer`);
  }
  if (answer.status !== 200) {
    await answer.body?.cancel();
    throw new PreviewCheckError(`${path} answered ${answer.status}`);
  }
  try {
    return await answer.text();
  } catch {
    throw new PreviewCheckError(`${path} did not answer`);
  }
}

/** Waits until the server answers at all, up to `limits.waitMs`. */
async function waitForServer(origin, limits) {
  const deadline = Date.now() + limits.waitMs;
  for (;;) {
    try {
      const answer = await fetch(`${origin}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(limits.requestMs),
      });
      await answer.body?.cancel();
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new PreviewCheckError(`the site did not answer on ${origin}`);
      }
      await sleep(limits.retryMs);
    }
  }
}

/** Probes the site at `origin`; throws `PreviewCheckError` with a fixed reason on any failure. */
export async function probeSite(origin, commit, limits = PROBE_LIMITS) {
  if (!LOCAL_ORIGIN.test(origin ?? "")) {
    throw new PreviewCheckError("the origin must be http://127.0.0.1:<port>");
  }
  if (!COMMIT.test(commit ?? "")) {
    throw new PreviewCheckError("the commit must be 40 lowercase hex characters");
  }
  await waitForServer(origin, limits);

  const page = await get(origin, GALLERY_PATH, limits);
  if (page.includes(GALLERY_BUNDLE_MARKER)) {
    throw new PreviewCheckError(
      "the bundle marker is in the page's HTML; it must be only in the built JavaScript",
    );
  }
  const script = page.match(ENTRY_SCRIPT)?.[0];
  if (!script) throw new PreviewCheckError(`no gallery script in ${GALLERY_PATH}`);
  const code = await get(origin, script, limits);
  if (!code.includes(GALLERY_BUNDLE_MARKER)) {
    throw new PreviewCheckError("the gallery's script has no bundle marker");
  }

  const served = await get(origin, `/${COMMIT_MARKER_FILE}`, limits);
  if (served !== `${commit}\n` && served !== commit) {
    throw new PreviewCheckError(`the served ${COMMIT_MARKER_FILE} is not the commit`);
  }
}

async function main(args) {
  const [command, first, commit] = args;
  if (args.length !== 3 || (command !== "marker" && command !== "probe")) {
    console.error(
      "preview-check: usage: preview-check.mjs marker <site folder> <commit> | probe <origin> <commit>",
    );
    process.exit(1);
  }
  try {
    if (command === "marker") {
      writeCommitMarker(first, commit);
      console.log(`preview-check: wrote ${COMMIT_MARKER_FILE}`);
    } else {
      await probeSite(first, commit);
      console.log("preview-check: the app loads and serves the commit");
    }
  } catch (error) {
    const reason =
      error instanceof PreviewCheckError ? error.message : "an unexpected error";
    console.error(`preview-check: ${command} failed: ${reason}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
