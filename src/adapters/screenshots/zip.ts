// Reads a workflow artifact, which GitHub serves as a zip file, in memory (D-242, D-267). Only
// stored and deflated entries are read; folders are skipped. A path that is absolute, has a `.` or
// `..` part, a backslash or a control character is refused, and so is an encrypted entry, so a
// crafted artifact cannot name a file outside the bundle. The number of entries and every entry's
// unpacked size are bounded (the inflate stops at the bound, so a zip bomb cannot fill memory).
// Each file's SHA-256 is still checked against the manifest by the visual comparison.
//
// `readZipEntries` is the same reader with its bounds given and each entry's symbolic link flag
// (a Unix mode of `S_IFLNK` in the entry's external attributes), for the staging site's file set
// (src/adapters/deploy/site-files.ts, O-116), which refuses links. Every refusal names its `code`.
import { inflateRawSync } from "node:zlib";

import { isPlainRelativePath } from "../github/archive-path.ts";

export const ZIP_LIMITS = {
  entries: 2_000,
  /** One entry, unpacked. */
  entryBytes: 20 * 1024 * 1024,
  /** All entries together, unpacked. */
  totalBytes: 200 * 1024 * 1024,
} as const;

export type ZipLimits = { [K in keyof typeof ZIP_LIMITS]: number };

/** What a refusal was about: the archive itself, or a bound or rule an entry broke. */
export type ZipErrorCode =
  | "not_zip"
  | "malformed"
  | "too_many_entries"
  | "entry_too_large"
  | "too_large"
  | "bad_path"
  | "encrypted"
  | "compression"
  | "duplicate";

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  constructor(message: string, code: ZipErrorCode = "malformed") {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

/** One file of the zip. `symlink` is true when the entry is a Unix symbolic link. */
export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  symlink: boolean;
}

/** The host system byte of "version made by" for Unix, whose attributes carry a mode. */
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function checkedPath(name: string): string {
  if (!isPlainRelativePath(name)) {
    throw new ZipError("the artifact names a path outside the bundle", "bad_path");
  }
  return name;
}

/** Every file of the zip by its path. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readZipEntries(bytes, ZIP_LIMITS))
    files.set(entry.path, entry.bytes);
  return files;
}

/** Every file of the zip, in the directory's order, within `limits`. */
export function readZipEntries(bytes: Uint8Array, limits: ZipLimits): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 64 KiB plus its own 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("the artifact is not a zip file", "not_zip");
  const count = buf.readUInt16LE(eocd + 10);
  const centralStart = buf.readUInt32LE(eocd + 16);
  if (count > limits.entries) {
    throw new ZipError(
      `the artifact has more than ${limits.entries} entries`,
      "too_many_entries",
    );
  }
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = centralStart;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError("the artifact's directory is malformed");
    }
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const path = checkedPath(name);
    if ((flags & 0x1) !== 0) {
      throw new ZipError("the artifact has an encrypted entry", "encrypted");
    }
    if (size > limits.entryBytes) {
      throw new ZipError(
        `an artifact entry is larger than ${limits.entryBytes} bytes`,
        "entry_too_large",
      );
    }
    total += size;
    if (total > limits.totalBytes) {
      throw new ZipError(
        `the artifact unpacks to more than ${limits.totalBytes} bytes`,
        "too_large",
      );
    }
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL) {
      throw new ZipError("the artifact's entry header is malformed");
    }
    const dataAt =
      localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    if (dataAt + compressed > buf.length)
      throw new ZipError("the artifact is cut short");
    const data = buf.subarray(dataAt, dataAt + compressed);
    let unpacked: Buffer;
    if (method === 0) unpacked = Buffer.from(data);
    else if (method === 8) {
      try {
        unpacked = inflateRawSync(data, { maxOutputLength: limits.entryBytes });
      } catch {
        throw new ZipError("an artifact entry does not inflate within its bound");
      }
    } else
      throw new ZipError(
        "an artifact entry uses a compression the runner does not read",
        "compression",
      );
    if (unpacked.length !== size) {
      throw new ZipError("an artifact entry's size does not match its directory");
    }
    if (seen.has(path)) {
      throw new ZipError("the artifact names one path twice", "duplicate");
    }
    seen.add(path);
    const symlink = madeBy === UNIX_HOST && ((external >>> 16) & S_IFMT) === S_IFLNK;
    entries.push({ path, bytes: new Uint8Array(unpacked), symlink });
  }
  return entries;
}
