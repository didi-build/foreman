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

### Work item body

Decided in M3.2 (D-213); no earlier document gave `body` a shape. The dispatch reads these fields from a work item's `body` to build the run's input (`src/core/task-input.ts`). Each is optional, and other fields are kept and ignored.

| Field                | Type         | Notes                                                                                  |
| -------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `description`        | text         | What the item is about                                                                 |
| `acceptanceCriteria` | list of text | What must be true when the item is done. An item without any still dispatches (D-213)  |
| `pathsInScope`       | list of text | The repository paths the work should stay within                                       |
| `checks`             | list of text | The repository checks that must pass before a push, for example `npm run check` (N-33) |

A field of the wrong type refuses the dispatch before anything is written, and the error names the field, never its value. A missing field is stated as missing in the input. Who fills these fields is settled with Triage (M3.6); until then they are written when the item is created.

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

| Column        | Type        | Notes                                                                                                                                                                                                                    |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | uuid pk     |                                                                                                                                                                                                                          |
| node_id       | uuid fk     |                                                                                                                                                                                                                          |
| kind          | text        | `ci_run`, `test_report`, `preview_check`, `staging_check`, `qa_verdict`, `visual_comparison`, `merge_check` (migration 0010), `merge_commit`, `spec_paths`, `dispatch_record`, `docs_note`, `screenshot`, `agent_report` |
| ref           | text        | Url or external id                                                                                                                                                                                                       |
| commit_sha    | text null   | The commit the evidence covers. Required for CI, preview, staging, QA verdict, visual comparison and merge check                                                                                                         |
| payload       | jsonb       | For example verdict, findings, round number, pass or fail                                                                                                                                                                |
| recorded_by   | text        | Actor id                                                                                                                                                                                                                 |
| recorded_at   | timestamptz |                                                                                                                                                                                                                          |
| supersedes_id | uuid null   | A new record replaces an old one without editing it                                                                                                                                                                      |
| ingest_key    | text null   | Unique. Only on `ci_run` and `merge_commit` (migration 0002, ADR 0113), so webhooks and polling record a fact once. The runner's merge uses the same key for its `merge_commit` (M3.3)                                   |

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

| Column                 | Type         | Notes                                                                                                                                    |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | uuid pk      |                                                                                                                                          |
| project_id             | uuid fk      |                                                                                                                                          |
| node_id                | uuid null    |                                                                                                                                          |
| bot                    | text         | Role bot name                                                                                                                            |
| agent_id               | text null    |                                                                                                                                          |
| runtime                | text         | `claude_code`, `grok`, `windmill_ai`, `cursor`, `code`                                                                                   |
| model                  | text         |                                                                                                                                          |
| head_sha               | text null    | The PR head commit the run was dispatched for. The API stores a QA verdict against it (ADR 0112)                                         |
| pr_number              | integer null | The pull request a QA run reviews (migration 0003). Admission allows one active QA run per project, pull request and head commit         |
| bot_version            | text         | Prompt, model and schema version behind the result                                                                                       |
| started_at, ended_at   | timestamptz  |                                                                                                                                          |
| outcome                | text         | `success`, `fail`, `timeout`, `cancelled`, `budget_exceeded`, `usage_exhausted`                                                          |
| turns                  | integer null |                                                                                                                                          |
| minutes                | numeric null |                                                                                                                                          |
| cost_usd               | numeric null | Worked out by the core when the end is recorded, from `tokens` and `model_price` at the served tier (ADR 0114 section 2, migration 0008) |
| tokens                 | jsonb null   | `uncachedInput`, `cachedInput`, `output`, and `cacheWriteInput` where the provider reports it (D-185)                                    |
| budget                 | jsonb        | The limits applied to this run: `maxTurns`, `maxMinutes`, `maxUsd` (ADR 0107)                                                            |
| parent_run_id          | uuid null    | A bot run that dispatched agents                                                                                                         |
| transcript_ref         | text null    | Where the transcript is kept. Never inline secrets                                                                                       |
| usage_exhausted_cause  | text null    | `rate_limit`, `capacity` or `out_of_credit`. Set exactly when the outcome is `usage_exhausted` (migration 0003)                          |
| retry_after_seconds    | integer null | The provider's retry-after, only on a `usage_exhausted` end (migration 0003)                                                             |
| task_type              | text         | From `contracts/task-types.yaml`, for example `developer:code` (ADR 0114 section 1, migration 0005)                                      |
| provider               | text         | The provider entry name, as in the egress proxy's provider list, for example `anthropic` (migration 0005)                                |
| model_family           | text         | From the model catalog. The QA independence rule reads it here (migration 0005)                                                          |
| service_tier_requested | text         | `standard`, `flex` or `priority` (migration 0005)                                                                                        |
| service_tier_served    | text null    | `standard`, `flex`, `priority` or `mixed`, from the provider's responses. Null when none reported it (migration 0005)                    |
| routing_policy_version | text         | The `model_routing_policy` version the route came from (migration 0005)                                                                  |
| model_catalog_version  | text         | The `model_catalog` version the family and price came from (migration 0005)                                                              |
| capacity_retries       | integer null | Flex capacity rejections retried inside the run, at least 0 (ADR 0114 section 9, migration 0005)                                         |
| capacity_wait_seconds  | integer null | Time spent waiting on those retries, at least 0 (migration 0005)                                                                         |
| first_token_ms         | integer null | Time to the first output token of the first request, where the runtime reports it (migration 0005)                                       |
| reported_cost_usd      | numeric null | The runtime's own cost figure, kept to compare with `cost_usd` (migration 0005)                                                          |
| handle                 | jsonb null   | What the runtime's `start` returned, to poll or cancel the run. An object, never a credential (migration 0006)                           |
| model_price            | jsonb null   | The route's model entry from the catalog version on the run, copied at admission: `tiers` and `pricePerMTok`. An object (migration 0008) |

