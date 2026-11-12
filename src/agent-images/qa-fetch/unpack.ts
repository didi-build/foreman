// QA's fetch step's unpack (ADR 0106 section 5, ADR 0112, D-184, O-124). It reads the gzip'd tar
// GitHub serves for one commit (`/repos/{owner}/{repo}/tarball/{sha}`, made by `git archive`) as
// it arrives, and writes the checkout into the run's volume, which QA's pod then mounts
// read-only. Nothing in the archive is ever run.
//
// The archive must name the requested commit in its first entry (the global pax header `git
// archive` writes, `comment=<sha>`, which `git get-tar-commit-id` reads), or nothing is written.
// Only regular files and folders are unpacked: a symbolic link, a hard link, a device file or any
// other kind of entry refuses the whole archive, as does a path that is absolute, has an empty,
// `.` or `..` part, a backslash or a control character, is not UTF-8, leaves the archive's one top
// folder, has a `.git` part, or comes twice. Each file and folder is created new, never over or
// through something already there; each file is read-only, and each folder is made read-only once
// the tree is complete. The archive, its unpacked size and its numbers of files and folders are
// bounded as the repo map's are. Each path, and each file's bytes as they arrive and before they
// are written, are scanned for the forms of the run's GitHub token (the secret-value scan,
// scripts/lib/find-secret-values.mjs): a hit refuses the archive. On any refusal everything written
// is removed again, so the workspace is left as it was and the run fails closed. A refusal is
// fixed text: nothing from the archive is ever repeated.
import { constants } from "node:fs";
import { chmod, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

import { isPlainRelativePath } from "../../adapters/github/archive-path.ts";

/**
 * The bounds of one archive: the repo map's (`MAX_ARCHIVE_BYTES` in src/adapters/repo-map/
 * github.ts, `TARBALL_LIMITS` in src/adapters/repo-map/tarball.ts), held equal by a test, with
 * folders counted apart from files and a bound on one pax header.
 */
export const FETCH_LIMITS = {
  /** The archive as downloaded, gzip'd. */
  archiveBytes: 100 * 1024 * 1024,
  /** The tar once unpacked: headers, files and padding. */
  unpackedBytes: 200 * 1024 * 1024,
  /** Regular files. */
  files: 50_000,
  /** Folders, the archive's own and those its paths need. */
  folders: 50_000,
  /** The records of one pax header. */
  paxBytes: 64 * 1024,
} as const;

export type FetchLimits = { [K in keyof typeof FETCH_LIMITS]: number };

/** Every refusal, as fixed text. None names a path, a value or anything else from the archive. */
export const REFUSED = {
  tooLarge: `the archive is larger than ${FETCH_LIMITS.archiveBytes} bytes`,
  notGzip: "the archive is not gzip",
  unreadable: "the archive could not be read",
  unpacksTooLarge: `the archive unpacks to more than ${FETCH_LIMITS.unpackedBytes} bytes`,
  cutShort: "the archive is cut short",
  malformed: "a tar header is malformed",
  wrongCommit: "the archive is not of the requested commit",
  outside: "the archive names a path outside the checkout",
  notUtf8: "the archive names a path that is not UTF-8",
  gitPath: "the archive names a .git path",
  tooLong: "the archive names a path too long to write",
  twice: "the archive names a path twice",
  symlink: "the archive holds a symbolic link",
  hardLink: "the archive holds a hard link",
  device: "the archive holds a device file",
  otherKind: "the archive holds an entry that is not a file or a folder",
  tooManyFiles: `the archive has more than ${FETCH_LIMITS.files} files`,
  tooManyFolders: `the archive has more than ${FETCH_LIMITS.folders} folders`,
  afterEnd: "the archive holds data after its end",
  token: "the secret-value scan found the GitHub token in the archive",
  noScan: "the secret-value scan has no value to look for",
  notWritten: "the tree could not be written",
} as const;

/** A refusal: the archive or its bounds were wrong. Its message is one of `REFUSED`. */
export class FetchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefusal";
  }
}

const refuse = (message: string): never => {
  throw new FetchRefusal(message);
};

export interface UnpackTarget {
  /** An existing folder holding nothing this run needs: the run's volume. */
  workspace: string;
  /** The full commit the archive must name. */
  commitSha: string;
  /** What the secret-value scan looks for: the forms of the run's GitHub token. */
  secretTexts: readonly string[];
}

