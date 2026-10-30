# State store schema: column-level proposal

Status: superseded for columns and constraints by [ADR 0104](./decisions/0104-state-store-schema.md) and `db/migrations/0001_factory_schema.sql`, which are now the source of truth (2026-10-29). Kept as the original proposal. The nine-table shape is in `docs/spec.md` (State store schema). This document adds columns, constraints and two small tables the contracts need. It is not SQL and not a migration.

How it is used: the implementing agent turns this into an ADR and a migration in milestone 1 (task M1.1). A migration is applied only after Didi reviews the ADR (review point in `docs/build-plan.md`).

Platform: managed Postgres. Types below are logical. Use `uuid` primary keys, `timestamptz` for all times (UTC), `jsonb` for flexible payloads, and `text` with check constraints for enumerations (so the contracts can add values without a type migration).

## Additions to the nine tables

- `settings`: runner and policy settings that must be configurable without a deploy (kill switch, dry run, thresholds).
- `node_decisions`: a join table so a reversed decision can find the nodes that depended on it.
- `spec_versions`: which version of the spec and contracts the runner loaded.

These three are proposals that need Didi's confirmation with the rest of the schema.

## projects

| Column                 | Type        | Notes                                                        |
| ---------------------- | ----------- | ------------------------------------------------------------ |
| id                     | uuid pk     |                                                              |
| slug                   | text unique | Short name, for example `we-met`                             |
| name                   | text        |                                                              |
| repo                   | text        | `owner/name`                                                 |
| linear_project_id      | text null   |                                                              |
| gallery_path_override  | text null   | The standard path comes from Launchpad. Set only to override |
| privileged_paths_extra | jsonb       | Additions to the Launchpad default list                      |
| prod_requires_approval | boolean     | Confirmed by a check, not assumed. Used by the merge guard   |
| staging_url            | text null   |                                                              |
| created_at             | timestamptz |                                                              |

## nodes

| Column                 | Type        | Notes                                                                                                                             |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| id                     | uuid pk     |                                                                                                                                   |
| project_id             | uuid fk     | Required on every node                                                                                                            |
| type                   | text        | `idea` or `work_item`                                                                                                             |
| track                  | text null   | `design`, `code`, `infra`, `docs`. Null for ideas                                                                                 |
| state                  | text        | Current state name from the contracts                                                                                             |
| substate               | text null   | For example `writing_spec`, `building_components`, `verifying_on_staging`. Needed because Linear shares statuses across substates |
| owner_role             | text        | One owner role per state                                                                                                          |
| title                  | text        |                                                                                                                                   |
| body                   | jsonb       | Description, acceptance criteria, links                                                                                           |
| hold                   | boolean     | A hold flag replaces hard-coded exclusions                                                                                        |
| agent_ready            | boolean     | Only items marked agent-ready are dispatched                                                                                      |
| stale                  | boolean     | Set when a decision the node depended on is reversed                                                                              |
| blocked_reason         | text null   | Required whenever the state is Blocked or an escalated state                                                                      |
| state_since            | timestamptz | For stall detection                                                                                                               |
| linear_issue_id        | text null   |                                                                                                                                   |
| linear_status_synced   | text null   | Last status the mirror wrote                                                                                                      |
| version                | integer     | Optimistic lock. Starts at 0 and increments on every state change                                                                 |
| created_at, updated_at | timestamptz |                                                                                                                                   |

Index: (project_id, state), (state, state_since).

## edges

| Column     | Type        | Notes                                                                                                     |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| id         | uuid pk     |                                                                                                           |
| from_node  | uuid fk     |                                                                                                           |
| to_node    | uuid fk     |                                                                                                           |
| type       | text        | `blocks` (from blocks to), `split_into` (idea to work item), `design_for` (design item to developer item) |
| created_at | timestamptz |                                                                                                           |

Constraint: unique (from_node, to_node, type). No self edges. A blocks cycle is rejected by the library when an edge is added.

## transitions (append-only)

| Column                     | Type        | Notes                                                                   |
| -------------------------- | ----------- | ----------------------------------------------------------------------- |
| id                         | uuid pk     |                                                                         |
| node_id                    | uuid fk     |                                                                         |
| from_state, to_state       | text        |                                                                         |
| from_substate, to_substate | text null   |                                                                         |
| trigger_kind               | text        | `event`, `reconcile`, `bot_report`, `human`, `timeout`                  |
| trigger_ref                | text null   | Webhook delivery id, run id, gate request id                            |
| actor_kind                 | text        | `runner`, `bot`, `operator`, `council`                                  |
| actor_id                   | text        | Bot name or `didi`                                                      |
| guard_result               | jsonb       | List of checks, each with name, pass or fail, and the evidence ids used |
| evidence_ids               | uuid[]      |                                                                         |
| spec_version               | text        | The spec version the runner used                                        |
| mode                       | text        | `applied` or `dry_run`                                                  |
| reason                     | text null   |                                                                         |
| at                         | timestamptz |                                                                         |

Enforcement: no UPDATE or DELETE for any application role (revoke, or a trigger that raises). Index: (node_id, at).