A run is active while `ended_at` is null. Dispatch admission reads the active runs (index `runs_active`) under one advisory lock, in the transaction that inserts the run (ADR 0106 section 7, `src/core/runs.ts`).

The route (`model` and the columns from `task_type` to `model_catalog_version`) is chosen by `src/core/routing.ts` when the run is admitted and written in the same transaction, with a `decision_point_records` row (decision point `model_route`, decider `model_route_rule_v1`, confidence 1). The route columns are not null with no default: migration 0005 stops if `runs` already holds a row, because a run recorded before routing has no route to fill in.

The run's state API token is stored in `run_tokens` (one row per run, only the token's SHA-256 hash) in the transaction that inserts the run. It expires at the run's start plus its `maxMinutes` plus 15 minutes, and ending the run revokes it in the transaction that records the end (ADR 0102, `src/core/run-tokens.ts`).

The columns from `service_tier_served` to `reported_cost_usd` are written when the run's end is recorded, in the same transaction, from what the runtime reported in its result line (`src/core/runs.ts`, `recordEnd`); each is null when the runtime could not report it. The Messages API image reports the served tier (one tier when every response named the same one, `mixed` when they differ or only some named one), its Flex capacity retries and the whole seconds it waited on them (0 and 0 when it retried nothing). The OpenCode image (D-222) reports no served tier, since OpenCode 1.19.5 reports none, and capacity retries only for a run that ended on a retryable Flex capacity rejection: OpenCode's fixed 5, with no wait seconds (O-28). The Claude Code fallback image reports the one served tier Claude Code names, and no capacity retries, since it cannot count Claude Code's own. No runtime reports `first_token_ms` yet. `reported_cost_usd` is the runtime's own cost figure, kept to compare with `cost_usd`.

`model_price` is the route's entry from the model catalog version in `model_catalog_version`: the tiers the provider supports for the model and its US dollar price per million tokens at each tier, as `{"tiers": ["standard"], "pricePerMTok": {"standard": {"input": 2, "cachedInput": 0.2, "cacheWrite": 2.5, "output": 10}}}`. The core copies it onto the run in the transaction that admits it and never changes it (migration 0008, O-25). The runner passes the same copy to the agent, whose dollar limit prices each request from it, and the runner does not start a run without one. `cost_usd` is worked out from it when the end is recorded (`src/core/run-cost.ts`), so a later catalog change never changes how a recorded run is priced (D-162): uncached input at `input`, cached input at `cachedInput`, cache writes at `cacheWrite` or, when the catalog lists none, at `input`, and output at `output`, per million tokens. The tier priced is the served tier when the run reports one tier the provider supports for the model; a `mixed` or null served tier, or an unsupported one, is priced at Standard (ADR 0114 section 8). A supported tier with no catalog price is priced at the highest cost any of the model's prices gives (O-26). `cost_usd` is null when the runtime reported no tokens, or the run has no usable `model_price`.

After a `usage_exhausted` end with cause `capacity`, the next dispatch of the item for the same task type reads that run's route. With `onCapacity: "next_candidate"` it takes the first candidate after it that passes the hard rules, without the `usage_exhausted_wait_minutes` wait; when none passes, it waits and then takes the first candidate, as for `wait` (D-221). The route's decision record says which happened (`afterCapacity`: `next_candidate`, `wait` or `no_later_candidate`).

