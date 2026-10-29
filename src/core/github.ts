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
  name: string;
  status: "queued" | "in_progress" | "completed";
  /** GitHub's conclusion once completed, for example `success`, `failure`, `skipped`. */
  conclusion: string | null;
}

export interface GitHubReader {
  getPullRequest(repo: string, number: number): Promise<PullRequest | null>;
  /** Files the PR changes, relative to the repo root. */
  listChangedPaths(repo: string, number: number): Promise<string[]>;
  /** Every check run on a commit, from every check suite. */
  listCheckRuns(repo: string, sha: string): Promise<CheckRun[]>;
  listOpenPullRequests(repo: string): Promise<PullRequest[]>;
}
