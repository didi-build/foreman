// The runner's read of the add-only apply jobs (src/core/add-only-applies.ts, D-378, D-444,
// O-158) on GitHub's REST API (read 2026-11-20), with the runner App's read-only `actions` token
// for `didi-build/foreman` only (D-267), the token Bootstrap's runs are read with (O-114). No new
// permission, token scope or record: GitHub keeps the runs.
//
// - "List workflow runs for a workflow",
//   `GET /repos/didi-build/foreman/actions/workflows/<file>/runs?branch=main&per_page=100`, newest
//   first, for `platform.yml` and `infra-apply.yml`. A run that completed before the window's
//   start cannot hold a job that ended in the window, since a run completes after its last job, so
//   only the runs still going or updated at or after it are read further. When all 100 of a page
//   are, there may be more than it reads, and the read throws.
// - "List jobs for a workflow run attempt", every attempt,
//   `GET /repos/didi-build/foreman/actions/runs/<id>/jobs?filter=all&per_page=100`, for each such
//   run. Only the add-only apply jobs are kept, by their name.
//
// A failed call, an answer of another shape, or a time GitHub gives that is not one, throws; the
// daily check then says the applies could not be read. The runner mints the token with its App's
// key (flows/lib/compose.ts, O-125). Tests pass fakes. Nothing here logs, and no token is kept.
import {
  ADD_ONLY_REPOSITORY,
  ADD_ONLY_WORKFLOWS,
  isAddOnlyJobName,
  type AddOnlyApplies,
  type AddOnlyApplyJob,
  type AddOnlyWorkflow,
} from "../../core/add-only-applies.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

/** The runs and the jobs one page holds, GitHub's most. */
const PAGE_SIZE = 100;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export interface GitHubAddOnlyAppliesOptions {
  /** The runner App's read-only tokens (D-267): `actions: read` for one repository. */
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function json(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** A time GitHub gives, or null when it gives none. Throws on anything else. */
function timeOf(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const at = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) throw new GitHubReadError("a time is not one");
  return at;
}

const isRunId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The runs of one page that may hold a job that ended at or after `since`, or still runs. */
export function runsToRead(
  body: unknown,
  since: Date,
): { id: number; runNumber: number }[] {
  if (!isObject(body) || !Array.isArray(body.workflow_runs)) {
    throw new GitHubReadError("the run list is not one");
  }
  const runs = body.workflow_runs as unknown[];
  const kept = runs.flatMap((run) => {
    if (
      !isObject(run) ||
      !isRunId(run.id) ||
      !isRunId(run.run_number) ||
      typeof run.status !== "string"
    ) {
      throw new GitHubReadError("a run is not one");
    }
    const updated = timeOf(run.updated_at);
    if (updated === null) throw new GitHubReadError("a run has no update time");
    const going = run.status !== "completed";
    return going || updated.getTime() >= since.getTime()
      ? [{ id: run.id, runNumber: run.run_number }]
      : [];
  });
  if (runs.length >= PAGE_SIZE && kept.length === runs.length) {
    throw new GitHubReadError("there are more recent runs than the check reads");
  }
  return kept;
}

/** The add-only apply jobs of one run's jobs answer. */
export function addOnlyJobsOf(
  body: unknown,
  workflow: AddOnlyWorkflow,
  runNumber: number,
): AddOnlyApplyJob[] {
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
  return (body.jobs as unknown[]).flatMap((job) => {
    if (
      !isObject(job) ||
      typeof job.name !== "string" ||
      typeof job.status !== "string" ||
      !(typeof job.conclusion === "string" || job.conclusion === null)
    ) {
      throw new GitHubReadError("a job is not one");
    }
    if (!isAddOnlyJobName(workflow, job.name)) return [];
    return [
      {
        workflow,
        runNumber,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: timeOf(job.started_at) ?? timeOf(job.created_at),
        completedAt: timeOf(job.completed_at),
      },
    ];
  });
}

export function createGitHubAddOnlyApplies({
  tokens,
  http,
}: GitHubAddOnlyAppliesOptions): AddOnlyApplies {
  async function get(path: string, token: string, what: string): Promise<unknown> {
    const answer = await http.get({
      path,
      token,
      accept: "json",
      maxBytes: MAX_ANSWER_BYTES,
    });
    if (answer.status !== 200) {
      throw new GitHubReadError(`reading ${what} failed with ${answer.status}`);
    }
    return json(answer.body);
  }

  return {
    async jobsSince(since) {
      const token = await tokens.mint({
        repository: ADD_ONLY_REPOSITORY,
        permission: "actions",
      });
      const jobs: AddOnlyApplyJob[] = [];
      for (const workflow of Object.keys(ADD_ONLY_WORKFLOWS) as AddOnlyWorkflow[]) {
        const runs = runsToRead(
          await get(
            `/repos/${ADD_ONLY_REPOSITORY}/actions/workflows/${ADD_ONLY_WORKFLOWS[workflow].file}/runs?branch=main&per_page=${PAGE_SIZE}`,
            token,
            "the workflow's runs",
          ),
          since,
        );
        for (const run of runs) {
          jobs.push(
            ...addOnlyJobsOf(
              await get(
                `/repos/${ADD_ONLY_REPOSITORY}/actions/runs/${run.id}/jobs?filter=all&per_page=${PAGE_SIZE}`,
                token,
                "a run's jobs",
              ),
              workflow,
              run.runNumber,
            ),
          );
        }
      }
      return jobs;
    },
  };
}
