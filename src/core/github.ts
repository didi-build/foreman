// What ingestion reads from GitHub (ADR 0113 section 7). The core defines the interface; the
// adapter in src/adapters/github/ implements it, with a fake beside it for tests.

/**
 * `owner/name` as GitHub spells a repository: the only form a token, an API path or a link to
 * GitHub is built for (the runner App's reads, D-267; the CI run link on a visual approval, O-89).
 */
export const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** A pull request as GitHub reports it now. */
export interface PullRequest {
  /** The base repository, `owner/name`. */
  repo: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  /** The merge commit on the base branch, once merged. */
  mergeCommitSha: string | null;
  headSha: string;
  headBranch: string;
  /** The repository the head branch lives in. Differs from `repo` for a fork. */
  headRepo: string;
  /** The login of the account that opened the PR, for example `foreman-developer[bot]`. */
  author: string;
}

export interface CheckRun {
  /** GitHub's check run id. A rerun creates a new check run with a higher id. */
  id: number;
  name: string;
  /** The slug of the GitHub App that created the run, for example `github-actions`. */
  appSlug: string | null;
  status: "queued" | "in_progress" | "completed";
  /** GitHub's conclusion once completed, for example `success`, `failure`, `skipped`. */
  conclusion: string | null;
}

/** A GitHub Actions workflow run, as GitHub reports it now. */
export interface WorkflowRun {
  /** GitHub's run id. A rerun keeps the id and starts a new attempt. */
  id: number;
  /** The workflow file, for example `.github/workflows/ci.yml`. */
  path: string;
  /** The event that started the run, for example `pull_request` or `push`. */
  event: string;
  headSha: string;
  /** The repository the run's commit came from, `owner/name`. A fork's run names the fork. */
  headRepo: string | null;
}

/** A job of a workflow run, from the run's latest attempt. */
export interface WorkflowJob {
  /** GitHub's job id, new on every attempt. */
  id: number;
  runId: number;
  /** The job's name as the workflow gives it (`name:`), which is also its check run's name. */
  name: string;
  headSha: string;
  /** For example `queued`, `in_progress` or `completed`. */
  status: string;
  /** GitHub's conclusion once completed, for example `success`, `failure`, `cancelled`. */
  conclusion: string | null;
}

/**
 * What ingestion reads about CI's workflow runs, to find CI's preview check (D-354, O-111). Read
 * with the runner App's `actions: read` (D-267).
 */
export interface GitHubWorkflowReader {
  /**
   * The runs of one workflow file (`ci.yml`) on a commit, as GitHub lists them for that workflow
   * filtered by `head_sha`: one page, at most 20.
   */
  listWorkflowRuns(
    repo: string,
    workflowFile: string,
    sha: string,
  ): Promise<WorkflowRun[]>;
  /** The jobs of a run's latest attempt (GitHub's default `filter=latest`). */
  listWorkflowJobs(repo: string, runId: number): Promise<WorkflowJob[]>;
}

export interface GitHubReader extends GitHubWorkflowReader {
  getPullRequest(repo: string, number: number): Promise<PullRequest | null>;
  /** Files the PR changes, relative to the repo root. */
  listChangedPaths(repo: string, number: number): Promise<string[]>;
  /**
   * The latest check run of each name on a commit, from every check suite (GitHub's default
   * `filter=latest`), so a rerun replaces the run it reruns.
   */
  listCheckRuns(repo: string, sha: string): Promise<CheckRun[]>;
  listOpenPullRequests(repo: string): Promise<PullRequest[]>;
}

/**
 * Whether GitHub can merge a PR's head into its base without a conflict, as GitHub reports it
 * now. `mergeable` is null while GitHub is still working it out (GitHub computes it in the
 * background after a push to either branch). `headSha` is the head the answer is for.
 */
export interface Mergeability {
  headSha: string;
  mergeable: boolean | null;
}

/** Why GitHub refused a squash merge. Nothing was merged. */
export type MergeRefusal =
  /** The PR's head is no longer the commit the runner checked (GitHub's 409). */
  | "head_changed"
  /** GitHub cannot merge it now: a conflict, or a branch rule (GitHub's 405). */
  | "not_mergeable"
  /** The PR is closed or already merged. */
  | "not_open";

export type SquashMergeResult =
  { merged: true; mergeCommitSha: string } | { merged: false; reason: MergeRefusal };

/**
 * The runner's merge calls (build plan M3.3, D-102, D-127: the runner may read CI and merge PRs).
 * The adapter in src/adapters/github/ implements them, with a fake beside it for tests.
 */
export interface GitHubMerger {
  getMergeability(repo: string, number: number): Promise<Mergeability | null>;
  /**
   * Squash-merges the PR only if its head is still `expectedHeadSha` (GitHub's merge API takes
   * the head as `sha`), so a commit pushed after the runner's check is never merged.
   */
  squashMerge(
    repo: string,
    number: number,
    expectedHeadSha: string,
  ): Promise<SquashMergeResult>;
}

/**
 * How `head` relates to `base` in the history, as GitHub's compare (`base...head`) reports it:
 * `ahead` when `base` is an ancestor of `head`, `identical` when they are the same commit,
 * `behind` when `head` is an ancestor of `base`, `diverged` otherwise.
 */
export type CommitRelation = "ahead" | "identical" | "behind" | "diverged";

/** GitHub's compare lists at most this many files, so a list this long may have been cut. */
export const COMPARE_FILE_CAP = 300;

/**
 * The files that changed from `base` to `head`, as GitHub's compare (`base...head`) lists them, with
 * the relation of the two commits. A renamed file gives its new and its old path. `complete` is
 * false when GitHub listed `COMPARE_FILE_CAP` files, since the list may then have been cut.
 */
export interface ComparedPaths {
  relation: CommitRelation;
  paths: string[];
  complete: boolean;
}

/**
 * What the runner reads about commits (D-225): whether one commit contains another, and the
 * commit a branch points at now. The staging check and the staging deploy use it to tell which
 * merge commits a deployed or served commit counts for (O-38, O-116); GitHub's deployments are not
 * read (D-356).
 */
export interface GitHubCommitReader {
  compareCommits(repo: string, base: string, head: string): Promise<CommitRelation>;
  /**
   * The paths that changed from `base` to `head` (D-388): the merge reads it to tell whether a
   * newer head of a PR only brought the base branch in (./docs-carry.ts).
   */
  listComparedPaths(repo: string, base: string, head: string): Promise<ComparedPaths>;
  /** The commit `branch` points at now, or null when GitHub has no such branch. */
  getBranchHead(repo: string, branch: string): Promise<string | null>;
}

/** Everything the runner reads from and does on GitHub. */
export type GitHub = GitHubReader & GitHubMerger & GitHubCommitReader;