`handle` is written once, after the runtime started the run, in one transaction with the run's `dispatch_record` evidence and its dispatch move (`src/core/run-start.ts`), and only while the run has not ended. It is jsonb because a handle is a small structured value: the Kubernetes runtime's is the run id, namespace, run spec and limits, the runtime interface keeps it generic, and Postgres checks it is valid JSON. Null means the run never started, or is still starting.

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

| Key                                | Default                  | Notes                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill_switch`                      | false                    | When true, the runner takes no transitions and dispatches nothing                                                                                                                                                                                                                                                                        |
| `dry_run`                          | true until cutover       | When true, the runner records planned actions (transitions with mode `dry_run`) and acts on nothing                                                                                                                                                                                                                                      |
| `reconcile_interval_minutes`       | 120                      | Every 2 hours until Kubernetes hosts Windmill, then 5 (D-164)                                                                                                                                                                                                                                                                            |
| `windmill_monthly_execution_limit` | 1000                     | Windmill Cloud free tier (D-163)                                                                                                                                                                                                                                                                                                         |
| `windmill_alert_percent`           | 80                       | Alert Didi at this share of the monthly limit (D-167)                                                                                                                                                                                                                                                                                    |
| `failure_threshold`                | 3                        |                                                                                                                                                                                                                                                                                                                                          |
| `qa_round_cap`                     | 3                        |                                                                                                                                                                                                                                                                                                                                          |
| `pii_credential_ttl_minutes`       | 60                       | Enforced by the runner                                                                                                                                                                                                                                                                                                                   |
| `stall_phone_alert_after_minutes`  | 60                       | After this a stalled item raises a push alert                                                                                                                                                                                                                                                                                            |
| `daily_spend_call_usd`             | 25                       | A phone call fires when daily spend passes this                                                                                                                                                                                                                                                                                          |
| `spend_alert_usd`                  | to set                   | Alert threshold. Work continues                                                                                                                                                                                                                                                                                                          |
| `usage_exhausted_wait_minutes`     | 30                       | Wait before a dispatch queued by a `usage_exhausted` end is tried again, or the provider's retry-after if longer (migration 0003)                                                                                                                                                                                                        |
| `gate_request_expiry_days`         | 7                        | An unanswered gate request expires after this many days (D-199, migration 0004)                                                                                                                                                                                                                                                          |
| `agent_cluster_max_active_runs`    | not seeded               | Active runs allowed across the cluster's agents pool. Sized to that pool at first hosting. While unset, every dispatch is refused                                                                                                                                                                                                        |
| `model_routing_policy`             | version `2026-10-31.1`   | Per task type, the ordered route candidates (provider, model, tier, optional `failFast`) and `onCapacity`, plus `qaIndependence`. Seeded with today's models: Claude Sonnet 5.5 for every task type, Claude Opus 5.5 for `qa:review`, Anthropic, Standard, `model_id` (D-185, D-186, ADR 0114 section 5, migration 0005)                 |
| `model_catalog`                    | version `2026-10-31.1`   | Per model: provider, family, supported tiers, price per million tokens per tier, output cap, price source and date. Seeded with the two models the policy uses, at Anthropic list prices (`docs/costs.md` section 2)                                                                                                                     |
| `model_providers_approved`         | `anthropic`, `deepinfra` | Providers that passed D-154, each with the decision that approved it (D-171, D-208) and what the approval `covers`: `all` models, or `self_hosted` only (DeepInfra, D-219). A `self_hosted` provider cannot route to a catalog model marked `resold`. Only Didi changes it                                                               |
| `model_output_token_needs`         | 16000 per task type      | Output tokens each task type needs. A candidate whose catalog cap is lower is not chosen (ADR 0114 hard rule 4, O-14)                                                                                                                                                                                                                    |
| `flex_capacity_retries`            | 3                        | Flex capacity rejections (a 429 with an overload error) one run retries, after 30 seconds doubling, at most 5 minutes each, counted against the run's minute limit. Then the run ends `usage_exhausted` with cause `capacity` (ADR 0114 section 9, migration 0007)                                                                       |
| `max_rejected_model_requests`      | 6                        | Requests the run's egress proxy lets through after the upstream answered 429. They do not count against the model request ceiling; past this the proxy answers 403 and the run ends `budget_exceeded` (ADR 0114 section 9, migration 0007). Migration 0009 raises the seeded 5 to 6, the requests OpenCode makes on one Flex 429 (D-223) |

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
