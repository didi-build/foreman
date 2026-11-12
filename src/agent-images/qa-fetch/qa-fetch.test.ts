// Seam: QA's fetch step's image (unit with a fake GitHub port, and integration as a process
// through a local stand-in for its egress proxy, O-124). Its settings and workspace checks, the
// archive it unpacks and how, each refusal (with the workspace left as it was), its bounds, and
// that the token reaches no output and no file. The archives are synthetic, shaped like the ones
// `git archive` makes for GitHub; the stand-in proxy answers CONNECT for GitHub's two hosts with
// a local TLS server, so nothing reaches the network. No real repository and no real token.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseAgentResult } from "../../adapters/agent-runtime/kubernetes/result.ts";
import { readBotFiles } from "../../adapters/contracts-file/bot-files.ts";
import { MAX_ARCHIVE_BYTES } from "../../adapters/repo-map/github.ts";
import { TARBALL_LIMITS } from "../../adapters/repo-map/tarball.ts";
import { CONNECT_RETRY_MS, CONNECT_TRIES } from "../shared/job-kit.ts";
import { runQaFetchImage, type ArchiveAnswer, type ArchiveHttp } from "./image.ts";
import { FETCH_LIMITS, REFUSED, unpackArchive } from "./unpack.ts";

const TOKEN = "ghs_notARealToken0123456789abcdefghijkl";
const REPO = "didi-build/rehearsal";
const SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);
const TOP = `didi-build-rehearsal-${SHA.slice(0, 7)}`;
const MIB = 1024 * 1024;

const ENV = {
  FOREMAN_RUN_ID: "6f1e2d3c-4b5a-4968-8778-695a4b3c2d1e",
  FOREMAN_REPOSITORY: REPO,
  FOREMAN_HEAD_SHA: SHA,
  FOREMAN_PR_NUMBER: "42",
  GITHUB_TOKEN: TOKEN,
  HTTPS_PROXY: "http://10.245.0.10:8080",
  NODE_USE_ENV_PROXY: "1",
};

// ---- Synthetic archives, as `git archive` makes them -------------------------------------

interface Entry {
  /** The entry's name as the archive gives it, top folder included. */
  name: string | Buffer;
  type?: string;
  data?: string | Buffer;
  linkName?: string;
  /** A pax header before the entry, with these records. */
  pax?: Record<string, string>;
  /** A pax header before the entry, with exactly these bytes. */
  paxRaw?: string;
  /** The ustar prefix field; `name` is then the rest. */
  prefix?: string;
  /** The size field's text, in place of the data's size. */
  sizeText?: string;
  magic?: string;
}

