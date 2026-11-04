// Seam: the repository visibility read (unit with fakes, O-89, D-267). The runner's port mints a
// read-only `contents` token for the one repository, reads the repository and answers whether it
// is private. A fake token port and a fake HTTP port stand in for GitHub; the answers are
// synthetic JSON made here. No network, no real repository or token.
import { describe, expect, it } from "vitest";

import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "../github/runner-app-tokens.ts";
import { createGitHubRepoVisibility } from "./github-visibility.ts";

const REPO = "didi-build/rehearsal";

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
  return { visibility: createGitHubRepoVisibility({ tokens, http }), minted, requests };
}

describe("the repository visibility read (unit with fakes, O-89)", () => {
  it("reads the repository with a contents read token and answers private", async () => {
    const f = fakes(200, { full_name: REPO, private: true, visibility: "private" });
    expect(await f.visibility.isPrivate(REPO)).toBe(true);
    expect(f.minted).toEqual([{ repository: REPO, permission: "contents" }]);
    expect(f.requests).toEqual([
      {
        path: `/repos/${REPO}`,
        token: "test-token-not-real",
        accept: "json",
        maxBytes: 1024 * 1024,
      },
    ]);
  });

  it("answers not private for a public or an internal repository", async () => {
    expect(
      await fakes(200, {
        full_name: REPO,
        private: false,
        visibility: "public",
      }).visibility.isPrivate(REPO),
    ).toBe(false);
    expect(
      await fakes(200, {
        full_name: REPO,
        private: true,
        visibility: "internal",
      }).visibility.isPrivate(REPO),
    ).toBe(false);
    // An answer without the newer `visibility` field is read from `private` alone.
    expect(
      await fakes(200, { full_name: REPO, private: true }).visibility.isPrivate(REPO),
    ).toBe(true);
  });

  it("throws on any other answer, so capture links nothing", async () => {
    await expect(fakes(404, {}).visibility.isPrivate(REPO)).rejects.toThrow(/404/);
    await expect(fakes(200, "not json").visibility.isPrivate(REPO)).rejects.toThrow(
      /not JSON/,
    );
    await expect(
      fakes(200, { full_name: REPO }).visibility.isPrivate(REPO),
    ).rejects.toThrow(/no visibility/);
    await expect(
      fakes(200, { full_name: "didi-build/other", private: true }).visibility.isPrivate(
        REPO,
      ),
    ).rejects.toThrow(/another repository/);
  });

  it("refuses a bad repository name before minting a token", async () => {
    const f = fakes(200, {});
    await expect(f.visibility.isPrivate("../x")).rejects.toThrow(/repository/);
    expect(f.minted).toEqual([]);
  });
});
