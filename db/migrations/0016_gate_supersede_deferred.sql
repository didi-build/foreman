-- 0016: a gate request's `superseded_by` is checked when the transaction commits (O-88). Never edit
-- an earlier migration; add a new one instead. No new table, role, grant or policy.

-- A newer request on a topic supersedes the open one in one transaction (schema invariant 5,
-- src/core/library.ts): the open one is closed with `superseded_by` naming the newer request,
-- then the newer one is inserted, since `gate_requests_one_open_per_topic` allows only one open
-- request per topic at a time. Checked at once, the reference named a row not yet inserted, so
-- every supersede failed on Postgres; the option capture slice's database test found it. Checked
-- at commit, the reference must still name a real request, and a transaction that never inserts it
-- fails as before.
alter table factory.gate_requests
  alter constraint gate_requests_superseded_by_fkey deferrable initially deferred;
