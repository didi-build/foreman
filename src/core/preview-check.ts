// CI's preview check (D-354, O-111). Hosted branch previews are dropped. Instead one job of CI,
// on CI's own machine, builds the app, writes the commit marker into the build, serves it on
// 127.0.0.1 and checks that it loads and serves the head commit
// (`.github/scripts/preview-check.mjs`). GitHub ingestion records that job's conclusion as
// `preview_check` for the PR's head commit (./github-ingest.ts), the check
// `qa_verdict_independent_on_head` requires (ADR 0112).
//
// Only one job counts: the job named `PREVIEW_CHECK_JOB` of the workflow `PREVIEW_CHECK_WORKFLOW`,
// in the newest run of that workflow on the head commit that a `pull_request` event started from
// the PR's own repository. A job of another workflow or with another name, a fork's run, a run on
// another commit, two jobs with the name, or a job still running give no result, so nothing is
// recorded. The job passes only on `success`; every other conclusion is recorded as not passing.
import type { GitHubWorkflowReader } from "./github.ts";

/** The workflow file that holds the check. */
export const PREVIEW_CHECK_WORKFLOW = ".github/workflows/ci.yml";

/** The workflow's file name, as GitHub's workflow runs list takes it. */
export const PREVIEW_CHECK_WORKFLOW_FILE = "ci.yml";

/** The job's name (`name:` in the workflow), which is also its check run's name. */
export const PREVIEW_CHECK_JOB = "preview-check";

/**
 * The commit marker at the root of the built site: the commit, 40 lowercase hex characters, and a
 * newline. Fixed, because the staging deploy (D-353) writes the same marker.
 */
export const COMMIT_MARKER_FILE = "foreman-commit.txt";

/** The only event whose run counts for a PR head. */
const PULL_REQUEST_EVENT = "pull_request";

/** GitHub's conclusions are short lowercase words; anything else is not a result. */
const CONCLUSION = /^[a-z_]{1,40}$/;

/** The named job's result on a commit. */
export interface PreviewCheckResult {
  /** True only when the job's conclusion is `success`. */
  pass: boolean;
  conclusion: string;
  workflowRunId: number;
  jobId: number;
}

/**
 * The key a preview check is recorded under. The job id is new on every attempt, so a rerun is
 * recorded again and is the newest, and the webhook and the polling backstop build the same key.
 */
export const previewCheckKey = (
  repo: string,
  pr: number,
  sha: string,
  result: PreviewCheckResult,
): string =>
  `github:preview_check:${repo}#${pr}:${sha}:${result.conclusion}:job-${result.jobId}`;

/** The named job's result on `sha` in `repo`, or null when there is none to record yet. */
export async function readPreviewCheck(
  github: GitHubWorkflowReader,
  repo: string,
  sha: string,
): Promise<PreviewCheckResult | null> {
  const runs = (
    await github.listWorkflowRuns(repo, PREVIEW_CHECK_WORKFLOW_FILE, sha)
  ).filter(
    (run) =>
      run.path === PREVIEW_CHECK_WORKFLOW &&
      run.event === PULL_REQUEST_EVENT &&
      run.headSha === sha &&
      run.headRepo === repo,
  );
  const newest = runs.reduce<(typeof runs)[number] | null>(
    (best, run) => (best === null || run.id > best.id ? run : best),
    null,
  );
  if (newest === null) return null;
  const jobs = (await github.listWorkflowJobs(repo, newest.id)).filter(
    (job) =>
      job.name === PREVIEW_CHECK_JOB && job.runId === newest.id && job.headSha === sha,
  );
  if (jobs.length !== 1) return null;
  const job = jobs[0]!;
  const { conclusion } = job;
  if (job.status !== "completed" || conclusion === null || !CONCLUSION.test(conclusion))
    return null;
  return {
    pass: conclusion === "success",
    conclusion,
    workflowRunId: newest.id,
    jobId: job.id,
  };
}
