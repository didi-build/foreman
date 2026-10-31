import { describe, expect, it } from "vitest";

import { createGitHubClient, GitHubNotConfiguredError } from "./client.ts";
import { signWebhook } from "./signature.ts";

describe("real GitHub client before M3 (unit: D-178)", () => {
  const client = createGitHubClient({ webhookSecret: "test-only-webhook-secret" });

  it("refuses every read and every merge until the runner App exists", async () => {
    await expect(client.getPullRequest("didi-build/rehearsal", 1)).rejects.toThrow(
      GitHubNotConfiguredError,
    );
    await expect(client.listOpenPullRequests("didi-build/rehearsal")).rejects.toThrow(
      /not configured until M3/,
    );
    await expect(client.getMergeability("didi-build/rehearsal", 1)).rejects.toThrow(
      GitHubNotConfiguredError,
    );
    await expect(
      client.squashMerge("didi-build/rehearsal", 1, "b".repeat(40)),
    ).rejects.toThrow(GitHubNotConfiguredError);
    await expect(
      client.listDeployments("didi-build/rehearsal", "staging", "b".repeat(40)),
    ).rejects.toThrow(GitHubNotConfiguredError);
    await expect(
      client.listRecentDeployments("didi-build/rehearsal", "staging", 20),
    ).rejects.toThrow(GitHubNotConfiguredError);
    await expect(
      client.compareCommits("didi-build/rehearsal", "b".repeat(40), "c".repeat(40)),
    ).rejects.toThrow(GitHubNotConfiguredError);
    await expect(client.getBranchHead("didi-build/rehearsal", "main")).rejects.toThrow(
      GitHubNotConfiguredError,
    );
  });

  it("still checks signatures, which need no network", () => {
    const body = Buffer.from("{}");
    expect(
      client.verifyWebhookSignature(
        body,
        signWebhook("test-only-webhook-secret", body),
      ),
    ).toBe(true);
    expect(client.verifyWebhookSignature(body, undefined)).toBe(false);
  });
});
