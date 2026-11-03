// Seam: the repo folders' GitHub read (unit with fakes, D-281, D-267). The runner's port mints a
// read-only `contents` token for the one repository, lists the folder's parent at the commit and
// takes the folder's git tree id from the listing. A fake token port and a fake HTTP port stand in
// for GitHub; the listings are synthetic JSON made here. No network, no real repository or token.
import { describe, expect, it } from "vitest";

import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "../github/runner-app-tokens.ts";
import { createGitHubRepoFolders } from "./github-folders.ts";

const REPO = "didi-build/rehearsal";
const SHA = "c".repeat(40);
const TREE = "7".repeat(40);
const FOLDER = "design/gallery/example-button/options/a";

function fakes(status: number, body: unknown) {
  const minted: RunnerAppTokenRequest[] = [];
  const requests: GitHubGetRequest[] = [];
  const tokens: RunnerAppTokens = {
    async mint(request) {
      minted.push(request);
      return "test-token-not-real";
    },
  };
  const http: GitHubHttp = {
    async get(request) {
      requests.push(request);
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  return { folders: createGitHubRepoFolders({ tokens, http }), minted, requests };
}

const listing = [
  {
    name: "a.md",
    path: "design/gallery/example-button/options/a.md",
    type: "file",
    sha: "1".repeat(40),
  },
  { name: "a", path: FOLDER, type: "dir", sha: TREE },
  {
    name: "b",
    path: "design/gallery/example-button/options/b",
    type: "dir",
    sha: "2".repeat(40),
  },
];

describe("the repo folders' GitHub read (unit with fakes, D-281)", () => {
  it("lists the parent at the commit with a contents read token and gives the folder's tree id", async () => {
    const f = fakes(200, listing);
    expect(await f.folders.folderId(REPO, SHA, FOLDER)).toBe(TREE);
    expect(f.minted).toEqual([{ repository: REPO, permission: "contents" }]);
    expect(f.requests).toEqual([
      {
        path: `/repos/${REPO}/contents/design/gallery/example-button/options?ref=${SHA}`,
        token: "test-token-not-real",
        accept: "json",
        maxBytes: 1024 * 1024,
      },
    ]);
  });

  it("is null when the parent is not there, or the folder is not a folder in it", async () => {
    expect(
      await fakes(404, { message: "Not Found" }).folders.folderId(REPO, SHA, FOLDER),
    ).toBeNull();
    const file = [{ name: "a", path: FOLDER, type: "file", sha: TREE }];
    expect(await fakes(200, file).folders.folderId(REPO, SHA, FOLDER)).toBeNull();
    expect(await fakes(200, []).folders.folderId(REPO, SHA, FOLDER)).toBeNull();
    // A path that is a file answers with an object, not a listing.
    expect(
      await fakes(200, { type: "file" }).folders.folderId(REPO, SHA, FOLDER),
    ).toBeNull();
  });

  it("throws on any other answer, so nothing is compared on a failed read", async () => {
    await expect(fakes(403, {}).folders.folderId(REPO, SHA, FOLDER)).rejects.toThrow(
      "listing the folder failed with 403",
    );
    await expect(
      fakes(200, "not json").folders.folderId(REPO, SHA, FOLDER),
    ).rejects.toThrow("not JSON");
    const noId = [{ name: "a", path: FOLDER, type: "dir", sha: "x" }];
    await expect(fakes(200, noId).folders.folderId(REPO, SHA, FOLDER)).rejects.toThrow(
      "no tree id",
    );
  });

  it("refuses a bad repository, commit or folder path before any request", async () => {
    const f = fakes(200, listing);
    await expect(f.folders.folderId("not a repo", SHA, FOLDER)).rejects.toThrow(
      "not a repository name",
    );
    await expect(f.folders.folderId(REPO, "abc", FOLDER)).rejects.toThrow(
      "40-character",
    );
    for (const path of ["design/../secret", "/design/a", "design", "design/a/./b"]) {
      await expect(f.folders.folderId(REPO, SHA, path), path).rejects.toThrow(
        "not a folder path",
      );
    }
    expect(f.minted).toEqual([]);
    expect(f.requests).toEqual([]);
  });
});
