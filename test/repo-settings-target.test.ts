import { describe, expect, it } from "vitest";
import {
  protectionMatches,
  repositorySettingsMatch,
  targetBranchProtection,
  targetRepositorySettings,
} from "../scripts/lib/repo-settings-target.mjs";

describe("repo-settings-target (unit)", () => {
  it("requires PR and check with zero approvals", () => {
    const target = targetBranchProtection();
    expect(target.required_pull_request_reviews).toEqual({
      required_approving_review_count: 0,
    });
    expect(target.required_status_checks.checks).toEqual([{ context: "check" }]);
  });

  it("matches GitHub branch protection API shape", () => {
    const expected = targetBranchProtection();
    expect(
      protectionMatches(
        {
          required_status_checks: {
            strict: false,
            checks: [{ context: "check" }],
          },
          enforce_admins: { enabled: false },
          required_pull_request_reviews: {
            required_approving_review_count: 0,
          },
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false },
        },
        expected,
      ),
    ).toBe(true);
  });

  it("matches repository merge settings", () => {
    const expected = targetRepositorySettings();
    expect(
      repositorySettingsMatch(
        {
          allow_auto_merge: true,
          delete_branch_on_merge: true,
          allow_squash_merge: true,
          allow_merge_commit: false,
          allow_rebase_merge: false,
        },
        expected,
      ),
    ).toBe(true);
  });

  it("requires squash-only merge settings", () => {
    const expected = targetRepositorySettings();
    expect(expected.allow_squash_merge).toBe(true);
    expect(expected.allow_merge_commit).toBe(false);
    expect(expected.allow_rebase_merge).toBe(false);
  });
});
