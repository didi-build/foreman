-- 0028: where each project's product runs (ADR 0118 appendix G, D-441, O-161). Never edit an
-- earlier migration; add a new one instead. A privileged change for Didi's review: one column on
-- factory.projects, and nothing else. No new table, role, grant or policy: the runner already
-- inserts and reads projects (0001), and factory_api reads them as before. No personal data: a
-- fixed word.
--
-- `deploy_target` is `cloudflare` or `cluster`, as a project file in didi-build/foreman-projects
-- names it (src/core/project-entry.ts). The New project form writes `cloudflare` for every new
-- project (D-435, D-441); the runner reads it when it deploys, and routes by it from slice 9 of
-- ADR 0118, which also gives Foreman's own row the cluster target through its own migration.
-- Every project recorded before this migration, the rehearsal among them, deploys to Cloudflare
-- today, so the default fills `cloudflare` in for each existing row. Changing a project's target
-- is Didi's change (ADR 0118 appendix G): no runner code updates a project row.
--
-- The display name needs no column: `name` (0001) holds it. The register-project form wrote the
-- slug there; the New project form writes the display name, and existing rows keep theirs.
alter table factory.projects add column deploy_target text not null default 'cloudflare'
  check (deploy_target in ('cloudflare', 'cluster'));
