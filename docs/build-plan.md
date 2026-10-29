# Build plan

Status: draft, 2026-10-28. Proposed order; Didi confirms. Milestones run in order. Tasks within a milestone run in order unless noted.

## How to read this

- Each task says what, why, how, constraints and success. Success is the verification: run it and record the result as evidence in the PR.
- "Review point" means stop and wait for Didi (or whoever is named) before continuing.
- Write an ADR (`docs/decisions/NNNN-title.md`) before code for anything architectural. The ADR list is in `docs/architecture/technical-architecture.md`, section 8.
- Anything that would spend money, create credentials, or touch real personal data goes through a gate. Do not work around it.

## Definition of done for any task

1. The code or document is merged by squash with CI green on the head commit.
2. The task's success checks ran, and the results are in the PR description.
3. New behaviour has tests at the right seam (`docs/test-plan.md`). Guards have tests that exercise both pass and fail.
4. `docs/decision-log.md` and the ADRs are updated.
5. No secret, database id or personal data appears in code, logs, the PR or comments.

## Milestone 0: foundations and spikes

Goal: a clean repo, the risky unknowns checked, and the provider chosen. The Linear spike (M0.3) is moved to the start of Milestone 5 (D-147).

### M0.0 Place the handoff files in the repo's layout

- What: move the handoff files from `handoff/` into the places this repo's existing layout expects, and merge the handoff `AGENTS.md` and `README.md` into the repo's own versions without losing either.
- Why: the handoff assumes a generic layout (`docs/`, `docs/decisions/`, `contracts/`, a root `README.md` and `AGENTS.md`). This repo comes from Launchpad, whose conventions win.
- How: first read the repo's existing structure, its `AGENTS.md`, its `README.md` and any ADRs. Write a placement plan (old path, new path, reason) and record it in the repo's ADR location as `0100-handoff-placement.md`. Move the files. Update every cross-reference and every path mentioned inside the documents so they point to the new locations. Merge the rules in the handoff `AGENTS.md` into the repo's `AGENTS.md`: keep every existing rule, add the handoff rules under a clear heading, and where two rules conflict, stop and ask. Remove `handoff/` only after the checks below pass.
- Constraints: do not delete or weaken any existing rule or file. Do not overwrite an existing file without merging it. No code changes in this task.
- Success: a link and path check finds no broken references in the documents. The repo's existing CI still passes. The placement ADR lists every moved file. The README links to the placed documents in reading order. (Review point: Didi skims the placement ADR before M0.1 starts.)

### M0.1 Repo and tooling

- What: with the handoff placed, set up TypeScript, lint, formatting, test runner and CI inside the repo's existing conventions. Add only what Launchpad does not already provide. (Didi creates the repo from the Launchpad template before the first session.)
- Why: every later task depends on a consistent base.
- How: follow `AGENTS.md` section 4. Exact-pinned dependencies, SHA-pinned actions, squash-only merges, a PR template with a Privacy section and the head commit. Write ADR 0101.
- Constraints: no deploys. No production credentials.
- Success: CI runs lint, typecheck and a placeholder test on a PR and passes. ADR 0101 is merged.

### M0.2 Spike: agent dispatch (V-01, V-04)

- What: prove the runner can start each agent and read its result without a person: Claude Code (non-interactive), Grok (QA), and Cursor agents. Record what works, what does not, and what each needs (API, CLI, credentials).
- Why: QA is assigned to Grok and Cursor has no role. If Grok cannot be driven, QA moves.
- How: a throwaway script per runtime that starts an agent on a trivial task in a scratch repo, reads the final message and exit status, and records a run. Check current documentation for each runtime. Write ADR 0107.
- Constraints: scratch repo only. No production access. Any new credential goes through the new-credentials gate.
- Success: for each runtime, a recorded yes or no with evidence. If Grok is a no, a proposed fallback for QA.

### M0.3 Spike: Linear API (V-02)

- Moved: runs at the start of Milestone 5, before M5.1, not in Milestone 0 (D-147). Nothing before Milestone 5 depends on it. It is not needed to finish Milestone 0.
- What: prove Linear's API can create statuses and let an app act under its own identity.
- Why: the status setup and bot identity depend on it.
- How: in a test team (not the real Didi Build team), create a status, rename one, create an issue and a comment as an app. Record the results.
- Constraints: do not touch the real team. Credentials through the gate.
- Success: a recorded yes or no for each capability, and a manual runbook for any capability that is a no.

