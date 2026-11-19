-- 0027: the weekly model test's records, its setting and two catalog entries (ADR 0117, D-204,
-- D-429, D-430, D-433, O-156). Never edit an earlier migration; add a new one instead. A
-- privileged change for Didi's review. Two new tables, written and read by the runner only (the
-- weekly flow and the daily check run as the runner). No new role. factory_api and
-- factory_ingest get no access. No personal data: model ids, case ids, fixed codes, counts and
-- amounts, and never a model's text or a key.
--
-- model_eval_jobs: one row per Job the weekly flow starts. Written when it starts, before its
-- cluster objects, and ended once, when a later run of the flow reads its result or finds it
-- failed. Only the end's columns can change, once (column grant, and the store's update only
-- where ended_at is null); a row is never deleted. At most one Job has no end at a time.
--
-- model_eval_results: one row per run of a Job's result, append-only. `facts` holds only what the
-- runner's own checks read (QA's verdict and the files its findings name, Triage's item count,
-- the Council's outcome and two flags), bounded at 2,048 bytes; `provider_error` only a status
-- and an error type, never a message.
--
-- model_eval: the setting the weekly flow reads (src/core/model-eval.ts): the weekly cap of 10 USD
-- (D-204); the three models tested every week on DeepInfra at Flex, for QA, Triage and the
-- Council (D-429); Claude's baseline, Opus 5.5 for QA and Sonnet 5.5 for Triage and the Council on
-- Anthropic at Standard, in the first Job of each calendar month (UTC); and each provider's key
-- path, eval/models/<provider>, the Windmill variables f/foreman/eval/models/<provider> (D-433).
-- Added only where no row has that key, so an operator's own setting is never replaced.
--
-- model_catalog gains deepseek-ai/DeepSeek-V4.1-Flash-1017 (family deepseek) and
-- moonshotai/Kimi-K2.6 (family kimi), models DeepInfra hosts itself (resold false, so D-208's
-- approval covers them), with Standard and Flex. Their prices were read on 2026-11-19 from
-- DeepInfra's public model list (api.deepinfra.com/models/list), each list field as given, in US
-- cents per token and rates as fractions of the input price:
--   DeepSeek V4.1 Flash 1017: cents_per_input_token 0.00002, cents_per_output_token 0.00006,
--     rate_per_input_token_cached 0.03, rate_per_service_tier_flex 0.8. In US dollars per million
--     tokens: 0.20 input, 0.006 cached input, 0.60 output; Flex 0.16, 0.0048 and 0.48. The list
--     also gives "discount": 0.51, which the shown price does not use (docs/costs.md section 4
--     uses the shown price too), so the entry does not either.
--   Kimi K2.6: cents_per_input_token 0.000075, cents_per_output_token 0.00035,
--     rate_per_input_token_cached 0.2, rate_per_service_tier_flex 0.8. In US dollars per million
--     tokens: 0.75 input, 0.15 cached input, 3.50 output; Flex 0.60, 0.12 and 2.80.
-- The list gives a Priority rate (1.5) too, but each entry lists only Standard and Flex, as the
-- Qwen3 Coder and DeepSeek V4 Pro entries do. DeepInfra lists no cache-write price, so neither
-- entry has one and a cache write is priced at the input rate (O-26). Each output cap is 16,384
-- tokens per response, the DeepInfra cap the catalog records (O-147). Each entry is added only
-- where the catalog has none under that id, so an operator's own entry is never replaced. The
-- catalog's version changes with its content: 0026's 2026-11-18.3 becomes 2026-11-19.1, and any
-- other version gets "+d429" at its end; it changes only when an entry was added, so running this
-- again changes nothing. The routing policy is not changed: no task type is routed to either
-- model, and the settings trigger records each change in settings_log.

