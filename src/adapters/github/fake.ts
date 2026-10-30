// A fake GitHub for every test (ADR 0113 section 7, D-178): pull requests, check runs and changed
// files held in memory, plus builders for webhook payloads in GitHub's shape (only the fields
// ingestion reads). Signatures use the real HMAC check, so tests sign deliveries for real.
import type { CheckRun, PullRequest } from "../../core/github.ts";
import type { GitHubAdapter } from "./adapter.ts";
import { signWebhook, verifyWebhookSignature } from "./signature.ts";

export interface FakeGitHub extends GitHubAdapter {
  /** Adds or replaces a pull request. */
  putPullRequest(pr: PullRequest): void;
  /** Moves a PR's head to a new commit, as a push to its branch does. */
  pushHead(repo: string, number: number, sha: string): void;
  merge(repo: string, number: number, mergeCommitSha: string): void;
  setCheckRuns(repo: string, sha: string, runs: CheckRun[]): void;
  setChangedPaths(repo: string, number: number, paths: string[]): void;
  /** Signs a body with the fake's webhook secret, as GitHub would. */
  sign(body: string): string;
  /** How many read calls were made, for tests that expect none. */
  readonly reads: number;
}

const prKey = (repo: string, number: number): string => `${repo}#${number}`;

export function createFakeGitHub(options: { webhookSecret: string }): FakeGitHub {
  const pulls = new Map<string, PullRequest>();
  const checks = new Map<string, CheckRun[]>();
  const paths = new Map<string, string[]>();
  let reads = 0;

  const pull = (repo: string, number: number): PullRequest => {
    const pr = pulls.get(prKey(repo, number));
    if (!pr) throw new Error(`fake GitHub has no pull request ${prKey(repo, number)}`);
    return pr;
  };

  return {
    verifyWebhookSignature: (rawBody, header) =>
      verifyWebhookSignature(options.webhookSecret, rawBody, header),
    sign: (body) => signWebhook(options.webhookSecret, body),
    get reads() {
      return reads;
    },

    async getPullRequest(repo, number) {
      reads++;
      const pr = pulls.get(prKey(repo, number));
      return pr ? structuredClone(pr) : null;
    },
    async listChangedPaths(repo, number) {
      reads++;
      return [...(paths.get(prKey(repo, number)) ?? [])];
    },
    async listCheckRuns(repo, sha) {
      reads++;
      return structuredClone(checks.get(`${repo}@${sha}`) ?? []);
    },
    async listOpenPullRequests(repo) {
      reads++;
      return [...pulls.values()]
        .filter((pr) => pr.repo === repo && pr.state === "open")
        .map((pr) => structuredClone(pr));
    },

    putPullRequest(pr) {
      pulls.set(prKey(pr.repo, pr.number), structuredClone(pr));
    },
    pushHead(repo, number, sha) {
      pull(repo, number).headSha = sha;
    },
    merge(repo, number, mergeCommitSha) {
      Object.assign(pull(repo, number), {
        state: "closed",
        merged: true,
        mergeCommitSha,
      });
    },
    setCheckRuns(repo, sha, runs) {
      checks.set(`${repo}@${sha}`, structuredClone(runs));
    },
    setChangedPaths(repo, number, list) {
      paths.set(prKey(repo, number), [...list]);
    },
  };
}

// Webhook payloads, trimmed to the fields ingestion reads plus a few it must ignore.

export function pullRequestEvent(
  action: "opened" | "reopened" | "synchronize" | "closed" | "edited",
  pr: PullRequest,
): Record<string, unknown> {
  return {
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      merge_commit_sha: pr.mergeCommitSha,
      user: { login: pr.author },
      head: { sha: pr.headSha, ref: pr.headBranch, repo: { full_name: pr.headRepo } },
      base: { ref: "main", repo: { full_name: pr.repo } },
      body: "Text from the PR body is never read.",
    },
    repository: { full_name: pr.repo },
  };
}

export function checkCompletedEvent(
  event: "check_suite" | "workflow_run",
  repo: string,
  sha: string,
  prNumbers: number[],
): Record<string, unknown> {
  return {
    action: "completed",
    [event]: {
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      pull_requests: prNumbers.map((number) => ({ number })),
    },
    repository: { full_name: repo },
  };
}
