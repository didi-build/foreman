-- 0022: Windmill's monthly execution limit follows the Team plan (D-369, amends D-167). Never edit
-- an earlier migration; add a new one instead. A privileged change for Didi's review: one setting's
-- value, and nothing else.
--
-- Why. Windmill Cloud counts one execution per job of up to one second and one more for each
-- further second, and its free plan allows 1,000 a month for the workspace and 1,000 for each user.
-- The reconcile pass every two hours alone needs more than that, so Didi chose the Team plan: one
-- seat, 10,000 executions a month. The reconcile pass's alert (80%, D-167) then warns at 8,000.
--
-- Only the seeded value is changed: a limit Didi has set to anything other than 1,000 is left as it
-- is. The change is logged in factory.settings_log like any other.
update factory.settings
  set value = '10000'::jsonb, updated_by = 'migration', updated_at = now()
  where key = 'windmill_monthly_execution_limit' and value = '1000'::jsonb;