-- One row per weekly model test Job (D-432, D-433). `plan` is the plan it was given: each
-- entry's model, provider, tier, catalog price, roles and whether it is Claude's baseline.
create table factory.model_eval_jobs (
  id uuid primary key,
  -- The Sunday (UTC) its week starts on.
  week_start date not null check (extract(isodow from week_start) = 7),
  started_at timestamptz not null,
  deadline_at timestamptz not null check (deadline_at > started_at),
  baseline boolean not null,
  cap_usd numeric not null check (cap_usd > 0),
  spent_before_usd numeric not null check (spent_before_usd >= 0),
  plan jsonb not null check (
    jsonb_typeof(plan) = 'array' and jsonb_array_length(plan) between 1 and 8
    and octet_length(plan::text) <= 16384
  ),
  recorded_by text not null,
  ended_at timestamptz,
  outcome text check (outcome in ('finished', 'failed')),
  -- For a failed Job: a fixed code (src/core/model-eval.ts JOB_FAILURES).
  reason text check (reason in (
    'start_failed', 'deadline', 'did_not_end', 'job_gone', 'job_failed', 'bad_result')),
  -- For a failed Job: the Job's own error text, plain words only and cut short.
  detail text check (char_length(detail) <= 200),
  spent_usd numeric check (spent_usd >= 0),
  check ((ended_at is null) = (outcome is null)),
  check (ended_at is not null or (reason is null and detail is null and spent_usd is null)),
  check (outcome is distinct from 'finished' or (spent_usd is not null and reason is null)),
  check (outcome is distinct from 'failed' or reason is not null)
);
create index model_eval_jobs_week on factory.model_eval_jobs (week_start, started_at);
-- One Job without an end at a time: two runs of the flow cannot both start one.
create unique index model_eval_jobs_one_open on factory.model_eval_jobs ((true))
  where ended_at is null;

create trigger model_eval_jobs_no_delete before delete or truncate on factory.model_eval_jobs
  for each statement execute function factory.forbid_change();

