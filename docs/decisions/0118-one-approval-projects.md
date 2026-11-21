# 0118. One-approval projects, with backends on Cloudflare

- **Status:** decided by Didi in the design interview of 2026-11-19 and 2026-11-20 for roadmap sitting 4 (D-434 to D-441). The nine open points were settled by Didi on 2026-11-20 (D-442 to D-450). The technical design is proposed: nothing of it is built.
- **Date:** 2026-11-20
- **Related:** D-004, D-007, D-339, D-340, D-345, D-346, D-348, D-353, D-354, D-357, D-358, D-365, D-370, D-372, D-375, D-377, D-378, D-379, D-391, D-394, D-411, D-417, D-418, D-419, D-434 to D-441, N-92, N-103, N-104, O-109, O-112, O-113, O-114, O-116, O-126, O-140, [ADR 0101](./0101-repo-layout-and-tooling.md), [ADR 0106](./0106-agent-execution-environment.md), [ADR 0110](./0110-infrastructure-as-code.md), [ADR 0111](./0111-kubernetes-ready-conventions.md), [ADR 0115](./0115-foreman-app.md), [ADR 0116](./0116-planning-chat.md)

## Context

Adding a project today takes six steps and three approvals from Didi (first-hosting runbook, "Adding a project"):

1. A pull request on `foreman` adds the slug and quota to `projects` in `infra/kubernetes/settings/production.json`.
2. Didi approves the Platform apply, which makes the `agents-<slug>` namespace.
3. Didi approves the Infra apply, which makes the `<slug>.didi.build` record and Workers route.
4. Didi runs `f/foreman/register_project` (D-345), which creates the repository from Launchpad and records the project.
5. Launchpad's Bootstrap sets the repository up.
6. The project's credentials are added by hand.

The rehearsal also showed that Cloudflare refuses the route until the staging Worker exists, so a new project needed a second Infra apply after its first upload (O-112, O-140).

Didi had already decided the direction. A project is data, so its list leaves `foreman` for its own settings repository (D-377). Didi's approval of a new project in Windmill also covers its cluster and DNS changes, when they only add the project (D-378). Project backends are designed with this flow (D-419), since nothing deploys one today and projects will soon call models at runtime (D-417). Today's staging site is an assets-only Worker with no code and no secret (D-353).

The first real uses are planned: `foreman-app`, Foreman's own screens (D-391), and the proof of concept Didi brings in as a fresh project (D-418).

## Decision

1. **One form, one approval (D-434, D-435).** Didi starts a project from a "New project" form in Windmill. Running it is the one approval. The chat can send Didi the form's link. The planner or the Council preparing it prefilled comes later. The form asks four things: the short name (slug), the display name, a one-line purpose, and "will it collect personal data?", which defaults to yes. The slug becomes `didi-build/<slug>`, `<slug>.didi.build` and the agent space. It uses lowercase letters, digits and hyphens, and it never changes. Everything else is fixed: a public repository as today (D-348), the standard size, and the Cloudflare target.
2. **One standard size, on the factory side (D-436).** Every project gets the rehearsal's quota (O-126): 12 pods, 6 CPU, 5Gi memory, 11Gi ephemeral storage, 3Gi storage and 3 volume claims. It applies to the project's agent space only: its `agents-<slug>` namespace. The add-only route (D-378) applies only this size. A bigger size is a separate change that Didi approves.
3. **The factory and its products stay apart (D-437).** Foreman (the platform) and the agents (factory work, one namespace per project they build) are on one side. The projects' running products are on the other side, never in the factory's namespaces or on its nodes. In the interview this first meant product namespaces and a products node pool in the cluster, added with the first backend. D-439 replaced that the same day: products leave the cluster entirely, and no products node is added.
4. **Every project answers on day one (D-438).** A new project starts on staging with a placeholder landing page at `/` and a placeholder backend at `/api`.
5. **Backends run on Cloudflare (D-439).** A project's backend is part of its Worker, beside its static assets, with Cloudflare D1 as its database. The Launchpad template already deploys each project as a Worker with static assets. This replaces D-419's "Foreman runs it in the project's own namespace" and, for projects, D-353's code-free and secret-free sites (Foreman's own app is point 7). A project's model calls at runtime (D-417) use the project's own key, held as a Worker secret, with its spending limit set on the key at the provider, not in Foreman's egress proxy. The limits are those of Workers' request model: no long-running jobs, and only part of Node's APIs. If that is not enough, Didi revisits it. A project that needs long-running work could get a cluster backend as an exception (the cluster target of point 7).
6. **Product secrets live only on Cloudflare (D-440).** A "Set project secret" form in Windmill takes the project, the secret's name and its value. Foreman puts the value straight on the project's staging Worker and keeps no copy. It records only the name, so it can check that every secret the code needs is set. Secrets Foreman can make itself, such as a session signing key, it will set on its own later. Factory keys, the agents' model keys per project at `f/foreman/projects/<slug>/models/*`, stay in Foreman's Windmill workspace. Product secrets go only on the staging Worker, never on a pull request preview Worker, whose code is unreviewed.
7. **Deploy targets are adapters, and Foreman upgrades Foreman (D-441).** Foreman's app server stays in Foreman's cluster (D-394 kept): it is the factory. A deploy target is an adapter. Cloudflare is one, Foreman's own cluster is another, Foreman supports both, and every new project defaults to Cloudflare. Foreman itself, and with it `foreman-app`'s server side (D-394), is built through the same pipeline with the cluster target. Production and the privileged paths stay Didi's (D-007, AGENTS.md section 5).

## How it works, in short

The details are in the technical design (appendix sections A to G).

- **A settings repository (D-377).** Proposed name `didi-build/foreman-projects`: public, one JSON file per project, written by the New project form as the runner App. The Platform and Infra workflows in `foreman` read it at one commit per run and print that commit. The standard size stays in `foreman`. The rehearsal moves over as one file, and both plans must then show no change (A).
- **The add-only rule (D-378).** A run is add-only when the cluster and Cloudflare already match `foreman`'s main and the existing projects, and the only difference is the new projects' standard objects. Then an apply job with no reviewer applies it. Anything else, including drift or a Foreman change Didi has not approved yet, waits for Didi as today. Any doubt fails closed to Didi's approval (B).
- **The New project form.** After its checks, it makes the D1 database, then a placeholder Worker, then the settings file. It starts the Platform and Infra runs, creates the repository, records the project, and restarts Bootstrap with the display name and the personal-data answer. Each step finds before it creates, so running the form again completes what is missing and creates nothing twice (C).
- **The Set project secret form.** The value field is a Windmill password field: Windmill keeps only a reference in the run's history, and the flow deletes the short-lived secret variable once the value is on the Worker (D).
- **The template.** Launchpad gains a Worker module serving `/api` beside the assets at `/`, one D1 binding, a `migrations/` folder, a placeholder landing page, no hosted previews (D-446), and Bootstrap inputs for the display name and the personal-data answer (E).
- **Cloudflare access.** Today's staging deploy token already covers every Worker call, secrets included. The only new right is D1, proposed as one new token with D1 Edit only. Names and routes still come from the infra plan, never from the runner (F).
- **Deploy targets.** A `DeployTarget` port over today's staging deploy, with the Cloudflare adapter extended and a first, small cluster adapter for Foreman itself. The cluster adapter never applies to the cluster: Didi approves each release of Foreman (G).