### M0.4 Spike: Windmill approval pages on a phone (V-03)

- What: build a hello-world flow with an approval step that Didi can open and answer on his phone, and record how it looks and behaves.
- Why: approval pages are the primary gate channel.
- How: a flow that suspends on an approval step and resumes with a typed reply. Capture the answer verbatim.
- Success: Didi answers it from his phone, the answer is captured verbatim with a timestamp, and the flow resumes. Record rough edges. (Review point: Didi decides whether the channel is good enough.)

### M0.5 Choose the managed Postgres provider (O-01)

- What: pick a provider and region and create the database.
- Why: the state store depends on it.
- How: compare providers on free-tier limits, idle pausing (the loop runs every 5 minutes), backups, connections from Windmill and from a Worker, and a Canadian region. Write ADR 0103.
- Constraints: spending money or starting a paid plan is Didi's. Creating credentials is the new-credentials gate.
- Success: a database exists, credentials are in the vault, and a connection test from Windmill succeeds. (Review point: Didi approves the provider, any spend, and the credentials.)

### M0.6 State API hosting and agent authentication (O-02)

- What: decide where the tiny API runs and how agents authenticate.
- Why: agents must not touch the database directly.
- How: compare Windmill endpoints, a Worker through Hyperdrive, and a small Node service. Choose the simplest option that gives each agent its own identity. Write ADR 0102.
- Success: ADR 0102 merged.

### M0.7 Infrastructure as code baseline (Proposed, D-133)

- What: choose the tool (Terraform or OpenTofu), the state backend and the secrets approach, and prove the baseline on a scratch project: declare its Cloudflare resources, apply, and show a clean plan.
- Why: visibility of what is set up and where, and plans that gates can show.
- How: check current Cloudflare provider support and free tiers for state storage. Create an `infra/` layout that matches Launchpad's conventions. Never put secret values in code, state output or plans. Write ADR 0110.
- Constraints: scratch project only. Credentials through the new-credentials gate. A paid plan is Didi's decision. Do not touch real projects.
- Success: after apply, a second plan is a no-op. A deliberate change appears as a plan diff. A scan of the plan output and state finds no secret values. ADR 0110 is merged.

### M0.8 Conventions that make Kubernetes easy (Proposed, D-134)

- What: write ADR 0111 and add the conventions to `AGENTS.md`: container-ready services, a target-agnostic deploy adapter interface, the per-project isolation model, secrets by path behind an interface, the model endpoint and API key as settings in each bot file (the key as a secret path; D-142), and an IaC layout with platform and project modules.
- Why: the second release moves to Kubernetes, and these keep the switch from being a rewrite.
- How: follow `docs/architecture/technical-architecture.md` section 2.10. Add CI checks: each service builds as a container image, serves a health endpoint, and reads config only from the environment.
- Constraints: do not build a cluster. No Kubernetes-specific code yet.
- Success: ADR 0111 is merged. A sample service builds as a container in CI and passes the health check. `AGENTS.md` carries the conventions.

Review point at the end of M0: Didi reviews ADRs 0101, 0102, 0103, 0107, 0110, 0111 and the spike results.

## Milestone 1: state store and library

Goal: the source of truth exists, is safe, and moves items correctly.

### M1.1 Finalize the schema (review point)

- What: turn `docs/schema.md` into ADR 0104 and migrations.
- Why: the shape was approved; columns and constraints were not.
- How: resolve the open points in `docs/schema.md` (the three added tables, counter rules, the reversal mechanism for append-only decisions). Write migrations. Add database roles or triggers that make `transitions` and `evidence` append-only.
- Constraints: do not apply the migration to the real database until reviewed.
- Success: migrations apply cleanly on an empty database in CI. Tests prove UPDATE and DELETE on append-only tables fail. (Review point: Didi reviews ADR 0104 before the migration is applied.)

### M1.2 Store interface and Postgres implementation

- What: a store interface the library depends on, and a Postgres implementation.
- Why: keeps the library testable and the database swappable.
- How: small interface (nodes, edges, transitions, evidence, decisions, gate requests, runs, counters, settings). Use transactions. No SQL outside this module.
- Success: integration tests against a real Postgres pass, including a rollback test.

### M1.3 State library