-- One row per run of a Job's result (D-430).
create table factory.model_eval_results (
  id uuid primary key,
  job_id uuid not null references factory.model_eval_jobs (id),
  -- Its place in the Job's order, from 1.
  seq integer not null check (seq between 1 and 300),
  case_id text not null check (case_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  case_version integer not null check (case_version >= 1),
  role text not null check (role in ('qa', 'triage', 'council')),
  model text not null check (char_length(model) between 1 and 200),
  provider text not null check (provider ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
  tier text not null check (tier in ('standard', 'flex', 'priority')),
  baseline boolean not null,
  outcome text not null check (outcome in ('correct', 'wrong', 'unusable', 'error', 'skipped')),
  reason text not null check (reason ~ '^[a-z_]{1,40}$'),
  turns integer not null check (turns >= 0),
  tokens jsonb not null check (jsonb_typeof(tokens) = 'object'),
  cost_usd numeric not null check (cost_usd >= 0),
  service_tier_served text check (service_tier_served in ('standard', 'flex', 'priority', 'mixed')),
  minutes numeric not null check (minutes >= 0),
  provider_error jsonb check (provider_error is null or jsonb_typeof(provider_error) = 'object'),
  facts jsonb check (
    facts is null or (jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 2048)),
  recorded_by text not null,
  recorded_at timestamptz not null,
  unique (job_id, seq),
  -- Facts only for a usable answer, and a provider error only for one.
  check ((outcome in ('correct', 'wrong')) = (facts is not null)),
  check ((reason = 'provider_error') = (provider_error is not null))
);

create trigger append_only_row before update or delete on factory.model_eval_results
  for each row execute function factory.forbid_change();
create trigger append_only_truncate before truncate on factory.model_eval_results
  for each statement execute function factory.forbid_change();

-- Row level security, as on every factory table.
alter table factory.model_eval_jobs enable row level security;
create policy runner_all on factory.model_eval_jobs for all to factory_runner
  using (true) with check (true);
alter table factory.model_eval_results enable row level security;
create policy runner_all on factory.model_eval_results for all to factory_runner
  using (true) with check (true);

-- Grants. No role gets DELETE or TRUNCATE here, and the runner updates only a Job's end.
grant select, insert on factory.model_eval_jobs to factory_runner;
grant update (ended_at, outcome, reason, detail, spent_usd) on factory.model_eval_jobs
  to factory_runner;
grant select, insert on factory.model_eval_results to factory_runner;

-- The setting and the catalog entries. From here on, running the file's rest again changes
-- nothing (test/db/schema.test.ts runs it again).
insert into factory.settings (key, value, updated_by, updated_at) values
  ('model_eval', '{
    "capUsd": 10,
    "weekly": [
      { "model": "deepseek-ai/DeepSeek-V4-Pro-0813", "provider": "deepinfra", "tier": "flex",
        "roles": ["qa", "triage", "council"] },
      { "model": "deepseek-ai/DeepSeek-V4.1-Flash-1017", "provider": "deepinfra", "tier": "flex",
        "roles": ["qa", "triage", "council"] },
      { "model": "moonshotai/Kimi-K2.6", "provider": "deepinfra", "tier": "flex",
        "roles": ["qa", "triage", "council"] }
    ],
    "baseline": [
      { "model": "claude-opus-5-5", "provider": "anthropic", "tier": "standard",
        "roles": ["qa"] },
      { "model": "claude-sonnet-5-5", "provider": "anthropic", "tier": "standard",
        "roles": ["triage", "council"] }
    ],
    "baselineCadence": "first_run_of_month",
    "keyPaths": {
      "deepinfra": "eval/models/deepinfra",
      "anthropic": "eval/models/anthropic"
    }
  }', 'migration', now())
on conflict (key) do nothing;

do $$
declare
  source constant text := 'DeepInfra public model list (api.deepinfra.com/models/list): input and output prices, the cached input rate and the Flex rate';
  entries constant jsonb := jsonb_build_object(
    'deepseek-ai/DeepSeek-V4.1-Flash-1017', jsonb_build_object(
      'provider', 'deepinfra',
      'family', 'deepseek',
      'tiers', '["standard", "flex"]'::jsonb,
      'pricePerMTok', '{
        "standard": { "input": 0.2, "cachedInput": 0.006, "output": 0.6 },
        "flex": { "input": 0.16, "cachedInput": 0.0048, "output": 0.48 }
      }'::jsonb,
      'maxOutputTokens', 16384,
      'resold', false,
      'priceSource', source,
      'priceReadOn', '2026-11-19'),
    'moonshotai/Kimi-K2.6', jsonb_build_object(
      'provider', 'deepinfra',
      'family', 'kimi',
      'tiers', '["standard", "flex"]'::jsonb,
      'pricePerMTok', '{
        "standard": { "input": 0.75, "cachedInput": 0.15, "output": 3.5 },
        "flex": { "input": 0.6, "cachedInput": 0.12, "output": 2.8 }
      }'::jsonb,
      'maxOutputTokens', 16384,
      'resold', false,
      'priceSource', source,
      'priceReadOn', '2026-11-19'));
  catalog jsonb;
  model text;
  added boolean := false;
begin
  select value into catalog from factory.settings where key = 'model_catalog';
  if jsonb_typeof(catalog -> 'models') is distinct from 'object' then
    return;
  end if;
  for model in select jsonb_object_keys(entries) order by 1 loop
    if catalog -> 'models' -> model is null then
      catalog := jsonb_set(catalog, array['models', model], entries -> model);
      added := true;
    end if;
  end loop;
  if added then
    catalog := jsonb_set(catalog, '{version}', to_jsonb(
      case when catalog ->> 'version' = '2026-11-18.3' then '2026-11-19.1'
           else coalesce(catalog ->> 'version', '') || '+d429' end));
    update factory.settings
      set value = catalog, updated_by = 'migration', updated_at = now()
      where key = 'model_catalog';
  end if;
end
$$;
