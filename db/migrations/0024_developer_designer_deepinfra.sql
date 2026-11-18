-- 0024: the Developer and the Designer move to Qwen3 Coder on DeepInfra's Flex tier (D-421, in
-- D-342's order, D-400; Flex by default, D-207). Never edit an earlier migration; add a new one
-- instead. A privileged change for Didi's review. No new table, column, role or grant: it only
-- changes two settings rows in place, and the settings trigger records each change in
-- settings_log.
--
-- model_catalog gains Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo, a model DeepInfra hosts itself
-- (resold false, so D-208's approval covers it). Its prices were read on 2026-11-18 from
-- DeepInfra's public model list (api.deepinfra.com/models/list): 0.30 USD per million input
-- tokens, 1.00 per million output tokens, cached input at a third of the input price (0.10), and
-- Flex at 0.8 times each (0.24, 0.08 and 0.80). DeepInfra lists no cache-write price, so the entry
-- has none and a cache write is priced at the input rate (O-26). Its output cap is DeepInfra's
-- 16,384 tokens per response (src/agent-images/opencode/settings.ts). The entry is added only
-- where the catalog has none under that id, so an operator's own entry is never replaced. The
-- catalog's version changes with its content, as the policy's did in 0019: the first catalog's
-- 2026-10-31.1 becomes 2026-11-18.1, and any other version gets "+d421" at its end.
--
-- model_routing_policy: "developer:code", "developer:infra" and "designer" each get one candidate,
-- the model on DeepInfra at Flex, with onCapacity wait. Each is changed only while it is still
-- exactly the entry 0005 seeded (Claude Sonnet 5.5 on Anthropic at Standard, wait), so an
-- operator's own entry is never replaced; any other entry is left as it is, with a NOTICE naming
-- its task type. Nothing moves unless the catalog lists the model under DeepInfra, since a route
-- to a model the catalog does not price is refused (ADR 0114 hard rule 2). The policy's version
-- changes only when an entry moved: 0019's 2026-11-04.1 becomes 2026-11-18.1, and any other
-- version gets "+d421". So running this again changes nothing.
--
-- Left as they are: "developer:close" and "designer:close", whose code never calls the model
-- (D-318, D-324), and "qa:review", "council" and "triage", which stay on Anthropic until the
-- Messages API image can reach DeepInfra (D-342, D-400). model_output_token_needs is unchanged:
-- each of the three task types needs 16000 output tokens, below the model's cap (hard rule 4).
do $$
declare
  qwen constant text := 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo';
  qwen_entry constant jsonb := '{
    "provider": "deepinfra",
    "family": "qwen",
    "tiers": ["standard", "flex"],
    "pricePerMTok": {
      "standard": { "input": 0.3, "cachedInput": 0.1, "output": 1 },
      "flex": { "input": 0.24, "cachedInput": 0.08, "output": 0.8 }
    },
    "maxOutputTokens": 16384,
    "resold": false,
    "priceSource": "DeepInfra public model list (api.deepinfra.com/models/list): input and output prices, the cached input rate and the Flex rate",
    "priceReadOn": "2026-11-18"
  }';
  -- The entry 0005 seeded for each of the three task types.
  seeded constant jsonb := '{
    "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
    "onCapacity": "wait"
  }';
  moved constant jsonb := jsonb_build_object(
    'candidates',
    jsonb_build_array(jsonb_build_object('provider', 'deepinfra', 'model', qwen, 'tier', 'flex')),
    'onCapacity', 'wait');
  catalog jsonb;
  policy jsonb;
  task_type text;
  changed boolean := false;
begin
  select value into catalog from factory.settings where key = 'model_catalog';
  if jsonb_typeof(catalog -> 'models') = 'object' and catalog -> 'models' -> qwen is null then
    catalog := jsonb_set(catalog, array['models', qwen], qwen_entry);
    catalog := jsonb_set(catalog, '{version}', to_jsonb(
      case when catalog ->> 'version' = '2026-10-31.1' then '2026-11-18.1'
           else coalesce(catalog ->> 'version', '') || '+d421' end));
    update factory.settings
      set value = catalog, updated_by = 'migration', updated_at = now()
      where key = 'model_catalog';
  end if;

  select value into policy from factory.settings where key = 'model_routing_policy';
  if jsonb_typeof(policy -> 'taskTypes') = 'object' then
    if catalog -> 'models' -> qwen ->> 'provider' is distinct from 'deepinfra' then
      raise notice '0024 moved no task type: model_catalog lists no % under deepinfra', qwen;
    else
      foreach task_type in array array['developer:code', 'developer:infra', 'designer'] loop
        if policy -> 'taskTypes' -> task_type = seeded then
          policy := jsonb_set(policy, array['taskTypes', task_type], moved);
          changed := true;
        elsif policy -> 'taskTypes' -> task_type is distinct from moved then
          raise notice '0024 left model_routing_policy.taskTypes.% as it is: it is not the entry 0005 seeded',
            task_type;
        end if;
      end loop;
    end if;
    if changed then
      policy := jsonb_set(policy, '{version}', to_jsonb(
        case when policy ->> 'version' = '2026-11-04.1' then '2026-11-18.1'
             else coalesce(policy ->> 'version', '') || '+d421' end));
      update factory.settings
        set value = policy, updated_by = 'migration', updated_at = now()
        where key = 'model_routing_policy';
    end if;
  end if;
end
$$;
