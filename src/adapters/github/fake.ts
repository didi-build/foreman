// A fake GitHub for every test (ADR 0113 section 7, D-178): pull requests, check runs, changed
// files and mergeability held in memory, a squash merge that behaves like GitHub's (it refuses a
// head that moved, a PR GitHub cannot merge and a PR that is not open), plus builders for webhook
// payloads in GitHub's shape (only the fields ingestion reads). Signatures use the real HMAC
// check, so tests sign deliveries for real.
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
  /** What GitHub reports as the PR's mergeable state. A PR starts as `true` (no conflict). */
  setMergeable(repo: string, number: number, mergeable: boolean | null): void;
  /** Squash merges the fake performed, in order. A refused merge is not listed. */
  readonly merges: readonly { repo: string; number: number; headSha: string }[];
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
  const mergeable = new Map<string, boolean | null>();
  const merges: { repo: string; number: number; headSha: string }[] = [];
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
    get merges() {
      return merges.map((m) => ({ ...m }));
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

    async getMergeability(repo, number) {
      reads++;
      const pr = pulls.get(prKey(repo, number));
      if (!pr) return null;
      const key = prKey(repo, number);
      return {
        headSha: pr.headSha,
        mergeable: mergeable.has(key) ? (mergeable.get(key) ?? null) : true,
      };
    },
    async squashMerge(repo, number, expectedHeadSha) {
      const pr = pull(repo, number);
      const key = prKey(repo, number);
      if (pr.state !== "open" || pr.merged)
        return { merged: false, reason: "not_open" };
      if (pr.headSha !== expectedHeadSha)
        return { merged: false, reason: "head_changed" };
      if (mergeable.has(key) && mergeable.get(key) === false) {
        return { merged: false, reason: "not_mergeable" };
      }
      merges.push({ repo, number, headSha: expectedHeadSha });
      // A merge commit sha of the fake's own: 40 hex digits, one per merge.
      const mergeCommitSha = merges.length.toString(16).padStart(40, "d");
      Object.assign(pr, { state: "closed", merged: true, mergeCommitSha });
      return { merged: true, mergeCommitSha };
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
    setMergeable(repo, number, value) {
      mergeable.set(prKey(repo, number), value);
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
