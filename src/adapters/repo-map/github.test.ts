// Seam: the repo map's GitHub reads and its result (unit with fakes, D-267, D-251, D-275 (2)). The
// runner reads the default branch's head with a read-only `contents` token; the Job downloads the
// archive at a commit, unpacks it in memory, builds the map with the TypeScript compiler and
// encodes it; the runner decodes and checks it. A fake HTTP port stands in for GitHub; the archive
// is a synthetic tar (./fixtures.ts). No network, no real repository and no real token.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { RepoMapError } from "../../core/repo-map.ts";
import type { GitHubGetRequest, GitHubHttp } from "../github/runner-app-tokens.ts";
import {
  FIXTURE_ENTRIES,
  FIXTURE_REPO as REPO,
  FIXTURE_SHA as SHA,
  FIXTURE_TOP as TOP,
  tarHeader,
  tarball,
} from "./fixtures.ts";
import { readHeadCommit, readRepoMapAt } from "./github.ts";
import {
  decodeRepoMapResult,
  encodeRepoMapResult,
  MAX_ENCODED_MAP_CHARS,
} from "./result.ts";
import { readTarball, TarballError } from "./tarball.ts";

const HEAD = "d".repeat(40);
const TOKEN = "fake-token-for-tests";

function fakeHttp(archive: Uint8Array = tarball(FIXTURE_ENTRIES)) {
  const asked: GitHubGetRequest[] = [];
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
      return { status: 404, body: new Uint8Array() };
    },
  };
  return { http, asked };
}

describe("the default branch's head, read by the runner (unit with fakes, D-267)", () => {
  it("reads the repository's default branch, then its head commit as a sha", async () => {
    const f = fakeHttp();
    expect(await readHeadCommit(f.http, REPO, TOKEN)).toBe(HEAD);
    expect(f.asked.map((a) => [a.path, a.accept, a.token])).toEqual([
      [`/repos/${REPO}`, "json", TOKEN],
      [`/repos/${REPO}/commits/main`, "sha", TOKEN],
    ]);
  });

  it("refuses a bad repository before any request", async () => {
    const f = fakeHttp();
    await expect(readHeadCommit(f.http, "not a repo", TOKEN)).rejects.toThrow(
      /repository/,
    );
    expect(f.asked).toEqual([]);
  });

  it("fails on GitHub's refusal, naming its status and never the token", async () => {
    const f = fakeHttp();
    const error = await readHeadCommit(f.http, "didi-build/other", TOKEN).catch(
      (e: unknown) => e,
    );
    expect(String(error)).toMatch(/failed with 404/);
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("the map at a commit, built inside the Job (unit with fakes, D-275 (2))", () => {
  it("downloads the archive at the commit and maps it", async () => {
    const f = fakeHttp();
    const map = await readRepoMapAt(f.http, REPO, SHA, TOKEN);
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

  it("refuses a bad repository or commit before any request", async () => {
    const f = fakeHttp();
    await expect(readRepoMapAt(f.http, "not a repo", SHA, TOKEN)).rejects.toThrow(
      /repository/,
    );
    await expect(readRepoMapAt(f.http, REPO, "abc", TOKEN)).rejects.toThrow(
      /40-character/,
    );
    expect(f.asked).toEqual([]);
  });

  it("fails on GitHub's refusal, naming its status and never the token", async () => {
    const f = fakeHttp();
    const error = await readRepoMapAt(f.http, REPO, "e".repeat(40), TOKEN).catch(
      (e: unknown) => e,
    );
    expect(String(error)).toMatch(/downloading the code failed with 404/);
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("the map handed back from the Job (unit, D-275 (2))", () => {
  it("round-trips a map through its encoded result", async () => {
    const map = await readRepoMapAt(fakeHttp().http, REPO, SHA, TOKEN);
    const result = encodeRepoMapResult(map);
    expect(Object.keys(result)).toEqual(["repoMap", "gzipBase64"]);
    expect(decodeRepoMapResult(JSON.parse(JSON.stringify(result)), SHA)).toEqual(map);
  });

  it("refuses a map for another commit than the one asked for", async () => {
    const map = await readRepoMapAt(fakeHttp().http, REPO, SHA, TOKEN);
    expect(() => decodeRepoMapResult(encodeRepoMapResult(map), HEAD)).toThrow(
      /not for the commit asked for/,
    );
  });

  const encoded = (json: string) => gzipSync(json).toString("base64");

  it.each<[string, unknown]>([
    ["no result", undefined],
    ["a list", []],
    ["an extra field", { repoMap: 1, gzipBase64: "", note: "x" }],
    ["another version", { repoMap: 2, gzipBase64: encoded("{}") }],
    ["text that is not base64", { repoMap: 1, gzipBase64: "not base64!" }],
    ["base64 that is not gzip", { repoMap: 1, gzipBase64: "aGVsbG8=" }],
    ["gzip that is not JSON", { repoMap: 1, gzipBase64: encoded("not json") }],
    ["JSON that is not a map", { repoMap: 1, gzipBase64: encoded('{"files":[]}') }],
    [
      "a map with a path out of the checkout",
      {
        repoMap: 1,
        gzipBase64: encoded(
          JSON.stringify({
            commitSha: SHA,
            files: [{ path: "../etc/passwd", exports: [], imports: [] }],
            scripts: {},
          }),
        ),
      },
    ],
  ])("refuses %s", (_label, structured) => {
    expect(() => decodeRepoMapResult(structured, SHA)).toThrow(RepoMapError);
  });

  it("refuses an encoded map over its bound before decoding it", () => {
    const big = { repoMap: 1, gzipBase64: "A".repeat(MAX_ENCODED_MAP_CHARS + 4) };
    expect(() => decodeRepoMapResult(big, SHA)).toThrow(/within its bound/);
  });

  it("refuses a map that unpacks past its bound", () => {
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20)).toString("base64");
    expect(() => decodeRepoMapResult({ repoMap: 1, gzipBase64: bomb }, SHA)).toThrow(
      /unpacks to more than/,
    );
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
        Buffer.concat([tarHeader(`${TOP}/src/a.ts`, 4096, "0"), Buffer.alloc(512)]),
      ),
    );
    expect(() => readTarball(whole)).toThrow(/cut short/);
  });
});
