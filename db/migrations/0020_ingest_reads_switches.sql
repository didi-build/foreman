-- 0020: the GitHub receiver reads the kill switch and dry run (D-291, D-327, D-329, O-101). Never
-- edit an earlier migration; add a new one instead. A privileged change for Didi's review: one
-- read grant and one row policy for the receiver's role, and nothing else.
--
-- Why. After it records CI's end on a design item's PR head, the receiver starts the option
-- capture flow when a capture is due (src/github-receiver/flow-starts.ts). Each start uses one of
-- the Windmill free plan's 1,000 runs a month (D-164), so under the kill switch or in dry run it
-- starts nothing, and it reads the two switches the way every flow does: the kill switch is on only
-- when set to true, and dry run is on unless set to false. Until now `factory_ingest` could not
-- read `settings` at all (0002). The rest of the due check needs only nodes, runs and evidence,
-- which it already reads, so no other grant is needed: whether capture already captured the head
-- is read from capture's own screenshots, not from gate requests.
--
-- Why no narrower path. A column grant cannot help: the store reads a setting as a whole row, and
-- a row holds only the key, its value and who changed it when. Copying the switches into the
-- receiver's environment would give it a second copy of the truth, which could disagree with the
-- store. So the role may select from `settings`, and row level security shows it exactly the
-- `kill_switch` and `dry_run` rows; every other setting stays invisible to it. It still cannot
-- insert, update or delete any setting (no such grant), and `settings_log` stays closed to it.
create policy ingest_read_switches on factory.settings for select to factory_ingest
  using (key in ('kill_switch', 'dry_run'));
grant select on factory.settings to factory_ingest;
