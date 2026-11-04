-- 0017: the record of each run of the Scanner's stage 1 (D-299, D-300, O-92). Never edit an
-- earlier migration; add a new one instead. One new table, append-only, written and read by the
-- runner only. No new role. factory_api and factory_ingest get no access: the daily check, which
-- reads it, runs as the runner.

-- One row per scan of one project's repository: when it ran, the commit, and what the daily check
-- shows. A scan is not about one node, so it is not evidence (evidence always names its node).
-- `summary` holds counts, the new ideas' ids and titles, and for a failed scan the fixed name of
-- the step that failed; never a token, a database id other than a node id, or personal data.
create table factory.scans (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  outcome text not null check (outcome in ('scanned', 'failed')),
  summary jsonb not null,
  recorded_by text not null,
  recorded_at timestamptz not null,
  -- A scan that ran names the commit it read.
  check (outcome <> 'scanned' or commit_sha is not null)
);
create index scans_project_recorded on factory.scans (project_id, recorded_at desc, id desc);

create trigger append_only_row before update or delete on factory.scans
  for each row execute function factory.forbid_change();
create trigger append_only_truncate before truncate on factory.scans
  for each statement execute function factory.forbid_change();

-- Row level security, as on every factory table.
alter table factory.scans enable row level security;
create policy runner_all on factory.scans for all to factory_runner
  using (true) with check (true);

-- Grants. No role gets UPDATE, DELETE or TRUNCATE here.
grant select, insert on factory.scans to factory_runner;
