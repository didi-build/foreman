// Seam: the read of Foreman's release on GitHub's REST API (unit with fakes, ADR 0118 appendix G,
// D-449, O-166). A fake token port and a fake HTTP port stand in for the runner App and GitHub;
// the runs, jobs, artifact and settings file are synthetic, made here, with made-up digests. The
// exact URLs, that each token is a read token for the one repository (`actions` for runs, jobs and
// the artifact, `contents` for the settings file), which Platform run counts as the cluster
// matching its commit, and that every other answer throws. No network, no real run, id or token.
import { describe, expect, it } from "vitest";

import {
  PLATFORM_IMAGE_KEYS,
  type PlatformImages,
} from "../../core/cluster-release.ts";
import { storedZip } from "../../../test/zip-fixture.ts";
import {
  IMAGES,
  PLATFORM,
  SETTINGS_PATH,
  createGitHubClusterReleases,
  imagesOfArtifact,
  imagesOfSettings,
  leftClusterMatching,
} from "./cluster-releases.ts";
import type {
  GitHubGetRequest,
  GitHubGetResponse,
  RunnerAppTokenRequest,
} from "./runner-app-tokens.ts";

const REPO = "didi-build/foreman";
const BUILT = "1".repeat(40);
const APPLIED = "2".repeat(40);

const images = (digit: string): PlatformImages => ({
  stateApi: `ghcr.io/didi-build/foreman-state-api@sha256:${digit.repeat(64)}`,
  receiver: `ghcr.io/didi-build/foreman-github-receiver@sha256:${digit.repeat(64)}`,
  egressProxy: `ghcr.io/didi-build/foreman-egress-proxy@sha256:${digit.repeat(64)}`,
  runWatcher: `ghcr.io/didi-build/foreman-run-watcher@sha256:${digit.repeat(64)}`,
});

const encode = (body: unknown) =>
  new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
const ok = (body: unknown): GitHubGetResponse => ({ status: 200, body: encode(body) });

const run = (
  id: number,
  path: string,
  sha: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  run_number: id + 100,
  path,
  head_branch: "main",
  head_sha: sha,
  head_repository: { full_name: REPO },
  status: "completed",
  conclusion: "success",
  ...extra,
});

const imagesJson = (commit: string, platform: unknown = images("a")) =>
  JSON.stringify({
    commit,
    images: {},
    settingsFile: { platform: { images: platform } },
    windmill: {},
  });

const settings = (platform: unknown) => ({
  type: "file",
  path: SETTINGS_PATH,
  encoding: "base64",
  content: Buffer.from(JSON.stringify({ platform: { images: platform } })).toString(
    "base64",
  ),
});

const jobs = (...list: [string, string, string | null][]) => ({
  total_count: list.length,
  jobs: list.map(([name, status, conclusion]) => ({ name, status, conclusion })),
});

const PATHS = {
  imagesRuns: `/repos/${REPO}/actions/workflows/images.yml/runs?branch=main&status=success&per_page=1`,
  artifacts: (id: number) =>
    `/repos/${REPO}/actions/runs/${id}/artifacts?name=${IMAGES.artifact}`,
  download: (id: number) => `/repos/${REPO}/actions/artifacts/${id}/zip`,
  platformRuns: `/repos/${REPO}/actions/workflows/platform.yml/runs?branch=main&status=completed&per_page=20`,
  jobs: (id: number) => `/repos/${REPO}/actions/runs/${id}/jobs?per_page=100`,
  settingsAt: (sha: string) => `/repos/${REPO}/contents/${SETTINGS_PATH}?ref=${sha}`,
};

function fakes(answers: Record<string, GitHubGetResponse>) {
  const mints: RunnerAppTokenRequest[] = [];
  const gets: GitHubGetRequest[] = [];
  const releases = createGitHubClusterReleases({
    tokens: {
      async mint(request) {
        mints.push(request);
        return `fake-${request.permission}-token-not-real`;
      },
    },
    http: {
      async get(request) {
        gets.push(request);
        return answers[request.path] ?? { status: 404, body: encode("") };
      },
    },
  });
  return { releases, mints, gets };
}

const artifactAnswer = (id: number, expired = false) =>
  ok({
    artifacts: [
      { id, name: IMAGES.artifact, expired, created_at: "2026-11-22T10:00:00Z" },
    ],
  });

