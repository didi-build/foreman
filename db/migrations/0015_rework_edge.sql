-- 0015: the `reworks` edge (D-233, Council slice follow-up). Never edit an earlier migration; add
-- a new one instead. No new table, role, grant or policy: the runner already inserts nodes and
-- edges.

-- When the Council gives `redo` to an item that is already merged, the runner opens a new work
-- item that undoes or reworks the merged change, and links it to the original with this edge:
-- from the rework item to the merged item (src/core/council.ts). None of the three earlier types
-- says that: `blocks` would hold the new item until the original is done, `split_into` is an
-- idea's split into work items, and `design_for` links a design item to its developer item.
alter table factory.edges drop constraint edges_type_check;
alter table factory.edges add constraint edges_type_check
  check (type in ('blocks', 'split_into', 'design_for', 'reworks'));