## What changes for earlier decisions

| Decision     | What happens to it                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-345        | Replaced by D-434 and D-435: one form with four fields, which writes the settings entry itself. No pull request on `foreman`. Kept: the repository name equals the slug, staging updates on every push to main with no approval, a project starts with no production, and every project shares the privileged paths.                                                                                                                                                                      |
| D-346        | Kept: the runner App creates the repository with the same narrow token. The form also mints two other narrow tokens (D-443).                                                                                                                                                                                                                                                                                                                                                              |
| D-339        | Amended by D-378 as designed here: adding a project no longer needs Didi's approval in GitHub when the change is add-only. Every other admin change still does.                                                                                                                                                                                                                                                                                                                           |
| D-353        | Kept: Foreman deploys staging itself from CI's build, with no secret in CI and no deploy secret in any project repository. Replaced for projects: the staging Worker is no longer assets-only. It runs the project's backend, with its D1 database and its product secrets held by Cloudflare. Replaced: "the backend runs in the project's own cluster namespace".                                                                                                                       |
| D-357        | Kept: one proxied name and one route per project, made only by the infra plan. When the change is add-only, the form's approval covers it (D-378). The room D-357 left for "a same-origin `/api` to the project's backend" is now used inside the Worker.                                                                                                                                                                                                                                 |
| D-375, D-379 | The rehearsal, `rehearsal`, moves to the settings repository as one entry, with its quota.                                                                                                                                                                                                                                                                                                                                                                                                |
| D-377, D-378 | Carried out by appendix sections A and B.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D-394        | Kept: Foreman's app server stays in Foreman's cluster (D-441). One of its reasons, "break D-353's code-free project sites", no longer applies to projects. Its other reasons stand for Foreman's own app: its model keys and its Foreman token stay off Cloudflare.                                                                                                                                                                                                                       |
| D-417        | Amended: a project's model calls at runtime come from its Worker, with its own key as a Worker secret and the spending limit on that key at the provider, not through the egress proxy. The egress proxy stays for the agents.                                                                                                                                                                                                                                                            |
| D-419        | Replaced in part: CI builds the Worker bundle with no secret, and Foreman deploys it to the staging Worker with its D1 database, instead of a server image in the project's namespace. Kept: staging first at `<slug>.didi.build/api`, the project's own keys and database, health and staging checks, production Didi's. The money gate is now Cloudflare's paid plan, not more room in the cluster. Its question about Foreman's own app is answered by D-441: it stays in the cluster. |
| N-92         | Answered by D-435: the form asks whether the project collects personal data, and Bootstrap gets the answer (appendix C, step 7).                                                                                                                                                                                                                                                                                                                                                          |

## Constraints

- Only a project's `slug`, `quota` and `deployTarget` reach the cluster or DNS. Its display name, purpose and personal-data answer are for people and for Bootstrap.
- An add-only apply never deletes, never changes an existing object except the run watcher's namespace list, and never applies a size other than the standard one. Any doubt sends the run to Didi's approval.
- No product secret value is kept by Foreman, in Windmill's run history or in a log. The secret form never returns it.
- Product secrets go only on `<slug>-staging`, never on a preview Worker.
- No project repository holds a deploy credential (D-353), and no database id is committed (AGENTS.md section 5).
- Cloudflare stays in the deploy adapter and in `infra/modules/platform/cloudflare/` (AGENTS.md section 3, D-146).
- The runner never gets admin access to the cluster (D-340) and never makes a DNS name or route (D-357).
- Products never run in the factory's namespaces or on its nodes (D-437).
- Production deploys stay Didi's (D-007).

## How success is judged

- Didi runs the form once and gives no other approval. Within minutes, `agents-<slug>` exists with the standard quota, `https://<slug>.didi.build/` shows a landing page and `https://<slug>.didi.build/api/health` answers. Once Bootstrap and CI finish, the template's own landing page and backend placeholder replace Foreman's.
- Running the form again after a failure at any step completes the rest and creates nothing twice. Unit tests cover a failure at each step, and it is tried once for real.
- After the rehearsal moves, the Platform plan and the Infra plan both show no change.
- A settings change that is not add-only waits for Didi's approval: a bigger quota, a removed project, another target, or a pending Foreman change. Tests cover each case of appendix B with fixtures.
- A secret set through the form reaches the Worker, Windmill's run shows only a `$var:` reference, the short-lived variable is gone, and the secret is still there after the next deploy.
- A change to Foreman merges through the normal flow and waits, listed in the daily check, for Didi's Platform apply.

## Reasons

- **A separate repository** keeps `foreman` free of per-project changes, as Didi asked (D-377), and keeps the plans reproducible from versioned files with no database login in the admin workflows.
- **One file per project** makes the form's write create-only: it cannot overwrite another project, and a commit that adds a project adds exactly one file.
- **Comparing against the live cluster and state**, not only against the previous settings, is what makes "add-only" true. A pending Foreman change or drift would otherwise ride along with a new project unreviewed.
- **The placeholder Worker before the settings file** follows the rehearsal's lesson (O-140): the route needs the Worker, so the name and route then apply in one run.
- **Bootstrap inputs** carry the display name and the personal-data answer with the permission the form already uses for the restart (D-358). A repository variable would need a new "Variables" permission for the runner App.
- **Backends on Cloudflare** were Didi's choice (D-439): no new node or products pool, the template is already a Worker, and D1 is free for a handful of projects.

## Consequences

- Adding a project no longer changes `foreman` (D-377), and a new project needs one approval (D-434, D-378).
- Two new GitHub environments hold admin credentials with no reviewer. The add-only check, in privileged files Didi reviews, is their only guard.
- Project code now runs on Cloudflare with its own data and secrets. A bad change merged by Foreman can read the project's secrets, including its model key. QA's review, no hosted previews, and the spending limit on the key at the provider bound the harm. Before D-439, the egress proxy kept the key away from the code.
- Each project holds one D1 database, even if it never uses it; on Workers Paid that has no practical limit (D-450).
- Removing a project is still not built: its settings file, namespace, Worker, database and repository stay until a removal path exists, which is a drop-data gate (D-411).

