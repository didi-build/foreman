-- 0030: the names of the product secrets set on each project's staging Worker (ADR 0118 appendix
-- D, D-440, O-163). Never edit an earlier migration; add a new one instead. A privileged change for
-- Didi's review: one new table, append-only, written and read by the runner only (the Set project
-- secret form runs as the runner). No new role. factory_api and factory_ingest get no access.
--
-- Never a value: the table has no column for one, and the form sends the value only to the
-- project's staging Worker on Cloudflare (D-440). No personal data: a project, a secret's name (the
-- form's rule, so uppercase letters, digits and underscores only), a time and a Windmill run's id.
--
-- One row each time the form puts a secret on a project's staging Worker. Setting the same name
-- again adds a row: Cloudflare replaces the value, and the record keeps when each set was made.
-- `windmill_run_id` is the form's Windmill run, when its id is a UUID, so Didi can open the run,
-- whose arguments hold only a reference to the short-lived variable its password field made.

create table factory.project_secret_names (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  -- The form's rule (src/core/deploy-target.ts): never DB or ASSETS, the bindings Foreman sets.
  name text not null check (
    name ~ '^[A-Z][A-Z0-9_]{0,63}$' and name not in ('DB', 'ASSETS')),
  set_at timestamptz not null,
  windmill_run_id uuid,
  recorded_by text not null
);
create index project_secret_names_project on factory.project_secret_names (project_id, set_at);

create trigger append_only_row before update or delete on factory.project_secret_names
  for each row execute function factory.forbid_change();
create trigger append_only_truncate before truncate on factory.project_secret_names
  for each statement execute function factory.forbid_change();

-- Row level security, as on every factory table.
alter table factory.project_secret_names enable row level security;
create policy runner_all on factory.project_secret_names for all to factory_runner
  using (true) with check (true);

-- Grants. No role gets UPDATE, DELETE or TRUNCATE here.
grant select, insert on factory.project_secret_names to factory_runner;
