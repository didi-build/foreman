// What ingestion reads from GitHub (ADR 0113 section 7). The core defines the interface; the
// adapter in src/adapters/github/ implements it, with a fake beside it for tests.

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

export interface GitHubReader {
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

/** GitHub's state for a deployment: its latest deployment status, or `pending` with none yet. */
export type DeploymentState =
  "success" | "failure" | "error" | "inactive" | "in_progress" | "queued" | "pending";

/** A GitHub deployment of one commit to one environment, as GitHub reports it now. */
export interface Deployment {
  id: number;
  /** The commit deployed. */
  sha: string;
  environment: string;
  state: DeploymentState;
}

/**
 * What the runner reads about staging deploys (build plan M3.4). A project's deploy on push to
 * main reports to GitHub as a deployment to the `staging` environment (O-34).
 */
export interface GitHubDeploymentReader {
  /** The deployments of `sha` to `environment`, newest first. */
  listDeployments(
    repo: string,
    environment: string,
    sha: string,
  ): Promise<Deployment[]>;
  /**
   * The latest `limit` deployments to `environment`, of any commit, newest first (GitHub's
   * deployments list filtered by environment, one page). D-225, O-38.
   */
  listRecentDeployments(
    repo: string,
    environment: string,
    limit: number,
  ): Promise<Deployment[]>;
}

/**
 * How `head` relates to `base` in the history, as GitHub's compare (`base...head`) reports it:
 * `ahead` when `base` is an ancestor of `head`, `identical` when they are the same commit,
 * `behind` when `head` is an ancestor of `base`, `diverged` otherwise.
 */
export type CommitRelation = "ahead" | "identical" | "behind" | "diverged";

/**
 * What the runner reads about commits (D-225): whether one commit contains another, and the
 * commit a branch points at now.
 */
export interface GitHubCommitReader {
  compareCommits(repo: string, base: string, head: string): Promise<CommitRelation>;
  /** The commit `branch` points at now, or null when GitHub has no such branch. */
  getBranchHead(repo: string, branch: string): Promise<string | null>;
}

/** Everything the runner reads from and does on GitHub. */
export type GitHub = GitHubReader &
  GitHubMerger &
  GitHubDeploymentReader &
  GitHubCommitReader;