## evidence (append-only)

| Column        | Type        | Notes                                                                                                                                                                    |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | uuid pk     |                                                                                                                                                                          |
| node_id       | uuid fk     |                                                                                                                                                                          |
| kind          | text        | `ci_run`, `test_report`, `preview_check`, `staging_check`, `qa_verdict`, `visual_comparison`, `merge_commit`, `spec_paths`, `dispatch_record`, `docs_note`, `screenshot` |
| ref           | text        | Url or external id                                                                                                                                                       |
| commit_sha    | text null   | The commit the evidence covers. Required for CI, preview, staging, QA verdict and visual comparison                                                                      |
| payload       | jsonb       | For example verdict, findings, round number, pass or fail                                                                                                                |
| recorded_by   | text        | Actor id                                                                                                                                                                 |
| recorded_at   | timestamptz |                                                                                                                                                                          |
| supersedes_id | uuid null   | A new record replaces an old one without editing it                                                                                                                      |
| ingest_key    | text null   | Unique. Set only by GitHub ingestion, only on `ci_run` and `merge_commit` (migration 0002, ADR 0113), so webhooks and polling record a fact once                         |

Rule: a guard reads only evidence whose `commit_sha` equals the PR's current head commit. A new commit makes earlier verdicts stale automatically.

## decisions (append-only; status changes through new rows)

| Column         | Type        | Notes                                                                             |
| -------------- | ----------- | --------------------------------------------------------------------------------- |
| id             | uuid pk     |                                                                                   |
| project_id     | uuid fk     |                                                                                   |
| node_id        | uuid null   |                                                                                   |
| kind           | text        | `approval`, `answer`, `council_decision`, `interview_answer`, `product_direction` |
| scope          | jsonb       | What it covers: option id, one exact commit, a request id                         |
| text_verbatim  | text        | Didi's words copied exactly. Other actors' text is not verbatim                   |
| by_actor       | text        | `didi` or a role                                                                  |
| recorded_at    | timestamptz |                                                                                   |
| status         | text        | `active`, `reversed`, `superseded`                                                |
| supersedes_id  | uuid null   |                                                                                   |
| reversed_by_id | uuid null   |                                                                                   |

Note: because rows are append-only, a reversal inserts a new `decisions` row and records its id in `reversed_by_id` through a controlled path. The implementing agent proposes the exact mechanism in the M1 ADR (for example, a separate `decision_events` table).

### node_decisions

| Column      | Type                   | Notes                           |
| ----------- | ---------------------- | ------------------------------- |
| node_id     | uuid fk                |                                 |
| decision_id | uuid fk                | The decision the node relies on |
| pk          | (node_id, decision_id) |                                 |

When a decision is reversed, every node in this table for that decision is marked stale, and a Council question is created.

## gate_requests

| Column                                    | Type        | Notes                                                                                                                                                                                               |
| ----------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                        | uuid pk     |                                                                                                                                                                                                     |
| project_id                                | uuid fk     |                                                                                                                                                                                                     |
| node_id                                   | uuid null   |                                                                                                                                                                                                     |
| topic_key                                 | text        | Same topic, newer request replaces older                                                                                                                                                            |
| kind                                      | text        | `visual_approval`, `new_credentials`, `drop_data`, `dns`, `pii_access`, `spend`, `send_message`, `production_deploy`, `scope`, `escalation`, `playbook_rule`, `privileged_path`, `council_question` |
| owner                                     | text        | `didi` or `council`                                                                                                                                                                                 |
| blocking                                  | boolean     | Blocking requests also raise a push alert                                                                                                                                                           |
| payload                                   | jsonb       | Question, links, options, the diff against locked product direction                                                                                                                                 |
| approval_url                              | text null   | Windmill resume or approval page link                                                                                                                                                               |
| status                                    | text        | `open`, `answered`, `superseded`, `expired`, `cancelled`                                                                                                                                            |
| decision_id                               | uuid null   | The recorded answer                                                                                                                                                                                 |
| superseded_by                             | uuid null   |                                                                                                                                                                                                     |
| created_at, answered_at, last_notified_at | timestamptz |                                                                                                                                                                                                     |

Constraint: a unique partial index on (topic_key) where status = `open`.

## runs