describe("Foreman's newest build on GitHub (unit with fakes, O-166)", () => {
  it("reads the newest successful Images run on main, its foreman-images artifact and the four platform images, with one actions read token", async () => {
    const f = fakes({
      [PATHS.imagesRuns]: ok({ workflow_runs: [run(31, IMAGES.path, BUILT)] }),
      [PATHS.artifacts(31)]: artifactAnswer(77),
      [PATHS.download(77)]: {
        status: 200,
        body: storedZip([{ name: IMAGES.entry, data: imagesJson(BUILT) }]),
      },
    });
    expect(await f.releases.latestBuild(REPO)).toEqual({
      runNumber: 131,
      commitSha: BUILT,
      images: images("a"),
    });
    expect(f.mints).toEqual([{ repository: REPO, permission: "actions" }]);
    expect(f.gets.map((g) => g.path)).toEqual([
      PATHS.imagesRuns,
      PATHS.artifacts(31),
      PATHS.download(77),
    ]);
  });

  it("answers null when main has no successful Images run, and throws on an expired artifact, another commit or images not pinned by digest", async () => {
    expect(
      await fakes({
        [PATHS.imagesRuns]: ok({ workflow_runs: [] }),
      }).releases.latestBuild(REPO),
    ).toBeNull();
    const base = {
      [PATHS.imagesRuns]: ok({ workflow_runs: [run(31, IMAGES.path, BUILT)] }),
    };
    const broken: Record<string, GitHubGetResponse>[] = [
      { ...base, [PATHS.artifacts(31)]: artifactAnswer(77, true) },
      {
        ...base,
        [PATHS.artifacts(31)]: artifactAnswer(77),
        [PATHS.download(77)]: {
          status: 200,
          body: storedZip([{ name: IMAGES.entry, data: imagesJson(APPLIED) }]),
        },
      },
      {
        ...base,
        [PATHS.artifacts(31)]: artifactAnswer(77),
        [PATHS.download(77)]: {
          status: 200,
          body: storedZip([
            {
              name: IMAGES.entry,
              data: imagesJson(BUILT, {
                ...images("a"),
                stateApi: "ghcr.io/didi-build/foreman-state-api:latest",
              }),
            },
          ]),
        },
      },
      { [PATHS.imagesRuns]: ok({ workflow_runs: [run(31, PLATFORM.path, BUILT)] }) },
      {
        [PATHS.imagesRuns]: ok({
          workflow_runs: [run(31, IMAGES.path, BUILT, { head_branch: "feature" })],
        }),
      },
      { [PATHS.imagesRuns]: { status: 403, body: encode("") } },
    ];
    for (const answers of broken) {
      await expect(fakes(answers).releases.latestBuild(REPO)).rejects.toThrow();
    }
    await expect(fakes({}).releases.latestBuild("not a repo")).rejects.toThrow(
      /not a repository name/,
    );
  });

  it("reads exactly the four platform images of the artifact, nothing else", () => {
    const zip = (data: string) => storedZip([{ name: IMAGES.entry, data }]);
    expect(imagesOfArtifact(zip(imagesJson(BUILT)), BUILT)).toEqual(images("a"));
    const extra = { ...images("a"), extra: images("a").stateApi };
    expect(() => imagesOfArtifact(zip(imagesJson(BUILT, extra)), BUILT)).toThrow();
    const missing: Partial<PlatformImages> = { ...images("a") };
    delete missing.runWatcher;
    expect(() => imagesOfArtifact(zip(imagesJson(BUILT, missing)), BUILT)).toThrow();
    expect(() => imagesOfArtifact(zip("not json"), BUILT)).toThrow();
    expect(() => imagesOfArtifact(new Uint8Array([1, 2, 3]), BUILT)).toThrow();
    expect(PLATFORM_IMAGE_KEYS).toEqual([
      "stateApi",
      "receiver",
      "egressProxy",
      "runWatcher",
    ]);
  });
});

