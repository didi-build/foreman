-- 0018: the runner's records of how a scanner idea changes over time (D-301, O-93). Never edit an
-- earlier migration; add a new one instead. No new table, role, grant or policy, and no new
-- ingest key: only the runner writes the two new kinds, under the project lock the scan's filing
-- holds, and factory_api and factory_ingest still insert only their own kinds (0001, 0002).

-- `scan_scope_update`: a new finding with the same check in the same file as an open scanner
-- idea, folded into that idea (its check, path, line, target and dedupe key, on the scan's
-- commit). `scan_not_found`: a scan at a commit found none of the idea's findings, once per
-- commit. Both hold repository paths and fixed text only. The kind list replaces the one from 0013
-- with them added.
alter table factory.evidence drop constraint evidence_kind_check;
alter table factory.evidence add constraint evidence_kind_check check (kind in (
  'ci_run', 'test_report', 'preview_check', 'staging_check', 'staging_deploy',
  'staging_deploy_failed', 'staging_no_result', 'qa_verdict', 'visual_comparison', 'merge_check',
  'merge_commit', 'spec_paths', 'dispatch_record', 'docs_note', 'screenshot', 'agent_report',
  'failure_count', 'scan_scope_update', 'scan_not_found'));

-- Each names the commit it is about.
alter table factory.evidence add constraint evidence_scan_commit
  check (kind not in ('scan_scope_update', 'scan_not_found') or commit_sha is not null);
