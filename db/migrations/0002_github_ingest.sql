-- 0002: GitHub evidence ingestion (ADR 0113, D-180). A table of webhook deliveries, an ingest key
-- on evidence, and the receiver's narrow role. Never edit 0001; add a migration instead.

-- The receiver's group role (ADR 0113 section 1). Its login user is created at deploy time with
-- a credential from the vault, never here. Tolerates a concurrent creation, like 0001.
do $$
begin
  if not exists (select from pg_roles where rolname = 'factory_ingest') then
    create role factory_ingest nologin;
  end if;
exception when duplicate_object or unique_violation then null;
end
$$;
grant usage on schema factory to factory_ingest;

-- Deliveries (append-only). Payloads are never stored: they are large and can name people.
create table factory.github_deliveries (
  delivery_id text primary key check (length(delivery_id) between 1 and 100),
  event_type text not null check (length(event_type) between 1 and 100),
  repository text check (length(repository) between 1 and 200),
  received_at timestamptz not null,
  outcome text not null check (outcome in ('recorded', 'ignored', 'rejected')),
  reason text check (length(reason) <= 200)
);
create trigger append_only_row before update or delete on factory.github_deliveries
  for each row execute function factory.forbid_change();
create trigger append_only_truncate before truncate on factory.github_deliveries
  for each statement execute function factory.forbid_change();

-- The same fact from a webhook and from the polling backstop gets the same key, so it is
-- recorded once. Only the kinds ingestion writes carry a key, so no other writer can take a
-- key first and block a real result.
alter table factory.evidence add column ingest_key text unique
  check (length(ingest_key) between 1 and 300);
alter table factory.evidence add constraint evidence_ingest_key_kinds
  check (ingest_key is null or kind in ('ci_run', 'merge_commit'));

-- Row level security, as on every factory table.
alter table factory.github_deliveries enable row level security;
create policy runner_all on factory.github_deliveries for all to factory_runner
  using (true) with check (true);
create policy ingest_insert on factory.github_deliveries for insert to factory_ingest
  with check (true);
-- "on conflict do nothing" checks the existing row against a select policy; the column grant
-- below limits what that can show to the delivery id.
create policy ingest_known_ids on factory.github_deliveries for select to factory_ingest
  using (true);

-- factory_ingest reads nodes, runs and evidence, writes deliveries and the ingested evidence
-- kinds under a key, and nothing else: it cannot move a node, write decisions, or write agent
-- evidence (ADR 0113 constraints).
create policy ingest_read on factory.nodes for select to factory_ingest using (true);
create policy ingest_read on factory.runs for select to factory_ingest using (true);
create policy ingest_read on factory.evidence for select to factory_ingest using (true);
create policy ingest_insert_github_kinds on factory.evidence for insert to factory_ingest
  with check (kind in ('ci_run', 'merge_commit') and ingest_key is not null and run_id is null);

-- Grants. No role gets UPDATE, DELETE or TRUNCATE here.
grant select, insert on factory.github_deliveries to factory_runner;
grant insert on factory.github_deliveries to factory_ingest;
-- An insert that skips a known delivery id (on conflict do nothing) must be able to see the ids;
-- nothing else in a delivery row is readable to the receiver.
grant select (delivery_id) on factory.github_deliveries to factory_ingest;
grant select on factory.nodes, factory.runs, factory.evidence to factory_ingest;
grant insert on factory.evidence to factory_ingest;
