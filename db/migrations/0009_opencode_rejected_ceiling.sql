-- 0009: the rejected-request ceiling for OpenCode runs (D-222, D-223). Never edit an earlier
-- migration; add a new one instead. No new table, column, role or grant.

-- OpenCode retries a retryable provider error itself, up to 5 times, so one Flex 429 becomes 6
-- requests (docs/spikes/opencode-runtime.md, check 1). With the ceiling at 5 the proxy answers
-- the sixth with 403 and the run ends budget_exceeded instead of usage_exhausted with cause
-- capacity. At 6 every request OpenCode makes reaches the provider. A value already above 6 is
-- left as it is. The settings trigger records the change in settings_log.
update factory.settings
  set value = '6'::jsonb, updated_by = 'migration', updated_at = now()
  where key = 'max_rejected_model_requests' and (value #>> '{}')::numeric < 6;
