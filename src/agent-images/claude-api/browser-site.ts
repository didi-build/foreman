// The site the browser host serves (ADR 0119 slice 5b, D-476, D-478). The runner puts the site's
// zip, which CI built and the runner checked (slice 5a), into the run's site Secret, the browser
// pod's only Secret. The host unpacks it once into an in-memory folder (an emptyDir on `Memory`),
// leaves every file and folder read-only, and serves it on 127.0.0.1 only with CI's own static
// server (`siteHandler`, .github/scripts/serve-site.mjs): a folder serves its `index.html`, any
// other path with no file serves the root `index.html` (the single-page fallback), and no dot-named
// part or path outside the folder is ever served. The site's backend does not run (D-478): any
// path under `/api/`, and `/api` itself, answers 503 with one fixed text.
//
// The zip is read with the runner's own zip reader (../../adapters/screenshots/zip.ts): plain
// relative paths only, stored or deflated entries only, nothing encrypted, and bounds on the
// entries and on what they unpack to, so a crafted zip cannot fill the pod's memory. A symbolic
// link, a file where a folder is (or the reverse) and a zip with no file refuse the whole site.
// Every refusal is fixed text that names no path or byte of the zip.
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { HOST, siteHandler } from "../../../.github/scripts/serve-site.mjs";
import {
  readZipEntries,
  ZipError,
  type ZipEntry,
  type ZipLimits,
} from "../../adapters/screenshots/zip.ts";

const MIB = 1024 * 1024;

/**
 * The host's bounds on the site it unpacks. The zip itself is at most 900 KiB (the runner's
 * bound, slice 5a); these bound what it unpacks to, which lives in the pod's memory.
 */
export const SITE_LIMITS: ZipLimits = {
  /** Entries in the zip's directory, folders included. */
  entries: 4_000,
  entryBytes: 16 * MIB,
  totalBytes: 48 * MIB,
};

/** The largest zip file the host reads: a Kubernetes Secret holds at most 1 MiB. */
export const MAX_SITE_ZIP_FILE_BYTES = MIB;

/** The folder inside the in-memory volume that holds the site. */
export const SITE_FOLDER = "site";

/** What every `/api` path answers (D-478). */
export const BACKEND_OFF_TEXT =
  "This review serves the site's static files only. The site's backend does not run here, so every /api/ address answers 503.";

/** The fixed reasons a site is refused. */
export const SITE_REFUSALS = {
  notEmpty: "the site folder is not empty",
  unreadable: "the site zip is not a zip the browser host reads",
  bound: "the site zip unpacks past the browser host's bounds",
  link: "the site zip holds a symbolic link",
  empty: "the site zip holds no file",
  conflict: "the site zip names a file where a folder is, or a folder where a file is",
  write: "the site could not be written to its folder",
} as const;

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

const BOUND_CODES = new Set(["too_many_entries", "entry_too_large", "too_large"]);

/**
 * Unpacks the site's zip into `<root>/site`, which it makes, and leaves it read-only: files 0444
 * and folders 0555. `root` must be an empty folder. Returns the site's folder.
 */
export function unpackSite(zip: Uint8Array, root: string): string {
  if (readdirSync(root).length > 0) throw new SiteError(SITE_REFUSALS.notEmpty);
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(zip, SITE_LIMITS);
  } catch (error) {
    if (error instanceof ZipError && BOUND_CODES.has(error.code)) {
      throw new SiteError(SITE_REFUSALS.bound);
    }
    throw new SiteError(SITE_REFUSALS.unreadable);
  }
  if (entries.some((entry) => entry.symlink)) throw new SiteError(SITE_REFUSALS.link);
  if (entries.length === 0) throw new SiteError(SITE_REFUSALS.empty);

  const site = join(root, SITE_FOLDER);
  const folders: string[] = [site];
  const made = new Set<string>(folders);
  mkdirSync(site, { mode: 0o755 });
  try {
    for (const entry of entries) {
      const parts = entry.path.split("/");
      let folder = site;
      for (const part of parts.slice(0, -1)) {
        folder = join(folder, part);
        if (made.has(folder)) continue;
        mkdirSync(folder, { mode: 0o755 });
        made.add(folder);
        folders.push(folder);
      }
      // A new file only, never through a link: O_EXCL and O_NOFOLLOW.
      const fd = openSync(
        join(site, ...parts),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o444,
      );
      try {
        writeFileSync(fd, entry.bytes);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new SiteError(
      code === "EEXIST" || code === "ENOTDIR"
        ? SITE_REFUSALS.conflict
        : SITE_REFUSALS.write,
    );
  }
  for (const folder of folders.reverse()) chmodSync(folder, 0o555);
  return site;
}

/** True for `/api` and any path under `/api/`, read as the site's server reads paths. */
export function isBackendPath(url: string | undefined): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url ?? "/", "http://site").pathname);
  } catch {
    return false;
  }
  return path === "/api" || path.startsWith("/api/");
}

/** The site's server: `siteHandler` for the folder, and 503 with the fixed text for `/api`. */
export function siteServer(folder: string): Server {
  const serve = siteHandler(folder);
  return createServer((request, response) => {
    if (isBackendPath(request.url)) {
      response.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : BACKEND_OFF_TEXT);
      return;
    }
    serve(request, response);
  });
}

/** Starts the site's server on 127.0.0.1 and a free port, and gives its origin. */
export function startSite(folder: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve, reject) => {
    const server = siteServer(folder);
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://${HOST}:${port}` });
    });
  });
}
