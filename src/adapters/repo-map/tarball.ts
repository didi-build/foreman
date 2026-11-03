// Reads the repository archive GitHub serves for a commit (`/repos/{owner}/{repo}/tarball/{sha}`, a
// gzip'd tar made by `git archive`) in memory, for the repo map (D-251, D-267). Nothing is written
// to disk and nothing in the archive is run: the map only parses code files' text. Only regular
// files are read; links, devices and folders are skipped. Every path loses the archive's top
// folder (`<owner>-<repo>-<short sha>/`), and a path that is absolute, has a `.` or `..` part, a
// backslash or a control character is refused, so a crafted archive cannot name a file outside the
// checkout. `.git` and `node_modules` are skipped as in `readCheckout`. The archive, its unpacked
// size and its number of files are bounded, and the text of a file is kept only when the map
// parses it (a code file up to 1 MB, and the root `package.json`).
import { gunzipSync } from "node:zlib";

import { isPlainRelativePath } from "../github/archive-path.ts";

/** The bounds of one archive. */
export const TARBALL_LIMITS = {
  /** Unpacked bytes of the whole tar. */
  unpackedBytes: 200 * 1024 * 1024,
  /** Regular files listed. */
  files: 50_000,
  /** The largest file whose text is kept (the map parses nothing larger). */
  textBytes: 1_000_000,
} as const;

/** The files the map parses (src/adapters/repo-map/typescript.ts). */
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED = new Set([".git", "node_modules"]);
const BLOCK = 512;

export class TarballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarballError";
  }
}

function field(block: Uint8Array, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

function octal(block: Uint8Array, start: number, length: number): number {
  const text = field(block, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarballError("a tar header has a bad number");
  return Number.parseInt(text, 8);
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Uint8Array): string | null {
  const text = Buffer.from(data).toString("utf8");
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    const length = Number(text.slice(at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    at += length;
  }
  return null;
}

/** The path inside the checkout, without the archive's top folder, or null to skip it. */
function checkoutPath(raw: string): string | null {
  const plain = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!isPlainRelativePath(plain)) {
    throw new TarballError("the archive names a path outside the checkout");
  }
  const parts = plain.split("/");
  const inside = parts.slice(1);
  if (inside.length === 0) return null;
  if (inside.some((p) => SKIPPED.has(p))) return null;
  return inside.join("/");
}

/**
 * The checkout's regular files from a gzip'd tar, each with its text when the map parses it and
 * an empty text otherwise (the shape `buildRepoMap` takes).
 */
export function readTarball(gzipped: Uint8Array): Map<string, string> {
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: TARBALL_LIMITS.unpackedBytes });
  } catch {
    throw new TarballError(
      `the archive is not gzip, or unpacks to more than ${TARBALL_LIMITS.unpackedBytes} bytes`,
    );
  }
  const files = new Map<string, string>();
  let at = 0;
  let longPath: string | null = null;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new TarballError("the archive is cut short");
    const data = tar.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      longPath = paxPath(data);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const raw = longPath ?? (prefix ? `${prefix}/${name}` : name);
    longPath = null;
    if (type !== "0" && type !== "\0") continue;
    const path = checkoutPath(raw);
    if (path === null) continue;
    if (files.size >= TARBALL_LIMITS.files) {
      throw new TarballError(`the archive has more than ${TARBALL_LIMITS.files} files`);
    }
    const wanted =
      (CODE.test(path) && size <= TARBALL_LIMITS.textBytes) || path === "package.json";
    files.set(path, wanted ? Buffer.from(data).toString("utf8") : "");
  }
  return files;
}
