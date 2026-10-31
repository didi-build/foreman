-- 0006: the agent runtime's handle on each run (ADR 0107, build plan M3.2). Never edit an earlier
-- migration; add a new one instead. No new table, role or grant: the runner already updates runs.

-- What the runtime's `start` returned, so a later flow can poll or cancel the run: the run-end
-- flow, and the kill switch's cancel pass (D-202). jsonb, not text: a handle is a small structured
-- value (the Kubernetes runtime's is its run id, namespace, run spec and limits), the runtime
-- interface keeps it generic, and jsonb stores it as given with Postgres checking it is valid
-- JSON. It holds no credential value: the runtime keeps those out of the handle. Null until the
-- run has started, and for a run that never started.
alter table factory.runs add column handle jsonb
  check (handle is null or jsonb_typeof(handle) = 'object');
