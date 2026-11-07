// Seam: the read of the platform settings file on main (unit with fakes, D-345, O-109). A fake
// token port and a fake HTTP port stand in for the runner App and GitHub; the answers are
// synthetic contents answers made here, plus the committed settings file itself, read from disk.
// No network, no real token.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PLATFORM_SETTINGS } from "../../core/register-project.ts";
import { createGitHubProjectSettings, listedSlugsOf } from "./project-settings.ts";
import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";

const PATH = "infra/kubernetes/settings/production.json";
const QUOTA = { pods: 10, cpu: "2", memory: "4Gi" };

/** GitHub's contents answer for a file, its text in base64 with line breaks, as GitHub sends it. */
const contentsAnswer = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "file",
  path: PATH,
  encoding: "base64",
  content: Buffer.from(text)
    .toString("base64")
    .replace(/(.{60})/g, "$1\n"),
  ...extra,
});

const settingsText = (projects: unknown) =>
  JSON.stringify({ platform: { serviceUser: 1000 }, projects });

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

describe("the settings file's listed slugs (unit with fakes, D-345, O-109)", () => {
  it("reads the file at main with a contents read token for didi-build/foreman only", async () => {
    const f = fakes(
      200,
      contentsAnswer(
        settingsText([
          { slug: "rehearsal", quota: QUOTA },
          { slug: "garden-notes", quota: QUOTA },
        ]),
      ),
    );
    expect(await f.settings.listedSlugs()).toEqual(["rehearsal", "garden-notes"]);
    expect(f.minted).toEqual([
      { repository: "didi-build/foreman", permission: "contents" },
    ]);
    expect(f.requests).toEqual([
      {
        path: `/repos/didi-build/foreman/contents/${PATH}?ref=main`,
        token: "fake-read-token-not-real",
        accept: "json",
        maxBytes: 2 * 1024 * 1024,
      },
    ]);
  });

  it("names the committed settings file, which reads as a list of projects", () => {
    expect(PLATFORM_SETTINGS).toEqual({
      repository: "didi-build/foreman",
      path: PATH,
      ref: "main",
    });
    expect(existsSync(PLATFORM_SETTINGS.path)).toBe(true);
    const committed = readFileSync(PLATFORM_SETTINGS.path, "utf8");
    const slugs = listedSlugsOf(committed);
    expect(slugs).toEqual(
      (JSON.parse(committed) as { projects: { slug: string }[] }).projects.map(
        (p) => p.slug,
      ),
    );
  });

  it("throws on a failed read or an answer that is not the settings file", async () => {
    const text = settingsText([{ slug: "rehearsal", quota: QUOTA }]);
    const answers: [number, unknown][] = [
      [404, { message: "Not Found" }],
      [403, { message: "Resource not accessible by integration" }],
      [200, "not json"],
      [200, [contentsAnswer(text)]],
      [200, contentsAnswer(text, { type: "dir" })],
      [200, contentsAnswer(text, { path: "infra/kubernetes/settings/other.json" })],
      [200, contentsAnswer(text, { encoding: "none", content: "" })],
      [200, contentsAnswer(text, { content: 7 })],
    ];
    for (const [status, body] of answers) {
      await expect(fakes(status, body).settings.listedSlugs()).rejects.toThrow();
    }
  });

  it("throws on a file with no projects list or a project with no slug", () => {
    expect(() => listedSlugsOf("not json")).toThrow(/not JSON/);
    expect(() => listedSlugsOf(JSON.stringify({ platform: {} }))).toThrow(/projects/);
    expect(() => listedSlugsOf(settingsText({ slug: "rehearsal" }))).toThrow(
      /projects/,
    );
    expect(() => listedSlugsOf(settingsText([{ quota: QUOTA }]))).toThrow(/slug/);
    expect(() => listedSlugsOf(settingsText([{ slug: 7 }]))).toThrow(/slug/);
    expect(listedSlugsOf(settingsText([]))).toEqual([]);
  });
});
