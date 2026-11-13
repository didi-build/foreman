// The headers of one GET to GitHub's REST API (`githubApiGet`, O-131). Unit: `fetch` is replaced
// by a spy that records the request and answers with a made-up body, so nothing reaches GitHub.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ACCEPT,
  githubApiGet,
  type GitHubGetRequest,
} from "./runner-app-tokens.ts";

const TOKEN = "made-up-token";

function spyFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("made-up body", { status: 200 }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one GET to GitHub's REST API (unit: githubApiGet, O-131)", () => {
  it("asks for a download with GitHub's own JSON type, never application/octet-stream", () => {
    // GitHub answers the tarball and artifact routes with a 302 for this type and refuses
    // application/octet-stream with 415, which stopped the rehearsal's first repo map read.
    expect(GITHUB_ACCEPT.download).toBe("application/vnd.github+json");
    expect(Object.values(GITHUB_ACCEPT)).not.toContain("application/octet-stream");
  });

  it.each<[GitHubGetRequest["accept"], string]>([
    ["json", "application/vnd.github+json"],
    ["sha", "application/vnd.github.sha"],
    ["download", "application/vnd.github+json"],
  ])(
    "sends %s as Accept %s, with the token, the API version, and redirects followed",
    async (accept, header) => {
      const fetch = spyFetch();
      await githubApiGet("/repos/example-org/example/tarball/main", TOKEN, accept);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(url).toBe("https://api.github.com/repos/example-org/example/tarball/main");
      expect(init?.redirect).toBe("follow");
      expect(init?.headers).toMatchObject({
        accept: header,
        authorization: `Bearer ${TOKEN}`,
        "x-github-api-version": "2022-11-28",
      });
    },
  );

  it("refuses a path that does not start with /, before any request", async () => {
    const fetch = spyFetch();
    await expect(
      githubApiGet("repos/example-org/example", TOKEN, "json"),
    ).rejects.toThrow("a GitHub path must start with /");
    expect(fetch).not.toHaveBeenCalled();
  });
});
