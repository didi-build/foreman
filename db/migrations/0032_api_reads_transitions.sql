-- 0032: the state API reads transitions (ADR 0119 slice 3b, D-470, O-168). Never edit an earlier
-- migration; add a new one instead. A privileged change for Didi's review (approve-once, wider
-- permissions): one read grant and one row policy for the state API's role, and nothing else.
--
-- Why. The item history route (`GET /context/items/:id/history`) shows a run an item's state
-- moves, for example from QA back to development with the reason. Until now `factory_api` could
-- not read `transitions` at all (0001). Didi granted the read on 2026-11-24 (D-470).
--
-- Own project only. The policy mirrors the role's other `api_read` policies exactly (0001): it
-- shows every row, `using (true)`, and the API scopes each read to the caller's project. As on
-- nodes, evidence, runs and decisions, the database does not check the project: a transition row
-- has no project column, and the API reads a node's transitions only after it has found that node
-- in the caller's project (src/core/context-reads.ts).
--
-- Read only. No insert, update, delete or truncate grant: only the runner writes a transition
-- (essential 1), and the table stays append-only for every role (0001). No index: the read is by
-- node, newest last, which `transitions_node_at (node_id, at)` already serves.
create policy api_read on factory.transitions for select to factory_api using (true);
grant select on factory.transitions to factory_api;
