-- 0023: the cluster runs at most two agent runs at once (D-372, first-hosting runbook step 14).
-- Never edit an earlier migration; add a new one instead. A privileged change for Didi's review:
-- one setting, and nothing else.
--
-- Why. 0003 left agent_cluster_max_active_runs unseeded, so every dispatch is refused until it is
-- sized to the agents node. That node (2 vCPU / 4 GB, D-194) gives pods 2.5 GiB of memory
-- (DigitalOcean's DOKS limits page, read 2026-11-11). Each run reserves about 0.6 GiB (the agent
-- 512 MiB and its proxy 64 MiB, and QA's fetch step 128 MiB), and 1 GiB stays free for the repo
-- map's Job, so two runs fit. A third ready item waits and starts when a slot frees (O-104).
--
-- A value already set (by Didi, by hand) is left as it is. The insert is logged in
-- factory.settings_log like any other.
insert into factory.settings (key, value, updated_by, updated_at)
  values ('agent_cluster_max_active_runs', '2', 'migration', now())
  on conflict (key) do nothing;
