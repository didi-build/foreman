// Seam: the repo map Job's image (unit and integration with fakes, D-275 (2), O-87). Its settings,
// the map it prints as its result line, which the runner's own parsers read back, its failures,
// and a start of the image from exactly the files its Dockerfile copies. A fake HTTP port stands
// in for GitHub; the archive is synthetic. No network, no real repository and no real token.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAgentResult } from "../../adapters/agent-runtime/kubernetes/result.ts";
import type {
  GitHubGetRequest,
  GitHubHttp,
} from "../../adapters/github/runner-app-tokens.ts";
import {
  FIXTURE_ENTRIES,
  FIXTURE_REPO as REPO,
  FIXTURE_SHA as SHA,
  tarball,
} from "../../adapters/repo-map/fixtures.ts";
import { decodeRepoMapResult } from "../../adapters/repo-map/result.ts";
import { CONNECT_TRIES, runRepoMapImage } from "./image.ts";

const TOKEN = "github-token-value-not-real-0123456789";

const ENV = {
  FOREMAN_RUN_ID: "6f1e2d3c-4b5a-4968-8778-695a4b3c2d1e",
  FOREMAN_REPOSITORY: REPO,
  FOREMAN_COMMIT_SHA: SHA,
  GITHUB_TOKEN: TOKEN,
  HTTPS_PROXY: "http://10.245.0.10:8080",
  NODE_USE_ENV_PROXY: "1",
};

function fakeGitHub(
  answer: (request: GitHubGetRequest) => Promise<Uint8Array | number>,
) {
  const asked: GitHubGetRequest[] = [];
  const http: GitHubHttp = {
    async get(request) {
      asked.push(request);
      const body = await answer(request);
      return typeof body === "number"
        ? { status: body, body: new Uint8Array() }
        : { status: 200, body };
    },
  };
  return { http, asked };
}

async function run(env: Record<string, string>, http: GitHubHttp) {
  const lines: string[] = [];
  const waits: number[] = [];
  const code = await runRepoMapImage(env, {
    http,
    write: (line) => lines.push(line),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { code, lines, waits, result: parseAgentResult(lines.join("\n")) };
}

describe("the repo map image (unit with fakes, D-275 (2))", () => {
  it("prints the map at the commit as its one result line, which the runner reads back", async () => {
    const github = fakeGitHub(async () => tarball(FIXTURE_ENTRIES));
    const { code, lines, result } = await run(ENV, github.http);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(github.asked.map((a) => [a.path, a.accept, a.token])).toEqual([
      [`/repos/${REPO}/tarball/${SHA}`, "raw", TOKEN],
    ]);
    expect(result?.status).toBe("success");
    const map = decodeRepoMapResult(result?.structured, SHA);
    expect(map.files.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "src/app.ts",
      "src/store.ts",
    ]);
    expect(map.scripts).toEqual({ check: "vitest run" });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it.each([
    ["FOREMAN_RUN_ID", /FOREMAN_RUN_ID is not set/],
    ["FOREMAN_REPOSITORY", /FOREMAN_REPOSITORY is not set/],
    ["FOREMAN_COMMIT_SHA", /FOREMAN_COMMIT_SHA is not set/],
    ["GITHUB_TOKEN", /GITHUB_TOKEN is not set/],
    ["HTTPS_PROXY", /HTTPS_PROXY is not set/],
    ["NODE_USE_ENV_PROXY", /NODE_USE_ENV_PROXY is not set/],
  ])("fails before any request without %s, naming it", async (name, message) => {
    const github = fakeGitHub(async () => tarball(FIXTURE_ENTRIES));
    const env: Record<string, string> = { ...ENV };
    delete env[name];
    const { code, result } = await run(env, github.http);
    expect(code).toBe(1);
    expect(result).toMatchObject({ status: "error" });
    expect(result?.errorText).toMatch(message);
    expect(github.asked).toEqual([]);
  });

  it("refuses a bad repository or commit, naming the setting and never its value", async () => {
    const github = fakeGitHub(async () => tarball(FIXTURE_ENTRIES));
    const { code, result } = await run(
      { ...ENV, FOREMAN_REPOSITORY: "../secret-value", FOREMAN_COMMIT_SHA: "abc" },
      github.http,
    );
    expect(code).toBe(1);
    expect(result?.errorText).toMatch(/FOREMAN_REPOSITORY is not owner\/name/);
    expect(result?.errorText).toMatch(/FOREMAN_COMMIT_SHA is not a full commit/);
    expect(result?.errorText).not.toContain("secret-value");
    expect(github.asked).toEqual([]);
  });

  it("fails with GitHub's status when the download is refused, never the token", async () => {
    const github = fakeGitHub(async () => 404);
    const { code, lines, result } = await run(ENV, github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toBe("downloading the code failed with 404");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("removes the token from an error that names it", async () => {
    const github = fakeGitHub(async () => {
      throw new Error(`refused for ${TOKEN}`);
    });
    const { lines } = await run(ENV, github.http);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("tries a connection that failed before any answer again, a few times", async () => {
    let calls = 0;
    const github = fakeGitHub(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return tarball(FIXTURE_ENTRIES);
    });
    const { code, waits } = await run(ENV, github.http);
    expect(code).toBe(0);
    expect(waits).toHaveLength(2);

    const never = fakeGitHub(async () => {
      throw new TypeError("fetch failed");
    });
    const failed = await run(ENV, never.http);
    expect(failed.code).toBe(1);
    expect(never.asked).toHaveLength(CONNECT_TRIES);
  });

  it("fails on an archive it cannot read", async () => {
    const github = fakeGitHub(async () => Buffer.from("not an archive"));
    const { code, result } = await run(ENV, github.http);
    expect(code).toBe(1);
    expect(result?.errorText).toMatch(/not gzip/);
  });
});

describe("the image starts from the files its Dockerfile copies (integration, D-275 (2))", () => {
  it("with no settings, exits 1 with a result line naming FOREMAN_RUN_ID as its last line", () => {
    const dockerfile = readFileSync("src/agent-images/repo-map/Dockerfile", "utf8");
    const dir = mkdtempSync(join(tmpdir(), "foreman-repo-map-image-"));
    try {
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
      // `npm ci` in the image installs the compiler; here the repository's own copy stands in.
      mkdirSync(join(dir, "node_modules"));
      symlinkSync(
        realpathSync("node_modules/typescript"),
        join(dir, "node_modules", "typescript"),
      );
      const started = spawnSync(
        process.execPath,
        ["src/agent-images/repo-map/main.ts"],
        { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
      );
      expect(started.status).toBe(1);
      const last = started.stdout.trimEnd().split("\n").at(-1) ?? "";
      const result = parseAgentResult(last);
      expect(result).toMatchObject({ status: "error" });
      expect(result?.errorText).toMatch(/FOREMAN_RUN_ID is not set/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
