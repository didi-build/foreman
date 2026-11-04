-- 0019: a route for the close runs (D-318, D-324). Never edit an earlier migration; add a new one
-- instead. No new table, column, role or grant: it only changes two settings rows in place, and
-- the settings trigger records each change in settings_log.
--
-- A cancelled item's pull request is closed by its own bot in a short run of task type
-- `developer:close` or `designer:close` (D-318). Those runs are routed like every other bot run
-- (D-324), so each needs an entry in the routing policy and in the output needs. The first policy
-- (0005) has none, so until now every close run was refused with no_route.
--
-- What it adds, and only where the key is absent, so an operator's own entry is never replaced:
-- - model_routing_policy.taskTypes."developer:close": a copy of the policy's own
--   "developer:code" entry (its candidates and onCapacity);
-- - model_routing_policy.taskTypes."designer:close": a copy of its own "designer" entry;
-- - model_output_token_needs."developer:close" and ."designer:close": the same values as
--   "developer:code" and "designer".
-- Each is copied from the row as it stands now, so the migration names no model, provider or
-- tier that the policy did not already have. An entry whose source is missing is not added.
--
-- The policy's version changes with its content, since each run records the version its route
-- came from (ADR 0114): the first policy's 2026-10-31.1 becomes 2026-11-04.1, and any other
-- version gets "+d324" at its end. The version changes only when an entry was added, so running
-- this again changes nothing.
--
-- The close code never calls the model, but the run's proxy holds the route's model key like
-- every builder run's; Didi accepted that so the close run keeps the one run path (D-324).
do $$
declare
  policy jsonb;
  needs jsonb;
  added boolean := false;
begin
  select value into policy from factory.settings where key = 'model_routing_policy';
  if policy is not null then
    if policy #> '{taskTypes,developer:close}' is null
       and policy #> '{taskTypes,developer:code}' is not null then
      policy := jsonb_set(policy, '{taskTypes,developer:close}',
                          policy #> '{taskTypes,developer:code}');
      added := true;
    end if;
    if policy #> '{taskTypes,designer:close}' is null
       and policy #> '{taskTypes,designer}' is not null then
      policy := jsonb_set(policy, '{taskTypes,designer:close}',
                          policy #> '{taskTypes,designer}');
      added := true;
    end if;
    if added then
      policy := jsonb_set(policy, '{version}', to_jsonb(
        case when policy ->> 'version' = '2026-10-31.1' then '2026-11-04.1'
             else (policy ->> 'version') || '+d324' end));
      update factory.settings
        set value = policy, updated_by = 'migration', updated_at = now()
        where key = 'model_routing_policy';
    end if;
  end if;

  added := false;
  select value into needs from factory.settings where key = 'model_output_token_needs';
  if needs is not null then
    if needs -> 'developer:close' is null and needs -> 'developer:code' is not null then
      needs := jsonb_set(needs, '{developer:close}', needs -> 'developer:code');
      added := true;
    end if;
    if needs -> 'designer:close' is null and needs -> 'designer' is not null then
      needs := jsonb_set(needs, '{designer:close}', needs -> 'designer');
      added := true;
    end if;
    if added then
      update factory.settings
        set value = needs, updated_by = 'migration', updated_at = now()
        where key = 'model_output_token_needs';
    end if;
  end if;
end
$$;
