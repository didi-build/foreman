// The receiver's GitHub client: signature checking only, which needs no network. The receiver
// holds no App key and no GitHub token (ADR 0106, ADR 0112), so every read and the merge calls
// refuse, and since D-381 the receiver calls none of them: a delivery that needs GitHub is handed
// to the ingest flow, which reads with the runner's own client over the runner App's narrow tokens
// (./runner-github.ts, O-127, O-128). Never used in tests.
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
    // CI's preview check (D-354, O-111): read with the runner App's `actions: read` token, which
    // only the runner can mint (no App key is on the cluster, ADR 0106), so it refuses here too.
    listWorkflowRuns: refuse,
    listWorkflowJobs: refuse,
    getMergeability: refuse,
    squashMerge: refuse,
    compareCommits: refuse,
    getBranchHead: refuse,
  };
}
