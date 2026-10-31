-- 0011: staging verification (build plan M3.4, O-34 to O-36). Two evidence kinds the runner writes
-- and keys for its staging facts. Never edit an earlier migration; add a new one instead. No new
-- table, role, grant or policy: only the runner writes these kinds, and factory_ingest still
-- inserts `ci_run` and `merge_commit` only (0002).

-- `staging_deploy`: GitHub reports a successful deployment of the merge commit to the `staging`
-- environment, read by the runner itself. `staging_no_result`: a staging check that ended without
-- a result for the merge commit. The kind list replaces the one from 0010 with both added.
alter table factory.evidence drop constraint evidence_kind_check;
alter table factory.evidence add constraint evidence_kind_check check (kind in (
  'ci_run', 'test_report', 'preview_check', 'staging_check', 'staging_deploy', 'staging_no_result',
  'qa_verdict', 'visual_comparison', 'merge_check', 'merge_commit', 'spec_paths', 'dispatch_record',
  'docs_note', 'screenshot', 'agent_report'));

-- Both name the merge commit they are about, like `staging_check` (0001).
alter table factory.evidence add constraint evidence_staging_commit
  check (kind not in ('staging_deploy', 'staging_no_result') or commit_sha is not null);

-- The runner records each staging fact once under a key: a deploy per GitHub deployment, a check
-- result per merge commit, a check without a result per attempt. The list replaces 0002's.
alter table factory.evidence drop constraint evidence_ingest_key_kinds;
alter table factory.evidence add constraint evidence_ingest_key_kinds
  check (ingest_key is null or kind in (
    'ci_run', 'merge_commit', 'staging_deploy', 'staging_check', 'staging_no_result'));
