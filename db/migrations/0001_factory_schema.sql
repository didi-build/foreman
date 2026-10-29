-- 0001: the state store (ADR 0104). Postgres 16, Supabase in production (ADR 0103).
-- Applied only after Didi reviews ADR 0104. Every table lives in the `factory` schema, which
-- Supabase's Data API does not expose, and has row level security on as a second barrier.
-- Ids and times are written by the library from its injected id source and clock (D-162), so
-- core-written columns have no defaults.

create schema factory;

-- Group roles. Login users that belong to them are created when the database is set up, with
-- credentials from the vault (new-credentials gate), never in a migration. Roles belong to the
-- whole server, so a concurrent creation (another database migrating at the same moment) is fine.
do $$
begin
  if not exists (select from pg_roles where rolname = 'factory_runner') then
    create role factory_runner nologin;
  end if;
exception when duplicate_object or unique_violation then null;
end
$$;
do $$
begin
  if not exists (select from pg_roles where rolname = 'factory_api') then
    create role factory_api nologin;
  end if;
exception when duplicate_object or unique_violation then null;
end
$$;

-- Supabase's API roles get nothing in this schema. Plain Postgres has none of them.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on schema factory from %I', r);
      execute format('alter default privileges in schema factory revoke all on tables from %I', r);
    end if;
  end loop;
end
$$;

revoke all on schema factory from public;
grant usage on schema factory to factory_runner, factory_api;

-- Append-only enforcement: no row in these tables is ever changed or removed, whatever the role.
create function factory.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'factory.% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end
$$;

create function factory.make_append_only(t regclass) returns void
language plpgsql as $$
begin
  execute format(
    'create trigger %I before update or delete on %s for each row execute function factory.forbid_change()',
    'append_only_row', t);
  execute format(
    'create trigger %I before truncate on %s for each statement execute function factory.forbid_change()',
    'append_only_truncate', t);
end
$$;

-- projects -----------------------------------------------------------------------------------
create table factory.projects (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  linear_project_id text,
  gallery_path_override text,
  privileged_paths_extra jsonb not null default '[]'::jsonb,
  prod_requires_approval boolean not null default false,
  staging_url text,
  created_at timestamptz not null
);

-- nodes: ideas and work items ------------------------------------------------------------------
create table factory.nodes (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  type text not null check (type in ('idea', 'work_item')),
  track text check (track in ('design', 'code', 'infra', 'docs')),
  state text not null,
  substate text,
  owner_role text not null,
  title text not null,
  body jsonb not null default '{}'::jsonb,
  hold boolean not null default false,
  agent_ready boolean not null default false,
  stale boolean not null default false,
  blocked_reason text,
  state_since timestamptz not null,
  linear_issue_id text,
  linear_status_synced text,
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check ((type = 'idea') = (track is null))
);
create index nodes_project_state on factory.nodes (project_id, state);
create index nodes_state_since on factory.nodes (state, state_since);

-- edges ------------------------------------------------------------------------------------------
create table factory.edges (
  id uuid primary key,
  from_node uuid not null references factory.nodes (id),
  to_node uuid not null references factory.nodes (id),
  type text not null check (type in ('blocks', 'split_into', 'design_for')),
  created_at timestamptz not null,
  unique (from_node, to_node, type),
  check (from_node <> to_node)
);
create index edges_to_node on factory.edges (to_node, type);

-- spec_versions (append-only) --------------------------------------------------------------------
create table factory.spec_versions (
  version text primary key,
  content_hash text not null,
  loaded_at timestamptz not null
);

-- transitions (append-only) ----------------------------------------------------------------------
create table factory.transitions (
  id uuid primary key,
  node_id uuid not null references factory.nodes (id),
  from_state text not null,
  to_state text not null,
  from_substate text,
  to_substate text,
  trigger_kind text not null check (trigger_kind in ('event', 'reconcile', 'bot_report', 'human', 'timeout')),
  trigger_ref text,
  actor_kind text not null check (actor_kind in ('runner', 'bot', 'operator', 'council')),
  actor_id text not null,
  guard_result jsonb not null,
  evidence_ids uuid[] not null default '{}',
  spec_version text not null references factory.spec_versions (version),
  mode text not null check (mode in ('applied', 'dry_run')),
  reason text,
  at timestamptz not null
);
create index transitions_node_at on factory.transitions (node_id, at);

-- runs ---------------------------------------------------------------------------------------------
create table factory.runs (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  node_id uuid references factory.nodes (id),
  bot text not null,
  agent_id text,
  runtime text not null,
  model text not null,
  head_sha text check (head_sha ~ '^[0-9a-f]{40}$'),
  bot_version text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text check (outcome in ('success', 'fail', 'timeout', 'cancelled', 'budget_exceeded', 'usage_exhausted')),
  turns integer check (turns >= 0),
  minutes numeric check (minutes >= 0),
  cost_usd numeric check (cost_usd >= 0),
  tokens jsonb,
  budget jsonb not null,
  parent_run_id uuid references factory.runs (id),
  transcript_ref text,
  check ((ended_at is null) = (outcome is null))
);
create index runs_node on factory.runs (node_id, started_at);
create index runs_started on factory.runs (started_at);