- What: the library in `docs/architecture/technical-architecture.md` section 2.1: create node, add edge (reject blocks cycles), record evidence and decisions, open or supersede a gate request, request a transition with the version check, counters, and read views.
- Why: this is the core. Everything else is a shell.
- How: pure TypeScript. `requestTransition` evaluates the guard from a contracts object and writes the transition and node update in one transaction with `where version = :expected`. Use a tiny test machine for the mechanics until real contracts arrive in M2.
- Constraints: no Windmill or HTTP imports. No rule is hard-coded outside contracts and guard functions.
- Success: unit tests for each invariant in `docs/schema.md`. A concurrency test shows two parallel requests for the same node produce one winner and one clean retry.

### M1.4 Tiny state API

- What: an HTTP API over the library: create idea, add edge, report done with evidence, record decision, read a node, read the attention list.
- Why: agents and adapters need a safe door.
- How: per ADR 0102. Each caller has its own identity and can only do what its role allows. No endpoint changes a node's state directly except through `requestTransition`, and callers other than the runner cannot call it.
- Success: API tests per role: allowed calls work, forbidden calls are rejected, and a bot cannot move an item.

### M1.5 Seed the store from Linear (read-only)

- What: an idempotent import of the system's own work items and relations from Linear into the store.
- Why: dogfooding, and it is the first input to the dry run.
- How: read-only Linear access. Map current statuses to states using the table in `docs/spec.md`. Record each import as a transition with trigger `import`.
- Constraints: read-only. Do not write to Linear.
- Success: running the import twice produces no duplicates. A report lists every item and its mapped state, and items that do not map cleanly.

## Milestone 2: contracts, guards, evidence and dry run

Goal: the runner can say what it would do, and be right.

### M2.1 Contracts as data and the consistency test

- What: `contracts/` files for Machine 2 (code track, design track, escalation) from `docs/spec.md` section 9, and a test comparing them with the spec.
- Why: contracts must not drift from the spec or live in flows.
- How: ADR 0105. A loader that validates the files against a schema. The test parses the spec's transition tables and fails on any difference.
- Success: the test passes, and deliberately removing a transition from either side fails it.

### M2.2 Guards

- What: one function per guard named in the contracts.
- Why: gates are enforced in code.
- How: at least `blockers_done`, `design_spec_merged`, `no_pending_gate`, `ci_green_on_head`, `docs_updated_or_none`, `qa_verdict_on_head_different_family`, `privileged_paths_approved`, `prod_env_protected`, `approval_recorded`, `not_third_failed_round`, `staging_check_on_merge_commit`, `spec_edited_by_designer_only`, `scope_matches_plan`.
- Constraints: a guard reads only evidence for the PR's current head commit. A guard never calls a model. `scope_matches_plan` is a gate request when the check is a judgment call, not a model verdict.
- Success: each guard has tests for pass, fail, stale evidence and missing evidence. Mutation testing of the guards finds no surviving mutants in the core logic (see `docs/test-plan.md`).

### M2.3 Evidence ingestion from GitHub

- What: record CI results, PR state, head commit, preview and staging deployments, merge state, as evidence.
- Why: proof must come from outside the agents.
- How: a webhook receiver with idempotency by delivery id, plus a polling backstop in the reconcile pass.
- Constraints: GitHub App identity for the runner. No secrets in logs.
- Success: replaying the same webhook twice records one evidence row. Killing the receiver and running the reconcile pass records the same evidence.

### M2.4 Reconcile pass in dry-run mode

- What: the reconcile pass of `docs/architecture/technical-architecture.md` section 2.5, writing `dry_run` transitions and acting on nothing.
- Why: it is how the cutover is rehearsed.
- How: a function in the library plus a Windmill schedule every 5 minutes. It respects the kill switch and `dry_run`.
- Success: against the imported state it releases the right blocked items, flags the right stalls, and plans the right dispatches. Nothing outside the store changes.

### M2.5 Dry-run report

- What: a report that compares what the runner would do with what is true today.
- Why: it is the main input to the go or no-go decision (O-07).
- How: for each node, show the mapped state, the planned transition, and the guard result. List differences from Linear and from recent history.
- Success: every difference is either fixed or explained. (Review point: Didi reads the first report.)

## Milestone 3: the runner live on a rehearsal project

Goal: Machine 2 works end to end on a throwaway project, with real agents.

### M3.1 Windmill flows

- What: one flow per transition, the reconcile flow, and webhook handlers.
- Why: this is the runner.
- How: flows call the library and adapters, check the kill switch and settings, and are idempotent. No business rules inside flows.
- Success: flow tests with fake adapters pass. A duplicate trigger produces one transition.

