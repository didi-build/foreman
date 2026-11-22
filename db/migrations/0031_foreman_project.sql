-- 0031: Foreman's own project row, on the cluster target (ADR 0118 slice 9, appendix G, D-441,
-- D-449, O-166). Never edit an earlier migration; add a new one instead. A privileged change for
-- Didi's review: one data row in factory.projects, and nothing else. No new table, column, role,
-- grant or policy. No personal data: a short name, a display name, a repository and fixed words.
--
-- Why: Foreman is built through its own pipeline with the cluster target (D-441). The runner reads
-- a project's target from its store row when it deploys (`deploy_target`, migration 0028), so
-- Foreman needs a row that names `cluster`. The New project form never records it: it refuses the
-- short name `foreman` and records only the Cloudflare target (D-435). Changing a project's target
-- is Didi's change (appendix G), which this reviewed migration is. Didi writes the matching project
-- file, projects/foreman.json in didi-build/foreman-projects, by hand (runbook, "Foreman as its own
-- project").
--
-- The row, shaped as the New project form shapes one (src/core/new-project.ts, `plannedProject`),
-- except where Foreman differs:
-- - slug `foreman`, name `Foreman` (the display name), repo `didi-build/foreman`;
-- - no Linear project and no gallery path override, as every new project;
-- - privileged_paths_extra `[]`: the shared list already holds every path appendix G names for
--   Foreman (`.github/**`, `infra/**` with the image pins, migrations and files named for secrets,
--   DEFAULT_PRIVILEGED_PATHS in src/core/guards/review.ts);
-- - prod_requires_approval true: every job that changes Foreman's production runs in an environment
--   with Didi as its required reviewer (runbook step 3, steps 9a and 15), and a release is
--   production (D-007); the merge guard `prod_env_protected` reads it;
-- - staging_url null: Foreman has no staging (D-449), and its own address, foreman.didi.build, is
--   production, never a staging link for the daily check;
-- - deploy_target `cluster`;
-- - a new random id (no database id is ever written into a file, AGENTS.md section 5) and the time
--   the migration runs.
--
-- Guarded like the earlier data migrations, so running it again changes nothing, and it never
-- changes an existing row:
-- - a row with the slug `foreman` that is exactly this row (all but its id and time) is left with
--   no NOTICE;
-- - a row with the slug `foreman` that differs in any way is left as it is, with a NOTICE naming
--   the columns that differ, so Didi decides;
-- - a row of another slug for the repository didi-build/foreman is left as it is and nothing is
--   inserted, with a NOTICE: the staging deploy finds a project by its repository, so two rows for
--   one repository would make its target unclear.
do $$
declare
  existing factory.projects%rowtype;
  other_slug text;
  differs text[] := '{}';
begin
  select * into existing from factory.projects where slug = 'foreman';
  if found then
    if existing.name is distinct from 'Foreman' then
      differs := array_append(differs, 'name');
    end if;
    if existing.repo is distinct from 'didi-build/foreman' then
      differs := array_append(differs, 'repo');
    end if;
    if existing.linear_project_id is not null then
      differs := array_append(differs, 'linear_project_id');
    end if;
    if existing.gallery_path_override is not null then
      differs := array_append(differs, 'gallery_path_override');
    end if;
    if existing.privileged_paths_extra is distinct from '[]'::jsonb then
      differs := array_append(differs, 'privileged_paths_extra');
    end if;
    if existing.prod_requires_approval is distinct from true then
      differs := array_append(differs, 'prod_requires_approval');
    end if;
    if existing.staging_url is not null then
      differs := array_append(differs, 'staging_url');
    end if;
    if existing.deploy_target is distinct from 'cluster' then
      differs := array_append(differs, 'deploy_target');
    end if;
    if cardinality(differs) > 0 then
      raise notice '0031 left the project foreman as it is: it differs from Foreman''s own row in %',
        array_to_string(differs, ', ');
    end if;
    return;
  end if;

  select slug into other_slug from factory.projects where repo = 'didi-build/foreman' limit 1;
  if found then
    raise notice '0031 recorded no row for foreman: the project % already names the repository didi-build/foreman',
      other_slug;
    return;
  end if;

  insert into factory.projects (
    id, slug, name, repo, linear_project_id, gallery_path_override, privileged_paths_extra,
    prod_requires_approval, staging_url, deploy_target, created_at
  ) values (
    gen_random_uuid(), 'foreman', 'Foreman', 'didi-build/foreman', null, null, '[]'::jsonb,
    true, null, 'cluster', now()
  );
end
$$;
