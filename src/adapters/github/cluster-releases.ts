// The daily check's read of Foreman's release (src/core/cluster-release.ts, ADR 0118 appendix G,
// D-449, slice 9, O-166) on GitHub's REST API, with the runner App's existing read-only tokens
// (D-267), each minted for the project's repository only and one permission: `actions: read` for
// the runs, jobs and artifact, `contents: read` for the settings file at a commit. No new
// permission, token scope, credential or record: GitHub keeps the runs, as for the add-only
// applies (./add-only-applies.ts, O-158).
//
// - `latestBuild`: "List workflow runs for a workflow",
//   `GET /repos/{repo}/actions/workflows/images.yml/runs?branch=main&status=success&per_page=1`,
//   the newest successful Images run on main (a push, or a run Didi started on main). Then its
//   artifact `foreman-images` (`GET /repos/{repo}/actions/runs/{id}/artifacts?name=...`, the newest
//   unexpired one, downloaded as GitHub's zip, ../screenshots/github-artifacts.ts), and in it
//   `images.json`, whose `commit` must be the run's head commit and whose
//   `settingsFile.platform.images` must be exactly the four images pinned by digest. The artifact
//   is kept 30 days (.github/workflows/images.yml); an expired one throws.
// - `latestApplied`: `GET /repos/{repo}/actions/workflows/platform.yml/runs?branch=main&status=
//   completed&per_page=20`, newest first, then each run's jobs (`GET /repos/{repo}/actions/runs/
//   {id}/jobs?per_page=100`, the latest attempt) until one left the cluster matching its commit:
//   `kubectl-diff` succeeded, and `kubectl-apply` and `kubectl-apply-add-only (...)` each
//   succeeded or were skipped. Then `GET /repos/{repo}/contents/infra/kubernetes/settings/
//   production.json?ref={its head commit}` and its `platform.images`. None of the 20 is null.
//
// A failed call, an answer of another shape, or a value the core's rules refuse throws a
// `GitHubReadError` naming the step, never a token or GitHub's words; the core then says the
// release could not be read. The runner mints each token with its App's key
// (flows/lib/compose.ts, O-125). Tests pass fakes. Nothing here logs, and no token is kept.
import {
  parsePlatformImages,
  type ClusterReleases,
  type ImagesBuild,
  type PlatformApplied,
  type PlatformImages,
} from "../../core/cluster-release.ts";
import {
  downloadArtifact,
  listRunArtifacts,
  newestArtifact,
} from "../screenshots/github-artifacts.ts";
import { readZip } from "../screenshots/zip.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** The Images workflow, its artifact and the file in it (.github/workflows/images.yml). */
export const IMAGES = {
  file: "images.yml",
  path: ".github/workflows/images.yml",
  artifact: "foreman-images",
  entry: "images.json",
} as const;

/** The Platform workflow and the jobs whose results say the cluster matches the run's commit. */
export const PLATFORM = {
  file: "platform.yml",
  path: ".github/workflows/platform.yml",
  plan: "kubectl-diff",
  apply: "kubectl-apply",
  addOnlyApply: "kubectl-apply-add-only",
} as const;

/** Foreman's settings file, whose `platform.images` a Platform run applies. */
export const SETTINGS_PATH = "infra/kubernetes/settings/production.json";

/** The newest Platform runs read, newest first. */
export const PLATFORM_RUNS_READ = 20;

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** GitHub serves a file's base64 content in the contents answer up to 1 MiB. */
const MAX_CONTENTS_ANSWER_BYTES = 2 * 1024 * 1024;
/** `images.json` is well under 4 KiB; anything near this is not it. */
const MAX_IMAGES_FILE_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRunId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function json(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new GitHubReadError(`${what} is not JSON`);
  }
}

/** A run of the workflow on main from the repository itself, or null. */
function runOf(
  raw: unknown,
  repo: string,
  path: string,
): { id: number; runNumber: number; headSha: string; conclusion: unknown } | null {
  if (!isObject(raw)) return null;
  const head = raw.head_repository;
  if (
    !isRunId(raw.id) ||
    !isRunId(raw.run_number) ||
    raw.path !== path ||
    raw.head_branch !== "main" ||
    typeof raw.head_sha !== "string" ||
    !FULL_SHA.test(raw.head_sha) ||
    !isObject(head) ||
    head.full_name !== repo
  ) {
    return null;
  }
  return {
    id: raw.id,
    runNumber: raw.run_number,
    headSha: raw.head_sha,
    conclusion: raw.conclusion,
  };
}

function runList(body: unknown): unknown[] {
  if (!isObject(body) || !Array.isArray(body.workflow_runs)) {
    throw new GitHubReadError("the run list is not one");
  }
  return body.workflow_runs;
}

/**
 * Whether a run's jobs show the cluster left matching the run's commit: the plan succeeded, and
 * each apply job succeeded or was skipped. Throws when the job list is not one.
 */
