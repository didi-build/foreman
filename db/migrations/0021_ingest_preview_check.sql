-- 0021: GitHub ingestion records CI's preview check (D-354, O-111). Never edit an earlier
-- migration; add a new one instead. A privileged change for Didi's review: one evidence kind more
-- for the receiver's role, under a key, and nothing else.
--
-- Why. Hosted branch previews are dropped. CI checks on its own machine that the app it built
-- loads and serves the head commit, in one named job, and ingestion records that job's conclusion
-- as `preview_check` for the PR's head commit (src/core/preview-check.ts), as it records `ci_run`:
-- from the webhook and from the polling backstop, under one key per job attempt, so a fact is
-- recorded once and a rerun again. Until now no writer recorded `preview_check` at all, and a key
-- on it was refused (0013).
--
-- The kind list for keys replaces 0013's with `preview_check` added. The receiver's insert policy
-- replaces 0002's with `preview_check` added; it still needs a key and no run, and the role still
-- cannot write any other kind, update or delete anything.
alter table factory.evidence drop constraint evidence_ingest_key_kinds;
alter table factory.evidence add constraint evidence_ingest_key_kinds
  check (ingest_key is null or kind in (
    'ci_run', 'merge_commit', 'preview_check', 'staging_deploy', 'staging_deploy_failed',
    'staging_check', 'staging_no_result', 'failure_count'));

drop policy ingest_insert_github_kinds on factory.evidence;
create policy ingest_insert_github_kinds on factory.evidence for insert to factory_ingest
  with check (
    kind in ('ci_run', 'merge_commit', 'preview_check')
    and ingest_key is not null
    and run_id is null);
