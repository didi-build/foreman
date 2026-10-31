-- 0010: the `merge_check` evidence kind for the runner's merge (build plan M3.3, D-218, O-32).
-- Never edit an earlier migration; add a new one instead. No new table, role or grant.

-- GitHub's mergeable state for a PR's head commit, which the runner reads and records itself
-- right before it merges. `no_merge_conflict_on_head` reads it. The kind list replaces the one
-- from 0001 with `merge_check` added.
alter table factory.evidence drop constraint evidence_kind_check;
alter table factory.evidence add constraint evidence_kind_check check (kind in (
  'ci_run', 'test_report', 'preview_check', 'staging_check', 'qa_verdict', 'visual_comparison',
  'merge_check', 'merge_commit', 'spec_paths', 'dispatch_record', 'docs_note', 'screenshot',
  'agent_report'));

-- It is evidence a head-commit guard reads, so it names its commit, like 0001's head-commit kinds.
alter table factory.evidence add constraint evidence_merge_check_commit
  check (kind <> 'merge_check' or commit_sha is not null);