### M3.2 Dispatch adapters and runs

- What: adapters to start the Developer (Claude Code), QA (Grok, or the fallback from M0.2), Designer (Claude with MagicPath MCP), and Council and Triage (Claude). Each records a run.
- Why: the bots do the judgment work.
- How: per ADR 0106 and 0107. Budgets (turns, minutes, dollars) are generous at first and enforced from outside the agent. When usage is exhausted, queue the dispatch and resume. Never kill a run mid-transition.
- Constraints: one agent per item, up to 3 Developer agents per project. Each agent is scoped to one project's repo and credentials. No production access.
- Success: each adapter can start an agent on a trivial task in the rehearsal project and record a run with model, turns, minutes, cost and outcome. A simulated usage-exhausted response queues and resumes.

### M3.3 Merge by the runner

- What: the merge action and its guard.
- Why: gates as code.
- How: the guard from the contract: CI green on the head commit, no conflicts, not past the round cap, privileged paths approved, production environment protected where the deploy runs on push to main. Squash merge.
- Constraints: a privileged-path PR is never merged without a recorded approval.
- Success: tests for each failure of the guard. A privileged-path PR creates a gate request and waits.

### M3.4 Staging verification

- What: after a merge, wait for the staging deploy, dispatch the staging check, and record the result.
- Why: Done requires it.
- How: trigger on the deploy event with a polling backstop. On pass the item is Done and dependents are released. On fail the item returns to In development (or Building components) and `failure` increases.
- Success: a rehearsal run passes, and a deliberately broken change reopens the item.

### M3.5 Escalation and stale marking

- What: counters, the Escalated to Council and Escalated to Didi states, and marking dependents stale when a decision is reversed.
- Why: a failing item must stop and move up, and a reversed approval must not leave work running on a stale basis.
- Success: three deliberate failures reach Escalated to Council. A Council "cannot resolve" reaches Didi as a gate request. A reversed decision marks dependents stale and opens a Council question.

### M3.6 Minimum Machine 1 (Proposed scope, P-05)

- What: create an idea through the API, record decisions verbatim, and a Triage transition from Plan accepted to work items.
- Why: work must be able to enter the system at cutover, since the Grok triage and breakdown routines will be disabled.
- How: Triage follows the rules from the Grok breakdown routine: one PR per child, acceptance criteria, blocked-by links in execution order, a project on every item, a developer counterpart for every design item, parts that need Didi become their own gate items, personal and non-engineering items are skipped, a hold flag replaces hard-coded exclusions. A mixed item is split into linked items, one per track. Any visible change goes to the design track. Interview and Council planning stay a chat with the Council, recorded through the API. The track classification goes through a decision-point interface (P-11), with a rule or a Sonnet call behind it.
- Success: a test plan accepted in the rehearsal project becomes the right items, edges and tracks. Review point: Didi confirms the minimum scope before this task starts.

### M3.7 Infrastructure as code in the deploy adapter

- What: the deploy adapter wraps `plan` and `apply`.
- Why: infrastructure changes become reviewable and gateable.
- How: a PR that touches `infra/` makes the runner run a plan and save its summary as evidence. A plan that includes DNS changes, new secrets or wider permissions, or deletions opens the matching gate request with the plan attached. The runner applies only after approval. Staging applies with none of those are free to run. Drift is reported by a plan in the reconcile pass.
- Constraints: production applies are never done by the runner. Cloudflare-specific code lives only in this adapter.
- Success: tests show a plan with a DNS change opens a gate and waits, an approved plan applies, a deletion opens the drop-data gate, and a drift report does not apply anything. The adapter contract test passes against the Cloudflare implementation and a fake second target.

Verification for M3: in the rehearsal project, one item passes each track to Done, each fail path reopens the item and increments the counter, and the third failure escalates. (Review point: Didi watches or reviews a recorded rehearsal.)

## Milestone 4: gates, attention list, alerts, daily check

Goal: Didi can act from his phone and nothing waits invisibly.

### M4.1 Gate request lifecycle

- What: open, supersede by topic key, answer, expire, and cancel gate requests. The attention list is a view.
- Success: only one open request per topic key. A newer request supersedes an older one. Tests cover every kind in `docs/schema.md`.

### M4.2 Approval pages

- What: Windmill approval pages that show the question, links and the diff against locked product direction, and save the answer as a verbatim decision with a scope (one commit, one option, one request).
- Success: an answer is recorded with Didi's exact words and a scope, and the suspended flow resumes. A new commit on a privileged PR requires a fresh approval.