-- run_tokens: per-run agent credentials (ADR 0102). Only the hash is stored. ----------------------
create table factory.run_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  run_id uuid not null unique references factory.runs (id),
  role text not null check (role in ('developer', 'qa', 'designer', 'council', 'triage')),
  project_id uuid not null references factory.projects (id),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

-- evidence (append-only) ---------------------------------------------------------------------------
create table factory.evidence (
  id uuid primary key,
  node_id uuid not null references factory.nodes (id),
  run_id uuid references factory.runs (id),
  kind text not null check (kind in (
    'ci_run', 'test_report', 'preview_check', 'staging_check', 'qa_verdict', 'visual_comparison',
    'merge_commit', 'spec_paths', 'dispatch_record', 'docs_note', 'screenshot', 'agent_report')),
  ref text not null,
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  payload jsonb not null default '{}'::jsonb,
  recorded_by text not null,
  recorded_at timestamptz not null,
  supersedes_id uuid references factory.evidence (id),
  -- Evidence a head-commit guard reads must name its commit.
  check (kind not in ('ci_run', 'preview_check', 'staging_check', 'qa_verdict', 'visual_comparison')
         or commit_sha is not null),
  -- A QA verdict comes from exactly one run (ADR 0112).
  check (kind <> 'qa_verdict' or run_id is not null)
);
create index evidence_node_commit on factory.evidence (node_id, commit_sha, kind);
create unique index evidence_one_verdict_per_run on factory.evidence (run_id) where kind = 'qa_verdict';

-- decisions (append-only) and their status events ----------------------------------------------
create table factory.decisions (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  node_id uuid references factory.nodes (id),
  kind text not null check (kind in ('approval', 'answer', 'council_decision', 'interview_answer', 'product_direction')),
  scope jsonb not null default '{}'::jsonb,
  text_verbatim text not null,
  by_actor text not null,
  recorded_at timestamptz not null
);
create index decisions_project on factory.decisions (project_id, recorded_at);

-- A reversal or supersession is a new event row, never an edit (O-05, ADR 0104).
create table factory.decision_events (
  id uuid primary key,
  decision_id uuid not null references factory.decisions (id),
  kind text not null check (kind in ('reversed', 'superseded')),
  by_decision_id uuid references factory.decisions (id),
  reason text,
  recorded_by text not null,
  recorded_at timestamptz not null,
  unique (decision_id),
  check (kind <> 'superseded' or by_decision_id is not null),
  check (by_decision_id is null or by_decision_id <> decision_id)
);

-- security_invoker: the caller's grants and row level security apply, not the view owner's.
create view factory.decisions_current with (security_invoker = true) as
select d.*,
       coalesce(e.kind, 'active') as status,
       e.by_decision_id as replaced_by_id,
       e.recorded_at as status_changed_at
from factory.decisions d
left join factory.decision_events e on e.decision_id = d.id;

create table factory.node_decisions (
  node_id uuid not null references factory.nodes (id),
  decision_id uuid not null references factory.decisions (id),
  primary key (node_id, decision_id)
);

-- gate_requests --------------------------------------------------------------------------------------
create table factory.gate_requests (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  node_id uuid references factory.nodes (id),
  topic_key text not null,
  kind text not null check (kind in (
    'visual_approval', 'new_credentials', 'drop_data', 'dns', 'pii_access', 'spend', 'send_message',
    'production_deploy', 'scope', 'escalation', 'playbook_rule', 'privileged_path', 'council_question')),
  owner text not null check (owner in ('didi', 'council')),
  blocking boolean not null,
  payload jsonb not null default '{}'::jsonb,
  approval_url text,
  status text not null check (status in ('open', 'answered', 'superseded', 'expired', 'cancelled')),
  decision_id uuid references factory.decisions (id),
  superseded_by uuid references factory.gate_requests (id),
  created_at timestamptz not null,
  answered_at timestamptz,
  last_notified_at timestamptz,
  check (status <> 'answered' or (decision_id is not null and answered_at is not null)),
  check (status <> 'superseded' or superseded_by is not null)
);
create unique index gate_requests_one_open_per_topic on factory.gate_requests (project_id, topic_key) where status = 'open';

-- counters (P-03) ---------------------------------------------------------------------------------------
create table factory.counters (
  node_id uuid not null references factory.nodes (id),
  kind text not null check (kind in ('failure', 'qa_round')),
  count integer not null check (count >= 0),
  updated_at timestamptz not null,
  primary key (node_id, kind)
);

