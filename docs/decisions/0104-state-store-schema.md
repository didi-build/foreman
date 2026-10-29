# 0104. State store schema

- **Status:** accepted at the M1.1 review (D-169, 2026-10-29). Applying it to Supabase still waits for the project and its credentials, which Didi creates.
- **Date:** 2026-10-29
- **Related:** P-02, P-03, O-05, P-11, D-161, D-162, D-164, D-166, D-167, `docs/schema.md`, [ADR 0102](./0102-state-api-hosting-and-agent-auth.md), [ADR 0103](./0103-managed-postgres-provider.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md)

## Context

`docs/schema.md` proposed the tables and columns. M1.1 turns it into a migration and settles what it left open: the three added tables (P-02), the counter rules (P-03), and how an append-only decision can be reversed (O-05). Decisions made since then also land here: the per-run tokens (ADR 0102), the QA verdict bound to the run's commit (ADR 0112), decision-point records (P-11), the deterministic core (D-162), and the loop and Windmill settings (D-164, D-167).

## Decision

The migration is `db/migrations/0001_factory_schema.sql`, for Postgres 16 (Supabase's version). From now on it is the source of truth for columns and constraints; `docs/schema.md` stays as the original proposal.

### Where it lives and who can reach it

- Every table is in the `factory` schema, which Supabase's Data API does not expose (ADR 0103).
- Two group roles, with no login: `factory_runner` and `factory_api`. Login users that belong to them are created when the database is set up, with credentials from the vault (new-credentials gate), never in a migration.
- Supabase's `anon`, `authenticated` and `service_role` get nothing in the schema. `public` gets nothing either.
- Row level security is on for every table. Only the two factory roles have policies.
- No role has DELETE or TRUNCATE on any table.

| Role             | Reads                                                         | Writes                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_runner` | Everything                                                    | Inserts everywhere. Updates only `projects`, `nodes`, `runs`, `run_tokens`, `gate_requests`, `counters`, `settings`                                                                                                                     |
| `factory_api`    | What it serves (no counters, no decision-point records, logs) | Inserts `nodes`, `edges`, `decisions`, and `evidence` of kinds `agent_report`, `docs_note` and `qa_verdict` only, enforced by a row level security policy (essential 6). Never updates anything, so it cannot move a node (essential 1) |

### Append-only, enforced by triggers

`transitions`, `evidence`, `decisions`, `decision_events`, `decision_point_records`, `decision_point_outcomes`, `spec_versions` and `settings_log` have triggers that reject UPDATE, DELETE and TRUNCATE for every role, the owner included. Settings can change but never be deleted, and every change writes a `settings_log` row through a trigger.

### Reversing a decision (O-05)

A decision row never changes. A reversal or supersession is a new row in `decision_events` (kind `reversed` or `superseded`, with the replacing decision for a supersession). One event per decision, so a decision cannot be both. The view `decisions_current` gives each decision's status (`active`, `reversed` or `superseded`). This replaces the `status`, `supersedes_id` and `reversed_by_id` columns in `docs/schema.md`. When a decision is reversed, the library marks every node in `node_decisions` for it stale and opens a Council question (unchanged from the proposal).

### Changes from `docs/schema.md`

| Table                                                     | Change                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All                                                       | Ids and times written by the library have no database default: the library passes them from its injected id source and clock (D-162)                                                                       |
| `nodes`                                                   | An idea has no track and a work item has one                                                                                                                                                               |
| `evidence`                                                | New `run_id`. New kind `agent_report` (ADR 0102). CI, preview, staging, QA verdict and visual comparison evidence must name a commit. A QA verdict must name its run, and a run has at most one (ADR 0112) |
| `runs`                                                    | `head_sha` (ADR 0112). `ended_at` and `outcome` are set together                                                                                                                                           |
| `run_tokens` (new)                                        | The per-run agent credential from ADR 0102: only the token's hash, its role, project, expiry and revocation                                                                                                |
| `decisions`, `decision_events` (new), `decisions_current` | The reversal mechanism above                                                                                                                                                                               |
| `gate_requests`                                           | One open request per topic within a project, not across all projects. An answered request names its decision; a superseded one names its replacement                                                       |
| `decision_point_records`, `decision_point_outcomes` (new) | P-11: decision point, decider id, input hash, output, confidence between 0 and 1. The outcome comes later as its own append-only row, so the record never changes                                          |
| `settings`, `settings_log` (new)                          | The change log the proposal asked for                                                                                                                                                                      |

What stays out of the database on purpose: state names and legal moves (contracts are data, essential 3), and the invariants that depend on them, such as "a Blocked node has a reason". The library enforces those (M1.3).

### Counters (P-03)

The table holds `failure` and `qa_round` per node, never below 0. The rules stay as P-03 proposes and are enforced by the library: `failure` goes up on a failed guard after a bot reports done, a failed QA or staging check, or repeated dispatch failure, not on every red CI run; `qa_round` counts failed QA verdicts; both escalate to the Council at 3 (the `failure_threshold` and `qa_round_cap` settings) and reset on a Council resolution and at Done. QA escapes (D-161) are counted from `transitions`, `evidence` and `runs`, so they need no table.

### Seeded settings

`kill_switch` false, `dry_run` true, `reconcile_interval_minutes` 120 (D-164), `failure_threshold` 3, `qa_round_cap` 3, `pii_credential_ttl_minutes` 60, `stall_phone_alert_after_minutes` 60, `daily_spend_call_usd` 25, `spend_alert_usd` not set, `windmill_monthly_execution_limit` 1000 and `windmill_alert_percent` 80 (D-167), `qa_escape_review_count` 3 and `qa_escape_review_window` 30 (D-161).

### Privacy

The store holds no end-user personal data; agents work from synthetic data (D-154). It does hold Didi's decisions word for word, so it is listed in `docs/privacy/data-map.yml`, and Supabase in `docs/privacy/subprocessors.yml`. Nodrift's migration check reads only Cloudflare D1 migrations in `migrations/`, so these Postgres migrations live in `db/migrations/` and the map entry is maintained by hand.

### How migrations run

- Now: CI only. `.github/workflows/db.yml` applies every file in `db/migrations/` to an empty PostgreSQL 16 on the runner and runs `test/db/`.
- M1.2 added the Postgres driver (`pg`) and `npm run db:migrate` (`src/adapters/store-postgres/migrate.ts`). It applies new files in name order, each in its own transaction together with its record in `factory_meta.schema_migrations` (name and SHA-256), under an advisory lock so two runs cannot overlap. It refuses to run if an applied file was edited or removed: a change is always a new migration.
- Applying to Supabase happens only after this review and once Didi has created the project and its credentials. At that point: the Data API is confirmed off, the login users are created, and a test confirms the anon key reads nothing through the REST endpoint (ADR 0103).

## Constraints

- Not applied to any real database before Didi reviews this ADR.
- No credentials in migrations.
- No new dependencies in M1.1. The tests drive `psql`.

## How success is judged

1. The migration applies cleanly to an empty database in CI.
2. Tests prove UPDATE, DELETE and TRUNCATE fail on every append-only table, for the owner and for the runner role, and that the API role cannot write evidence a guard trusts or move a node.
3. Tests cover the evidence commit rule, one verdict per run, one open gate request per topic, no self edges, the decision status view and the settings log.
4. Breaking the triggers or the evidence policy on purpose makes the tests fail (done when writing them: 10 failures).
5. Didi reviews this ADR. Done 2026-10-29 (D-169).

## Reasons

- Triggers make append-only true even for the owner, so a mistake in grants cannot undo it.
- An event table for reversals keeps every decision row untouched, and the history of a decision stays readable.
- A row level security policy on evidence kinds puts essential 6 in the database itself, not only in the API code.
- Leaving state names out keeps the contracts the only place rules live.

## Consequences

- The library must always pass ids and times. A missing one is a database error, which is what D-162 wants.
- Adding an evidence kind, gate kind or runtime value needs a migration. That is intended: these are checked lists.
- Seventeen tables instead of the proposal's twelve, all small.