| Column                | Type         | Notes                                                                                                                            |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| id                    | uuid pk      |                                                                                                                                  |
| project_id            | uuid fk      |                                                                                                                                  |
| node_id               | uuid null    |                                                                                                                                  |
| bot                   | text         | Role bot name                                                                                                                    |
| agent_id              | text null    |                                                                                                                                  |
| runtime               | text         | `claude_code`, `grok`, `windmill_ai`, `cursor`, `code`                                                                           |
| model                 | text         |                                                                                                                                  |
| head_sha              | text null    | The PR head commit the run was dispatched for. The API stores a QA verdict against it (ADR 0112)                                 |
| pr_number             | integer null | The pull request a QA run reviews (migration 0003). Admission allows one active QA run per project, pull request and head commit |
| bot_version           | text         | Prompt, model and schema version behind the result                                                                               |
| started_at, ended_at  | timestamptz  |                                                                                                                                  |
| outcome               | text         | `success`, `fail`, `timeout`, `cancelled`, `budget_exceeded`, `usage_exhausted`                                                  |
| turns                 | integer null |                                                                                                                                  |
| minutes               | numeric null |                                                                                                                                  |
| cost_usd              | numeric null |                                                                                                                                  |
| tokens                | jsonb null   | `uncachedInput`, `cachedInput`, `output`, and `cacheWriteInput` where the provider reports it (D-185)                            |
| budget                | jsonb        | The limits applied to this run: `maxTurns`, `maxMinutes`, `maxUsd` (ADR 0107)                                                    |
| parent_run_id         | uuid null    | A bot run that dispatched agents                                                                                                 |
| transcript_ref        | text null    | Where the transcript is kept. Never inline secrets                                                                               |
| usage_exhausted_cause | text null    | `rate_limit`, `capacity` or `out_of_credit`. Set exactly when the outcome is `usage_exhausted` (migration 0003)                  |
| retry_after_seconds   | integer null | The provider's retry-after, only on a `usage_exhausted` end (migration 0003)                                                     |

A run is active while `ended_at` is null. Dispatch admission reads the active runs (index `runs_active`) under one advisory lock, in the transaction that inserts the run (ADR 0106 section 7, `src/core/runs.ts`).

## counters

| Column     | Type            | Notes                   |
| ---------- | --------------- | ----------------------- |
| node_id    | uuid fk         |                         |
| kind       | text            | `failure` or `qa_round` |
| count      | integer         |                         |
| updated_at | timestamptz     |                         |
| pk         | (node_id, kind) |                         |

Rules (Proposed interpretation, to confirm in the M1 ADR):

- `failure` increments when a transition guard fails after a bot reports done, when a QA or staging check fails, and when dispatch fails repeatedly. It does not increment on every red CI run during development. At 3 the item goes to Escalated to Council.
- `qa_round` counts QA verdicts that failed. At 3 the item goes to Escalated to Council.
- Both reset when the Council records a decision that resolves the escalation, and when the item reaches Done.

## settings

| Key                               | Default            | Notes                                                                                                                             |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `kill_switch`                     | false              | When true, the runner takes no transitions and dispatches nothing                                                                 |
| `dry_run`                         | true until cutover | When true, the runner records planned actions (transitions with mode `dry_run`) and acts on nothing                               |
| `reconcile_interval_minutes`      | 5                  |                                                                                                                                   |
| `failure_threshold`               | 3                  |                                                                                                                                   |
| `qa_round_cap`                    | 3                  |                                                                                                                                   |
| `pii_credential_ttl_minutes`      | 60                 | Enforced by the runner                                                                                                            |
| `stall_phone_alert_after_minutes` | 60                 | After this a stalled item raises a push alert                                                                                     |
| `daily_spend_call_usd`            | 25                 | A phone call fires when daily spend passes this                                                                                   |
| `spend_alert_usd`                 | to set             | Alert threshold. Work continues                                                                                                   |
| `usage_exhausted_wait_minutes`    | 30                 | Wait before a dispatch queued by a `usage_exhausted` end is tried again, or the provider's retry-after if longer (migration 0003) |
| `agent_cluster_max_active_runs`   | not seeded         | Active runs allowed across the cluster's agents pool. Sized to that pool at first hosting. While unset, every dispatch is refused |

Columns: key (pk), value jsonb, updated_by, updated_at. Changes to settings are logged.

## github_deliveries (append-only, migration 0002)

One row per GitHub webhook delivery the receiver authenticated (ADR 0113 section 3). Never the payload.

| Column      | Type        | Notes                                                     |
| ----------- | ----------- | --------------------------------------------------------- |
| delivery_id | text pk     | `X-GitHub-Delivery`. A replayed id records nothing new    |
| event_type  | text        | `X-GitHub-Event`                                          |
| repository  | text null   | `owner/name`, null when a signed payload named none       |
| received_at | timestamptz |                                                           |
| outcome     | text        | `recorded`, `ignored`, `rejected`                         |
| reason      | text null   | A short fixed reason from the ingestion code, at most 200 |

Roles: the receiver's `factory_ingest` inserts rows and can read only `delivery_id` (needed to skip a known id). The runner reads them for the daily check.

## spec_versions

| Column       | Type        | Notes                                    |
| ------------ | ----------- | ---------------------------------------- |
| version      | text pk     | Git commit sha of the spec and contracts |
| content_hash | text        |                                          |
| loaded_at    | timestamptz |                                          |

## Invariants the library must enforce

1. A state change writes one `transitions` row and updates the node in one transaction, with `where version = :expected`. Zero rows updated means another job won. Retry from a fresh read.
2. `transitions` and `evidence` are never updated or deleted.
3. Only the legal moves in the contracts are allowed, and each transition's guard has passed at the time of the write.
4. A node in Blocked or an escalated state has a `blocked_reason`.
5. Only one open gate request per `topic_key`.
6. An item in an escalated state cannot be dispatched.
7. Every node has a project.
