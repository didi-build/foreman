-- 0003: run dispatch and run ends (ADR 0106 sections 6 and 7, build plan M3.2). Never edit 0001
-- or 0002; add a migration instead. No new table, role or grant: the runner already reads and
-- updates runs, and row level security on runs is unchanged.

-- The pull request a QA run reviews. The dispatch rule is one active QA run per project, pull
-- request and head commit (ADR 0112), and head_sha alone cannot tell two pull requests apart.
alter table factory.runs add column pr_number integer check (pr_number > 0);

-- Why a run ended usage_exhausted (ADR 0106 section 6). out_of_credit is kept apart because only
-- money fixes it, so a later milestone alerts Didi on it.
alter table factory.runs add column usage_exhausted_cause text
  check (usage_exhausted_cause in ('rate_limit', 'capacity', 'out_of_credit'));

-- The provider's retry-after, in seconds, when it sent one. The runner waits for it if it is
-- longer than the usage_exhausted_wait_minutes setting.
alter table factory.runs add column retry_after_seconds integer check (retry_after_seconds >= 0);

-- A usage_exhausted end always names its cause, and no other run carries a cause or a retry-after.
-- "is not distinct from" keeps a run with no outcome yet from passing as unknown.
alter table factory.runs add constraint runs_usage_exhausted_detail check (
  (outcome is not distinct from 'usage_exhausted') = (usage_exhausted_cause is not null)
  and (retry_after_seconds is null or outcome is not distinct from 'usage_exhausted'));

-- Dispatch admission reads every active run (no ended_at) inside its transaction.
create index runs_active on factory.runs (started_at) where ended_at is null;

-- The wait before a usage_exhausted dispatch is tried again (ADR 0106 section 6). The cluster's
-- agent_cluster_max_active_runs is not seeded: it is sized to the node pool at first hosting, and
-- until it is set every dispatch is refused.
insert into factory.settings (key, value, updated_by, updated_at) values
  ('usage_exhausted_wait_minutes', '30', 'migration', now());