export interface UnpackSummary {
  files: number;
  folders: number;
  /** The files' bytes. */
  bytes: number;
}

const BLOCK = 512;
const ZEROS = Buffer.alloc(64 * 1024);
/** How much of a file is read, scanned and written at a time. */
const PART_BYTES = 64 * 1024;
/** Linux's limits on one name and on a whole path. */
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 4095;
const FILE_MODE = 0o444;
const OPEN_FOLDER_MODE = 0o755;
const SEALED_FOLDER_MODE = 0o555;
/** A new file only: never one that exists, and never through a symbolic link. */
const NEW_FILE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Unpacks the gzip'd archive into `target.workspace`, or refuses it and leaves the workspace as
 * it was. Throws only `FetchRefusal`.
 */
export async function unpackArchive(
  gzipped: AsyncIterable<Uint8Array>,
  target: UnpackTarget,
  limits: FetchLimits = FETCH_LIMITS,
): Promise<UnpackSummary> {
  const tree = new Tree(target.workspace, limits);
  const tar = new TarBytes(gunzipped(gzipped, limits), limits);
  try {
    if (target.secretTexts.length === 0) refuse(REFUSED.noScan);
    const scan = new SecretScan(target.secretTexts);
    await readArchive(tar, target.commitSha, tree, scan, limits);
    await tree.seal();
    return { files: tree.files.size, folders: tree.folders.size, bytes: tree.bytes };
  } catch (error) {
    await tree.removeAll();
    throw asRefusal(error);
  } finally {
    await tar.close();
  }
}

/** A refusal as it is, and anything else as fixed text by where it came from. */
function asRefusal(error: unknown): FetchRefusal {
  if (error instanceof FetchRefusal) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("Z_")) {
    return new FetchRefusal(REFUSED.notGzip);
  }
  if ((error as { syscall?: unknown } | null)?.syscall !== undefined) {
    return new FetchRefusal(REFUSED.notWritten);
  }
  return new FetchRefusal(REFUSED.unreadable);
}

/** The archive as it arrives, refused once it is larger than its bound. */
async function* bounded(
  chunks: AsyncIterable<Uint8Array>,
  limits: FetchLimits,
): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > limits.archiveBytes) refuse(REFUSED.tooLarge);
    yield chunk;
  }
}

/** The archive unpacked as it is read. An error anywhere reaches the reader. */
function gunzipped(
  gzipped: AsyncIterable<Uint8Array>,
  limits: FetchLimits,
): AsyncIterable<Buffer> {
  return pipeline(
    Readable.from(bounded(gzipped, limits), { objectMode: false }),
    createGunzip(),
    () => {},
  );
}

/** The unpacked tar as bytes, counted against its bound as they arrive. */
class TarBytes {
  private readonly source: AsyncIterator<Buffer>;
  private readonly limits: FetchLimits;
  private chunk: Buffer = Buffer.alloc(0);
  private at = 0;
  private total = 0;

  constructor(source: AsyncIterable<Buffer>, limits: FetchLimits) {
    this.source = source[Symbol.asyncIterator]();
    this.limits = limits;
  }

  /** At least one and at most `max` bytes, or null at the end. */
  async some(max: number): Promise<Buffer | null> {
    while (this.at >= this.chunk.length) {
      const next = await this.source.next();
      if (next.done) return null;
      this.total += next.value.length;
      if (this.total > this.limits.unpackedBytes) refuse(REFUSED.unpacksTooLarge);
      this.chunk = next.value;
      this.at = 0;
    }
    const part = this.chunk.subarray(this.at, this.at + max);
    this.at += part.length;
    return part;
  }

  /** Exactly `length` bytes: an archive that ends first was cut short. */
  async exactly(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (let left = length; left > 0;) {
      const part = (await this.some(left)) ?? refuse(REFUSED.cutShort);
      parts.push(part);
      left -= part.length;
    }
    return Buffer.concat(parts);
  }

  async skip(length: number): Promise<void> {
    for (let left = length; left > 0;) {
      const part = (await this.some(left)) ?? refuse(REFUSED.cutShort);
      left -= part.length;
    }
  }

  /** Reads to the end: after the end marker there may be zeros only (git pads with them). */
  async zerosToEnd(): Promise<void> {
    for (;;) {
      const part = await this.some(ZEROS.length);
      if (part === null) return;
      if (!part.equals(ZEROS.subarray(0, part.length))) refuse(REFUSED.afterEnd);
    }
  }