export function leftClusterMatching(body: unknown): boolean {
  if (
    !isObject(body) ||
    !Array.isArray(body.jobs) ||
    typeof body.total_count !== "number"
  ) {
    throw new GitHubReadError("the job list is not one");
  }
  if (body.total_count > body.jobs.length) {
    throw new GitHubReadError("the run has more jobs than the check reads");
  }
  const jobs = (body.jobs as unknown[]).map((job) => {
    if (!isObject(job) || typeof job.name !== "string") {
      throw new GitHubReadError("a job is not one");
    }
    return { name: job.name, status: job.status, conclusion: job.conclusion };
  });
  const done = (j: { status: unknown; conclusion: unknown }, ok: string[]) =>
    j.status === "completed" &&
    typeof j.conclusion === "string" &&
    ok.includes(j.conclusion);
  const plan = jobs.filter((j) => j.name === PLATFORM.plan);
  const applies = jobs.filter(
    (j) =>
      j.name === PLATFORM.apply ||
      j.name === PLATFORM.addOnlyApply ||
      j.name.startsWith(`${PLATFORM.addOnlyApply} `),
  );
  // A plan with no change skips both applies; one with changes runs exactly one of them.
  return (
    plan.length === 1 &&
    done(plan[0] as (typeof jobs)[number], ["success"]) &&
    applies.every((j) => done(j, ["success", "skipped"]))
  );
}

/** The four platform images in `images.json`, checked against the run's commit. */
export function imagesOfArtifact(zip: Uint8Array, commitSha: string): PlatformImages {
  let files: Map<string, Uint8Array>;
  try {
    files = readZip(zip);
  } catch {
    throw new GitHubReadError("the foreman-images artifact is not a zip it can read");
  }
  const file = files.get(IMAGES.entry);
  if (!file || file.length > MAX_IMAGES_FILE_BYTES) {
    throw new GitHubReadError("the foreman-images artifact holds no images.json");
  }
  const parsed = json(file, "images.json");
  if (!isObject(parsed) || parsed.commit !== commitSha) {
    throw new GitHubReadError("images.json names another commit than its run");
  }
  const settingsFile = parsed.settingsFile;
  const platform = isObject(settingsFile) ? settingsFile.platform : undefined;
  const images = parsePlatformImages(isObject(platform) ? platform.images : undefined);
  if (!images) throw new GitHubReadError("images.json holds no platform images");
  return images;
}

/** The platform images of the settings file as GitHub's contents answer gives it. */
export function imagesOfSettings(answer: unknown): PlatformImages {
  if (
    !isObject(answer) ||
    answer.type !== "file" ||
    answer.path !== SETTINGS_PATH ||
    answer.encoding !== "base64" ||
    typeof answer.content !== "string"
  ) {
    throw new GitHubReadError("the settings file's answer is not one");
  }
  const text = Buffer.from(answer.content, "base64");
  const parsed = json(text, "the settings file");
  const platform = isObject(parsed) ? parsed.platform : undefined;
  const images = parsePlatformImages(isObject(platform) ? platform.images : undefined);
  if (!images) throw new GitHubReadError("the settings file holds no platform images");
  return images;
}

export interface GitHubClusterReleasesOptions {
  /** The runner App's read-only tokens (D-267): one repository, one permission. */
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubClusterReleases({
  tokens,
  http,
}: GitHubClusterReleasesOptions): ClusterReleases {
  async function get(
    path: string,
    token: string,
    what: string,
    maxBytes = MAX_ANSWER_BYTES,
  ): Promise<unknown> {
    const answer = await http.get({ path, token, accept: "json", maxBytes });
    if (answer.status !== 200) {
      throw new GitHubReadError(`reading ${what} failed with ${answer.status}`);
    }
    return json(answer.body, what);
  }

  const checked = (repo: string): void => {
    if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
  };

  return {
    async latestBuild(repo): Promise<ImagesBuild | null> {
      checked(repo);
      const token = await tokens.mint({ repository: repo, permission: "actions" });
      const listed = runList(
        await get(
          `/repos/${repo}/actions/workflows/${IMAGES.file}/runs?branch=main&status=success&per_page=1`,
          token,
          "the Images runs",
        ),
      );
      if (listed.length === 0) return null;
      const run = runOf(listed[0], repo, IMAGES.path);
      if (!run || run.conclusion !== "success") {
        throw new GitHubReadError(
          "the newest Images run is not a successful run on main",
        );
      }
      const artifact = newestArtifact(
        await listRunArtifacts(http, {
          repo,
          runId: run.id,
          name: IMAGES.artifact,
          token,
        }),
        IMAGES.artifact,
      );
      if (!artifact) {
        throw new GitHubReadError(
          "the newest Images run keeps no foreman-images artifact, or it has expired",
        );
      }
      const zip = await downloadArtifact(http, { repo, id: artifact.id, token });
      return {
        runNumber: run.runNumber,
        commitSha: run.headSha,
        images: imagesOfArtifact(zip, run.headSha),
      };
    },

    async latestApplied(repo): Promise<PlatformApplied | null> {
      checked(repo);
      const actions = await tokens.mint({ repository: repo, permission: "actions" });
      const listed = runList(
        await get(
          `/repos/${repo}/actions/workflows/${PLATFORM.file}/runs?branch=main&status=completed&per_page=${PLATFORM_RUNS_READ}`,
          actions,
          "the Platform runs",
        ),
      );
      for (const raw of listed.slice(0, PLATFORM_RUNS_READ)) {
        const run = runOf(raw, repo, PLATFORM.path);
        if (!run) continue;
        const jobs = await get(
          `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
          actions,
          "a Platform run's jobs",
        );
        if (!leftClusterMatching(jobs)) continue;
        const contents = await tokens.mint({
          repository: repo,
          permission: "contents",
        });
        const answer = await get(
          `/repos/${repo}/contents/${SETTINGS_PATH}?ref=${run.headSha}`,
          contents,
          "the settings file",
          MAX_CONTENTS_ANSWER_BYTES,
        );
        return {
          runNumber: run.runNumber,
          commitSha: run.headSha,
          images: imagesOfSettings(answer),
        };
      }
      return null;
    },
  };
}
