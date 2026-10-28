/** @typedef {{ strict: boolean; checks: { context: string }[] }} RequiredStatusChecks */
/** @typedef {{ required_status_checks: RequiredStatusChecks; enforce_admins: boolean; required_pull_request_reviews: { required_approving_review_count: number }; restrictions: null; allow_force_pushes: boolean; allow_deletions: boolean }} BranchProtection */

export const defaultBranch = "main";

/** @returns {BranchProtection} */
export function targetBranchProtection() {
  return {
    required_status_checks: {
      strict: false,
      checks: [{ context: "check" }],
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

/** @returns {{ allow_auto_merge: boolean; delete_branch_on_merge: boolean; allow_squash_merge: boolean; allow_merge_commit: boolean; allow_rebase_merge: boolean }} */
export function targetRepositorySettings() {
  return {
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  };
}

/** @param {boolean} expected */
function flagMatches(actual, expected) {
  if (typeof actual === "boolean") return actual === expected;
  if (actual && typeof actual === "object" && "enabled" in actual) {
    return actual.enabled === expected;
  }
  return false;
}

export function protectionMatches(actual, expected) {
  if (!actual) return false;
  const checks = actual.required_status_checks?.checks ?? [];
  const contexts = checks.map((c) => c.context).sort();
  const expectedContexts = expected.required_status_checks.checks
    .map((c) => c.context)
    .sort();
  const reviewsOk =
    actual.required_pull_request_reviews?.required_approving_review_count ===
    expected.required_pull_request_reviews.required_approving_review_count;
  return (
    actual.required_status_checks?.strict === expected.required_status_checks.strict &&
    JSON.stringify(contexts) === JSON.stringify(expectedContexts) &&
    reviewsOk &&
    flagMatches(actual.enforce_admins, expected.enforce_admins) &&
    flagMatches(actual.allow_force_pushes, expected.allow_force_pushes) &&
    flagMatches(actual.allow_deletions, expected.allow_deletions)
  );
}

export function repositorySettingsMatch(actual, expected) {
  return (
    actual.allow_auto_merge === expected.allow_auto_merge &&
    actual.delete_branch_on_merge === expected.delete_branch_on_merge &&
    actual.allow_squash_merge === expected.allow_squash_merge &&
    actual.allow_merge_commit === expected.allow_merge_commit &&
    actual.allow_rebase_merge === expected.allow_rebase_merge
  );
}
