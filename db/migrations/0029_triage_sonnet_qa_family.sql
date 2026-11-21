-- 0029: Triage moves back to Claude Sonnet 5.5 on Anthropic at Standard (D-451, O-162), and QA
-- independence switches from model id to model family (D-452, D-209, ADR 0114 hard rule 1). Never
-- edit an earlier migration; add a new one instead. A privileged change for Didi's review. No new
-- table, column, role or grant: it only changes the model_routing_policy row in place, and the
-- settings trigger records the change in settings_log.
--
-- Why Triage moves (D-451): the first weekly model test (ADR 0117, the week of 2026-11-15) gave
-- DeepSeek V4 Pro, Triage's model since 0026 (D-425), 0 of the 3 Triage cases: it split both
-- single-item plans into more than one item, and its answer for triage-helper-then-page was
-- rejected. Kimi K2.6 got 2 of 3 and DeepSeek V4.1 Flash 1 of 3; Claude's baseline got 12 of 12.
-- So Triage goes back to the entry 0005 seeded for it until an open model passes Triage in the
-- weekly test. QA's review and the Council stay on DeepSeek V4 Pro, which passed 7 of 7 QA cases
-- and 2 of 2 Council cases.
--
-- Why QA independence switches now (D-452): D-209 switches qaIndependence from model_id to family
-- once a QA candidate of another family holds quality. The same test met that condition: DeepSeek
-- V4 Pro (family deepseek) passed 7 of 7 QA cases, four of them with a planted defect, reviewing
-- work built on Qwen3 Coder (family qwen). D-158's waiver ends with the switch (D-209).
--
-- What it changes, in one do block:
-- - taskTypes.triage becomes the entry 0005 seeded (one candidate, claude-sonnet-5-5 on anthropic
--   at standard, onCapacity wait), only while it is still exactly the entry 0026 set (one
--   candidate, deepseek-ai/DeepSeek-V4-Pro-0813 on deepinfra at flex, onCapacity wait). An entry
--   that is already the Sonnet one is left with no NOTICE; any other entry, an operator's own, is
--   left as it is with a NOTICE naming the task type. It moves only while model_catalog lists
--   claude-sonnet-5-5 under anthropic, since a route to a model the catalog does not price is
--   refused (ADR 0114 hard rule 2); otherwise a NOTICE says so. The catalog as 0027 leaves it
--   does: 0005 seeded the entry, with a Standard price, and 0025 set its cached input price.
-- - qaIndependence becomes "family", only while it is "model_id". Any other value is left as it
--   is; a value that is neither model_id nor family gets a NOTICE.
-- - The policy's version changes only when one of those changed: 0026's 2026-11-18.2 becomes
--   2026-11-21.1, and any other version gets "+d451" at its end.
-- So running this again changes nothing. 0026 is never run again (each migration runs once, with
-- its record, ADR 0104); if it were, its guard would match the Sonnet entry and move Triage again.
--
-- The other hard rules for Triage on Sonnet: Anthropic is approved for every model it serves
-- (D-171, rule 3), and model_output_token_needs.triage is 16000 while Sonnet's catalog entry has
-- maxOutputTokens null, no cap, so the need fits (rule 4). Neither setting changes.
--
-- QA independence by family for the seeded routes (rule 1): the Developer and the Designer are on
-- Qwen3 Coder, family qwen (0024), their close runs on Claude Sonnet 5.5, family claude (0019),
-- and QA's review on DeepSeek V4 Pro, family deepseek (0026), so a QA run after any of them still
-- has a route. The rule (src/core/routing.ts, qaIndependenceProblem) compares the QA candidate's
-- family in the catalog with runs.model_family on each Developer and Designer run of the item.
-- That family is copied onto the run from the catalog when the run is admitted (not null and not
-- empty, migration 0005), so a builder run whose model has since left the catalog is still
-- compared by the family it ran with; the catalog is never read for a builder run. A QA candidate
-- the catalog does not list has no family to compare, so it is refused (and fails rule 2 too).
-- The merge guard and the visual record check keep their own model id check (D-158), which a
-- different family always passes.
--
-- Order: nothing needs to reach the cluster first. The Triage bot file lists anthropic, with the
-- project's key at projects/{project}/models/anthropic, the key the close runs already use, and
-- the Messages API image pinned for O-152 still gives a provider without messages_api, such as
-- anthropic, Anthropic's structured outputs, as Triage had before 0026.
do $$
declare
  sonnet constant text := 'claude-sonnet-5-5';
  -- The entry 0026 set for "triage".
  deepseek_entry constant jsonb := '{
    "candidates": [{ "provider": "deepinfra", "model": "deepseek-ai/DeepSeek-V4-Pro-0813", "tier": "flex" }],
    "onCapacity": "wait"
  }';
  -- The entry 0005 seeded for "triage".
  sonnet_entry constant jsonb := '{
    "candidates": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }],
    "onCapacity": "wait"
  }';
  catalog jsonb;
  policy jsonb;
  changed boolean := false;
begin
  select value into policy from factory.settings where key = 'model_routing_policy';
  if jsonb_typeof(policy -> 'taskTypes') = 'object' then
    if policy -> 'taskTypes' -> 'triage' = deepseek_entry then
      select value into catalog from factory.settings where key = 'model_catalog';
      if catalog -> 'models' -> sonnet ->> 'provider' is distinct from 'anthropic' then
        raise notice '0029 moved no task type: model_catalog lists no % under anthropic', sonnet;
      else
        policy := jsonb_set(policy, '{taskTypes,triage}', sonnet_entry);
        changed := true;
      end if;
    elsif policy -> 'taskTypes' -> 'triage' is distinct from sonnet_entry then
      raise notice '0029 left model_routing_policy.taskTypes.triage as it is: it is not the entry 0026 set';
    end if;

    if policy -> 'qaIndependence' = '"model_id"'::jsonb then
      policy := jsonb_set(policy, '{qaIndependence}', '"family"'::jsonb);
      changed := true;
    elsif policy -> 'qaIndependence' is distinct from '"family"'::jsonb then
      raise notice '0029 left model_routing_policy.qaIndependence as it is: it is not model_id';
    end if;

    if changed then
      policy := jsonb_set(policy, '{version}', to_jsonb(
        case when policy ->> 'version' = '2026-11-18.2' then '2026-11-21.1'
             else coalesce(policy ->> 'version', '') || '+d451' end));
      update factory.settings
        set value = policy, updated_by = 'migration', updated_at = now()
        where key = 'model_routing_policy';
    end if;
  end if;
end
$$;