### M4.3 Notifications and incident calls

- What: push alerts for blocking gates and long stalls, and calls for a failed production health check, data loss or PII exposure flagged by a bot, and daily spend over the set amount.
- How: choose providers (ADR 0109) after checking current pricing. A production health check is plain code. Who flags PII exposure is N-08.
- Constraints: a paid plan is Didi's decision. Alerts never block progress.
- Success: each trigger fires its alert in a test, and the call fires once per incident, not repeatedly. (Review point: Didi approves providers and spend.)

### M4.4 Daily check

- What: a generator and delivery of the daily check, including the production deploy approval link.
- Success: a sample shows, per project and ordered by what blocks the most work: what moved, what is blocked, staging links, questions waiting, and spend.

### M4.5 Spend roll-up

- What: daily and per-run cost from the `runs` table, with the alert and call thresholds read from settings.
- Success: crossing each threshold in a test raises the right alert. Work continues after the alert.

## Milestone 5: Linear mirror

Goal: Linear shows the state and cannot silently drift.

First run the M0.3 Linear spike, moved here from Milestone 0 (D-147). If the Linear mirror is dropped before then, the spike is dropped with it.

### M5.1 One-time Linear setup (review point)

- What: create the new statuses (Interview, Council planning, Escalated to Council, Escalated to Didi), rename Ready for triage to Submitted, Ready to explore design to Ready for design exploration, ready for maintainer to Waiting for Didi, and Ready for CTO breakdown to Triage. Plan the retirement of Ready for review and Ready for design dev.
- How: a script if M0.3 showed the API can do it, otherwise a manual runbook.
- Constraints: run on the real team only after Didi approves. Retire statuses only after cutover.
- Success: the status list matches the mapping in `docs/spec.md`.

### M5.2 Linear adapter

- What: write statuses, issues and comments through Linear's API under the runner's app identity, from the store.
- How: a mapping config, idempotent writes, rate-limit handling, and mismatch reporting. A mismatch is reported, never overwritten silently. Behind an adapter so Linear can be swapped out later.
- Success: after a state change, Linear matches within one reconcile cycle. Changing a status by hand creates a reported mismatch.

### M5.3 Bot identities

- What: each bot and agent acts under its own identity in GitHub and Linear.
- Success: a QA verdict appears as a real review from the QA identity, and a bot comment is distinguishable from Didi's without a text prefix.

## Milestone 6: cutover

See `docs/cutover.md`.

- M6.1 Rehearsal on the real imported state, with fixes until the dry run report has no unexplained differences.
- M6.2 Go or no-go checklist with Didi.
- M6.3 Cutover day: disable the Grok routines, set `dry_run` to false, watch the first cycles, test the kill switch.
- M6.4 One week later: tune budgets from the `runs` table and adjust thresholds.

## Milestone 7: second release, the Kubernetes platform (planned, not detailed)

Goal: a pod per project, per-project isolation, monitoring, and a way off Cloudflare.

This is its own project, run through the factory starting with the Interview. It is outlined here so the first release leaves room for it:

- A cluster (k3s on a VPS or a managed cluster, decided then), GitOps, Vault for secrets, and replicas.
- Per-project namespaces with network policies and resource quotas, so each project is isolated.
- A Kubernetes deploy adapter next to the Cloudflare one, with previews and staging per project.
- Monitoring: metrics, logs, dashboards, and alerts wired into the existing alert and call tiers.
- A self-hosted model gateway (LiteLLM or Bifrost, chosen then; O-10) as a pod, with the agent runtime adapters pointed at it by changing the model endpoint setting in each bot file. OpenRouter is not chosen (D-142).
- Move the state API and the agent runners onto the cluster. Then move projects off Cloudflare one at a time.
- First, import the existing Cloudflare resources of current projects into infrastructure as code, and add the proven `infra/` module to Launchpad (outside this repo; Launchpad is public, so no account ids or secrets), with a Kubernetes variant.
- Revisit the managed Postgres (D-118) and whether to self-host Windmill because of token and cost burn.

## Milestone 8: after that (not scheduled)

The full intake agent for Machine 1 (the interview as a chat with the Council, Council planning), the viewer (read-only state machine with a live item overlay), the frontend (attention list and viewer), a role for Cursor agents, and the Recruiter flows on the runner.

