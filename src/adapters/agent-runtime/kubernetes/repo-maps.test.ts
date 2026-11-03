// Adapter contract: the repo map port on Kubernetes (D-275 (2), O-87) against the in-memory fake
// client. The Job's log is made by the image's own code (src/agent-images/repo-map/image.ts) over a
// synthetic archive, or written by hand for a malformed or oversized result. No cluster, no network,
// no real repository and no real token.
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

import { RepoMapError } from "../../../core/repo-map.ts";
import { runRepoMapImage } from "../../../agent-images/repo-map/image.ts";
import type {
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "../../github/runner-app-tokens.ts";
import {
  FIXTURE_ENTRIES,
  FIXTURE_REPO as REPO,
  FIXTURE_SHA as SHA,
  tarball,
} from "../../repo-map/fixtures.ts";
import { MAX_ENCODED_MAP_CHARS } from "../../repo-map/result.ts";
import { createFakeKubernetes, type FakeKubernetes, type JobEnd } from "./fake.ts";
import { GITHUB_TOKEN, SETTINGS } from "./fixtures.ts";
import { REPO_MAP_HOSTS } from "./manifests.ts";
import { repoMapNames } from "./names.ts";
import type { Job, Secret } from "./objects.ts";
import {
  createKubernetesRepoMaps,
  REPO_MAP_POLL_MS,
  RepoMapJobError,
} from "./repo-maps.ts";

const NS = "agents-rehearsal";
const PROJECT = { slug: "rehearsal", repo: REPO };
const HEAD = "d".repeat(40);
const MAP_ID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const n = repoMapNames(MAP_ID);

let fake: FakeKubernetes;
let minted: RunnerAppTokenRequest[];
let clusterReads: number;
let clock: number;
/** What the Job does when the runner first waits on it; undefined leaves it running. */
let jobEnd: (() => Promise<JobEnd>) | undefined;

const tokens: RunnerAppTokens = {
  async mint(request) {
    minted.push(request);
    return GITHUB_TOKEN;
  },
};
const github: GitHubHttp = {
  async get({ path }) {
    if (path === `/repos/${REPO}`) {
      return { status: 200, body: Buffer.from('{"default_branch":"main"}') };
    }
    if (path === `/repos/${REPO}/commits/main`) {
      return { status: 200, body: Buffer.from(HEAD) };
    }
    return { status: 404, body: new Uint8Array() };
  },
};

/** The Job's log as the image prints it, over the synthetic archive at `commit`. */
async function imageLog(commit: string): Promise<string> {
  const lines: string[] = [];
  await runRepoMapImage(
    {
      FOREMAN_RUN_ID: MAP_ID,
      FOREMAN_REPOSITORY: REPO,
      FOREMAN_COMMIT_SHA: commit,
      GITHUB_TOKEN: "token-inside-the-job",
      HTTPS_PROXY: "http://10.245.0.10:8080",
      NODE_USE_ENV_PROXY: "1",
    },
    {
      http: { get: async () => ({ status: 200, body: tarball(FIXTURE_ENTRIES) }) },
      write: (line) => lines.push(line),
    },
  );
  return `starting\n${lines.join("\n")}\n`;
}

const resultLine = (fields: Record<string, unknown>) =>
  `${JSON.stringify({ foremanResult: 1, ...fields })}\n`;

function maps() {
  return createKubernetesRepoMaps({
    tokens,
    http: github,
    cluster: async () => {
      clusterReads += 1;
      return { client: fake, settings: SETTINGS };
    },
    ids: { next: () => MAP_ID },
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (jobEnd) {
        const end = await jobEnd();
        jobEnd = undefined;
        fake.finishJob(NS, n.job, end);
      }
    },
  });
}

beforeEach(() => {
  fake = createFakeKubernetes();
  minted = [];
  clusterReads = 0;
  clock = 0;
  jobEnd = undefined;
});

const created = () => fake.calls.filter((c) => c.startsWith("create "));