  /** Stops the download and the unpacking if the archive was not read to its end. */
  async close(): Promise<void> {
    await this.source.return?.().catch(() => {});
  }
}

/** The forms of the token, looked for in each path and in each file's bytes as they arrive. */
class SecretScan {
  private readonly texts: readonly string[];
  private readonly needles: readonly Buffer[];
  /** How many bytes of a file's last part are kept, so a form split across two parts is found. */
  private readonly overlap: number;
  private tail: Buffer = Buffer.alloc(0);

  constructor(texts: readonly string[]) {
    this.texts = texts;
    this.needles = texts.map((text) => Buffer.from(text, "utf8"));
    this.overlap = Math.max(...this.needles.map((needle) => needle.length)) - 1;
  }

  path(path: string): void {
    if (this.texts.some((text) => path.includes(text))) refuse(REFUSED.token);
  }

  startFile(): void {
    this.tail = Buffer.alloc(0);
  }

  part(bytes: Buffer): void {
    const window = this.tail.length === 0 ? bytes : Buffer.concat([this.tail, bytes]);
    if (this.needles.some((needle) => window.includes(needle))) refuse(REFUSED.token);
    this.tail = Buffer.from(window.subarray(Math.max(0, window.length - this.overlap)));
  }
}

/** The tree in the workspace: what was made, so it can be sealed, or removed on a refusal. */
class Tree {
  readonly files = new Set<string>();
  readonly folders = new Set<string>();
  bytes = 0;
  private readonly root: string;
  private readonly limits: FetchLimits;
  /** The workspace's own entries this run made. */
  private readonly made = new Set<string>();

  constructor(root: string, limits: FetchLimits) {
    this.root = root;
    this.limits = limits;
  }

  /** `inside` is plain (`checkoutPath`), so the path it joins to stays in the workspace. */
  private absolute(inside: string): string {
    const path = join(this.root, inside);
    if (Buffer.byteLength(path) > MAX_PATH_BYTES) refuse(REFUSED.tooLong);
    return path;
  }

  /** Makes the folder `inside` and each folder above it not made yet, each one new. */
  async folder(inside: string): Promise<void> {
    const parts = inside.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = parts.slice(0, depth).join("/");
      if (this.files.has(path)) refuse(REFUSED.twice);
      if (this.folders.has(path)) continue;
      if (this.folders.size >= this.limits.folders) refuse(REFUSED.tooManyFolders);
      await mkdir(this.absolute(path), { mode: OPEN_FOLDER_MODE });
      this.folders.add(path);
      if (depth === 1) this.made.add(path);
    }
  }

  /** A new read-only file at `inside`, open for writing, in folders made here. */
  async file(inside: string): Promise<FileHandle> {
    if (this.files.has(inside) || this.folders.has(inside)) refuse(REFUSED.twice);
    const slash = inside.lastIndexOf("/");
    if (slash > 0) await this.folder(inside.slice(0, slash));
    if (this.files.size >= this.limits.files) refuse(REFUSED.tooManyFiles);
    const handle = await open(this.absolute(inside), NEW_FILE, FILE_MODE);
    this.files.add(inside);
    if (slash < 0) this.made.add(inside);
    return handle;
  }

  /** Every folder made read-only once the tree is complete. */
  async seal(): Promise<void> {
    for (const folder of this.folders) {
      await chmod(this.absolute(folder), SEALED_FOLDER_MODE);
    }
  }

  /** Removes everything this run wrote. */
  async removeAll(): Promise<void> {
    for (const folder of this.folders) {
      await chmod(join(this.root, folder), OPEN_FOLDER_MODE).catch(() => {});
    }
    for (const entry of this.made) {
      await rm(join(this.root, entry), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}

/** A NUL-ended field of a header. */
function field(header: Buffer, start: number, length: number): Buffer {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

function octal(header: Buffer, start: number, length: number): number {
  const text = field(header, start, length).toString("latin1").trim();
  if (!/^[0-7]{1,12}$/.test(text)) refuse(REFUSED.malformed);
  return Number.parseInt(text, 8);
}

function utf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return refuse(REFUSED.notUtf8);
  }
}

/** A pax header's records, each `<length> <key>=<value>\n`, read strictly. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const digits = space < 0 ? "" : data.toString("latin1", at, space);
    if (!/^[1-9][0-9]{0,5}$/.test(digits)) refuse(REFUSED.malformed);
    const end = at + Number(digits);
    if (end > data.length || data[end - 1] !== 0x0a) refuse(REFUSED.malformed);
    const record = utf8(data.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals < 1) refuse(REFUSED.malformed);
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at = end;
  }
  return records;
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** A pax header's data and its padding. */
async function paxData(tar: TarBytes, size: number, limits: FetchLimits) {
  if (size > limits.paxBytes) refuse(REFUSED.malformed);
  const data = await tar.exactly(size);
  await tar.skip(padding(size));
  return paxRecords(data);
}

/** Refuses every kind of entry but a regular file and a folder. */
function checkKind(type: string): void {
  if (type === "1") refuse(REFUSED.hardLink);
  if (type === "2") refuse(REFUSED.symlink);
  if (type === "3" || type === "4") refuse(REFUSED.device);
  if (type !== "0" && type !== "\0" && type !== "5") refuse(REFUSED.otherKind);
}

/** The entry's path split into the archive's top folder and the path inside the checkout. */
function checkoutPath(raw: string, folder: boolean): { top: string; inside: string } {
  const plain = folder && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!isPlainRelativePath(plain)) refuse(REFUSED.outside);
  const [top = "", ...parts] = plain.split("/");
  if (parts.includes(".git")) refuse(REFUSED.gitPath);
  if (parts.some((part) => Buffer.byteLength(part) > MAX_NAME_BYTES)) {
    refuse(REFUSED.tooLong);
  }
  return { top, inside: parts.join("/") };
}

