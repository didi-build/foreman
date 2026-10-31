-- 0007: the Flex capacity bounds (ADR 0114 section 9, build plan M3.2). Never edit an earlier
-- migration; add a new one instead. No new table, column, role or grant: the run columns for
-- capacity retries, their wait and the served tier came with 0005, and the runner already reads
-- settings.

-- flex_capacity_retries: how many times one run retries a Flex capacity rejection (a 429 with an
-- overload error) before it ends usage_exhausted with cause capacity. Each wait starts at 30
-- seconds and doubles, at most 5 minutes, and counts against the run's minute limit.
-- max_rejected_model_requests: how many model requests the run's egress proxy lets through after
-- the upstream answered 429. Those do not count against the model request ceiling, because a
-- rejected request is not billed; past this small ceiling the proxy answers 403 and the run ends
-- budget_exceeded, so a runtime that retries without end is stopped.
insert into factory.settings (key, value, updated_by, updated_at) values
  ('flex_capacity_retries', '3', 'migration', now()),
  ('max_rejected_model_requests', '5', 'migration', now());
