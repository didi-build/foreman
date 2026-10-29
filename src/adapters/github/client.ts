// The real GitHub client. The runner's GitHub App is registered at M3 (D-178), so until then every
// read refuses; only signature checking, which needs no network, works. Never used in tests.
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
  };
}
