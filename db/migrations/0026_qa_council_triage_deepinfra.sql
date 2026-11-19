-- 0026: QA's review, the Council and Triage move to DeepSeek V4 Pro on DeepInfra's Flex tier
-- (D-425, O-153; D-342's order, D-400; Flex by default, D-207). Never edit an earlier migration;
-- add a new one instead. A privileged change for Didi's review. No new table, column, role or
-- grant: it only changes two settings rows in place, and the settings trigger records each change
-- in settings_log.
--
-- Order: this needs the new Messages API image first. The image pinned before O-152 asks every
-- provider for Anthropic's structured outputs, which DeepInfra's endpoint does not have, so a run
-- routed here on the old image would fail. The same change pins the image built from 12f3a2a, the
-- merge of O-152, in infra/kubernetes/settings/agent-runs.json (agentImages."claude-api"), and
-- the Windmill deploy carries it to agent runs. Approve the Windmill deploy before the migrations
-- job.
--
-- model_catalog gains deepseek-ai/DeepSeek-V4-Pro-0813, family deepseek, a model DeepInfra hosts
-- itself (resold false, so D-208's approval covers it). Its prices were read on 2026-11-18 from
-- DeepInfra's public model list (api.deepinfra.com/models/list): 1.30 USD per million input
-- tokens, 2.60 per million output tokens, cached input at 0.07692308 times the input price (0.10),
-- and Flex at 0.8 times each (1.04, 0.08 and 2.08). The list also gives a Priority rate, but the
-- entry lists only Standard and Flex, as the Qwen3 Coder entry does. DeepInfra lists no
-- cache-write price, so the entry has none and a cache write is priced at the input rate (O-26).
-- Its output cap is 16,384 tokens per response, the DeepInfra cap the Qwen3 Coder entry records
-- (O-147, src/agent-images/opencode/settings.ts). DeepInfra's Anthropic models endpoint lists
-- max_tokens 393216 for this model, but the entry keeps the recorded cap, the safe side: hard rule
-- 4 then refuses a task type that needs more than 16,384 output tokens, and none does. The entry is
-- added only where the catalog has none under that id, so an operator's own entry is never
-- replaced. The catalog's version changes with its content, as in 0024 and 0025: 0025's
-- 2026-11-18.2 becomes 2026-11-18.3, and any other version gets "+d425" at its end.
--
-- model_routing_policy: "qa:review", "council" and "triage" each get one candidate, the model on
-- DeepInfra at Flex, with onCapacity wait. Each is changed only while it is still exactly the
-- entry 0005 seeded for it (Claude Opus 5.5 for "qa:review", Claude Sonnet 5.5 for "council" and
-- "triage", each on Anthropic at Standard, wait), so an operator's own entry is never replaced;
-- any other entry is left as it is, with a NOTICE naming its task type. Nothing moves unless the
-- catalog lists the model under DeepInfra, since a route to a model the catalog does not price is
-- refused (ADR 0114 hard rule 2); then a NOTICE says so. The policy's version changes only when an
-- entry moved: 0024's 2026-11-18.1 becomes 2026-11-18.2, and any other version gets "+d425". So
-- running this again changes nothing.
--
-- Left as they are: "qa:visual" and "council:visual", which have no route yet (the vision model
-- test picks their model by D-249's measured bar, N-57); "developer:code", "developer:infra",
-- "designer" and the close task types; and qaIndependence, still model_id (D-209 moves it to
-- family only once the rehearsal shows the new QA model holds quality). QA's model differs from
-- the Developer's Qwen3 Coder by id and by family. model_output_token_needs is unchanged: each of
-- the three task types needs 16000 output tokens, below the model's cap (hard rule 4).
do $$
declare
  deepseek constant text := 'deepseek-ai/DeepSeek-V4-Pro-0813';
  deepseek_entry constant jsonb := '{
    "provider": "deepinfra",
    "family": "deepseek",
    "tiers": ["standard", "flex"],
    "pricePerMTok": {
      "standard": { "input": 1.3, "cachedInput": 0.1, "output": 2.6 },
      "flex": { "input": 1.04, "cachedInput": 0.08, "output": 2.08 }
    },
    "maxOutputTokens": 16384,
    "resold": false,
    "priceSource": "DeepInfra public model list (api.deepinfra.com/models/list): input and output prices, the cached input rate and the Flex rate",
    "priceReadOn": "2026-11-18"
  }';
  -- The entry 0005 seeded for each of the three task types.
  seeded constant jsonb := '{
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
  }';
  moved constant jsonb := jsonb_build_object(
    'candidates',
    jsonb_build_array(jsonb_build_object('provider', 'deepinfra', 'model', deepseek, 'tier', 'flex')),
    'onCapacity', 'wait');
  catalog jsonb;
  policy jsonb;
  task_type text;
  changed boolean := false;
begin
  select value into catalog from factory.settings where key = 'model_catalog';
  if jsonb_typeof(catalog -> 'models') = 'object' and catalog -> 'models' -> deepseek is null then
    catalog := jsonb_set(catalog, array['models', deepseek], deepseek_entry);
    catalog := jsonb_set(catalog, '{version}', to_jsonb(
      case when catalog ->> 'version' = '2026-11-18.2' then '2026-11-18.3'
           else coalesce(catalog ->> 'version', '') || '+d425' end));
    update factory.settings
      set value = catalog, updated_by = 'migration', updated_at = now()
      where key = 'model_catalog';
  end if;

  select value into policy from factory.settings where key = 'model_routing_policy';
  if jsonb_typeof(policy -> 'taskTypes') = 'object' then
    if catalog -> 'models' -> deepseek ->> 'provider' is distinct from 'deepinfra' then
      raise notice '0026 moved no task type: model_catalog lists no % under deepinfra', deepseek;
    else
      foreach task_type in array array['qa:review', 'council', 'triage'] loop
        if policy -> 'taskTypes' -> task_type = seeded -> task_type then
          policy := jsonb_set(policy, array['taskTypes', task_type], moved);
          changed := true;
        elsif policy -> 'taskTypes' -> task_type is distinct from moved then
          raise notice '0026 left model_routing_policy.taskTypes.% as it is: it is not the entry 0005 seeded',
            task_type;
        end if;
      end loop;
    end if;
    if changed then
      policy := jsonb_set(policy, '{version}', to_jsonb(
        case when policy ->> 'version' = '2026-11-18.1' then '2026-11-18.2'
             else coalesce(policy ->> 'version', '') || '+d425' end));
      update factory.settings
        set value = policy, updated_by = 'migration', updated_at = now()
        where key = 'model_routing_policy';
    end if;
  end if;
end
$$;
