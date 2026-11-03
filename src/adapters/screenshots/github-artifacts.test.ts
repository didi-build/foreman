// Seam: the screenshot bundles' GitHub read (unit with fakes, D-267, D-242, N-52 option a). The
// runner's port mints a read-only `actions` token for the one repository, lists the artifacts of
// the bundle's name, takes the newest unexpired one whose workflow run is on the commit asked for,
// downloads it and reads the zip in memory. A fake token port and a fake HTTP port stand in for
// GitHub; the artifacts are synthetic zips made here. No network, no real repository or token.
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "../github/runner-app-tokens.ts";
import {
  artifactName,
  createGitHubScreenshotBundles,
  MANIFEST,
} from "./github-artifacts.ts";
import { readZip, ZipError, ZIP_LIMITS } from "./zip.ts";

const REPO = "didi-build/rehearsal";
const HEAD = "b".repeat(40);
const OLDER = "a".repeat(40);

/** A zip with each entry stored or deflated, as GitHub's artifact downloads are. */
function zip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const packed = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const PNG = Buffer.from("not really a png, only bytes for the hash");
const MANIFEST_JSON = {
  kind: "gallery",
  commit: HEAD,
  shots: [
    {
      component: "settings-panel",
      variant: null,
      file: "shots/settings-panel.png",
      sha256: createHash("sha256").update(PNG).digest("hex"),
    },
  ],
  specs: [],
};

const artifact = (id: number, headSha: string, created: string, expired = false) => ({
  id,
  name: artifactName("gallery"),
  expired,
  created_at: created,
  workflow_run: { id: id * 10, head_sha: headSha },
});

function fakes(listing: unknown[], downloads: Record<number, Buffer>) {
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
      if (request.path.startsWith(`/repos/${REPO}/actions/artifacts?`)) {
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ artifacts: listing })),
        };
      }
      const id = /\/actions\/artifacts\/(\d+)\/zip$/.exec(request.path)?.[1];
      const bytes = id ? downloads[Number(id)] : undefined;
      return bytes
        ? { status: 200, body: bytes }
        : { status: 404, body: new Uint8Array() };
    },
  };
  return { tokens, http, minted, asked };
}

const bundleZip = zip([
  { name: MANIFEST, data: Buffer.from(JSON.stringify(MANIFEST_JSON)), deflate: true },
  { name: "shots/", data: Buffer.alloc(0) },
  { name: "shots/settings-panel.png", data: PNG },
]);

describe("the screenshot bundles from CI's workflow artifacts (unit with fakes, D-267)", () => {
  it("reads the newest unexpired artifact on the head commit with an actions-read token", async () => {
    const f = fakes(
      [
        artifact(1, HEAD, "2026-11-03T08:00:00Z"),
        artifact(2, HEAD, "2026-11-03T09:00:00Z"),
        artifact(3, HEAD, "2026-11-03T10:00:00Z", true),
        artifact(4, OLDER, "2026-11-03T11:00:00Z"),
        { ...artifact(5, HEAD, "2026-11-03T12:00:00Z"), name: "something-else" },
      ],
      { 2: bundleZip },
    );
    const bundle = await createGitHubScreenshotBundles(f).read(REPO, HEAD, "gallery");
    expect(f.minted).toEqual([{ repository: REPO, permission: "actions" }]);
    expect(f.asked.map((a) => [a.path, a.accept])).toEqual([
      [
        `/repos/${REPO}/actions/artifacts?name=foreman-screenshots-gallery&per_page=100`,
        "json",
      ],
      [`/repos/${REPO}/actions/artifacts/2/zip`, "raw"],
    ]);
    expect(bundle?.manifest).toEqual(MANIFEST_JSON);
    expect(Buffer.from((await bundle?.file("shots/settings-panel.png")) ?? [])).toEqual(
      PNG,
    );
    expect(await bundle?.file("shots/missing.png")).toBe(null);
  });

  it("gives no bundle when no artifact is on the commit", async () => {
    const f = fakes([artifact(4, OLDER, "2026-11-03T11:00:00Z")], {});
    expect(await createGitHubScreenshotBundles(f).read(REPO, HEAD, "gallery")).toBe(
      null,
    );
    expect(f.asked).toHaveLength(1);
  });

  it("gives a null manifest when the artifact has none, for the comparison to refuse", async () => {
    const f = fakes([artifact(2, HEAD, "2026-11-03T09:00:00Z")], {
      2: zip([{ name: "shots/settings-panel.png", data: PNG }]),
    });
    const bundle = await createGitHubScreenshotBundles(f).read(REPO, HEAD, "gallery");
    expect(bundle?.manifest).toBe(null);
  });

  it("refuses a bad repository or commit before minting a token", async () => {
    const f = fakes([], {});
    const bundles = createGitHubScreenshotBundles(f);
    await expect(bundles.read("bad repo", HEAD, "gallery")).rejects.toThrow(
      /repository/,
    );
    await expect(bundles.read(REPO, "abc", "options")).rejects.toThrow(/40-character/);
    expect(f.minted).toEqual([]);
  });
});

describe("an artifact's zip read in memory (unit, D-267)", () => {
  it.each([
    ["a parent folder", "../outside.png"],
    ["an absolute path", "/etc/passwd"],
    ["a backslash", "shots\\a.png"],
  ])("refuses %s", (_label, name) => {
    expect(() => readZip(zip([{ name, data: PNG }]))).toThrow(ZipError);
  });

  it("refuses an entry that unpacks past its bound, and a file that is not a zip", () => {
    const big = Buffer.alloc(ZIP_LIMITS.entryBytes + 1);
    expect(() => readZip(zip([{ name: "big.png", data: big, deflate: true }]))).toThrow(
      /larger than/,
    );
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(/not a zip/);
  });

  it("refuses one path named twice", () => {
    expect(() =>
      readZip(
        zip([
          { name: "a.png", data: PNG },
          { name: "a.png", data: PNG },
        ]),
      ),
    ).toThrow(/twice/);
  });
});
