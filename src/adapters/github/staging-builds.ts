// The runner's reads of CI's builds for the staging deploy (D-353, D-267, O-116): the core's
// `StagingBuilds` (src/core/staging-deploy.ts). Each read mints a read-only installation token of
// the runner App that carries only `actions: read` for that one repository (./runner-app-tokens.ts),
// uses it for that read and never keeps or logs it. No permission or webhook event is added:
// D-267 gave the runner App `actions: read`, and GitHub's REST docs name "Actions" read for each
// call below.
//
// - `getRun`: `GET /repos/{repo}/actions/runs/{run_id}`, the one run; 404 is no run.
// - `latestMainBuild`: `GET /repos/{repo}/actions/workflows/ci.yml/runs?branch=main&event=push&
//   status=success&exclude_pull_requests=true&per_page=1`, the newest successful run of CI that a
//   push to main started, one page of one.
// - `siteArchive`: the artifacts of exactly that run named `staging-site`
//   (`GET /repos/{repo}/actions/runs/{run_id}/artifacts?name=staging-site`), the newest unexpired
//   one, downloaded as GitHub's zip (`GET /repos/{repo}/actions/artifacts/{id}/zip`) at most
//   `MAX_ARTIFACT_BYTES`, the bound the screenshot bundles use, with their listing and download code
//   (../screenshots/github-artifacts.ts). The zip is not read here: the deploy target checks it
//   (src/adapters/deploy/site-files.ts).
//
// Fields are mapped as GitHub names them (`id`, `path`, `event`, `head_sha`, `head_branch`,
// `head_repository.full_name`, `status`, `conclusion`). A run missing a field, or with a status or
// conclusion that is not a short lowercase word, is no run, never guessed at; the core then checks
// that it is CI's run on main (`isMainBuild`). Until the runner App is registered (D-178) the token
// port refuses with `NotBuiltError` (flows/lib/compose.ts). Tests pass fakes.
import {
  STAGING_BUILD_EVENT,
  STAGING_BUILD_WORKFLOW_FILE,
  STAGING_SITE_ARTIFACT,
  type BuildRun,
  type StagingBuilds,
} from "../../core/staging-deploy.ts";
import { STAGING_MAIN_BRANCH } from "../../core/staging.ts";
import {
  downloadArtifact,
  listRunArtifacts,
  newestArtifact,
} from "../screenshots/github-artifacts.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
/** GitHub's statuses and conclusions are short lowercase words. */
const WORD = /^[a-z_]{1,40}$/;
/** A branch name as the runner reads it; anything else is no branch. */
const BRANCH = /^[A-Za-z0-9._/-]{1,250}$/;
/** The largest listing the runner reads. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

function json(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GitHubReadError(`the ${what} is not JSON`);
  }
}

/** A run as GitHub reports it, or null when a field is missing or not in its shape. */
export function toBuildRun(raw: unknown): BuildRun | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const head = r.head_repository as Record<string, unknown> | null | undefined;
  const headRepo = head?.full_name;
  if (!isId(r.id) || typeof r.path !== "string" || typeof r.event !== "string")
    return null;
  if (r.path === "" || r.path.length > 300 || !WORD.test(r.event)) return null;
  if (typeof r.head_sha !== "string" || !FULL_SHA.test(r.head_sha)) return null;
  if (typeof r.status !== "string" || !WORD.test(r.status)) return null;
  const conclusion = r.conclusion ?? null;
  if (conclusion !== null && (typeof conclusion !== "string" || !WORD.test(conclusion)))
    return null;
  return {
    id: r.id,
    path: r.path,
    event: r.event,
    headSha: r.head_sha,
    headBranch:
      typeof r.head_branch === "string" && BRANCH.test(r.head_branch)
        ? r.head_branch
        : null,
    headRepo:
      typeof headRepo === "string" && REPOSITORY.test(headRepo) ? headRepo : null,
    status: r.status,
    conclusion,
  };
}

export interface GitHubStagingBuildsOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubStagingBuilds({
  tokens,
  http,
}: GitHubStagingBuildsOptions): StagingBuilds {
  /** Minted for one read only, with actions read on this repository only (D-267). */
  const tokenFor = (repo: string) =>
    tokens.mint({ repository: repo, permission: "actions" });

  function checked(repo: string, runId?: number): void {
    if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
    if (runId !== undefined && !isId(runId))
      throw new GitHubReadError("not a workflow run id");
  }

  return {
    async getRun(repo, runId) {
      checked(repo, runId);
      const answer = await http.get({
        path: `/repos/${repo}/actions/runs/${runId}`,
        token: await tokenFor(repo),
        accept: "json",
        maxBytes: MAX_LISTING_BYTES,
      });
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading the workflow run failed with ${answer.status}`,
        );
      }
      return toBuildRun(json(answer.body, "workflow run"));
    },

    async latestMainBuild(repo) {
      checked(repo);
      const query = [
        `branch=${STAGING_MAIN_BRANCH}`,
        `event=${STAGING_BUILD_EVENT}`,
        "status=success",
        "exclude_pull_requests=true",
        "per_page=1",
      ].join("&");
      const answer = await http.get({
        path: `/repos/${repo}/actions/workflows/${STAGING_BUILD_WORKFLOW_FILE}/runs?${query}`,
        token: await tokenFor(repo),
        accept: "json",
        maxBytes: MAX_LISTING_BYTES,
      });
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `listing the workflow runs failed with ${answer.status}`,
        );
      }
      const list = (
        json(answer.body, "workflow run listing") as { workflow_runs?: unknown }
      ).workflow_runs;
      if (!Array.isArray(list))
        throw new GitHubReadError("the workflow run listing has no list");
      return list.length > 0 ? toBuildRun(list[0]) : null;
    },

    async siteArchive(repo, runId) {
      checked(repo, runId);
      const token = await tokenFor(repo);
      const found = newestArtifact(
        await listRunArtifacts(http, {
          repo,
          runId,
          name: STAGING_SITE_ARTIFACT,
          token,
        }),
        STAGING_SITE_ARTIFACT,
      );
      if (!found) return null;
      return downloadArtifact(http, { repo, id: found.id, token });
    },
  };
}