const inTop = (path: string) => `${TOP}/${path}`;

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512);
  const name = typeof entry.name === "string" ? Buffer.from(entry.name) : entry.name;
  name.copy(block, 0, 0, 100);
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(entry.sizeText ?? `${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("15275176312\0", 136);
  block.write(entry.type ?? "0", 156);
  if (entry.linkName) block.write(entry.linkName, 157, 100);
  block.write(entry.magic ?? "ustar\u000000", 257);
  if (entry.prefix) block.write(entry.prefix, 345, 155);
  block.write("        ", 148);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

const pad = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

function paxRecord(key: string, value: string): string {
  const rest = Buffer.byteLength(` ${key}=${value}\n`);
  let length = rest + 1;
  while (String(length).length + rest !== length) length = String(length).length + rest;
  return `${length} ${key}=${value}\n`;
}

function paxBlocks(type: "x" | "g", data: string): Buffer[] {
  const bytes = Buffer.from(data);
  return [header({ name: "pax_global_header", type }, bytes.length), pad(bytes)];
}

interface ArchiveOptions {
  /** The commit the global header names; null for no global header. */
  commit?: string | null;
  /** The global header's records in place of `comment=<commit>`. */
  globalRecords?: Record<string, string>;
  /** False for no top folder entry. */
  topFolder?: boolean;
  /** False for no end marker. */
  end?: boolean;
  /** Bytes after the end marker. git pads with zeros to a 10 KiB record. */
  tail?: Buffer;
}

function tar(entries: Entry[], options: ArchiveOptions = {}): Buffer {
  const blocks: Buffer[] = [];
  if (options.commit !== null) {
    const records = options.globalRecords ?? { comment: options.commit ?? SHA };
    blocks.push(
      ...paxBlocks(
        "g",
        Object.entries(records)
          .map(([k, v]) => paxRecord(k, v))
          .join(""),
      ),
    );
  }
  if (options.topFolder !== false)
    blocks.push(header({ name: `${TOP}/`, type: "5" }, 0));
  for (const entry of entries) {
    if (entry.pax) {
      const records = Object.entries(entry.pax)
        .map(([k, v]) => paxRecord(k, v))
        .join("");
      blocks.push(...paxBlocks("x", records));
    }
    if (entry.paxRaw !== undefined) blocks.push(...paxBlocks("x", entry.paxRaw));
    if (entry.type === "x-only") continue;
    const data = Buffer.from(entry.data ?? "");
    blocks.push(header(entry, data.length), pad(data));
  }
  if (options.end !== false) blocks.push(Buffer.alloc(1024));
  blocks.push(options.tail ?? Buffer.alloc(0));
  return Buffer.concat(blocks);
}

const archive = (entries: Entry[], options?: ArchiveOptions) =>
  gzipSync(tar(entries, options));

const BINARY = Buffer.from([0, 1, 2, 255, 0, 10, 13, 0]);
const LONG_NAME = `deep/${"a".repeat(120)}.ts`;

/** A small checkout: folders given and implied, a long name, a prefixed name, dot folders. */
const GOOD_ENTRIES: Entry[] = [
  { name: inTop("README.md"), data: "# Rehearsal\n" },
  { name: inTop("src/"), type: "5" },
  { name: inTop("src/app.ts"), data: 'export const app = "app";\n' },
  { name: inTop("docs/"), type: "5" },
  { name: inTop("docs/empty.txt"), data: "" },
  { name: inTop("assets/logo.bin"), data: BINARY },
  { name: "cut", pax: { path: inTop(LONG_NAME), mtime: "1527517631" }, data: "long\n" },
  { name: "file.md", prefix: inTop("very/long/prefix"), data: "prefixed\n" },
  { name: inTop(".github/workflows/ci.yml"), data: "name: CI\n" },
  { name: inTop("node_modules/x/index.js"), data: "export const x = 1;\n" },
];

/** What the workspace holds after the good archive: each path, its mode and its content. */
const GOOD_TREE = [
  ".github/ 555",
  ".github/workflows/ 555",
  ".github/workflows/ci.yml 444 name: CI\n",
  "README.md 444 # Rehearsal\n",
  "assets/ 555",
  `assets/logo.bin 444 ${BINARY.toString("latin1")}`,
  "deep/ 555",
  `${LONG_NAME} 444 long\n`,
  "docs/ 555",
  "docs/empty.txt 444 ",
  "node_modules/ 555",
  "node_modules/x/ 555",
  "node_modules/x/index.js 444 export const x = 1;\n",
  "src/ 555",
  'src/app.ts 444 export const app = "app";\n',
  "very/ 555",
  "very/long/ 555",
  "very/long/prefix/ 555",
  "very/long/prefix/file.md 444 prefixed\n",
].sort();

// ---- Workspaces and the fake GitHub port --------------------------------------------------

const made: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-qa-fetch-"));
  made.push(dir);
  return dir;
}

/** Each entry under `root`, sorted: folders end with `/`, then the mode, then a file's text. */
function listTree(root: string, at = ""): string[] {
  const lines: string[] = [];
  for (const name of readdirSync(join(root, at)).sort()) {
    const path = at === "" ? name : `${at}/${name}`;
    const info = lstatSync(join(root, path));
    const mode = (info.mode & 0o777).toString(8);
    if (info.isDirectory()) {
      lines.push(`${path}/ ${mode}`, ...listTree(root, path));
    } else if (info.isFile()) {
      lines.push(
        `${path} ${mode} ${readFileSync(join(root, path)).toString("latin1")}`,
      );
    } else {
      lines.push(`${path} not a file or folder`);
    }
  }
  return lines.sort();
}

/** Every file's bytes under `root`, folders opened first so a test can always read them. */
function everyFileText(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      parts.push(name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) parts.push(readFileSync(path).toString("latin1"));
    }
  };
  walk(root);
  return parts.join("\n");
}

function removeTree(root: string): void {
  const open = (dir: string) => {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) open(path);
    }
  };
  try {
    open(root);
  } catch {
    // Already gone.
  }
  rmSync(root, { recursive: true, force: true });
}

afterEach(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

async function* inChunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

interface FakeAnswer {
  status?: number;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
  declaredBytes?: number | null;
  chunk?: number;
}

function fakeGitHub(answer: (call: number) => FakeAnswer | Promise<FakeAnswer>) {
  const asked: { path: string; token: string }[] = [];
  let discarded = 0;
  const http: ArchiveHttp = {
    async get(path, token): Promise<ArchiveAnswer> {
      asked.push({ path, token });
      const given = await answer(asked.length);
      const body = given.body ?? new Uint8Array();
      return {
        status: given.status ?? 200,
        declaredBytes: given.declaredBytes ?? null,
        body: body instanceof Uint8Array ? inChunks(body, given.chunk ?? 777) : body,
        discard: async () => {
          discarded += 1;
        },
      };
    },
  };
  return { http, asked, discarded: () => discarded };
}

async function run(env: Record<string, string>, http: ArchiveHttp) {
  const lines: string[] = [];
  const waits: number[] = [];
  const code = await runQaFetchImage(env, {
    http,
    write: (line) => lines.push(line),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { code, lines, waits, result: parseAgentResult(lines.join("\n")) };
}

const withWorkspace = (dir: string) => ({ ...ENV, FOREMAN_WORKSPACE: dir });

// ---- The image, with a fake GitHub port ------------------------------------------------------

describe("QA's fetch image unpacks the head commit (unit with fakes, O-124)", () => {
  it("writes exactly the commit's files and folders, read-only, and prints one success line", async () => {
    const dir = workspace();
    const github = fakeGitHub(() => ({
      body: archive(GOOD_ENTRIES, { tail: Buffer.alloc(8192) }),
    }));
    const { code, lines, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(github.asked).toEqual([
      { path: `/repos/${REPO}/tarball/${SHA}`, token: TOKEN },
    ]);
    expect(result).toMatchObject({ status: "success" });
    expect(result?.structured).toEqual({
      commitSha: SHA,
      files: 8,
      folders: 11,
      bytes: 12 + 26 + 0 + BINARY.length + 5 + 9 + 9 + 20,
    });
    expect(listTree(dir)).toEqual(GOOD_TREE);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("reads the archive the same however it arrives, one byte at a time included", async () => {
    for (const chunk of [1, 512, 100_000]) {
      const dir = workspace();
      const github = fakeGitHub(() => ({ body: archive(GOOD_ENTRIES), chunk }));
      const { code } = await run(withWorkspace(dir), github.http);
      expect(code).toBe(0);
      expect(listTree(dir)).toEqual(GOOD_TREE);
    }
  });

  it("leaves the lost+found folder of a new volume as it is", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "lost+found"), { mode: 0o700 });
    const github = fakeGitHub(() => ({ body: archive(GOOD_ENTRIES) }));
    const { code } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(0);
    expect(listTree(dir)).toEqual(["lost+found/ 700", ...GOOD_TREE].sort());
  });
});

describe("QA's fetch image refuses a bad archive and leaves the workspace as it was (unit with fakes, O-124)", () => {
  const file = (name: string | Buffer, more: Partial<Entry> = {}): Entry => ({
    name,
    data: "x",
    ...more,
  });

  it.each<[string, Entry[], ArchiveOptions, string]>([
    ["a .. part", [file(inTop("../escape.txt"))], {}, REFUSED.outside],
    [
      "a path that climbs out",
      [file(inTop("src/../../escape.txt"))],
      {},
      REFUSED.outside,
    ],
    ["an absolute path", [file("/etc/passwd")], {}, REFUSED.outside],
    [
      "an absolute pax path",
      [file("cut", { pax: { path: "/tmp/escape.txt" } })],
      {},
      REFUSED.outside,
    ],
    [
      "a .. pax path",
      [file("cut", { pax: { path: inTop("../escape.txt") } })],
      {},
      REFUSED.outside,
    ],
    ["an empty part", [file(inTop("src//app.ts"))], {}, REFUSED.outside],
    ["a . part", [file(inTop("./app.ts"))], {}, REFUSED.outside],
    ["a backslash", [file(inTop("src\\app.ts"))], {}, REFUSED.outside],
    ["a control character", [file(inTop("src/a\nb.ts"))], {}, REFUSED.outside],
    ["another top folder", [file("other-top/app.ts")], {}, REFUSED.outside],
    ["a file beside the top folder", [file("loose.txt")], {}, REFUSED.outside],
    ["a file in place of the top folder", [file(TOP)], {}, REFUSED.outside],
    [
      "a name that is not UTF-8",
      [file(Buffer.concat([Buffer.from(inTop("bad-")), Buffer.from([0xff, 0xfe])]))],
      {},
      REFUSED.notUtf8,
    ],
    ["a .git path", [file(inTop(".git/config"))], {}, REFUSED.gitPath],
    [
      "a name over 255 bytes",
      [file("cut", { pax: { path: inTop("n".repeat(256)) } })],
      {},
      REFUSED.tooLong,
    ],
    [
      "a path over 4,095 bytes in all",
      [
        file("cut", {
          pax: { path: inTop(Array(17).fill("p".repeat(250)).join("/")) },
        }),
      ],
      {},
      REFUSED.tooLong,
    ],
    [
      "a symbolic link out of the tree",
      [file(inTop("link"), { type: "2", data: "", linkName: "/etc/passwd" })],
      {},
      REFUSED.symlink,
    ],
    [
      "a symbolic link inside the tree",
      [file(inTop("link"), { type: "2", data: "", linkName: "README.md" })],
      {},
      REFUSED.symlink,
    ],
    [
      "a hard link",
      [file(inTop("again"), { type: "1", data: "", linkName: inTop("README.md") })],
      {},
      REFUSED.hardLink,
    ],
    [
      "a character device",
      [file(inTop("tty"), { type: "3", data: "" })],
      {},
      REFUSED.device,
    ],
    [
      "a block device",
      [file(inTop("sda"), { type: "4", data: "" })],
      {},
      REFUSED.device,
    ],
    ["a FIFO", [file(inTop("pipe"), { type: "6", data: "" })], {}, REFUSED.otherKind],
    ["a GNU long name", [file("././@LongLink", { type: "L" })], {}, REFUSED.otherKind],
    [
      "a sparse file",
      [file(inTop("sparse"), { pax: { "GNU.sparse.major": "1" } })],
      {},
      REFUSED.otherKind,
    ],
    ["a file named twice", [file(inTop("a")), file(inTop("a"))], {}, REFUSED.twice],
    [
      "a folder where a file is",
      [file(inTop("a")), file(inTop("a/"), { type: "5", data: "" })],
      {},
      REFUSED.twice,
    ],
    ["a file inside a file", [file(inTop("a")), file(inTop("a/b"))], {}, REFUSED.twice],
    [
      "a file where a folder is",
      [file(inTop("a/b")), file(inTop("a"))],
      {},
      REFUSED.twice,
    ],
    ["another commit", [file(inTop("a"))], { commit: OTHER_SHA }, REFUSED.wrongCommit],
    [
      "a short commit",
      [file(inTop("a"))],
      { commit: SHA.slice(0, 7) },
      REFUSED.wrongCommit,
    ],
    ["no commit header", [file(inTop("a"))], { commit: null }, REFUSED.wrongCommit],
    [
      "a commit header that names no commit",
      [file(inTop("a"))],
      { globalRecords: { mtime: "1527517631" } },
      REFUSED.wrongCommit,
    ],
    [
      "a second commit header",
      [
        file(inTop("a")),
        file("pax_global_header", { type: "g", data: paxRecord("comment", SHA) }),
      ],
      {},
      REFUSED.wrongCommit,
    ],
    ["no end marker", [file(inTop("a"))], { end: false }, REFUSED.cutShort],
    [
      "data after the end",
      [file(inTop("a"))],
      { tail: pad(Buffer.from("hidden")) },
      REFUSED.afterEnd,
    ],
    [
      "an entry after the end",
      [file(inTop("a"))],
      {
        tail: Buffer.concat([
          header({ name: inTop("hidden") }, 1),
          pad(Buffer.from("x")),
        ]),
      },
      REFUSED.afterEnd,
    ],
    ["a bad number", [file(inTop("a"), { sizeText: "12x\0" })], {}, REFUSED.malformed],
    [
      "a header that is not ustar",
      [file(inTop("a"), { magic: "ustar  \0" })],
      {},
      REFUSED.malformed,
    ],
    [
      "a malformed pax header",
      [file(inTop("a"), { paxRaw: "garbage" })],
      {},
      REFUSED.malformed,
    ],
    [
      "a pax header with a wrong length",
      [file(inTop("a"), { paxRaw: "99 path=a\n" })],
      {},
      REFUSED.malformed,
    ],
    [
      "a pax header over 64 KiB",
      [file(inTop("a"), { pax: { comment: "c".repeat(FETCH_LIMITS.paxBytes) } })],
      {},
      REFUSED.malformed,
    ],
    [
      "a pax size that differs",
      [file(inTop("a"), { pax: { size: "999" } })],
      {},
      REFUSED.malformed,
    ],
    [
      "two pax headers in a row",
      [file(inTop("a"), { pax: { mtime: "1" }, paxRaw: paxRecord("mtime", "2") })],
      {},
      REFUSED.malformed,
    ],
    [
      "a pax header with nothing after it",
      [file(inTop("a")), { name: "", type: "x-only", pax: { path: inTop("b") } }],
      {},
      REFUSED.malformed,
    ],
    [
      "a folder with data",
      [file(inTop("d/"), { type: "5", data: "x" })],
      {},
      REFUSED.malformed,
    ],
    [
      "the token in a file",
      [file(inTop("a"), { data: `token=${TOKEN}` })],
      {},
      REFUSED.token,
    ],
    [
      "the token base64 encoded in a file",
      [file(inTop("a"), { data: Buffer.from(`x${TOKEN}`).toString("base64") })],
      {},
      REFUSED.token,
    ],
    [
      "the token URL encoded in a file",
      [file(inTop("a"), { data: encodeURIComponent(`?t=${TOKEN}`) })],
      {},
      REFUSED.token,
    ],
    ["the token in a path", [file(inTop(`${TOKEN}.txt`))], {}, REFUSED.token],
  ])("%s", async (_name, entries, options, refusal) => {
    const dir = workspace();
    // A good start, so each refusal also shows that what was already written is removed.
    const github = fakeGitHub(() => ({
      body: archive([...GOOD_ENTRIES.slice(0, 3), ...entries], options),
    }));
    const { code, lines, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(result).toMatchObject({ status: "error", errorText: refusal });
    expect(github.asked).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("refuses an archive with nothing before its end marker", async () => {
    const dir = workspace();
    const github = fakeGitHub(() => ({
      body: archive([], { commit: null, topFolder: false }),
    }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.wrongCommit);
  });

  it("finds the token split across the pieces the archive arrives in", async () => {
    // Bytes that do not compress, sent one compressed byte at a time: the token's 39 bytes reach
    // the scan in many pieces, so only the overlap the scan keeps between pieces can find it.
    const noise = (n: number) =>
      Buffer.concat(
        Array.from({ length: Math.ceil(n / 32) }, (_, i) =>
          createHash("sha256").update(String(i)).digest(),
        ),
      ).subarray(0, n);
    const dir = workspace();
    const data = Buffer.concat([noise(1500), Buffer.from(TOKEN), noise(1500)]);
    const github = fakeGitHub(() => ({
      body: archive([...GOOD_ENTRIES.slice(0, 3), { name: inTop("noise.bin"), data }]),
      chunk: 1,
    }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.token);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an archive cut short inside a file", async () => {
    const dir = workspace();
    const whole = tar([{ name: inTop("big"), data: Buffer.alloc(5000, "b") }]);
    const github = fakeGitHub(() => ({ body: gzipSync(whole.subarray(0, 3000)) }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.cutShort);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a path that is already in the workspace, and leaves what was there", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "lost+found"), { mode: 0o700 });
    const github = fakeGitHub(() => ({
      body: archive([
        { name: inTop("README.md"), data: "x" },
        { name: inTop("lost+found/x"), data: "x" },
      ]),
    }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.notWritten);
    expect(listTree(dir)).toEqual(["lost+found/ 700"]);
  });

  it("refuses an archive that is not gzip", async () => {
    const dir = workspace();
    const github = fakeGitHub(() => ({ body: tar(GOOD_ENTRIES) }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.notGzip);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an archive whose download breaks off, and removes what it wrote", async () => {
    const dir = workspace();
    const whole = archive([
      ...GOOD_ENTRIES,
      { name: inTop("big"), data: Buffer.alloc(300_000, "z") },
    ]);
    async function* breaking(): AsyncGenerator<Uint8Array> {
      yield whole.subarray(0, whole.length - 100);
      throw new TypeError("terminated");
    }
    const github = fakeGitHub(() => ({ body: breaking() }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.unreadable);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("QA's fetch image bounds the archive as the repo map does (unit with fakes, O-124)", () => {
  /** An archive that ends at once, then `count` gzip members of 1 MiB of zeros each. */
  async function* zerosAfterEnd(
    count: number,
    level: number,
  ): AsyncGenerator<Uint8Array> {
    yield archive([]);
    const member = gzipSync(Buffer.alloc(MIB), { level });
    for (let i = 0; i < count; i++) yield member;
  }

  it("keeps the repo map's bounds", () => {
    expect(FETCH_LIMITS.archiveBytes).toBe(MAX_ARCHIVE_BYTES);
    expect(FETCH_LIMITS.unpackedBytes).toBe(TARBALL_LIMITS.unpackedBytes);
    expect(FETCH_LIMITS.files).toBe(TARBALL_LIMITS.files);
    expect(FETCH_LIMITS.folders).toBe(TARBALL_LIMITS.files);
  });

  it("refuses an archive GitHub says is larger than its bound, before reading it", async () => {
    const dir = workspace();
    const never: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        throw new Error("the body was read");
      },
    };
    const github = fakeGitHub(() => ({
      declaredBytes: FETCH_LIMITS.archiveBytes + 1,
      body: never,
    }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.tooLarge);
    expect(github.discarded()).toBe(1);
  });

  it("refuses an archive that grows past its bound as it arrives", async () => {
    const dir = workspace();
    const github = fakeGitHub(() => ({ body: zerosAfterEnd(101, 0) }));
    const { code, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe(REFUSED.tooLarge);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an archive that unpacks to more than its bound, and takes one just under it", async () => {
    const over = fakeGitHub(() => ({ body: zerosAfterEnd(201, 9) }));
    const refused = await run(withWorkspace(workspace()), over.http);
    expect(refused.result?.errorText).toBe(REFUSED.unpacksTooLarge);

    const under = fakeGitHub(() => ({ body: zerosAfterEnd(199, 9) }));
    const taken = await run(withWorkspace(workspace()), under.http);
    expect(taken.code).toBe(0);
  });

  it("refuses more files or folders than its bound, and removes what it wrote", async () => {
    const entries = [
      { name: inTop("a/one"), data: "1" },
      { name: inTop("a/two"), data: "2" },
      { name: inTop("b/three"), data: "3" },
    ];
    for (const [limits, refusal] of [
      [{ ...FETCH_LIMITS, files: 2 }, REFUSED.tooManyFiles],
      [{ ...FETCH_LIMITS, folders: 1 }, REFUSED.tooManyFolders],
    ] as const) {
      const dir = workspace();
      await expect(
        unpackArchive(
          inChunks(archive(entries), 100),
          { workspace: dir, commitSha: SHA, secretTexts: [TOKEN] },
          limits,
        ),
      ).rejects.toThrow(refusal);
      expect(readdirSync(dir)).toEqual([]);
    }
    const dir = workspace();
    await expect(
      unpackArchive(
        inChunks(archive(entries), 100),
        { workspace: dir, commitSha: SHA, secretTexts: [TOKEN] },
        { ...FETCH_LIMITS, files: 3, folders: 2 },
      ),
    ).resolves.toEqual({ files: 3, folders: 2, bytes: 3 });
  });

  it("refuses to unpack with nothing for the scan to look for", async () => {
    const dir = workspace();
    await expect(
      unpackArchive(inChunks(archive(GOOD_ENTRIES), 100), {
        workspace: dir,
        commitSha: SHA,
        secretTexts: [],
      }),
    ).rejects.toThrow(REFUSED.noScan);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("QA's fetch image checks its settings and workspace before any request (unit with fakes, O-124)", () => {
  it.each([
    "FOREMAN_RUN_ID",
    "FOREMAN_REPOSITORY",
    "FOREMAN_HEAD_SHA",
    "FOREMAN_PR_NUMBER",
    "FOREMAN_WORKSPACE",
    "GITHUB_TOKEN",
    "HTTPS_PROXY",
    "NODE_USE_ENV_PROXY",
  ])("fails without %s, naming it", async (name) => {
    const github = fakeGitHub(() => ({ body: archive(GOOD_ENTRIES) }));
    const env: Record<string, string> = withWorkspace(workspace());
    delete env[name];
    const { code, result } = await run(env, github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toContain(`${name} is not set`);
    expect(github.asked).toEqual([]);
  });

  it.each([
    ["FOREMAN_RUN_ID", "Run_ONE-secret-value", "is not a run id"],
    ["FOREMAN_REPOSITORY", "../secret-value", "is not owner/name"],
    ["FOREMAN_REPOSITORY", "secret-value/..", "is not owner/name"],
    ["FOREMAN_REPOSITORY", "secret-value", "is not owner/name"],
    ["FOREMAN_HEAD_SHA", "abc", "is not a full commit"],
    ["FOREMAN_HEAD_SHA", "C".repeat(40), "is not a full commit"],
    ["FOREMAN_PR_NUMBER", "0", "is not a pull request number"],
    ["FOREMAN_PR_NUMBER", "12-secret-value", "is not a pull request number"],
    ["FOREMAN_WORKSPACE", "secret-value", "is not a plain absolute path"],
    ["FOREMAN_WORKSPACE", "/workspace/../secret-value", "is not a plain absolute path"],
    ["FOREMAN_WORKSPACE", "/secret-value/", "is not a plain absolute path"],
    ["FOREMAN_WORKSPACE", "//secret-value", "is not a plain absolute path"],
    ["GITHUB_TOKEN", "short", "is not a token"],
    ["GITHUB_TOKEN", "ghs_secret value 0123456789", "is not a token"],
    ["GITHUB_TOKEN", "ghs_secret-value\n0123456789", "is not a token"],
    ["NODE_USE_ENV_PROXY", "0", "is not 1"],
  ])(
    "refuses %s %j, naming the setting and never its value",
    async (name, value, problem) => {
      const github = fakeGitHub(() => ({ body: archive(GOOD_ENTRIES) }));
      const { code, lines, result } = await run(
        { ...withWorkspace(workspace()), [name]: value },
        github.http,
      );
      expect(code).toBe(1);
      expect(result?.errorText).toContain(`${name} ${problem}`);
      expect(lines.join("\n")).not.toContain("secret");
      expect(lines.join("\n")).not.toContain(TOKEN);
      expect(github.asked).toEqual([]);
    },
  );

  it("refuses a workspace that is not a folder: missing, a file, or a link to a folder", async () => {
    const base = workspace();
    writeFileSync(join(base, "file"), "x");
    mkdirSync(join(base, "folder"));
    symlinkSync(join(base, "folder"), join(base, "link"));
    for (const path of ["missing", "file", "link"]) {
      const github = fakeGitHub(() => ({ body: archive(GOOD_ENTRIES) }));
      const { code, result } = await run(withWorkspace(join(base, path)), github.http);
      expect(code).toBe(1);
      expect(result?.errorText).toBe("the workspace is not a folder");
      expect(github.asked).toEqual([]);
    }
    expect(readdirSync(join(base, "folder"))).toEqual([]);
  });

  it("refuses a workspace that holds anything but a lost+found folder, and leaves it alone", async () => {
    for (const fill of [
      (dir: string) => writeFileSync(join(dir, "stale.txt"), "old tree"),
      (dir: string) => writeFileSync(join(dir, "lost+found"), "not a folder"),
      (dir: string) => mkdirSync(join(dir, "src")),
    ]) {
      const dir = workspace();
      fill(dir);
      const before = listTree(dir);
      const github = fakeGitHub(() => ({ body: archive(GOOD_ENTRIES) }));
      const { code, result } = await run(withWorkspace(dir), github.http);
      expect(code).toBe(1);
      expect(result?.errorText).toBe("the workspace is not empty");
      expect(github.asked).toEqual([]);
      expect(listTree(dir)).toEqual(before);
    }
  });
});

describe("QA's fetch image and GitHub's answers (unit with fakes, O-124)", () => {
  it("fails with GitHub's status when the download is refused, and drops the body", async () => {
    const dir = workspace();
    const github = fakeGitHub(() => ({ status: 404, body: Buffer.from("Not Found") }));
    const { code, lines, result } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe("downloading the archive failed with 404");
    expect(github.discarded()).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("tries a connection that failed before any answer again, a few times", async () => {
    const dir = workspace();
    const github = fakeGitHub((call) => {
      if (call < 3) throw new TypeError("fetch failed");
      return { body: archive(GOOD_ENTRIES) };
    });
    const { code, waits } = await run(withWorkspace(dir), github.http);
    expect(code).toBe(0);
    expect(waits).toEqual([CONNECT_RETRY_MS, CONNECT_RETRY_MS]);

    const never = fakeGitHub(() => {
      throw new TypeError("fetch failed");
    });
    const failed = await run(withWorkspace(workspace()), never.http);
    expect(failed.code).toBe(1);
    expect(failed.result?.errorText).toBe("the archive could not be downloaded");
    expect(never.asked).toHaveLength(CONNECT_TRIES);
  });

  it("never retries another failure, and never shows its text", async () => {
    const github = fakeGitHub(() => {
      throw new Error(`refused for ${TOKEN} at secret-host`);
    });
    const { code, lines, result } = await run(withWorkspace(workspace()), github.http);
    expect(code).toBe(1);
    expect(github.asked).toHaveLength(1);
    expect(result?.errorText).toBe("the archive could not be downloaded");
    expect(lines.join("\n")).not.toMatch(/secret-host|ghs_/);
  });
});

// ---- As a process, through a stand-in for its egress proxy ---------------------------------

let certDir = "";
let certPath = "";
let key = "";
let cert = "";

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "foreman-qa-fetch-cert-"));
  certPath = join(certDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=api.github.com",
      "-addext",
      "subjectAltName=DNS:api.github.com,DNS:codeload.github.com",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(certDir, "key.pem"), "utf8");
  cert = readFileSync(certPath, "utf8");
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

interface SeenRequest {
  host: string;
  path: string;
  authorization: string | undefined;
}

/**
 * Stands in for the fetch step's egress proxy: CONNECT only, and only to the hosts given, each
 * tunnel answered by a local TLS server with a certificate for GitHub's two hosts. The API
 * answers the archive request with a redirect to the download host, as GitHub does.
 */
async function startProxy(
  hosts: readonly string[],
  archiveStatus: number,
  body: Buffer,
) {
  const connects: string[] = [];
  const plain: string[] = [];
  const seen: SeenRequest[] = [];
  const github = createHttpsServer(
    { key, cert },
    (request: IncomingMessage, response) => {
      const host = request.headers.host ?? "";
      seen.push({
        host,
        path: request.url ?? "",
        authorization: request.headers.authorization,
      });
      if (
        host === "api.github.com" &&
        request.url === `/repos/${REPO}/tarball/${SHA}`
      ) {
        if (archiveStatus !== 302) {
          response.writeHead(archiveStatus, { "content-type": "application/json" });
          response.end('{"message":"Not Found"}');
          return;
        }
        response.writeHead(302, {
          location: `https://codeload.github.com/${REPO}/legacy.tar.gz/${SHA}`,
        });
        response.end();
        return;
      }
      if (host === "codeload.github.com") {
        response.writeHead(200, {
          "content-type": "application/x-gzip",
          "content-length": String(body.length),
        });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    },
  );
  const proxy = createHttpServer((request, response) => {
    plain.push(request.url ?? "");
    response.writeHead(403);
    response.end();
  });
  proxy.on("connect", (request: IncomingMessage, socket, head: Buffer) => {
    connects.push(request.url ?? "");
    if (!hosts.map((host) => `${host}:443`).includes(request.url ?? "")) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    github.emit("connection", socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    plain,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

/** The image's own files, exactly those its Dockerfile copies, in a folder of their own. */
function copyImageFiles(): string {
  const dockerfile = readFileSync("src/agent-images/qa-fetch/Dockerfile", "utf8");
  const dir = mkdtempSync(join(tmpdir(), "foreman-qa-fetch-image-"));
  made.push(dir);
  for (const line of dockerfile.split("\n")) {
    const copy = /^COPY\s+(.+)\s+(\S+)$/.exec(line);
    if (!copy) continue;
    const sources = (copy[1] as string).split(/\s+/);
    const target = copy[2] as string;
    for (const source of sources) {
      const to = target.endsWith("/")
        ? join(dir, target, source.split("/").at(-1) as string)
        : join(dir, target);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(source, to);
    }
  }
  return dir;
}

/** Runs the image's entry in `appDir` as its own process, as the Job runs it. */
function runProcess(appDir: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, ["src/agent-images/qa-fetch/main.ts"], {
        cwd: appDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
      child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

describe("QA's fetch image as a process (integration, O-124)", () => {
  const fetchHosts = readBotFiles().qa.fetchAllowedHosts ?? [];

  it("needs only the archive download's two hosts, which are exactly QA's fetch hosts", () => {
    expect(fetchHosts).toEqual(["api.github.com", "codeload.github.com"]);
  });

  async function fetchThroughProxy(archiveStatus: number, body: Buffer) {
    const appDir = copyImageFiles();
    const dir = workspace();
    const home = workspace();
    const scratch = workspace();
    const proxy = await startProxy(fetchHosts, archiveStatus, body);
    try {
      const ran = await runProcess(appDir, {
        PATH: process.env.PATH ?? "",
        ...ENV,
        FOREMAN_WORKSPACE: dir,
        HOME: home,
        TMPDIR: scratch,
        HTTPS_PROXY: proxy.url,
        https_proxy: proxy.url,
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
        NODE_EXTRA_CA_CERTS: certPath,
      });
      return { ...ran, dir, home, scratch, appDir, proxy };
    } finally {
      await proxy.close();
    }
  }

  it("downloads through the proxy with the token sent to the API only, and writes it nowhere", async () => {
    const ran = await fetchThroughProxy(302, archive(GOOD_ENTRIES));
    expect(ran.code).toBe(0);
    const last = ran.stdout.trimEnd().split("\n").at(-1) ?? "";
    expect(parseAgentResult(last)).toMatchObject({ status: "success" });
    expect(listTree(ran.dir)).toEqual(GOOD_TREE);
    expect(ran.proxy.connects).toEqual([
      "api.github.com:443",
      "codeload.github.com:443",
    ]);
    expect(ran.proxy.plain).toEqual([]);
    expect(ran.proxy.seen).toEqual([
      {
        host: "api.github.com",
        path: `/repos/${REPO}/tarball/${SHA}`,
        authorization: `Bearer ${TOKEN}`,
      },
      {
        host: "codeload.github.com",
        path: `/${REPO}/legacy.tar.gz/${SHA}`,
        authorization: undefined,
      },
    ]);
    for (const text of [
      ran.stdout,
      ran.stderr,
      everyFileText(ran.dir),
      everyFileText(ran.home),
      everyFileText(ran.scratch),
      everyFileText(ran.appDir),
    ]) {
      expect(text).not.toContain(TOKEN);
    }
  });

  it("refuses a bad archive or GitHub's refusal with the token in no output or file", async () => {
    const symlink = archive([
      { name: inTop("link"), type: "2", linkName: "/etc/passwd" },
    ]);
    for (const [status, body, refusal] of [
      [302, symlink, REFUSED.symlink],
      [404, Buffer.alloc(0), "downloading the archive failed with 404"],
    ] as const) {
      const ran = await fetchThroughProxy(status, body);
      expect(ran.code).toBe(1);
      const last = ran.stdout.trimEnd().split("\n").at(-1) ?? "";
      expect(parseAgentResult(last)).toMatchObject({
        status: "error",
        errorText: refusal,
      });
      expect(readdirSync(ran.dir)).toEqual([]);
      for (const text of [
        ran.stdout,
        ran.stderr,
        everyFileText(ran.home),
        everyFileText(ran.scratch),
      ]) {
        expect(text).not.toContain(TOKEN);
      }
    }
  });

  it("starts from exactly the files its Dockerfile copies: with no settings it exits 1 naming FOREMAN_RUN_ID", async () => {
    const ran = await runProcess(copyImageFiles(), { PATH: process.env.PATH ?? "" });
    expect(ran.code).toBe(1);
    const result = parseAgentResult(ran.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(result).toMatchObject({ status: "error" });
    expect(result?.errorText).toMatch(/FOREMAN_RUN_ID is not set/);
  });
});
