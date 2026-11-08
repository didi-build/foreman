// Seam: the runner's reads of CI's builds for the staging deploy (unit with fakes, D-267, O-116).
// Each read mints a read-only `actions` token for the one repository; the run, the newest
// successful push run of CI on main and the `staging-site` artifact of exactly that run are read
// with GitHub's documented paths, and a field out of shape is no run, never a guess. A fake token
// port and a fake HTTP port stand in for GitHub. No network, no real repository or token.
import { describe, expect, it } from "vitest";

import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";
import { createGitHubStagingBuilds, toBuildRun } from "./staging-builds.ts";

const REPO = "didi-build/rehearsal";
const SHA = "b".repeat(40);
const ZIP = new Uint8Array([0x50, 0x4b, 5, 6]);

const run = (fields: Record<string, unknown> = {}) => ({
  id: 77,
  path: ".github/workflows/ci.yml",
  event: "push",
  head_sha: SHA,
  head_branch: "main",
  head_repository: { full_name: REPO },
  status: "completed",
  conclusion: "success",
  pull_requests: [],
  ...fields,
});

const json = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));

function fakes(answers: Record<string, { status: number; body: Uint8Array }>) {
  const minted: RunnerAppTokenRequest[] = [];
  const asked: GitHubGetRequest[] = [];
  const tokens: RunnerAppTokens = {
    async mint(request) {
      minted.push(request);
      return "fake-actions-read-token";
    },
  };
  const http: GitHubHttp = {
    async get(request) {
      asked.push(request);
      return answers[request.path] ?? { status: 404, body: json({}) };
    },
  };
  return { builds: createGitHubStagingBuilds({ tokens, http }), minted, asked };
}

const RUN_PATH = `/repos/${REPO}/actions/runs/77`;
const LATEST_PATH = `/repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&exclude_pull_requests=true&per_page=1`;
const ARTIFACTS_PATH = `/repos/${REPO}/actions/runs/77/artifacts?name=staging-site`;

describe("CI's builds for the staging deploy (unit, fake GitHub, O-116)", () => {
  it("reads one run with an actions read token for that repository only", async () => {
    const { builds, minted, asked } = fakes({
      [RUN_PATH]: { status: 200, body: json(run()) },
    });
    expect(await builds.getRun(REPO, 77)).toEqual({
      id: 77,
      path: ".github/workflows/ci.yml",
      event: "push",
      headSha: SHA,
      headBranch: "main",
      headRepo: REPO,
      status: "completed",
      conclusion: "success",
    });
    expect(minted).toEqual([{ repository: REPO, permission: "actions" }]);
    expect(asked).toMatchObject([{ path: RUN_PATH, accept: "json" }]);
    expect(await builds.getRun(REPO, 78)).toBeNull();
  });

  it("reads the newest successful push run of CI on main, one page of one", async () => {
    const { builds, asked } = fakes({
      [LATEST_PATH]: { status: 200, body: json({ workflow_runs: [run({ id: 90 })] }) },
    });
    expect(await builds.latestMainBuild(REPO)).toMatchObject({ id: 90, headSha: SHA });
    expect(asked.map((a) => a.path)).toEqual([LATEST_PATH]);
    const none = fakes({
      [LATEST_PATH]: { status: 200, body: json({ workflow_runs: [] }) },
    });
    expect(await none.builds.latestMainBuild(REPO)).toBeNull();
  });

  it("downloads the newest unexpired staging-site artifact of exactly that run", async () => {
    const { builds, asked } = fakes({
      [ARTIFACTS_PATH]: {
        status: 200,
        body: json({
          artifacts: [
            {
              id: 5,
              name: "staging-site",
              expired: false,
              created_at: "2026-11-08T01:00:00Z",
            },
            {
              id: 6,
              name: "staging-site",
              expired: true,
              created_at: "2026-11-08T02:00:00Z",
            },
            {
              id: 7,
              name: "other",
              expired: false,
              created_at: "2026-11-08T03:00:00Z",
            },
          ],
        }),
      },
      [`/repos/${REPO}/actions/artifacts/5/zip`]: { status: 200, body: ZIP },
    });
    expect(await builds.siteArchive(REPO, 77)).toEqual(ZIP);
    expect(asked.map((a) => [a.path, a.accept])).toEqual([
      [ARTIFACTS_PATH, "json"],
      [`/repos/${REPO}/actions/artifacts/5/zip`, "raw"],
    ]);
    expect(asked[1]?.maxBytes).toBe(100 * 1024 * 1024);
    const none = fakes({
      [ARTIFACTS_PATH]: { status: 200, body: json({ artifacts: [] }) },
    });
    expect(await none.builds.siteArchive(REPO, 77)).toBeNull();
  });

  it("throws on a GitHub refusal, and refuses a name or id out of shape before minting", async () => {
    const { builds, minted } = fakes({
      [RUN_PATH]: { status: 500, body: json({}) },
      [LATEST_PATH]: { status: 403, body: json({}) },
      [ARTIFACTS_PATH]: { status: 410, body: json({}) },
    });
    await expect(builds.getRun(REPO, 77)).rejects.toThrow(/failed with 500/);
    await expect(builds.latestMainBuild(REPO)).rejects.toThrow(/failed with 403/);
    await expect(builds.siteArchive(REPO, 77)).rejects.toThrow(/failed with 410/);
    const before = minted.length;
    await expect(builds.getRun("not a repo", 77)).rejects.toThrow(/repository name/);
    await expect(builds.getRun(REPO, 0)).rejects.toThrow(/run id/);
    await expect(builds.siteArchive(REPO, -1)).rejects.toThrow(/run id/);
    expect(minted).toHaveLength(before);
  });

  it("maps a run as GitHub names its fields, and drops one out of shape", () => {
    expect(toBuildRun(run({ conclusion: null, status: "in_progress" }))).toMatchObject({
      status: "in_progress",
      conclusion: null,
    });
    expect(toBuildRun(run({ head_repository: null }))?.headRepo).toBeNull();
    expect(toBuildRun(run({ head_branch: "bad branch" }))?.headBranch).toBeNull();
    for (const bad of [
      { id: 0 },
      { id: "77" },
      { head_sha: "short" },
      { event: "Push!" },
      { status: "Done" },
      { conclusion: "a very long conclusion that is not one word" },
      { path: "" },
    ]) {
      expect(toBuildRun(run(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});
