// The runner's reads of CI's workflow runs and jobs (D-354, D-267, O-111): the two calls of the
// core's `GitHubWorkflowReader` that GitHub ingestion uses to find CI's preview check
// (src/core/preview-check.ts). Each read mints a read-only installation token of the runner App
// that carries only `actions: read` for that one repository (./runner-app-tokens.ts), uses it for
// that read and never keeps or logs it. No permission or webhook event is added: D-267 gave the
// runner App `actions: read`.
//
// - `listWorkflowRuns`: `GET /repos/{repo}/actions/workflows/{file}/runs?head_sha={sha}&per_page=20`,
//   the runs of that one workflow file on the commit, one page.
// - `listWorkflowJobs`: `GET /repos/{repo}/actions/runs/{id}/jobs?per_page=100`, the jobs of the
//   run's latest attempt (GitHub's default `filter=latest`), one page.
//
// Fields are mapped as GitHub names them (`path`, `event`, `head_sha`, `head_repository.full_name`;
// `id`, `run_id`, `name`, `head_sha`, `status`, `conclusion`). A run or job missing a field, or
// with a status or conclusion that is not a short lowercase word, is dropped, never guessed at.
// The core then picks the one job that counts. Until the runner App is registered (D-178) the
// token port refuses with `NotBuiltError` (flows/lib/compose.ts). Tests pass fakes.
import type {
  GitHubWorkflowReader,
  WorkflowJob,
  WorkflowRun,
} from "../../core/github.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;
/** GitHub's statuses and conclusions are short lowercase words. */
const WORD = /^[a-z_]{1,40}$/;

/** The most runs of one workflow on one commit the runner reads (reruns keep their run). */
export const MAX_RUNS = 20;
/** The most jobs of one run the runner reads. */
export const MAX_JOBS = 100;
/** The largest listing the runner reads. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= 300;

function list(body: Uint8Array, what: string, key: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GitHubReadError(`the ${what} listing is not JSON`);
  }
  const items = (parsed as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(items))
    throw new GitHubReadError(`the ${what} listing has no list`);
  return items;
}

function toRun(raw: unknown): WorkflowRun[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const head = r.head_repository as Record<string, unknown> | null | undefined;
  const headRepo = head?.full_name;
  if (!isId(r.id) || !isText(r.path) || !isText(r.event)) return [];
  if (typeof r.head_sha !== "string" || !FULL_SHA.test(r.head_sha)) return [];
  return [
    {
      id: r.id,
      path: r.path,
      event: r.event,
      headSha: r.head_sha,
      headRepo:
        typeof headRepo === "string" && REPOSITORY.test(headRepo) ? headRepo : null,
    },
  ];
}

function toJob(raw: unknown): WorkflowJob[] {
  const j = (raw ?? {}) as Record<string, unknown>;
  if (!isId(j.id) || !isId(j.run_id) || !isText(j.name)) return [];
  if (typeof j.head_sha !== "string" || !FULL_SHA.test(j.head_sha)) return [];
  if (typeof j.status !== "string" || !WORD.test(j.status)) return [];
  const conclusion = j.conclusion ?? null;
  if (conclusion !== null && (typeof conclusion !== "string" || !WORD.test(conclusion)))
    return [];
  return [
    {
      id: j.id,
      runId: j.run_id,
      name: j.name,
      headSha: j.head_sha,
      status: j.status,
      conclusion,
    },
  ];
}

export interface GitHubWorkflowReadsOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubWorkflowReads({
  tokens,
  http,
}: GitHubWorkflowReadsOptions): GitHubWorkflowReader {
  /** One listing with a token minted for it: `actions: read` on this repository only (D-267). */
  async function read(repo: string, path: string, what: string): Promise<Uint8Array> {
    const token = await tokens.mint({ repository: repo, permission: "actions" });
    const answer = await http.get({
      path,
      token,
      accept: "json",
      maxBytes: MAX_LISTING_BYTES,
    });
    if (answer.status !== 200) {
      throw new GitHubReadError(`listing the ${what} failed with ${answer.status}`);
    }
    return answer.body;
  }

  return {
    async listWorkflowRuns(repo, workflowFile, sha) {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      if (!WORKFLOW_FILE.test(workflowFile))
        throw new GitHubReadError("not a workflow file name");
      if (!FULL_SHA.test(sha)) {
        throw new GitHubReadError("a commit must be a full 40-character sha");
      }
      const body = await read(
        repo,
        `/repos/${repo}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&per_page=${MAX_RUNS}`,
        "workflow runs",
      );
      return list(body, "workflow run", "workflow_runs").flatMap(toRun);
    },
    async listWorkflowJobs(repo, runId) {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      if (!isId(runId)) throw new GitHubReadError("not a workflow run id");
      const body = await read(
        repo,
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=${MAX_JOBS}`,
        "workflow jobs",
      );
      return list(body, "workflow job", "jobs").flatMap(toJob);
    },
  };
}
