// Seam: the read of the settings repository's project list on main (unit with fakes, D-345, O-109,
// D-377, ADR 0118 appendix A, O-157). A fake token port and a fake HTTP port stand in for the
// runner App and GitHub; the answers are synthetic folder listings made here, in the shape
// GitHub's "Get repository content" gives for a folder. No network, no real token.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PROJECTS_REPOSITORY } from "../../core/project-entry.ts";
import { createGitHubProjectSettings, listedSlugsOf } from "./project-settings.ts";
import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** One entry of GitHub's listing of `projects/`. */
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "file",
  name,
  path: `projects/${name}`,
  sha: "0".repeat(40),
  size: 400,
  ...extra,
});

function fakes(status: number, body: unknown) {
  const minted: RunnerAppTokenRequest[] = [];
  const requests: GitHubGetRequest[] = [];
  const tokens: RunnerAppTokens = {
    async mint(request) {
      minted.push(request);
      return "fake-read-token-not-real";
    },
  };
  const http: GitHubHttp = {
    async get(request) {
      requests.push(request);
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new TextEncoder().encode(text) };
    },
  };
  return { settings: createGitHubProjectSettings({ tokens, http }), minted, requests };
}

describe("the project list's listed slugs (unit with fakes, D-345, O-109, D-377)", () => {
  it("lists projects/ at main with a contents read token for didi-build/foreman-projects only", async () => {
    const f = fakes(200, [entry("rehearsal.json"), entry("garden-notes.json")]);
    expect(await f.settings.listedSlugs()).toEqual(["garden-notes", "rehearsal"]);
    expect(PROJECTS_REPOSITORY).toBe("didi-build/foreman-projects");
    expect(f.minted).toEqual([
      { repository: "didi-build/foreman-projects", permission: "contents" },
    ]);
    expect(f.requests).toEqual([
      {
        path: "/repos/didi-build/foreman-projects/contents/projects?ref=main",
        token: "fake-read-token-not-real",
        accept: "json",
        maxBytes: 2 * 1024 * 1024,
      },
    ]);
  });

  it("reads the test fixture's folder as the rehearsal alone", () => {
    const names = readdirSync("test/fixtures/foreman-projects/projects");
    expect(listedSlugsOf(names.map((name) => entry(name)))).toEqual(["rehearsal"]);
  });

  it("throws on a failed read or an answer that is not a folder listing", async () => {
    const answers: [number, unknown][] = [
      [404, { message: "Not Found" }],
      [403, { message: "Resource not accessible by integration" }],
      [200, "not json"],
      [200, { type: "file", name: "projects", path: "projects", content: "" }],
      [200, { message: "a folder listing is a list" }],
    ];
    for (const [status, body] of answers) {
      await expect(fakes(status, body).settings.listedSlugs()).rejects.toThrow();
    }
  });

  it("throws on an entry in the folder that is not a project file, as the render does", () => {
    expect(listedSlugsOf([])).toEqual([]);
    for (const bad of [
      [entry("README.md")],
      [entry("rehearsal.json"), entry("notes.txt")],
      [entry("Rehearsal.json")],
      [entry("re--hearsal.json")],
      [entry("-rehearsal.json")],
      [entry(".json")],
      [entry("rehearsal.json", { type: "dir" })],
      [entry("rehearsal.json", { type: "symlink" })],
      [entry("rehearsal.json", { path: "elsewhere/rehearsal.json" })],
      [entry("rehearsal.json", { name: 7 })],
      ["rehearsal.json"],
    ]) {
      expect(() => listedSlugsOf(bad), JSON.stringify(bad)).toThrow(
        /projects folder holds/,
      );
    }
  });
});
