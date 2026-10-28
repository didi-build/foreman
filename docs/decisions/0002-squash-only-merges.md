# 0002. Squash-only merges on derived repositories

- **Status:** accepted
- **Date:** 2026-10-18

## Context

Launchpad recommends Dependabot auto-merge, which uses squash merges. Allowing merge commits and rebase merges on the same repository invites inconsistent history and PRs that bypass the intended merge path. The new-project checklist previously asked maintainers to set squash-only manually after Bootstrap.

## Decision

Bootstrap and `npm run repo-settings` configure derived repositories with **squash merges only**: `allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, alongside existing `allow_auto_merge` and `delete_branch_on_merge`.

## Reasons

- Matches Dependabot auto-merge (`--squash`) and keeps `main` linear.
- Removes a manual checklist step; settings apply through the same `PATCH /repos/{owner}/{repo}` flow as auto-merge.
- No new token permissions beyond what `repo-settings` already requires.

## Consequences

- Contributors can only merge PRs via squash on repos that ran Bootstrap or `repo-settings --apply`.
- Existing repos with other merge strategies need a one-time `repo-settings` apply or manual GitHub settings change.