## Milestone 9: decision models (release 3 or 4, not scheduled, not detailed)

Small models that return typed choices, scores or probabilities (D-148). They fill the decision points from P-11 in place of a rule or a Sonnet call, without changing flows, and only advise (P-12). Jev's System One is a pilot candidate; compare alternatives then (O-11). Use cases and the open items they would help:

| Use case                                                                     | Helps with                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Classification, spot decisions                                               | N-01 (small visual tweak), N-02 (Triage rubric), N-06 (severity), N-08 (PII flag), the Triage track in M3.6 |
| Agent guardrails, LLM guardrails                                             | Screening untrusted PR text before QA                                                                       |
| Model routing, LLM cascades                                                  | The self-hosted model gateway (O-10) and the spend alerts (M4.5)                                            |
| LLM-as-a-judge                                                               | Evidence for the QA guard (P-04), never a verdict the runner trusts on its own (P-12)                       |
| Context compaction (with a classifier on what to compact), memory management | The deferred context graph (N-14)                                                                           |
| Search and rerank, reranker in RAG                                           | The deferred context graph (N-14)                                                                           |
| Tool selection                                                               | Choosing tools inside a role's allowed toolbox                                                              |
| Workflow branching                                                           | Recommendation only; the guard and the runner decide (P-12)                                                 |

## Milestone 10: Machine 3, the Scanner (after cutover is stable, not detailed)

Self-improvement stage A (D-151). A scheduled, read-only scan whose findings become ideas in Machine 1 (D-150). It never changes code, opens PRs or creates gate requests. Starts after cutover has run stably for a few weeks; it does not need Kubernetes and is independent of RSI (P-16).

- Sources, idea fields, safeguards and intake by class: `docs/architecture/technical-architecture.md` section 2.12 (P-13 to P-15).
- Before it starts, Didi reviews the schedule and scope per project, the idea cap, the confidence threshold, the scan budget and the model (O-12).

## Milestone 11: recursive self-improvement (release 4 or later, not scheduled, not detailed)

Stages B to D of D-151, which are RSI Levels 1 to 3 (P-17). Planned for release 4 or later (D-152). Production deploys stay Didi's (D-007, D-149).

| Stage | Level   | What                                                                                                                                                                                       | Depends on                                     |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| B     | Level 1 | Proposed changes to the playbook, bot files, prompts and contract thresholds as ordinary ideas, tested by replaying recorded history and shadow runs. Didi approves                        | The dependencies below, except Kubernetes      |
| C     | Level 2 | Changes to the factory's own code in an isolated sandbox, deployed to staging, run against the current version, rolled back automatically on regression. Production promotion stays a gate | Level 1, Kubernetes (Milestone 7)              |
| D     | Level 3 | Didi's call later: auto-promotion for narrow, low-risk classes of change, never for the protected set                                                                                      | Level 2, an explicit decision per class (N-24) |

Dependencies:

- Cutover stable, with at least a few weeks of data (M6).
- Decision-point records (P-11).
- Kubernetes for Level 2 (Milestone 7).
- Decision models (Milestone 9).
- The Scanner as a source of ideas (Milestone 10).
- Still to build first: an outcome view per work item, a replay harness, and an experiment tag on runs (`docs/architecture/technical-architecture.md` section 2.13).

Protected set (P-18), never changed by the system without Didi, enforced through the privileged-path list and the merge guard: the gate list and its enforcement code, the guards that authorize transitions and the privileged-path list, the runner's credentials and how they are issued, the metrics and the evaluation harness, spend caps and the kill switch, the rule that production deploys are Didi's, and this list itself. Every self-change follows the RSI rules (P-19).

## Order and dependencies

- M0.0 comes first. M1 needs M0. M2 needs M1. M3 needs M2.
- M4 can start once the API exists (M1.4) and run in parallel with M3.
- M5.1 and M5.2 can start after M1. M5.2 integrates with M3.
- M6 needs M3, M4 and M5.

## Review points, in one list

1. M0.0: the placement ADR.
2. End of M0: ADRs and spike results.
3. M0.4: is the approval page channel good enough.
4. M0.5: provider, spend, credentials.
5. M1.1: schema ADR before the migration is applied.
6. M2.5: the first dry-run report.
7. Before M3.6: the minimum Machine 1 scope.
8. After M3: the rehearsal.
9. M4.3: notification providers and spend.
10. M5.1: before running the Linear setup on the real team.
11. M6.2: go or no-go.