describe("what Foreman's cluster runs, from the Platform runs on GitHub (unit with fakes, O-166)", () => {
  it("takes the newest completed Platform run that left the cluster matching its commit and the pins of production.json at that commit", async () => {
    const f = fakes({
      [PATHS.platformRuns]: ok({
        workflow_runs: [
          run(53, PLATFORM.path, "3".repeat(40), { conclusion: "failure" }),
          run(52, PLATFORM.path, APPLIED),
          run(51, PLATFORM.path, "4".repeat(40)),
        ],
      }),
      // Didi rejected or the apply failed: the cluster may not match its commit.
      [PATHS.jobs(53)]: ok(
        jobs(
          ["render", "completed", "success"],
          [PLATFORM.plan, "completed", "success"],
          [PLATFORM.apply, "completed", "failure"],
          [`${PLATFORM.addOnlyApply} ()`, "completed", "skipped"],
        ),
      ),
      [PATHS.jobs(52)]: ok(
        jobs(
          ["render", "completed", "success"],
          [PLATFORM.plan, "completed", "success"],
          [PLATFORM.apply, "completed", "success"],
          [`${PLATFORM.addOnlyApply} ()`, "completed", "skipped"],
          ["cluster-secrets", "completed", "skipped"],
        ),
      ),
      [PATHS.settingsAt(APPLIED)]: ok(settings(images("b"))),
    });
    expect(await f.releases.latestApplied(REPO)).toEqual({
      runNumber: 152,
      commitSha: APPLIED,
      images: images("b"),
    });
    expect(f.mints).toEqual([
      { repository: REPO, permission: "actions" },
      { repository: REPO, permission: "contents" },
    ]);
    expect(f.gets.map((g) => g.path)).toEqual([
      PATHS.platformRuns,
      PATHS.jobs(53),
      PATHS.jobs(52),
      PATHS.settingsAt(APPLIED),
    ]);
  });

  it("counts a plan with no change, whose applies were skipped, and nothing else", () => {
    const matching = [
      jobs(
        [PLATFORM.plan, "completed", "success"],
        [PLATFORM.apply, "completed", "skipped"],
        [`${PLATFORM.addOnlyApply} ()`, "completed", "skipped"],
      ),
      jobs(
        [PLATFORM.plan, "completed", "success"],
        [PLATFORM.apply, "completed", "skipped"],
        [`${PLATFORM.addOnlyApply} (shop-2)`, "completed", "success"],
      ),
    ];
    for (const body of matching) expect(leftClusterMatching(body)).toBe(true);
    const not = [
      jobs(
        [PLATFORM.plan, "completed", "failure"],
        [PLATFORM.apply, "completed", "skipped"],
      ),
      jobs(
        [PLATFORM.plan, "completed", "success"],
        [PLATFORM.apply, "completed", "cancelled"],
      ),
      jobs([PLATFORM.plan, "completed", "success"], [PLATFORM.apply, "waiting", null]),
      jobs(["render", "completed", "success"]),
    ];
    for (const body of not) expect(leftClusterMatching(body)).toBe(false);
    expect(() => leftClusterMatching({ total_count: 5, jobs: [] })).toThrow(
      /more jobs than the check reads/,
    );
    expect(() => leftClusterMatching({ jobs: "no" })).toThrow();
  });

  it("answers null when none of the newest runs matched, and throws on a failed read or a settings file without pinned images", async () => {
    const plain = fakes({
      [PATHS.platformRuns]: ok({ workflow_runs: [run(52, PLATFORM.path, APPLIED)] }),
      [PATHS.jobs(52)]: ok(jobs([PLATFORM.plan, "completed", "failure"])),
    });
    expect(await plain.releases.latestApplied(REPO)).toBeNull();
    await expect(fakes({}).releases.latestApplied(REPO)).rejects.toThrow(
      /reading the Platform runs failed with 404/,
    );
    const noPins = fakes({
      [PATHS.platformRuns]: ok({ workflow_runs: [run(52, PLATFORM.path, APPLIED)] }),
      [PATHS.jobs(52)]: ok(jobs([PLATFORM.plan, "completed", "success"])),
      [PATHS.settingsAt(APPLIED)]: ok(settings({ stateApi: "x" })),
    });
    await expect(noPins.releases.latestApplied(REPO)).rejects.toThrow(
      /holds no platform images/,
    );
    expect(() => imagesOfSettings({ type: "dir" })).toThrow();
  });
});