## Costs

In short; details and sources in appendix H.

- **Cluster:** no new node. A project adds a namespace, and its quota is a cap, not a reservation (O-126). How many runs go at once stays bounded by the cluster limit on the one agents node (D-194, D-372). More runs at once would need a bigger node: Didi's money gate.
- **Cloudflare, per project** (the account is on Workers Paid, D-450; the Free plan's figures are kept for reference): one Worker (100 per account), one D1 database (10 per account), the name and route (free), and asset requests (free and unlimited). Requests to `/api` share 100,000 a day across the account. Each request gets 10 ms of CPU and 50 subrequests. D1 allows 5 million rows read and 100,000 rows written a day, and 5 GB stored, across the account, with at most 500 MB per database.
- **Workers Paid,** 5 USD a month per account, is already in place (D-450), so those limits do not apply and this design adds no cost. Usage beyond the paid plan's included amounts (appendix H) would be billed and is watched in Cloudflare's dashboard.
- **Unchanged:** GitHub (public repositories, D-348) and Windmill (one execution per form run, against the Free plan's 1,000 a month).
- **Each project's runtime model key** (D-417) is the project's own spend, with its limit at the provider. Creating it is Didi's gate, for money and for the new credential.

## Open points, settled (D-442 to D-450)

Didi answered the nine open points on 2026-11-20, one at a time.

1. **The settings repository (D-442):** `didi-build/foreman-projects`, public, created by Didi once by hand with the ruleset in appendix A, so that only Foreman's form adds files.
2. **The runner App's existing permissions in new places (D-443):** `contents: write` narrowed to `foreman-projects` for the settings file, and `actions: write` narrowed to `foreman`, minted only by the form's start step, which makes only the two workflow start calls.
3. **The add-only environments (D-444):** `platform-add-project` and `infra-add-project`, with no reviewer, `main` only, holding copies of today's credentials, guarded by the add-only check, with each unreviewed apply listed in the daily check.
4. **Cloudflare access for the databases (D-445):** one new account-owned token with D1 Edit only, used only by the code that creates databases and applies migrations. The staging deploy token is not widened; it already covers Worker secrets. Names and routes stay in the infra plan (D-357). Didi creates the token when slice 4 comes.
5. **Pull request previews (D-446):** no database and no secret on previews, and no hosted pull request previews at all: the template's preview workflow and `wrangler.preview.jsonc` are removed (as D-354 did for Foreman). CI's `preview-check`, which builds and serves the site inside CI and deploys nothing, stays as QA's evidence.
6. **Where staging databases live (D-447):** the location hint `enam` (Eastern North America).
7. **A secret the code needs that is not set (D-448):** the staging deploy holds as an infrastructure refusal that names the missing secret and the form, counts no failure, shows in the daily check, and deploys on the next pass once the secret is set.
8. **How a Foreman self-upgrade item finishes (D-449):** Done at merge, with a daily-check line "Foreman upgrade waiting for your Platform apply" until Didi applies; a contract change in `docs/spec.md`. A/B deployments for Foreman, which would give it a real staging step, are a later idea.
9. **The Workers plan (D-450):** Didi's account is already on Workers Paid, so the Free plan's limits (10 databases, 10 ms of CPU per request) do not apply, and no new cost comes from this design.

## Build plan

Each slice is one pull request, in this order. Slices 3 and 4 can be built while slice 2 is in review. No project should be registered between slice 5 (the template) and slice 6 (the form): a template build with a database binding needs the database that only the new form makes.

1. **The settings repository, read; the rehearsal moves** (`foreman`).
   - Before it: Didi creates the repository (D-442) with its ruleset, and adds the marker file and `projects/rehearsal.json` (appendix A).
   - Delivers: `src/core/project-entry.ts`, the entry rules and the standard size. `infra/kubernetes/render.ts` reads the platform settings and the projects folder. `production.json` loses `projects` and gains `projectStandardQuota`. The factory stack reads the project files and requires the marker. Both workflows resolve the settings repository's commit (with the `projects_commit` input) and print it, and the validate job checks the repository out too. The form's settings read moves (`src/adapters/github/project-settings.ts`).
   - Privileged paths: `.github/workflows/platform.yml`, `.github/workflows/infra-apply.yml`, `.github/workflows/infra.yml`, `.github/scripts/**`, `infra/**`.
   - Didi after: merges, then checks that both plans show no change.
2. **The add-only rule and its applies** (`foreman`).
   - Delivers: the candidate list in the render job, the live checks in the plan jobs, the two add-only apply jobs, and the summary lines. Tests use fixture plans for each case in appendix B. The daily check lists unreviewed applies.
   - Privileged paths: the two workflows and `.github/scripts/**`.
   - Didi after: creates the two environments (D-444), pastes the existing secrets, and merges.
3. **A Worker with code in the deploy adapter** (`foreman`).
   - Delivers: the `DeployTarget` port (`src/core/deploy-target.ts`) over `StagingTarget`. `site-files.ts` reads the new build layout and the old one. The upload carries the module, `keep_bindings` and `run_worker_first`. The staging check probes `/api/health` when the build has a Worker.
   - Privileged paths: none expected.
   - Didi after: reviews.
4. **Project setup on Cloudflare** (`foreman`).
   - Delivers: the database found or created, the placeholder Worker, the inherited `DB` binding, and the secret put and list calls, all in `src/adapters/deploy/cloudflare-staging.ts` with `ALLOWED_CALLS` extended.
   - Privileged paths: none expected.
   - Didi after: creates the D1 token (D-445) and stores it in Windmill.
5. **The template** (`didi-build/launchpad`).
   - Delivers: Bootstrap with D-358's lock (1) as O-113 built it for Foreman, plus the two inputs; the Worker, the landing page, the D1 binding and `migrations/`; the preview workflow and its Worker config removed (D-446); nodrift's binding entry; CI's local probe and the new `staging-site` layout; `init-project`'s database name; the docs (appendix E).
   - Privileged paths in Launchpad: `.github/**`, `docs/privacy/**`, `**/migrations/**`.
   - Didi after: reviews and merges in Launchpad.
6. **The New project form** (`foreman`).
   - Delivers: `flows/new-project.ts` and `src/core/new-project.ts`; the settings-write and start tokens; a migration for the store's `deploy_target` (and `name` as the display name); the runbook's "Adding a project" rewritten. `f/foreman/register_project` is retired.
   - Privileged paths: `db/migrations/0028_*.sql`.
   - Didi after: approves the Windmill deploy. Didi runs the form in dry run, then for a throwaway project, and checks that the add-only applies ran with no approval and that the placeholder answers.
7. **The Set project secret form** (`foreman`).
   - Delivers: `flows/set-project-secret.ts` and its core; the deploy's schema for the password field; the scopes and the deletion of the short-lived variable; the names table (a migration); the required-secret check at deploy.
   - Privileged paths: the new files (`**/*secret*`), `.github/scripts/windmill-deploy.sh`, the migration.
   - Didi after: approves the deploy. Didi sets a test secret on the throwaway project and checks the run's arguments and the variable's removal.
8. **D1 migrations on staging** (`foreman`).
   - Delivers: the deploy applies new `migrations/*.sql` files to `<slug>-staging` with the D1 token before it uploads, and records them in `d1_migrations`. A migration that fails is the change's own failure, like a refused file set.
   - Privileged paths: none in `foreman`.
   - Didi after: nothing new.
9. **Deploy targets and Foreman as its own project** (`foreman`).
   - Delivers: routing by target; the cluster adapter's first build (appendix G); the stack skipping names for cluster-target projects; Foreman's store row (a migration).
   - Privileged paths: the migration, `infra/**`.
   - Didi after: commits `projects/foreman.json` and approves its Platform plan (`agents-foreman`).

Later, each its own design or decision: the chat sending the form's link (with ADR 0116's chat), the planner or Council prefilling the form (D-434), generated secrets (D-440), removing a project, a project's production (D-007), the cluster adapter proposing Foreman's new image pins itself, and a cluster backend for a product as an exception (D-439).

## Technical design (appendix)

### A. The settings repository (D-377)

**Shape.** No code and no secret:

```
foreman-projects.json   {"schema": 1}: marks a checkout as this repository
projects/<slug>.json    one file per project
README.md               the format, and a link to this ADR
```

A project file, shown for the rehearsal as it moves over (D-375, D-379). Its display name, purpose and personal-data answer are what Bootstrap gave `didi-build/rehearsal`, and its date is the repository's first commit:

```json
{
  "schema": 1,
  "slug": "rehearsal",
  "displayName": "Rehearsal",
  "purpose": "Foreman rehearsal: a throwaway project for testing the factory end to end.",
  "collectsPersonalData": true,
  "quota": {
    "pods": 12,
    "cpu": "6",
    "memory": "5Gi",
    "ephemeralStorage": "11Gi",
    "storage": "3Gi",
    "persistentVolumeClaims": 3
  },
  "deployTarget": "cloudflare",
  "createdOn": "2026-11-13"
}
```

**Rules.** The rules live in one place in the core, a new `src/core/project-entry.ts`. The form uses them when it writes, and the render job when it reads:

- exact fields, and a file name equal to `<slug>.json`;
- the slug rule of section C, step 1;
- a display name of at most 60 characters and a purpose that follows `checkDescription` (at most 200), both one line with no control or format characters;
- `deployTarget` either `cloudflare` or `cluster`;
- `createdOn` a date.

The standard size stays in Foreman. `production.json` keeps `platform` and `eval`, loses `projects`, and gains `projectStandardQuota` with today's values. Changing the standard is a Foreman change that Didi reviews. Each project file states its quota in full, so changing the standard later never changes an existing project silently.

**Who writes it.** The New project form, as the runner App (D-346, D-347). The token is minted for one write, narrowed to `foreman-projects` with `contents: write`, through the shared mint that refuses a wider grant (`src/adapters/github/narrow-tokens.ts`). The App already holds Contents read and write for its merges (D-365) and is installed on every repository of `didi-build` (D-347), so it gains no permission (D-443). The write is GitHub's "Create or update file contents" without a `sha`. GitHub requires the file's sha to replace an existing file, so the write can only create; the exact status GitHub answers for an existing file is checked in slice 6. The commit message names the form and its Windmill run.

**The ruleset.** The settings repository's `main` gets a ruleset (free on public repositories): restrict updates, restrict deletions, and block force pushes. The runner App and the repository's admins (Didi) are on the bypass list. The Developer, Designer and QA Apps are installed on every repository too (D-347), so this is what stops them pushing there. Didi can still change a file by hand, for example to give a project a bigger size (D-436). Such a change is not add-only, so its plans wait for Didi.

**How the workflows read it.** Both workflows stay in `foreman` and keep their triggers on `foreman`'s main. Each also takes a `workflow_dispatch` input, `projects_commit`. At its start, a run resolves the settings repository's `main` to a commit with `git ls-remote` (public, no token). It checks that `projects_commit`, when given, is that commit or one of its ancestors. Then it uses the resolved commit in every job and prints it in the summary. Taking `main`'s head, not the input, means an older list is never applied after a newer one.

- **Platform** (`.github/workflows/platform.yml`). The `render` job checks out the settings repository at that commit (`actions/checkout` with `repository`, `ref` and `persist-credentials: false`). `infra/kubernetes/render.ts` takes the platform settings and the `projects/` folder, checks every file (one bad file stops the render), and sorts projects by slug, so `AGENT_NAMESPACES` keeps a stable order.
- **Infra** (`.github/workflows/infra-apply.yml`, and `infra.yml` for validation). The plan job checks the settings repository out into a fixed, git-ignored folder. `infra/stacks/factory/main.tf` reads the marker with `file()`, which fails the plan if the folder is missing, then each `projects/*.json` with `fileset()`. O-112 refused to pass the list in as a variable, because an empty list plans to delete every project's name. The marker keeps that guard, and the add-only rule sends any delete to Didi (B). The stack makes a record and a route only for `deployTarget: "cloudflare"`, so a cluster-target project gets neither, as `foreman` gets neither today.
- **The forms** read the settings repository instead of `production.json`'s `projects` (`src/adapters/github/project-settings.ts`), still with the runner App's read-only `contents` token, now narrowed to `foreman-projects`.

**The rehearsal moves as one entry (D-377).** First, a commit in the settings repository adds the marker and `projects/rehearsal.json`. Then one `foreman` pull request switches the render, the stack and the forms to the settings repository and removes `projects` from `production.json`. After it merges, the Platform plan and the Infra plan must both show no change. The Infra resources are keyed by host name and the namespace objects by slug, so moving the list's source changes nothing. That empty plan is the proof that nothing was lost.

### B. The add-only rule (D-378)

**The idea.** A run is add-only when two things hold. The cluster and Cloudflare already match `foreman`'s main and the projects already set up. And the only difference is the standard objects of the new projects. Anything else waits for Didi's approval as today, including drift and a pending Foreman change that Didi has not approved yet.

The check fails closed. A failed read, an unknown field, a script error or any doubt sends the run to the reviewed apply job, never to the unreviewed one, and never to no apply.

**The jobs.** Each workflow gets a second apply job, in a new environment with no reviewer that accepts main only: `platform-add-project` and `infra-add-project` (D-444). The plan job sets `add_only` to `true` or `false`. When the plan has changes, the reviewed apply runs if `add_only` is false and the add-only apply runs if it is true. The workflow files and `.github/scripts/` are privileged paths that Didi reviews (D-339), so an agent's pull request cannot change the rule.

**Platform: what is compared.**

1. In the `render` job, which has no secret and is the only job that runs the repository's TypeScript: every project file passes section A's rules. The job lists the candidates: projects whose `quota` equals `projectStandardQuota` field by field and whose `deployTarget` is `cloudflare`. A candidate's objects are, by construction, `agentNamespaceObjects(slug, quota)` (`src/adapters/agent-runtime/kubernetes/namespace.ts`): the Namespace, the default-deny NetworkPolicy, the ResourceQuota, and the runner's and the run watcher's Roles and RoleBindings. That is seven objects.
2. In the `kubectl-diff` job, which holds the cluster credential: the new namespaces are those `platform-plan.sh` already finds missing on the cluster. Each new namespace must be a candidate's, with at most three in one run (a cap that fails closed if something writes many entries at once).
3. A base list is made from the rendered objects with `jq`: the new namespaces' objects are left out, and the run watcher's `AGENT_NAMESPACES` (`infra/kubernetes/platform.ts`) is set back to the list without them. `kubectl diff --server-side` of the base list must find no change at all. This proves the cluster matches `foreman`'s main and the existing projects exactly: no pending image and no drift.
4. The full list's plan must then be exactly a create for each of the seven objects of each new namespace, plus one update: the run watcher's Deployment. Adding a project is not purely additive, because the watcher's namespace list changes and the watcher restarts (runbook step 7 already says so). Step 3 shows that this is the only change to that Deployment.

The add-only apply job repeats steps 2 to 4 with its own short-lived credential just before it applies, so a change between the plan and the apply sends the run back to Didi. It then applies the rendered objects and runs the same checks as the reviewed apply (`platform-checks.sh`: the RBAC `can-i` list, default deny, and pods on their pools), which now cover the new namespace.

**Infra: what is compared.** The plan job already reads the plan's JSON form for addresses, types and actions only (`changes.json`, ADR 0110 secrets rule 5). The rule reads nothing more:

1. Every change that is not a no-op or a data-source read is a `create`. There is no update, delete or replace.
2. Each create is either `module.edge.cloudflare_dns_record.project["<slug>.didi.build"]` or `module.edge.cloudflare_workers_route.project["<slug>.didi.build"]`. Both are there for each such slug, and the slug is a candidate in the settings commit.
3. There are at most three slugs, and the plan's own count is two creates per slug.

The values come from the reviewed module (`infra/modules/platform/cloudflare/projects.tf`): an AAAA record to `100::`, proxied, and the route `<slug>.didi.build/*` to `<slug>-staging`. A change to that module changes every existing project's record or route, which shows as an update and so is not add-only. OpenTofu refuses to apply a saved plan once the state has moved, so the add-only apply applies exactly the plan it checked.

A route created alone, for a project whose record already exists, is not add-only. That is the retry O-112 needed, and the form now avoids it by making the Worker first (C, step 2).

**What Didi sees.** Each add-only run writes its summary as today, headed "Add-only: applied without approval (D-378)", with the settings commit and the new namespaces and names. The next daily check lists each one, so nothing applies unseen. A run that is not add-only gives the reason in one fixed line, for example "the cluster differs from main outside the new project", and waits for Didi as today.

### C. The New project form, step by step

`f/foreman/new_project` (`flows/new-project.ts`, with its core in `src/core/new-project.ts`, built from `src/core/register-project.ts`) replaces `f/foreman/register_project`. Didi starts it from its page in the Windmill workspace, signed in (O-97). No schedule, pass or service starts it. Its fields are one box each (D-376): `slug`, `displayName`, `purpose`, and `collectsPersonalData`, a box ticked by default.

**Checks, before any effect.**

1. **The input.** The slug is 1 to 47 lowercase letters, digits or hyphens, starts and ends with a letter or digit, and has no two hyphens together. That is the agent namespace's rule (`checkSlug` in `src/adapters/agent-runtime/kubernetes/names.ts`), which is stricter than today's `PROJECT_SLUG` (up to 100 characters) and also fits the Worker name `<slug>-staging` and a DNS label. Refusing two hyphens together keeps names clear of DNS's reserved `xn--` form. `foreman` is reserved (G). The display name and purpose follow section A's rules.
2. **The switches**, read as the other Didi forms read them. The kill switch refuses before anything is read. Dry run only reads, and says what each step would do.
3. **Not taken, or taken by an earlier run of this form.** Each must hold:
   - the settings file `projects/<slug>.json` is absent, or present with exactly these values (a re-run);
   - the store has no project with the slug, or one this form recorded;
   - the repository `didi-build/<slug>` is absent, or public and generated from `didi-build/launchpad` under exactly this name (today's reuse rule);
   - a public DNS lookup of `<slug>.didi.build` finds nothing, unless the settings file is already there.

   A file with other values, a repository from elsewhere or a name in use refuses with fixed text, and nothing is created.

4. **Foreman's own settings**, read from `foreman`'s main as today, give the standard quota the file will carry.

**Effects, in order.** Each step finds before it creates, so running the form again after a partial failure completes the rest and creates nothing twice.

| Step | What                                                                                                                                                                                   | Found first by                                                                                                | Why at this point                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | The D1 database `<slug>-staging`, with the location hint `enam` (D-447)                                                                                                                | Cloudflare's list by name, matched exactly                                                                    | The placeholder Worker binds to it                                         |
| 2    | The placeholder Worker `<slug>-staging`                                                                                                                                                | A read of whether the Worker exists. If it does, the step is skipped, so a re-run never replaces a real build | The route needs the Worker (O-112, O-140)                                  |
| 3    | The settings file `projects/<slug>.json`                                                                                                                                               | The create-only write. On a re-run the file is compared                                                       | The cluster and DNS pieces read it                                         |
| 4    | The Platform and Infra runs, started with `projects_commit`                                                                                                                            | None needed: starting them again is harmless, since a plan with nothing to do applies nothing                 | They take minutes, so they run while the repository is set up              |
| 5    | The repository from `didi-build/launchpad`, public, with the purpose as its description                                                                                                | Today's rule (D-346, O-109)                                                                                   |                                                                            |
| 6    | The store's project row: `name` is the display name, `deployTarget` is `cloudflare`, staging is `https://<slug>.didi.build`, and there is no production (D-345)                        | The slug's unique key, as today                                                                               | The staging deploy refuses a repository that is not a registered project   |
| 7    | Bootstrap: the repository is added to `BOOTSTRAP_TOKEN`'s selected repositories, and Bootstrap is started again on main with two inputs, the display name and the personal-data answer | Today's resume rule (D-358, O-114)                                                                            | Bootstrap's push starts CI, and CI's build starts the first staging deploy |

**The placeholder.** Step 2 uploads Foreman's own fixed site and tiny module, kept in the Cloudflare adapter. It serves a page at `/` with the display name and "being set up", and answers `/api/health` with `{"status":"placeholder"}`. It carries the `DB` binding to the database of step 1. It answers as soon as the Infra run makes the name and route (D-438). The first staging deploy of the template's build replaces it (E).

**Bootstrap's inputs.** Step 7's inputs answer N-92: a project that will not collect personal data starts without nodrift's scaffolding. The form starts Bootstrap through GitHub's dispatch call with `inputs`, which the template declares (E). No repository variable is set, so the runner App needs no "Variables" permission.

**After the form.** Bootstrap pushes its init commit. CI on main keeps the build, the receiver starts the staging deploy (O-116), and Foreman uploads the template's landing page and `/api` placeholder. The agents' namespace is ready when the first plan's items run.

**What Didi sees.** The form returns `created`, or `completed` on a re-run, `dry_run`, or `refused` with fixed text, like today's refusals. It gives one line per step: the database created or reused, the placeholder uploaded or skipped, the settings commit, the two workflow runs (as links), the repository, the record, and Bootstrap's run. Then it says what to expect next: "In a few minutes `https://<slug>.didi.build` shows the placeholder. Once Bootstrap and CI finish, it shows the template's landing page." The form does not wait for the workflows. Running it again shows what is done and starts what is not. If a workflow run is not add-only, its line says that it waits for Didi's approval in GitHub.

**Tokens.** The form mints each GitHub token for its one step (D-346): the repository creation token as today, `contents: write` on `foreman-projects` for the settings file, `actions: write` on `foreman` for the two starts (D-443), and the D-358 tokens for Bootstrap. Its Cloudflare calls use the staging deploy token and the new database token (F).

### D. The Set project secret form

`f/foreman/set_project_secret` (`flows/set-project-secret.ts`; its name puts it under the privileged pattern `**/*secret*`). Its fields are `project` (a slug), `name` and `value`.

**How Windmill stores arguments.** This was checked on 2026-11-20 against Windmill's docs and its source on `main`. Windmill Cloud may run another version, so slice 7 confirms it with a test secret.

- A job's arguments are stored with the job and shown in its run history to anyone who can see the run. A plain string field would keep the pasted value there.
- A field marked "Is Password" (`password: true` in the script's schema) works differently. As Didi types, the form saves the value as a secret variable at `u/<username>/secret_arg/<random>`, set to expire 7 days later (`mintEphemeralSecret` in `frontend/src/lib/components/secretArgUtils.ts`). The job's arguments hold only `$var:<that path>`.
- When the job starts, the worker reads that variable with the job's own token (`transform_json_value` in `backend/windmill-worker/src/common.rs`).
- Windmill masks secret values of 8 characters or more in job logs.

So the form uses a password field, and the flow deletes the variable once the value is on the Worker. That is D-440's short-lived secret variable, made by Windmill rather than by Didi first. Three things follow:

- **The deploy must send a schema for this script.** Foreman's Windmill deploy sends no schema today; Windmill infers each form from `main` (`.github/scripts/windmill-deploy.sh`). Windmill's TypeScript parser has no password type (`windmill-parser-ts`). So the deploy sends a schema for this one script, with `password: true` on `value`, from a new field in `flows/windmill.yaml`.
- **The form's scopes must cover Didi's short-lived variables.** Its `job_token_scopes` add write on `u/<Didi's username>/secret_arg/*` (write includes read), because the worker reads the variable with the job's token and the flow deletes it. The username can be supplied at deploy time rather than committed.
- **The flow finds the variable's path in its own job.** It reads `GET /api/w/<workspace>/jobs_u/get/<its own job id>`, a route Windmill leaves open to a job's own token whatever its scopes (`is_own_job_runtime_route` in `backend/windmill-api-auth/src/scopes.rs`), and deletes exactly that path. If either step fails, the variable still expires on its own after 7 days, and the form says so.

If a password field cannot be made to work, the fallback is the other form of D-440: Didi saves a secret variable in a folder only this form can read, the form takes its path, and the flow deletes it after use.

**Steps.**

1. The kill switch refuses. Dry run checks and deletes the variable but sets nothing.
2. Checks: the project is registered with the Cloudflare target; the name is 1 to 64 uppercase letters, digits or underscores, starts with a letter, and is not a binding Foreman sets (`DB`, `ASSETS`); the value is not empty and is at most 5 KB, Cloudflare's size limit for a Worker variable.
3. `PUT /accounts/<account>/workers/scripts/<slug>-staging/secrets` with `{"name", "text", "type": "secret_text"}`, using the staging deploy token. The adapter allows this call only for the project's staging Worker name, so no product secret can reach a preview Worker (D-440).
4. The name and the time go into a new append-only table (a migration). The variable is deleted. The form returns the project and the name, never the value.

**Keeping secrets across deploys.** Every staging upload sends `keep_bindings: ["secret_text", "secret_key"]` in its metadata. Without it, Cloudflare would drop the secrets on the next deploy.

**Checking that every secret is set.** The project lists the names its Worker needs in a committed file (E), and CI copies the list into the build's manifest. Before each upload, the deploy compares that list with the names Cloudflare lists for the staging Worker (`GET .../secrets`, which gives names and types only). Open point 7 decides what a missing name does.

### E. The template (Launchpad, a later pull request)

In `didi-build/launchpad`:

1. **Bootstrap.** First, carry out D-358's lock (1) in the template. O-113 built it for Foreman's own copy (`.github/workflows/bootstrap.yml` with `.github/scripts/bootstrap-*.mjs`) and noted that Launchpad needed the same change before the first project was registered. Launchpad's Bootstrap still passes `BOOTSTRAP_TOKEN` to `scripts/bootstrap.mjs`, template code outside `.github/`, and `didi-build/rehearsal` was set up that way. Then add two `workflow_dispatch` inputs, `display_name` and `collects_personal_data` (`yes` or `no`). They are passed through the environment, never written into a `run:` line, and used in place of the display name derived from the repository's name (`deriveInitArgs` in `scripts/lib/bootstrap.mjs`) and of the repository variable `LAUNCHPAD_COLLECTS_PERSONAL_DATA`.
2. **The Worker.** A small module, for example `src/worker/index.ts`, with a fetch handler. `/api/health` answers `{"status":"ok"}`, and any other `/api/*` path answers a JSON 404. `wrangler.jsonc` gains `main`, `assets.run_worker_first: ["/api/*"]` (so only `/api` invokes the Worker and asset requests stay free), and one D1 binding, `DB`, with `database_name` `<slug>-staging` and `migrations_dir` `migrations`. The real database id is never committed (AGENTS.md section 5). The file holds a placeholder for local runs, and Foreman binds the real database at deploy (F). Slice 5 checks that Wrangler accepts the placeholder for local runs.
3. **The landing page.** A placeholder page at `/` with the project's display name and purpose. The component gallery stays at `/gallery`.
4. **Previews.** The hosted preview workflow (`.github/workflows/preview.yml`) and `wrangler.preview.jsonc` are removed, and the docs stop asking for a preview token (D-446). CI's `preview-check` stays.
5. **Migrations.** A `migrations/` folder, empty at first. nodrift already reads `migrations/*.sql` as D1 migrations (its Check 1) and ignores the `d1_migrations` table (read in `@didi-build/nodrift` 0.1.0). Its Check 2 requires every D1 binding in `wrangler.jsonc` to appear in the data map's `other_items` with `binding:`, and `nodrift init` writes `other_items: []`. So `init-project` adds the `DB` entry after `nodrift init`. Without it, a personal-data project's `npm run check` fails right after Bootstrap.
6. **Required secrets.** A committed file listing the names of the secrets the Worker needs (names only, empty at first). CI copies it into the build manifest (D).
7. **CI.** The `preview-check` job also bundles the Worker with Wrangler's dry run, which needs no credential. It runs the bundle locally with a local database and probes `/` (the commit marker, as today) and `/api/health`. The kept build, `staging-site`, gets a new layout: `assets/`, `worker/`, `migrations/`, and `foreman-deploy.json` (the compatibility date and flags from `wrangler.jsonc`, and the required secret names). It holds no secret, as today. The exact manifest format and file rules the deploy accepts are in O-159 (slice 3): only `index.js` goes into `worker/`.
8. **Names.** `init-project` already renames the package and the Worker (`<slug>`); with previews gone it no longer names a preview Worker. It also sets the D1 `database_name` to `<slug>-staging`. Foreman names the staging Worker `<slug>-staging` itself and ignores `name`.
9. **Docs.** The README and `docs/runbooks/deploy.md` describe the Worker, `/api`, D1, migrations, and secrets (names only, set through Foreman's form).

Existing projects such as `didi-build/rehearsal` keep their assets-only build, and Foreman keeps deploying it as today.

### F. Cloudflare access

**The calls Foreman makes.** The permission names are those in Cloudflare's API reference.

| Call                                                                                                 | Made by                                  | Permission                                      | Token                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| D1: list by name, and create (`/accounts/<a>/d1/database`)                                           | New project form, step 1                 | List: D1 Read or Write. Create: D1 Write        | The new database token (D-445)      |
| D1: run a migration (`.../d1/database/<id>/query`)                                                   | Staging deploy (slice 8)                 | D1 Write                                        | The new database token              |
| Worker: the assets upload session, the assets upload, and the Worker upload with module and bindings | Staging deploy; New project form, step 2 | Workers Scripts Write                           | The staging deploy token, unchanged |
| Worker: whether it exists                                                                            | New project form, step 2                 | Workers Scripts Read or Write                   | The staging deploy token            |
| Worker secrets: put, and list names (`.../workers/scripts/<name>/secrets`)                           | Set project secret form; staging deploy  | Put: Workers Scripts Write. List: Read or Write | The staging deploy token            |
| DNS record and Workers route                                                                         | Infra plan, add-only or reviewed         | DNS Edit and Workers Routes Edit on the zone    | The infra token, unchanged (D-357)  |

**Compared with today's staging deploy token.** Today's token is account-owned with one permission, Workers Scripts: Edit (runbook step 16, made at the rehearsal, O-140). It already covers every Worker call above, secrets included, so it is not widened. The only new right is D1. Cloudflare's token form gives D1 per account, not per database, so a D1 token can read and change every database in the account, including real product data once a product has users. Foreman's code only creates databases and applies migrations, and the token stays in Windmill (D-370), never in a project repository or an agent's run.

**No database id kept.** Later deploys keep the database binding without knowing its id. The upload names `{"type": "inherit", "name": "DB"}` with `bindings_inherit=strict`, so a binding that cannot be carried over fails the upload instead of being dropped (Cloudflare's "Upload Worker" reference). Only the form's placeholder upload binds by id, using the id the create call just returned. So no database id is stored in the store or the settings repository.

**Names and routes.** D-357 and O-112 stay: the record and the route come from the infra plan, now applied without a separate approval when the change is add-only (D-378). Cloudflare now recommends a Custom Domain where the Worker is the origin. But a Custom Domain made by the runner would create DNS records outside the plan, and Cloudflare requires "Workers Routes Write" on the zone for it (Workers roles page). So the runner's tokens keep no zone permission, and `ALLOWED_CALLS` still admits no route, domain or DNS call.

**Two limits of Cloudflare's tokens.**

- Per-Worker roles now exist, but they cannot cover a Worker that does not exist yet, and creating a Worker needs rights across the account (Workers roles page). So the staging deploy token stays account-wide and can change any Worker in the account.
- That matters once a project has production (D-007): a production Worker in the same account would be within the staging token's reach. Production is outside this ADR. A separate Cloudflare account, or a per-Worker production token, is the question to settle then.

### G. Deploy targets and Foreman as its own project (D-441)

**The interface.** Today's port is `StagingTarget.deploy({project, commitSha, archive})` in `src/core/staging-deploy.ts`, implemented by `src/adapters/deploy/cloudflare-staging.ts`, with a fake in `src/adapters/deploy/fake.ts`. It grows into a `DeployTarget` port in a new `src/core/deploy-target.ts`, still with no Cloudflare type in it (AGENTS.md section 3):

- `setUp(project)`: makes what a new project needs on the target, finding before creating.
- `deploy({project, commitSha, archive})`: today's operation.
- `setSecret(project, name, value)` and `secretNames(project)`: product secrets, never a value back.
- `health`, `logs` and `teardown` (ADR 0111 section 2) stay unbuilt.

Each answers done, or refused with fixed text, and never throws for a refusal, as `StagingUpload` does today. The composition (`flows/lib/compose.ts`) gives each target to the core by name, and the project's target picks one.

**Where the target is recorded.** In two places, both written by the form: the project file (`deployTarget`, A), which the Infra stack reads; and a new column on the store's project row, checked to `cloudflare` or `cluster` with `cloudflare` as the default, which the runner reads when it deploys. Changing a project's target is Didi's change.

**The Cloudflare target.** Today's adapter, extended:

- `setUp` makes the database and the placeholder (C, steps 1 and 2).
- `deploy` accepts the new build layout and the old one (`site-files.ts`). It uploads the module with the bindings Foreman sets: `DB` inherited, `keep_bindings` for secrets, and `run_worker_first: ["/api/*"]`. It takes the compatibility date and flags from the manifest only when they pass an allow-list, and it never takes bindings from the build. From slice 8 it applies new migrations first.
- The staging check also probes `/api/health` when the build has a Worker module.

**The cluster target.**

- **What it would deploy:** a project's server image, built by CI with no secret, as a Deployment and Service in a namespace on Foreman's cluster, reached through the tunnel under `/api`.
- **Where, for Foreman:** in `foreman-platform` on the platform pool, from `infra/kubernetes/platform.ts` and the image pins in `production.json`, applied by the Platform workflow.
- **What never changes:** the runner never applies to the cluster. Admin access belongs to Didi and to the jobs Didi approves (D-340), and a release of Foreman is production (D-007).

**What the first build includes.**

- A project file `projects/foreman.json` with `deployTarget: "cluster"` and the standard quota for `agents-foreman`. Didi writes it, since a cluster-target file is never add-only. Foreman's store row gets the same target through a migration. The New project form refuses `foreman`.
- For a cluster-target project, the deploy pass does not call Cloudflare. The cluster adapter's `deploy` records that the merged commit's images were built, from the Images workflow's run read with the runner's existing `actions: read`, and that they wait for Didi's Platform apply of the new pins. The daily check lists the waiting upgrade.
- `setUp` and `setSecret` refuse for the cluster target. Foreman's own secrets go through the Platform workflow's cluster Secrets job, which Didi approves.
- Foreman may use the planning chat, the Council, Triage, the builders, QA and the merge, like any project. Every privileged path still needs Didi: `.github/**`, `infra/**` (which holds the image pins), migrations, and files named for secrets. So do the Platform and Infra applies, the database migrations job and the Windmill deploy.

That is what "Foreman upgrades Foreman" means at first: Foreman's agents do the work through the normal flow, and Didi approves the release.

**What comes later**, each its own decision:

- The cluster adapter proposing the pin change itself. That needs an identity that may open a pull request on `foreman`, which the runner App cannot today (Pull requests: read, D-365).
- A staging space for Foreman, which needs more room in the cluster: Didi's money gate.
- A cluster backend for a product, as D-439's exception. That needs D-437's first step, product namespaces and a products pool, which is also a money gate.

A cluster-target item is Done at merge (D-449).

### H. Costs in detail

All prices and limits were read on Cloudflare's pages on 2026-11-20 (section I).

**Workers.**

| Item                    | Free                       | Paid (5 USD a month minimum per account)                                    |
| ----------------------- | -------------------------- | --------------------------------------------------------------------------- |
| Requests to the Worker  | 100,000 a day, per account | 10 million a month included, then 0.30 USD per million                      |
| Requests to assets      | Free and unlimited         | Free and unlimited                                                          |
| CPU time per request    | 10 ms                      | Up to 5 minutes (30 seconds by default); 30 million CPU ms a month included |
| Subrequests per request | 50                         | 10,000                                                                      |
| Workers per account     | 100                        | 500                                                                         |

With `run_worker_first` set to `/api/*`, only `/api` requests count. On the Free plan, requests over the limit get a 429 (Cloudflare's static assets billing page).

**D1.**

| Item                | Free                             | Paid                                                          |
| ------------------- | -------------------------------- | ------------------------------------------------------------- |
| Databases           | 10 per account                   | 100,000 included, then 0.10 USD a month each                  |
| Rows read           | 5 million a day                  | 25 billion a month included, then 0.001 USD per million       |
| Rows written        | 100,000 a day                    | 50 million a month included, then 1.00 USD per million        |
| Storage             | 5 GB in all, 500 MB per database | 5 GB included, then 0.75 USD per GB-month; 10 GB per database |
| Queries per request | 50                               | 1,000                                                         |

On the Free plan, queries fail with an error once the account reaches a day's limit.

**What each new project costs.** On the account's Workers Paid plan (D-450), nothing beyond the 5 USD a month already paid, within the included usage: one Worker, one database, one record and one route on Cloudflare, plus a namespace and its quota on the cluster, with no new node. `docs/costs.md` already counts 0 to 5 USD a month for Cloudflare. The slice that ships the first backend updates its reason.

**What hits Didi's money gate:** usage beyond Workers Paid's included amounts; a bigger agents node for more runs at once; each project's runtime model key with its spending limit (D-417).

### I. Sources read on 2026-11-20

- **Cloudflare:**
  - "D1 Pricing" and "D1 Limits" (both last updated 2026-10-30).
  - "Workers Pricing" (2026-11-18), "Workers Limits" (2026-11-19), and "Static assets: Billing and Limitations" (2026-11-12).
  - "API token permissions" (2026-11-15) and "Workers roles and permissions" (modified 2026-09-15).
  - API reference pages: "Create D1 Database", "List D1 Databases", "Query D1 Database", "Upload Worker" (`keep_bindings`, `bindings_inherit`, the `inherit` and `d1` bindings, `assets.config.run_worker_first`), "Add a secret to a Worker script", "List secrets bound to a Worker script", and "Attach Worker Domain".
- **Windmill:**
  - Docs: "Variables and secrets" (sensitive inputs) and "Customize the UI" (Is Password).
  - Source on `main`: `frontend/src/lib/components/secretArgUtils.ts`, `PasswordArgInput.svelte` and `job_args.ts`; `backend/windmill-worker/src/common.rs`; `backend/parsers/windmill-parser-ts/src/lib.rs`; `backend/windmill-api-auth/src/scopes.rs`.
- **GitHub:** REST "Create or update file contents", and "Creating rulesets for a repository" (rulesets are free on public repositories, with Apps on the bypass list).
- **Local:**
  - The `@didi-build/nodrift` 0.1.0 package in Launchpad's `node_modules` (README, `check1`, `check2`, `init/scaffold-map.js`).
  - `didi-build/launchpad` at `0f34a34` (`wrangler.jsonc`, `wrangler.preview.jsonc`, `.github/workflows/bootstrap.yml`, `.github/workflows/ci.yml`, `scripts/init-project.mjs`, `scripts/lib/bootstrap.mjs`, `docs/runbooks/deploy.md`).
  - `didi-build/rehearsal` at `52c1159`.
