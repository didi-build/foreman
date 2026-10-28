# Technical architecture

Status: draft, 2026-10-28. Items marked Proposed need an ADR and review. Items marked To verify need a spike before anything depends on them.

## 1. Overview

Four ideas shape the design:

1. The state store is the source of truth. Every other thing (Linear, approval pages, push alerts, the daily check, a future frontend) renders it.
2. The runner decides every transition. A transition is a guarded, transactional write. Agents propose by reporting; they never write state.
3. Contracts are data. Guards, evidence, timeouts and fallbacks are loaded at a version, not hard-coded in flows.
4. Plumbing is plain code. Models do judgment inside a state and nothing else.

```mermaid
flowchart LR
  Didi[Didi on phone] -->|answers| Approval[Windmill approval pages]
  Push[Push app and call service] --> Didi
  subgraph Runner[Windmill: the runner]
    Reconcile[Reconcile loop, every 5 min]
    Flows[Transition flows]
    Approval
    Daily[Daily check]
  end
  Flows --> Lib[State library: transitions, guards, contracts]
  Reconcile --> Lib
  Lib --> Store[(Managed Postgres: state store)]
  Flows --> Agents[Agents: Claude Code, Claude, Grok]
  Agents -->|report done, evidence| Flows
  GitHub[GitHub: PRs, CI, preview, staging] -->|webhooks and API| Flows
  Flows -->|merge, read CI| GitHub
  Lib --> LinearAdapter[Linear adapter]
  LinearAdapter --> Linear[Linear: mirror]
  Flows --> Notify[Notification adapter]
  Notify --> Push
```

## 2. Components

### 2.1 State library (core, plain TypeScript)

- Pure logic with no Windmill or HTTP dependency. Takes a store interface and a contracts object.
- Exposes operations: create node, add edge, record evidence, record decision, open or supersede a gate request, request transition, run the reconcile pass, and read views (attention list, daily check data).
- `requestTransition(nodeId, toState, trigger, actor)` loads the node, finds the contract for the move, evaluates the guard against recorded evidence, and on success writes the transition row and updates the node in one transaction with the version check. It returns the result and the guard report.
- Everything else (flows, API, adapters) is a thin shell around it. This is where most tests live.

### 2.2 State store

Managed Postgres. Schema in `docs/schema.md`. Append-only tables are protected by database roles or triggers. Provider and region are open (check free-tier limits, idle pausing, and a Canadian region). Revisit when there is a Kubernetes cluster with a vault and replicas.

### 2.3 State API (tiny, Proposed)

A thin HTTP API over the library for agents, the viewer and adapters: create idea, record decision, report done with evidence, read a node, read the attention list. Hosting options for the M0 ADR: Windmill scripts exposed as endpoints, or a small service (for example a plain Node service; a Worker is allowed only if the code stays portable). Choose the simplest option that keeps agents from touching the database directly, and keep Cloudflare-specific APIs out of the API and the library (D-132). Agents authenticate with their own identity and can only write what their role allows.

### 2.4 Runner (Windmill)

- One flow per transition, plus the reconcile flow, event handlers for webhooks, and the daily check flow. Windmill's flow format is acyclic, and our machine has cycles (a QA failure sends work back), so durable state lives in the store and each flow handles exactly one transition.
- Flows are small. They call the library, call adapters, and write results. They contain no business rules.
- Every flow is idempotent. A repeated webhook or a retried run produces the same final state.
- Approval steps suspend a flow until resumed through a URL. They are the primary channel for gate approvals in v1 (To verify on a phone).

### 2.5 Reconcile loop

Runs every 5 minutes, every day of the week (setting `reconcile_interval_minutes`). It is the backstop for missed events. Each pass does, in order:

1. If `kill_switch` is true, stop.
2. Release: for each Blocked node whose blockers are all Done (and whose design spec is merged where required), request the transition to Ready.
3. Dispatch: for each node that is ready but has no active run, dispatch the owning bot. A ready item that is not running after one cycle is a bug, so it is put on the attention list and the daily check, and becomes a push alert after `stall_phone_alert_after_minutes`.
4. Advance from evidence: if an agent has pushed fixes and CI is green on the head commit, move the item to review and dispatch QA. If main has deployed to staging after a merge, dispatch the staging check.
5. Stall check: flag running items that stopped making progress (no run activity within the run's budget window).
6. Clean up: close gate requests that are no longer needed or are absorbed by a newer request on the same topic.
7. Mirror: write the current state to Linear through the adapter and report mismatches (do not overwrite silently).
8. Spend: roll up cost per day, raise the alert threshold, and raise a call at `daily_spend_call_usd`.

In `dry_run` mode the pass computes the same plan but writes transitions with mode `dry_run` and acts on nothing.

### 2.6 Contracts as data (Proposed)

- Contracts live in `contracts/` as YAML or JSON: states (purpose, input, output, evidence to exit, tools and permissions, budget, side effects, failure) and transitions (trigger, guard, timeout, fallback), for Machine 1 and Machine 2.
- Each guard is a named function in the library, referenced by name from the contract (for example `blockers_done`, `ci_green_on_head`, `qa_verdict_on_head`, `privileged_paths_approved`, `prod_env_protected`, `approval_recorded`, `not_third_failed_round`).
- The spec version is the git commit sha of `docs/spec.md` and `contracts/`. The runner records it in `spec_versions` and on every transition.
- A consistency test compares the transitions in the contracts with the transitions in `docs/spec.md`. A transition that exists in one and not the other fails CI.
- Whether the spec should generate Windmill flows automatically is open and deferred.

### 2.7 Adapters

Each integration sits behind an interface so it can be replaced.

| Adapter       | Does                                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub        | Reads PRs, CI results, preview and staging deployments, merge state. Merges PRs. Receives webhooks                                                                                                 | Bots and the runner act through GitHub Apps with their own identities, so QA can post real reviews and round counts come from the store                                                                                                                                                                           |
| Linear        | Creates and updates issues and statuses, mirrors the store                                                                                                                                         | Uses Linear's own API under the runner's app identity, not the MCP. To verify: that the API can create statuses and let an app act under its own identity. A one-time setup creates new statuses (Interview, Council planning, Escalated to Council, Escalated to Didi) and renames others (see the spec mapping) |
| Agent runtime | Starts an agent on a task and reads its result                                                                                                                                                     | One implementation per runtime: Claude Code (Developer), Claude with MCP tools (Designer, Council, Triage), Grok (QA, To verify). The bot file names the runtime and model                                                                                                                                        |
| Deploy        | Staging deploys and preview branches, through infrastructure as code (plan, then apply). Cloudflare Workers first, Kubernetes in the second release. The only place Cloudflare-specific code lives | Production deploys and production applies are not available to the runner. A plan with DNS changes, new secrets or wider permissions, or deletions goes through its gate first                                                                                                                                    |
| Notification  | Push alerts and incident calls                                                                                                                                                                     | Providers are chosen at build time after checking current pricing                                                                                                                                                                                                                                                 |
| Approval      | Creates Windmill approval pages and reads answers                                                                                                                                                  | Answers are saved as verbatim decisions                                                                                                                                                                                                                                                                           |

### 2.8 Agent execution environment (decide during build)

Agents need somewhere to run. Options for the M3 ADR: a Windmill worker with the agent CLI, GitHub Actions, or a separate sandboxed runtime. Claude Code can be run non-interactively from a command line (check the current documentation for the headless mode or Agent SDK before depending on a specific flag). Requirements: one agent per item, scoped to one project's repo and credentials, no production access, budgets enforced from outside the agent (turn, minute and dollar limits), and a clean report-back path that records a run and evidence.

### 2.9 Infrastructure as code (Proposed, D-133)

- Why: with deploys spread across Cloudflare it is hard to see what is set up and where. Declaring it in a repo makes that visible, and a plan is the exact diff a gate should show.
- Scope: each project's Cloudflare resources and DNS, the factory's own staging resources, and, where providers exist, the managed Postgres and GitHub settings.
- Tool: Terraform or OpenTofu (the open-source fork). Check current Cloudflare provider support for each. Decide in ADR 0110.
- State: a remote, locked backend, not in the repo. Check free tiers. Never put secret values in code, state output or plans. Pass secrets from the vault at apply time.
- Layout: an `infra/` module per project, ideally from Launchpad. The Launchpad change is outside this repo (N-15).
- Flow: a PR that touches `infra/` makes the runner run a plan and save its summary as evidence. If the plan includes DNS changes, new secrets or wider permissions, or deletions, the runner opens the matching gate request and attaches the plan. The runner applies only after approval. Production applies stay with Didi.
- Drift: the reconcile pass (or the daily check) runs a plan to detect drift and reports it. It does not apply.
- Existing resources: import them per project after cutover so the cutover is not delayed.
- Kubernetes: the planned second release (D-134). See section 2.10.

### 2.10 Preparing for Kubernetes (Proposed, D-134, ADR 0111)

The second release moves to Kubernetes for a pod per project, per-project isolation and monitoring, and eventually off Cloudflare. The first release does not build a cluster. It is built so the switch is easy:

- Containers: the state API and the agent runners are container images with a Dockerfile. They read config only from the environment, expose a health endpoint, log structured JSON, and shut down cleanly. No platform-specific code.
- A target-agnostic deploy adapter: the operations are deploy, preview, health, logs and teardown, with a Cloudflare implementation first. Previews and staging are concepts in the adapter, not Cloudflare URLs in the code. A contract test runs against two targets (Cloudflare and a fake second one).
- The isolation model is defined up front: each project has its own boundary of credentials, secrets path (`projects/<slug>/...`), network rules and resource limits. In the first release the boundary is enforced by credentials and the secrets path. In the second it maps to a namespace with network policies and quotas.
- Secrets are referenced by path behind an interface: Windmill resources now, Vault later.
- The IaC layout separates platform modules from project modules. A project module takes a target (Cloudflare now, Kubernetes later), so a project can move without a rewrite.
- Monitoring hooks: structured logs, health endpoints, and the `runs` and `transitions` tables already provide the data. The monitoring stack (metrics, logs, dashboards, alerts wired into the existing alert and call tiers) arrives with Kubernetes.
- The second release is its own project, run through the factory with the Interview first. It is outlined in Milestone 7 of the build plan and not detailed here.

## 3. Key flows

### 3.1 Code track item

1. Ready for dev: the reconcile loop (or the entry event) dispatches the Developer. Guard: no open blockers, no pending gate request on the item, agent-ready, not on hold. The run is recorded.
2. The agent works on a branch and opens a PR. It reports done with the PR link.
3. The runner reads CI for the head commit and checks docs. If the guard passes, the item moves to In QA review and QA is dispatched. If not, it stays In development and `failure` increases by one.
4. QA checks the preview branch (different model family) and posts a verdict naming the commit. Evidence is recorded.
5. On pass, the runner checks the merge guard (CI on head, no conflicts, privileged paths approved, production environment protected where relevant) and merges. The substate becomes `verifying_on_staging`.
6. Main deploys to staging. A bot checks staging. On pass the item is Done and dependents are released. On fail the item returns to In development and `failure` increases by one.
7. Three failures, or three failed QA rounds, send the item to Escalated to Council.

### 3.2 Design track item

Ready for design exploration, In design exploration (visual options), Waiting for Didi (visual approval, or the Council for a small tweak), Writing spec (Designer only edits `design/<area>/<feature>/`), Building components, In QA review on the preview branch, merge by the runner, Verifying on staging, Done. On Done the runner adds a Spec section to the linked developer item (merge commit, paths on main, final decisions) and releases it.

### 3.3 Gate request

1. A guard or an agent report needs a human or the Council. The library opens a gate request with a topic key (superseding any open request on the same topic) and a payload.
2. A Windmill approval page is created. A blocking request also raises a push alert with the link.
3. Didi answers. The answer is saved as a verbatim decision with a scope (for example one exact commit, one option, one request). The suspended flow resumes.
4. If the answer reverses an earlier approval, dependent nodes become stale and a Council question opens.

### 3.4 Cutover

See `docs/cutover.md`.

## 4. Security model

| Actor              | Can                                                                                                                      | Cannot                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Runner             | Read and write the state store. Read CI, merge PRs. Write Linear through its API. Deploy to staging                      | Deploy to production. Hold any credential beyond these without the new-credentials gate. Reach real personal data without a PII gate |
| Developer agent    | Read and write one project's repo branches, open PRs, read CI                                                            | Merge. Reach production or remote databases. Print secrets. Change the spec directory                                                |
| Designer agent     | Edit `design/<area>/<feature>/` and gallery components for one project. Use the MagicPath canvas through MCP and exports | Edit anything else. Read MagicPath comments in v1 (needs a signed-in browser)                                                        |
| QA agent           | Read PRs, CI, preview and staging. Post verdicts under its own identity                                                  | Merge. Edit code                                                                                                                     |
| Council and Triage | Read the status view of all projects, create plans, work items and decisions                                             | Read other projects' code or secrets. Move states directly                                                                           |
| Didi               | Everything gated to him                                                                                                  |                                                                                                                                      |

Rules:

- No secret values in chat, repos, Linear, logs or transcripts. Secrets live in the vault or Windmill resources.
- Temporary credentials for personal data: Didi approves one request, the runner mints or enables a credential whose expiry (default 60 minutes) is set and enforced by the runner, not chosen by the agent.
- Every bot and agent has its own identity so no action looks like Didi's.
- Privileged paths (migrations, PII, privacy, deploy workflows, `.github`, secrets) are listed in Launchpad as a default, and each repo can add to it. The runner decides from the list, never the bot.
- Toolbox: each tool declares a side-effect type (read, write, needs approval, only Didi). The runner refuses to call a needs-approval tool without an approval attached, so gates are enforced by the toolbox itself.

## 5. Observability

- The `transitions` log explains every state. The `evidence` table explains every guard.
- The `runs` table records model, turns, minutes, cost and outcome. Spend and stall checks read it.
- The daily check is generated from the store, grouped by project and ordered by what blocks the most work.
- The attention list is a view of `gate_requests` and stalls. Channels only render it.
- Alerts: push for blocking gates and long stalls; a phone call for a failed production health check, data loss or PII exposure flagged by a bot, and daily spend over the set amount.

## 6. Failure modes

| Failure                                   | Handling                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Missed or duplicate webhook               | Reconcile loop catches it. Flows are idempotent                                                                                 |
| Two runner jobs move the same item        | The version check makes one fail. It retries from a fresh read                                                                  |
| Model usage exhausted                     | Plumbing is code and keeps running. Dispatches queue and resume. Runs record `usage_exhausted`. No run is killed mid-transition |
| Linear unavailable or out of sync         | The runner continues. The mirror lags and reports a mismatch. It never overwrites silently                                      |
| Agent loops or burns budget               | The run stops at its budget. The item goes to Escalated to Council                                                              |
| QA verdict for an old commit              | Ignored. A verdict applies only to the PR's current head commit                                                                 |
| Approval pages unreachable                | Email digest and Linear view still show the attention list. Production deploys can still be approved on GitHub                  |
| Runner misbehaves                         | Kill switch pauses all transitions and dispatch. Grok routines are disabled, not deleted, so they can be re-enabled             |
| Grok or another runtime cannot be started | QA moves to another non-Claude agent. The bot file makes the model a setting                                                    |
| Reversed approval                         | Dependents marked stale, a Council question opens, nothing continues on the stale basis                                         |

## 7. Deployment

- Windmill Cloud for the runner. Managed Postgres for the state store. The API location is decided in M0. Infrastructure is declared as code (section 2.9).
- The API and agent runners ship as containers. Where they run in the first release is decided in ADRs 0102 and 0106. As guidance, always-on services fit the droplet and bursty work fits on-demand compute. The move to Kubernetes in the second release is a redeploy, not a rewrite (section 2.10).
- The factory is its own first project. Its production deploys stay with Didi. Gates stay fully on during bootstrap.
- Environments: a staging project used for rehearsals, and the real projects. A rehearsal never touches real projects.

## 8. Architecture decisions to write as ADRs

| ADR  | Decision                                                                                   | When              |
| ---- | ------------------------------------------------------------------------------------------ | ----------------- |
| 0101 | Repo layout, language and tooling (TypeScript, test runner, lint, CI, pinned dependencies) | M0                |
| 0102 | State API hosting and agent authentication                                                 | M0                |
| 0103 | Managed Postgres provider and region                                                       | M0                |
| 0104 | Final column-level schema, the reversal mechanism for decisions, counter rules             | M1 (review point) |
| 0105 | Contracts format and consistency test                                                      | M2                |
| 0106 | Agent execution environment and budget enforcement                                         | M3                |
| 0107 | Dispatch adapters per runtime and the Grok verification result                             | M0 spike, M3      |
| 0108 | Linear adapter, statuses setup and app identity                                            | M5                |
| 0109 | Notification providers                                                                     | M4                |
| 0110 | Infrastructure as code: tool, state backend, secrets handling, layout                      | M0 (M0.7)         |
| 0111 | Conventions that make the move to Kubernetes cheap                                         | M0 (M0.8)         |
