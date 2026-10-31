-- 0005: the model route on every run, and the routing settings (ADR 0114 sections 2 and 5, D-211,
-- build plan M3.2). Never edit an earlier migration; add a new one instead. No new table, role or
-- grant: the runner already inserts runs and reads settings.

-- The route columns that every run has are NOT NULL with no default. A run that existed before
-- this migration has no route, and none can be made up for it, so the migration refuses a table
-- that already holds runs instead of inventing values. No run exists before first hosting: the
-- runner has never dispatched, and dry run inserts no run.
do $$
begin
  if exists (select 1 from factory.runs) then
    raise exception '0005 needs an empty factory.runs: the route columns are not null and a run recorded before routing has no route';
  end if;
end
$$;

-- The route the core chose when it admitted the run, recorded in the transaction that inserts it.
-- runs.model is the route's model.
alter table factory.runs
  add column task_type text not null check (task_type ~ '^[a-z]+(:[a-z]+)?$'),
  add column provider text not null check (provider ~ '^[a-z][a-z0-9_-]*$'),
  add column model_family text not null check (model_family <> ''),
  add column service_tier_requested text not null
    check (service_tier_requested in ('standard', 'flex', 'priority')),
  -- From the provider's responses: one tier, or mixed. Null when no response reported it.
  add column service_tier_served text
    check (service_tier_served in ('standard', 'flex', 'priority', 'mixed')),
  add column routing_policy_version text not null check (routing_policy_version <> ''),
  add column model_catalog_version text not null check (model_catalog_version <> ''),
  -- Flex capacity rejections retried inside the run, and the time spent waiting on them.
  add column capacity_retries integer check (capacity_retries >= 0),
  add column capacity_wait_seconds integer check (capacity_wait_seconds >= 0),
  add column first_token_ms integer check (first_token_ms >= 0),
  -- The runtime's own cost figure, kept to compare with cost_usd.
  add column reported_cost_usd numeric check (reported_cost_usd >= 0);

-- The routing settings. The first policy reproduces today's choices (D-185, D-186): Claude Sonnet
-- 5.5 for every task type but QA review, which runs on Claude Opus 5.5, all Anthropic at Standard,
-- with QA independence by model id (the D-158 waiver). The catalog holds only those two models, at
-- Anthropic's list prices (docs/costs.md section 2; cache writes at the 5-minute rate from
-- src/agent-images/claude-api/pricing.ts). Anthropic is approved under D-171 and DeepInfra under
-- D-208; the policy routes nothing to DeepInfra. Each task type needs 16000 output tokens, the
-- Messages API loop's default (FOREMAN_MAX_OUTPUT_TOKENS).
insert into factory.settings (key, value, updated_by, updated_at) values
  ('model_routing_policy', '{
    "version": "2026-10-31.1",
    "qaIndependence": "model_id",
    "taskTypes": {
      "developer:code": {
        "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
        "onCapacity": "wait"
      },
      "developer:infra": {
        "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
        "onCapacity": "wait"
      },
      "designer": {
        "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
        "onCapacity": "wait"
      },
      "qa:review": {
        "candidates": [{ "provider": "anthropic", "model": "claude-opus-5-5", "tier": "standard" }],
        "onCapacity": "wait"
      },
      "council": {
        "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
        "onCapacity": "wait"
      },
      "triage": {
        "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
        "onCapacity": "wait"
      }
    }
  }', 'migration', now()),
  ('model_catalog', '{
    "version": "2026-10-31.1",
    "models": {
      "claude-sonnet-5-5": {
        "provider": "anthropic",
        "family": "claude",
        "tiers": ["standard"],
        "pricePerMTok": { "standard": { "input": 2, "cachedInput": 0.2, "cacheWrite": 2.5, "output": 10 } },
        "maxOutputTokens": null,
        "priceSource": "Anthropic list price (docs/costs.md section 2, claude-api/pricing.ts)",
        "priceReadOn": "2026-10-31"
      },
      "claude-opus-5-5": {
        "provider": "anthropic",
        "family": "claude",
        "tiers": ["standard"],
        "pricePerMTok": { "standard": { "input": 4, "cachedInput": 0.2, "cacheWrite": 5, "output": 20 } },
        "maxOutputTokens": null,
        "priceSource": "Anthropic list price (docs/costs.md section 2, claude-api/pricing.ts)",
        "priceReadOn": "2026-10-31"
      }
    }
  }', 'migration', now()),
  ('model_providers_approved', '{
    "anthropic": { "decision": "D-171" },
    "deepinfra": {
      "decision": "D-208",
      "note": "Only models DeepInfra hosts itself. Anthropic and Google models resold through DeepInfra are not covered"
    }
  }', 'migration', now()),
  ('model_output_token_needs', '{
    "developer:code": 16000,
    "developer:infra": 16000,
    "designer": 16000,
    "qa:review": 16000,
    "council": 16000,
    "triage": 16000
  }', 'migration', now());