async function readArchive(
  tar: TarBytes,
  commitSha: string,
  tree: Tree,
  scan: SecretScan,
  limits: FetchLimits,
): Promise<void> {
  let commitNamed = false;
  let top: string | null = null;
  let pax: Map<string, string> | null = null;
  for (;;) {
    const header = await tar.exactly(BLOCK);
    if (header.equals(ZEROS.subarray(0, BLOCK))) {
      if (!commitNamed) refuse(REFUSED.wrongCommit);
      if (pax !== null) refuse(REFUSED.malformed);
      await tar.zerosToEnd();
      return;
    }
    if (header.toString("latin1", 257, 265) !== "ustar\u000000")
      refuse(REFUSED.malformed);
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);

    // The first entry names the commit, and no later entry may name another.
    if (!commitNamed || type === "g") {
      if (commitNamed || type !== "g") refuse(REFUSED.wrongCommit);
      const records = await paxData(tar, size, limits);
      if (records.get("comment") !== commitSha) refuse(REFUSED.wrongCommit);
      commitNamed = true;
      continue;
    }
    if (type === "x") {
      if (pax !== null) refuse(REFUSED.malformed);
      pax = await paxData(tar, size, limits);
      continue;
    }
    const records = pax ?? new Map<string, string>();
    pax = null;

    checkKind(type);
    if ([...records.keys()].some((key) => key.startsWith("GNU.sparse"))) {
      refuse(REFUSED.otherKind);
    }
    const paxSize = records.get("size");
    if (paxSize !== undefined && paxSize !== String(size)) refuse(REFUSED.malformed);
    const name = utf8(field(header, 0, 100));
    const prefix = utf8(field(header, 345, 155));
    const raw = records.get("path") ?? (prefix === "" ? name : `${prefix}/${name}`);
    const folder = type === "5";
    const path = checkoutPath(raw, folder);
    if (top === null) top = path.top;
    if (path.top !== top) refuse(REFUSED.outside);
    scan.path(path.inside);

    if (folder) {
      if (size !== 0) refuse(REFUSED.malformed);
      // The top folder itself is the workspace.
      if (path.inside !== "") await tree.folder(path.inside);
      continue;
    }
    if (path.inside === "") refuse(REFUSED.outside);
    const handle = await tree.file(path.inside);
    try {
      scan.startFile();
      for (let left = size; left > 0;) {
        const part =
          (await tar.some(Math.min(left, PART_BYTES))) ?? refuse(REFUSED.cutShort);
        scan.part(part);
        for (let written = 0; written < part.length;) {
          const { bytesWritten } = await handle.write(
            part,
            written,
            part.length - written,
          );
          written += bytesWritten;
        }
        left -= part.length;
      }
    } finally {
      await handle.close();
    }
    tree.bytes += size;
    await tar.skip(padding(size));
  }
}
