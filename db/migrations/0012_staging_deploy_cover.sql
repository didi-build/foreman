-- 0012: staging deploys that cover a merge commit, failed staging deploys, and the wait setting
-- (D-225, O-38 to O-40). Never edit an earlier migration; add a new one instead. No new table,
-- role, grant or policy: only the runner writes the new kind, and factory_ingest still inserts
-- `ci_run` and `merge_commit` only (0002).

-- `staging_deploy_failed`: GitHub reports a staging deployment of the merge commit, or of a later
-- commit that contains it, whose latest status is `failure` or `error`, read by the runner itself.
-- The kind list replaces the one from 0011 with it added.
alter table factory.evidence drop constraint evidence_kind_check;
alter table factory.evidence add constraint evidence_kind_check check (kind in (
  'ci_run', 'test_report', 'preview_check', 'staging_check', 'staging_deploy',
  'staging_deploy_failed', 'staging_no_result', 'qa_verdict', 'visual_comparison', 'merge_check',
  'merge_commit', 'spec_paths', 'dispatch_record', 'docs_note', 'screenshot', 'agent_report'));

-- It names the merge commit it covers, like the other staging kinds (0011). The list replaces 0011's.
alter table factory.evidence drop constraint evidence_staging_commit;
alter table factory.evidence add constraint evidence_staging_commit
  check (kind not in ('staging_deploy', 'staging_deploy_failed', 'staging_no_result')
    or commit_sha is not null);

-- The runner records each failed deploy once per deployment and merge commit under a key. The
-- list replaces 0011's.
alter table factory.evidence drop constraint evidence_ingest_key_kinds;
alter table factory.evidence add constraint evidence_ingest_key_kinds
  check (ingest_key is null or kind in (
    'ci_run', 'merge_commit', 'staging_deploy', 'staging_deploy_failed', 'staging_check',
    'staging_no_result'));

-- Minutes an item may wait in Verifying on staging with no staging deploy recorded before the
-- reconcile pass puts it on the attention list (D-225: one hour).
insert into factory.settings (key, value, updated_by, updated_at) values
  ('staging_deploy_attention_after_minutes', '60', 'migration', now());
