-- 0013: the runner's record of a P-03 failure count that has no move of its own (build plan M3.5,
-- D-169, O-43, O-44). Never edit an earlier migration; add a new one instead. No new table, role,
-- grant or policy: only the runner writes the new kind, and factory_api and factory_ingest still
-- insert only their own kinds (0001, 0002).

-- `failure_count`: a done report the runner refused on its guards, or a repeated failed start,
-- that added one to the node's `failure` counter. It is written in the counter's transaction, so
-- the row and the count commit together. The kind list replaces the one from 0012 with it added.
alter table factory.evidence drop constraint evidence_kind_check;
alter table factory.evidence add constraint evidence_kind_check check (kind in (
  'ci_run', 'test_report', 'preview_check', 'staging_check', 'staging_deploy',
  'staging_deploy_failed', 'staging_no_result', 'qa_verdict', 'visual_comparison', 'merge_check',
  'merge_commit', 'spec_paths', 'dispatch_record', 'docs_note', 'screenshot', 'agent_report',
  'failure_count'));

-- Each count is recorded once under a key that names its cause and run, so a repeated report or a
-- retried flow counts once. The list replaces 0012's.
alter table factory.evidence drop constraint evidence_ingest_key_kinds;
alter table factory.evidence add constraint evidence_ingest_key_kinds
  check (ingest_key is null or kind in (
    'ci_run', 'merge_commit', 'staging_deploy', 'staging_deploy_failed', 'staging_check',
    'staging_no_result', 'failure_count'));

-- A count names the run it is about.
alter table factory.evidence add constraint evidence_failure_count_run
  check (kind <> 'failure_count' or run_id is not null);