describe("a map read on Kubernetes (adapter contract, D-275 (2))", () => {
  it("creates the token's Secret, the policies, the proxy and its Service, then the Job", async () => {
    jobEnd = async () => ({ condition: "Complete", log: await imageLog(SHA) });
    await maps().read(PROJECT, SHA);
    expect(created()).toEqual([
      `create Secret/${n.githubTokenSecret}`,
      `create NetworkPolicy/${n.policy}`,
      `create NetworkPolicy/${n.proxyPolicy}`,
      `create Job/${n.proxyJob}`,
      `create Service/${n.proxyService}`,
      `create Job/${n.job}`,
    ]);
    expect(minted).toEqual([{ repository: REPO, permission: "contents" }]);
  });

  it("returns the Job's map, checked, and leaves nothing behind", async () => {
    jobEnd = async () => ({ condition: "Complete", log: await imageLog(SHA) });
    const map = await maps().read(PROJECT, SHA);
    expect(map.commitSha).toBe(SHA);
    expect(map.files.find((f) => f.path === "src/app.ts")).toEqual({
      path: "src/app.ts",
      exports: ["app"],
      imports: ["src/store.ts"],
    });
    expect(map.scripts).toEqual({ check: "vitest run" });
    expect(fake.objects.size).toBe(0);
  });

  it("deletes the token's Secret as soon as the Job ends, before its log is read", async () => {
    jobEnd = async () => ({ condition: "Complete", log: await imageLog(SHA) });
    await maps().read(PROJECT, SHA);
    const secretGone = fake.calls.indexOf(`delete Secret/${n.githubTokenSecret}`);
    const logRead = fake.calls.findIndex((c) => c.startsWith("log Pod/"));
    expect(secretGone).toBeGreaterThan(-1);
    expect(secretGone).toBeLessThan(logRead);
    expect(fake.calls.filter((c) => c.startsWith("delete Job/")).slice(0, 2)).toEqual([
      `delete Job/${n.job}`,
      `delete Job/${n.proxyJob}`,
    ]);
  });

  it("with no commit, reads the default branch's head itself and gives the Job that commit", async () => {
    jobEnd = async () => {
      const job = fake.get<Job>("Job", NS, n.job);
      const env = job?.spec.template.spec.containers[0]?.env ?? [];
      const commit = env.find((e) => e.name === "FOREMAN_COMMIT_SHA");
      expect(commit && "value" in commit ? commit.value : null).toBe(HEAD);
      return { condition: "Complete", log: await imageLog(HEAD) };
    };
    const map = await maps().read(PROJECT);
    expect(map.commitSha).toBe(HEAD);
    expect(minted).toHaveLength(1);
  });

  it("puts the token only in the Job's Secret, and the Job's proxy allows GitHub only", async () => {
    let seen: Secret | undefined;
    let objectsText = "";
    jobEnd = async () => {
      seen = fake.get<Secret>("Secret", NS, n.githubTokenSecret);
      objectsText = JSON.stringify(
        [...fake.objects.values()].filter((o) => o.kind !== "Secret"),
      );
      return { condition: "Complete", log: await imageLog(SHA) };
    };
    await maps().read(PROJECT, SHA);
    expect(seen?.stringData).toEqual({ token: GITHUB_TOKEN });
    expect(objectsText).not.toContain(GITHUB_TOKEN);
    expect(objectsText).toContain(
      `"ALLOWED_HOSTS","value":"${REPO_MAP_HOSTS.join(",")}"`,
    );
  });
});

