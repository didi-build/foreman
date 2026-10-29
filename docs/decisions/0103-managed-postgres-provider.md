# 0103. Managed Postgres provider and region

- **Status:** accepted for step 1 (Didi, 2026-10-28: "I approve. I'm still out so I can't generate the keys yet but I approve of supabase"). Recorded as D-140. Didi creates the project and its credentials. Step 2 (the plan before cutover, and its spend) is still Didi's decision when it comes. Reviewed at the end of M0 (D-168).
- **Date:** 2026-10-28
- **Related:** O-01, D-118, [build plan M0.5](../build-plan.md#m05-choose-the-managed-postgres-provider-o-01)

## Context

The state store is a managed Postgres (D-118). M0.5 compares providers on free-tier limits, idle pausing (the reconcile loop runs every 5 minutes), backups, connections from Windmill and from a Worker (Hyperdrive), and a Canadian region. Two needs come from the schema: database roles or triggers, so `transitions` and `evidence` can be made append-only, and transactions with a version check.

This comparison is from current pricing and documentation pages read on 2026-10-28. Several vendor sites could not be opened from this cloud session, so some figures come from search summaries. Everything marked "check" must be confirmed at signup.

## The 5-minute loop changes the free-tier picture

A loop that connects every 5 minutes keeps a scale-to-zero database awake all month. Neon's free compute allowance would run out around day 16. So the useful comparison is an always-on small instance, not a pausing one.

## Comparison

| Provider                               | Canadian region           | Cost for this use                                   | Backups                                    | Fit                                                                                                                                                                                                |
| -------------------------------------- | ------------------------- | --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase                               | Yes, `ca-central-1`       | Free now; Pro about $25 a month                     | None on Free. Pro: daily, kept 7 days      | Full roles and triggers. Windmill connects through the free IPv4 pooler. Official Hyperdrive guide. Check: whether a free project with a query every 5 minutes is still paused for "low activity". |
| PlanetScale Postgres                   | Yes, `aws-ca-central-1`   | About $5 a month (check the Canadian price)         | Every 12 hours plus point-in-time recovery | Cheapest paid option. Tight Hyperdrive integration. Check: `CREATE ROLE` and `CREATE TRIGGER` are allowed. Single node.                                                                            |
| DigitalOcean                           | Yes, Toronto (check)      | $15 a month                                         | Point-in-time recovery, 7 days, included   | Simple and predictable. Pooling included.                                                                                                                                                          |
| AWS RDS `db.t4g.micro`                 | Yes, `ca-central-1`       | About $13 to $16 a month after free credits (check) | Point-in-time recovery, up to 35 days      | Strong, but more setup.                                                                                                                                                                            |
| Google Cloud SQL                       | Yes, Montreal and Toronto | About $10 to $13 a month                            | Point-in-time recovery                     | Shared-core instance has no SLA.                                                                                                                                                                   |
| Neon                                   | **No**                    | Free tier runs out under the loop                   |                                            | Ruled out: no Canadian region.                                                                                                                                                                     |
| Render, Railway, Xata, Prisma Postgres | **No**                    |                                                     |                                            | Ruled out: no Canadian region.                                                                                                                                                                     |
| Nile                                   | No                        |                                                     |                                            | Ruled out: no triggers.                                                                                                                                                                            |

## Decision

1. **Now, for Milestones 1 to 5 (no real data): Supabase Free in `ca-central-1`.** It costs nothing, has a Canadian region and full roles and triggers. Because Free has no backups, add a nightly `pg_dump` job until the upgrade.
2. **Before cutover (M6), when the store holds real state: move to a plan with point-in-time recovery.** Either Supabase Pro (about $25 a month, same database) or DigitalOcean Toronto ($15 a month, recovery included). Spend is Didi's decision at that point.

### Supabase hardening (from the outside review, 2026-10-28)

Supabase serves a REST API (PostgREST) over the database, and by default it exposes the `public` schema to anyone holding the project's public (anon) key. The append-only roles do not help if that door is open. So:

- The state store tables live in their own schema (`factory`), which is not in Supabase's list of exposed schemas.
- The Data API is turned off for the project, and row level security is enabled on every table as a second barrier.
- The application connects as a dedicated role with only the grants the API and runner need (ADR 0102), never as `postgres` or the service role.
- A migration test in M1.1 connects with the anon key through the REST endpoint and checks it can read nothing. (These settings are checked again at signup, because the defaults could not be read from this session.)

### Backups until the paid plan

The runner owns them: a Windmill job runs `pg_dump` once a night (one execution a day, small against N-19), encrypts the dump before it leaves the job, and writes it to a private R2 bucket used only for backups, keeping 14 days. A restore is rehearsed once in M1. The dump's encryption key lives in Windmill's secret store at `platform/backups/dump-key` and as a copy in Didi's password manager; the restore rehearsal uses that copy (D-166). A second backup location in Canada (AWS S3 or DigitalOcean Spaces) is chosen at cutover (O-13), and R2 is retired after the move to Kubernetes (D-165). This lasts until the plan with point-in-time recovery (step 2) replaces it.

PlanetScale at about $5 a month is the cheapest paid option, but whether it allows the roles and triggers we need is not confirmed. It is worth a check if cost matters more than simplicity.

## Constraints

- No database is created, and no account or credential exists, until Didi approves the provider, the spend and the credentials.
- Credentials go into the vault or Windmill resources only. Never in the repo, logs or chat.
- If data residency in Canada matters, check where each provider keeps backups and logs, not only the primary region.

## How success is judged

M1.1 adds: the anon key reads nothing through the REST API, and a nightly dump restores into an empty database.

M0.5's success check: a database exists, credentials are in the vault, and a connection test from Windmill succeeds. Also: a role that cannot UPDATE or DELETE can be created, and a trigger can be created.

## Consequences

- Hyperdrive limits apply to any Worker that connects: no LISTEN/NOTIFY and no advisory locks over Hyperdrive. The runner's own connection from Windmill is not affected.
- Starting on a free tier means one planned migration or upgrade before cutover.