-- decision-point records (P-11) and their later outcomes, both append-only ---------------------------
create table factory.decision_point_records (
  id uuid primary key,
  project_id uuid not null references factory.projects (id),
  node_id uuid references factory.nodes (id),
  decision_point text not null,
  decider_id text not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  output jsonb not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  recorded_at timestamptz not null
);
create index decision_point_records_point on factory.decision_point_records (decision_point, recorded_at);

create table factory.decision_point_outcomes (
  id uuid primary key,
  record_id uuid not null unique references factory.decision_point_records (id),
  outcome jsonb not null,
  recorded_by text not null,
  recorded_at timestamptz not null
);

-- settings, with every change logged -----------------------------------------------------------------------
create table factory.settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null
);

create table factory.settings_log (
  id bigint generated always as identity primary key,
  key text not null,
  old_value jsonb,
  new_value jsonb not null,
  changed_by text not null,
  changed_at timestamptz not null
);

create function factory.log_setting_change() returns trigger
language plpgsql as $$
begin
  insert into factory.settings_log (key, old_value, new_value, changed_by, changed_at)
  values (new.key, case when tg_op = 'UPDATE' then old.value end, new.value, new.updated_by, new.updated_at);
  return new;
end
$$;

create trigger settings_logged after insert or update on factory.settings
  for each row execute function factory.log_setting_change();
create trigger settings_no_delete before delete or truncate on factory.settings
  for each statement execute function factory.forbid_change();

-- Seeded at the time the migration runs; every later change goes through the library.
insert into factory.settings (key, value, updated_by, updated_at) values
  ('kill_switch', 'false', 'migration', now()),
  ('dry_run', 'true', 'migration', now()),
  ('reconcile_interval_minutes', '120', 'migration', now()),
  ('failure_threshold', '3', 'migration', now()),
  ('qa_round_cap', '3', 'migration', now()),
  ('pii_credential_ttl_minutes', '60', 'migration', now()),
  ('stall_phone_alert_after_minutes', '60', 'migration', now()),
  ('daily_spend_call_usd', '25', 'migration', now()),
  ('spend_alert_usd', 'null', 'migration', now()),
  ('windmill_monthly_execution_limit', '1000', 'migration', now()),
  ('windmill_alert_percent', '80', 'migration', now()),
  ('qa_escape_review_count', '3', 'migration', now()),
  ('qa_escape_review_window', '30', 'migration', now());

-- Append-only tables ------------------------------------------------------------------------------------------
do $$
declare
  t regclass;
begin
  foreach t in array array[
    'factory.spec_versions', 'factory.transitions', 'factory.evidence', 'factory.decisions',
    'factory.decision_events', 'factory.decision_point_records', 'factory.decision_point_outcomes',
    'factory.settings_log']::regclass[] loop
    perform factory.make_append_only(t);
  end loop;
end
$$;
drop function factory.make_append_only(regclass);

-- Row level security on every table: only the two factory roles have policies. --------------------------------
do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'factory' loop
    execute format('alter table factory.%I enable row level security', t);
    execute format('create policy runner_all on factory.%I for all to factory_runner using (true) with check (true)', t);
  end loop;
end
$$;

-- The API reads what it serves and writes only what agents and the Council may write (ADR 0102).
create policy api_read on factory.projects for select to factory_api using (true);
create policy api_read on factory.nodes for select to factory_api using (true);
create policy api_insert on factory.nodes for insert to factory_api with check (true);
create policy api_read on factory.edges for select to factory_api using (true);
create policy api_insert on factory.edges for insert to factory_api with check (true);
create policy api_read on factory.runs for select to factory_api using (true);
create policy api_read on factory.run_tokens for select to factory_api using (true);
create policy api_read on factory.evidence for select to factory_api using (true);
-- Agents never write evidence a guard trusts (essential 6, ADR 0102, ADR 0112).
create policy api_insert_agent_kinds on factory.evidence for insert to factory_api
  with check (kind in ('agent_report', 'docs_note', 'qa_verdict'));
create policy api_read on factory.decisions for select to factory_api using (true);
create policy api_insert on factory.decisions for insert to factory_api with check (true);
create policy api_read on factory.decision_events for select to factory_api using (true);
create policy api_read on factory.gate_requests for select to factory_api using (true);
create policy api_read on factory.settings for select to factory_api using (true);
create policy api_read on factory.spec_versions for select to factory_api using (true);

-- Grants. No role gets DELETE or TRUNCATE on anything.
grant select, insert on all tables in schema factory to factory_runner;
grant update on factory.projects, factory.nodes, factory.runs, factory.run_tokens,
  factory.gate_requests, factory.counters, factory.settings to factory_runner;
grant select on factory.projects, factory.nodes, factory.edges, factory.runs, factory.run_tokens,
  factory.evidence, factory.decisions, factory.decision_events, factory.decisions_current,
  factory.gate_requests, factory.settings, factory.spec_versions to factory_api;
grant insert on factory.nodes, factory.edges, factory.evidence, factory.decisions to factory_api;
grant select on factory.decisions_current to factory_runner;
grant usage on all sequences in schema factory to factory_runner;