describe("refusing a bad or unusable map (adapter contract, D-275 (2))", () => {
  it("refuses on the token before the cluster is read or anything is created", async () => {
    const refusing = createKubernetesRepoMaps({
      tokens: {
        mint: async () => {
          throw new Error("the runner App is not registered");
        },
      },
      http: github,
      cluster: async () => {
        clusterReads += 1;
        return { client: fake, settings: SETTINGS };
      },
      ids: { next: () => MAP_ID },
    });
    await expect(refusing.read(PROJECT, SHA)).rejects.toThrow(/runner App/);
    expect(clusterReads).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["a bad repository", { slug: "rehearsal", repo: "not a repo" }, SHA],
    ["a bad project slug", { slug: "Not_A_Slug", repo: REPO }, SHA],
    ["a short commit", PROJECT, "abc"],
  ])("refuses %s before minting a token", async (_label, project, commit) => {
    await expect(maps().read(project, commit)).rejects.toThrow();
    expect(minted).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a malformed result and removes everything", async () => {
    jobEnd = async () => ({
      condition: "Complete",
      log: resultLine({
        status: "success",
        structured: {
          repoMap: 1,
          gzipBase64: gzipSync('{"files":[]}').toString("base64"),
        },
      }),
    });
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(RepoMapError);
    expect(fake.objects.size).toBe(0);
  });

  it("refuses an oversized result and removes everything", async () => {
    jobEnd = async () => ({
      condition: "Complete",
      log: resultLine({
        status: "success",
        structured: { repoMap: 1, gzipBase64: "A".repeat(MAX_ENCODED_MAP_CHARS + 4) },
      }),
    });
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(/within its bound/);
    expect(fake.objects.size).toBe(0);
  });

  it("refuses a map built at another commit than the one asked for", async () => {
    jobEnd = async () => ({ condition: "Complete", log: await imageLog(HEAD) });
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(/not for the commit/);
    expect(fake.objects.size).toBe(0);
  });

  it("refuses a Job with no result line", async () => {
    jobEnd = async () => ({ condition: "Complete", log: "no result here\n" });
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(RepoMapJobError);
    expect(fake.objects.size).toBe(0);
  });

  it("reports a failed Job with the image's error in plain words, cut short", async () => {
    jobEnd = async () => ({
      condition: "Failed",
      reason: "BackoffLimitExceeded",
      log: resultLine({
        status: "error",
        errorText: `downloading the code failed with 404\u001b[31m${"x".repeat(500)}`,
      }),
    });
    const error = await maps()
      .read(PROJECT, SHA)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoMapJobError);
    expect(String(error)).toContain("downloading the code failed with 404");
    expect(String(error)).not.toContain("\u001b");
    expect((error as Error).message.length).toBeLessThan(260);
    expect(fake.objects.size).toBe(0);
  });

  it("reports a Job past its deadline", async () => {
    jobEnd = async () => ({ condition: "Failed", reason: "DeadlineExceeded" });
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(/deadline/);
    expect(fake.objects.size).toBe(0);
  });

  it("gives up on a Job that never ends past its bound, and removes everything", async () => {
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(/did not end in time/);
    const boundMs =
      (SETTINGS.repoMapMaxMinutes * 60 +
        SETTINGS.terminationGracePeriodSeconds +
        SETTINGS.proxyDeadlineMarginSeconds) *
      1000;
    expect(clock).toBeGreaterThanOrEqual(boundMs);
    expect(clock).toBeLessThan(boundMs + REPO_MAP_POLL_MS);
    expect(fake.objects.size).toBe(0);
  });

  it("creates nothing with run settings that break the rules", async () => {
    const unpinned = createKubernetesRepoMaps({
      tokens,
      http: github,
      cluster: async () => ({
        client: fake,
        settings: { ...SETTINGS, repoMapImage: "registry.example.com/repo-map:latest" },
      }),
      ids: { next: () => MAP_ID },
    });
    await expect(unpinned.read(PROJECT, SHA)).rejects.toThrow(/pinned by digest/);
    expect(fake.calls).toEqual([]);
  });

  it("removes what it made when a create fails, and reports the error", async () => {
    fake.failNextCreate("Service", 403, "Forbidden");
    await expect(maps().read(PROJECT, SHA)).rejects.toThrow(/Forbidden/);
    expect(fake.objects.size).toBe(0);
  });
});
