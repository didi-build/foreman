// The real GitHub client. The runner's GitHub App is registered at M3 (D-178), so until then every
// read and the merge calls refuse; only signature checking, which needs no network, works. Never
// used in tests. The real merge is GitHub's `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with
// `merge_method: "squash"` and `sha` set to the expected head: 200 is merged (its `sha` is the
// merge commit), 409 is `head_changed`, 405 is `not_mergeable`. It is written and checked against
// GitHub when the runner App exists, not guessed at here.
import type { GitHubAdapter } from "./adapter.ts";
import { verifyWebhookSignature } from "./signature.ts";

export class GitHubNotConfiguredError extends Error {
  constructor() {
    super("The GitHub client is not configured until M3 (D-178)");
    this.name = "GitHubNotConfiguredError";
  }
}

export function createGitHubClient(options: { webhookSecret: string }): GitHubAdapter {
  const refuse = async (): Promise<never> => {
    throw new GitHubNotConfiguredError();
  };
  return {
    verifyWebhookSignature: (rawBody, header) =>
      verifyWebhookSignature(options.webhookSecret, rawBody, header),
    getPullRequest: refuse,
    listChangedPaths: refuse,
    listCheckRuns: refuse,
    listOpenPullRequests: refuse,
    getMergeability: refuse,
    squashMerge: refuse,
  };
}
