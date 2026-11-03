// Seam: the repo map's GitHub read (unit with fakes, D-267, D-251). The runner's port mints a
// read-only `contents` token for the one repository, reads the default branch's head when no
// commit is given, downloads the archive, unpacks it in memory and builds the map with the
// TypeScript compiler. A fake token port and a fake HTTP port stand in for GitHub; the archive is a
// synthetic tar made here. No network, no real repository and no real token.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "../github/runner-app-tokens.ts";
import { createGitHubRepoMaps } from "./github.ts";
import { readTarball, TarballError } from "./tarball.ts";

const REPO = "didi-build/rehearsal";
const SHA = "c".repeat(40);
const HEAD = "d".repeat(40);
const TOP = `didi-build-rehearsal-${SHA.slice(0, 7)}`;

type Entry = { path: string; text?: string; type?: string; pax?: boolean };

function header(name: string, size: number, type: string, prefix = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(prefix, 345, 155, "utf8");
  return block;
}

const pad = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** A gzip'd tar like `git archive` makes: a global pax header, the top folder, then entries. */
function tarball(entries: Entry[]): Uint8Array {
  const blocks: Buffer[] = [];
  const global = Buffer.from(`52 comment=${SHA}\n`);
  blocks.push(header("pax_global_header", global.length, "g"), pad(global));
  blocks.push(header(`${TOP}/`, 0, "5"));
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const type = entry.type ?? "0";
    if (entry.pax) {
      const record = `path=${entry.path}\n`;
      let length = record.length + 3;
      length = `${length} ${record}`.length;
      const pax = Buffer.from(`${length} ${record}`);
      blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
      blocks.push(header("cut", data.length, type), pad(data));
    } else {
      blocks.push(header(entry.path, data.length, type), pad(data));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const ENTRIES: Entry[] = [
  { path: `${TOP}/package.json`, text: '{"scripts":{"check":"vitest run"}}' },
  { path: `${TOP}/README.md`, text: "# Rehearsal" },
  {
    path: `${TOP}/src/app.ts`,
    text: 'import { read } from "./store.js";\nexport const app = read;',
  },
  { path: `${TOP}/src/store.ts`, text: "export function read() {}" },
  { path: `${TOP}/node_modules/x/index.js`, text: "export const x = 1;" },
  { path: `${TOP}/.git/config`, text: "[core]" },
  { path: `${TOP}/src/link.ts`, type: "2" },
];

function fakes(archive: Uint8Array = tarball(ENTRIES)) {
  const minted: RunnerAppTokenRequest[] = [];
  const asked: GitHubGetRequest[] = [];
  const tokens: RunnerAppTokens = {
    async mint(request) {
      minted.push(request);
      return "fake-token-for-tests";
    },
  };
  const http: GitHubHttp = {
    async get(request) {
      asked.push(request);
      if (request.path === `/repos/${REPO}`) {
        return { status: 200, body: Buffer.from('{"default_branch":"main"}') };
      }
      if (request.path === `/repos/${REPO}/commits/main`) {
        return { status: 200, body: Buffer.from(HEAD) };
      }
      if (request.path === `/repos/${REPO}/tarball/${SHA}`) {
        return { status: 200, body: archive };
      }
      if (request.path === `/repos/${REPO}/tarball/${HEAD}`) {
        return { status: 200, body: archive };
      }
      return { status: 404, body: new Uint8Array() };
    },
  };
  return { tokens, http, minted, asked };
}

describe("the repo map from GitHub's archive (unit with fakes, D-267)", () => {
  it("reads the code at a commit with a contents-read token for that repository only", async () => {
    const f = fakes();
    const map = await createGitHubRepoMaps(f).read(REPO, SHA);
    expect(f.minted).toEqual([{ repository: REPO, permission: "contents" }]);
    expect(f.asked.map((a) => [a.path, a.accept])).toEqual([
      [`/repos/${REPO}/tarball/${SHA}`, "raw"],
    ]);
    expect(map.commitSha).toBe(SHA);
    expect(map.files.map((file) => file.path)).toEqual([
      "README.md",
      "package.json",
      "src/app.ts",
      "src/store.ts",
    ]);
    expect(map.files.find((file) => file.path === "src/app.ts")).toEqual({
      path: "src/app.ts",
      exports: ["app"],
      imports: ["src/store.ts"],
    });
    expect(map.scripts).toEqual({ check: "vitest run" });
  });

  it("reads the default branch's head when no commit is given, and records that commit", async () => {
    const f = fakes();
    const map = await createGitHubRepoMaps(f).read(REPO);
    expect(map.commitSha).toBe(HEAD);
    expect(f.asked.map((a) => a.path)).toEqual([
      `/repos/${REPO}`,
      `/repos/${REPO}/commits/main`,
      `/repos/${REPO}/tarball/${HEAD}`,
    ]);
    expect(f.minted).toHaveLength(1);
  });

  it("refuses a bad repository or commit before minting a token", async () => {
    const f = fakes();
    const maps = createGitHubRepoMaps(f);
    await expect(maps.read("not a repo", SHA)).rejects.toThrow(/repository/);
    await expect(maps.read(REPO, "abc")).rejects.toThrow(/40-character/);
    expect(f.minted).toEqual([]);
  });

  it("fails on GitHub's refusal, naming its status and never the token", async () => {
    const f = fakes();
    await expect(createGitHubRepoMaps(f).read(REPO, "e".repeat(40))).rejects.toThrow(
      /failed with 404/,
    );
    await expect(
      createGitHubRepoMaps(f).read(REPO, "e".repeat(40)),
    ).rejects.not.toThrow(/fake-token/);
  });
});

describe("the archive unpacked in memory (unit, D-267)", () => {
  it("takes a long path from its pax header", () => {
    const deep = `${TOP}/src/${"a".repeat(120)}.ts`;
    const files = readTarball(
      tarball([{ path: deep, text: "export const a = 1;", pax: true }]),
    );
    expect([...files.keys()]).toEqual([`src/${"a".repeat(120)}.ts`]);
  });

  it.each([
    ["a parent folder", `${TOP}/../outside.ts`],
    ["an absolute path", "/etc/passwd"],
    ["a backslash", `${TOP}/src\\app.ts`],
  ])("refuses %s", (_label, path) => {
    expect(() => readTarball(tarball([{ path, text: "x" }]))).toThrow(TarballError);
  });

  it("keeps a code file's text only up to the size the map parses", () => {
    const big = "x".repeat(1_000_001);
    const files = readTarball(
      tarball([
        { path: `${TOP}/src/big.ts`, text: big },
        { path: `${TOP}/docs/guide.md`, text: "words" },
      ]),
    );
    expect(files.get("src/big.ts")).toBe("");
    expect(files.get("docs/guide.md")).toBe("");
  });

  it("refuses an archive that is not gzip, or is cut short", () => {
    expect(() => readTarball(Buffer.from("not an archive"))).toThrow(TarballError);
    const whole = Buffer.from(
      gzipSync(
        Buffer.concat([header(`${TOP}/src/a.ts`, 4096, "0"), Buffer.alloc(512)]),
      ),
    );
    expect(() => readTarball(whole)).toThrow(/cut short/);
  });
});
