// Reads a workflow artifact, which GitHub serves as a zip file, in memory (D-242, D-267). Only
// stored and deflated entries are read; folders are skipped. A path that is absolute, has a `.` or
// `..` part, a backslash or a control character is refused, and so is an encrypted entry, so a
// crafted artifact cannot name a file outside the bundle. The number of entries and every entry's
// unpacked size are bounded (the inflate stops at the bound, so a zip bomb cannot fill memory).
// Each file's SHA-256 is still checked against the manifest by the visual comparison.
import { inflateRawSync } from "node:zlib";

import { isPlainRelativePath } from "../github/archive-path.ts";

export const ZIP_LIMITS = {
  entries: 2_000,
  /** One entry, unpacked. */
  entryBytes: 20 * 1024 * 1024,
  /** All entries together, unpacked. */
  totalBytes: 200 * 1024 * 1024,
} as const;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function checkedPath(name: string): string {
  if (!isPlainRelativePath(name)) {
    throw new ZipError("the artifact names a path outside the bundle");
  }
  return name;
}

/** Every file of the zip by its path. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 64 KiB plus its own 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("the artifact is not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  const centralStart = buf.readUInt32LE(eocd + 16);
  if (count > ZIP_LIMITS.entries) {
    throw new ZipError(`the artifact has more than ${ZIP_LIMITS.entries} entries`);
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let at = centralStart;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError("the artifact's directory is malformed");
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const path = checkedPath(name);
    if ((flags & 0x1) !== 0) throw new ZipError("the artifact has an encrypted entry");
    if (size > ZIP_LIMITS.entryBytes) {
      throw new ZipError(
        `an artifact entry is larger than ${ZIP_LIMITS.entryBytes} bytes`,
      );
    }
    total += size;
    if (total > ZIP_LIMITS.totalBytes) {
      throw new ZipError(
        `the artifact unpacks to more than ${ZIP_LIMITS.totalBytes} bytes`,
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
        unpacked = inflateRawSync(data, { maxOutputLength: ZIP_LIMITS.entryBytes });
      } catch {
        throw new ZipError("an artifact entry does not inflate within its bound");
      }
    } else
      throw new ZipError(
        "an artifact entry uses a compression the runner does not read",
      );
    if (unpacked.length !== size) {
      throw new ZipError("an artifact entry's size does not match its directory");
    }
    if (files.has(path)) throw new ZipError("the artifact names one path twice");
    files.set(path, new Uint8Array(unpacked));
  }
  return files;
}
