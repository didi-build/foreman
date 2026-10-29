# 0113. GitHub evidence ingestion

- **Status:** accepted at the M2.3 review point (D-180, 2026-10-29).
- **Date:** 2026-10-29
- **Related:** build plan M2.3 and M2.4, D-156, D-160, D-164, D-178, essentials 1 and 6, `docs/guards.md`, [ADR 0102](./0102-state-api-hosting-and-agent-auth.md), [ADR 0104](./0104-state-store-schema.md), [ADR 0111](./0111-kubernetes-ready-conventions.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md)

## Context

The guards (M2.2) read evidence the runner records from outside the agents: CI results on a PR's head commit, merge commits, and later preview and staging checks. M2.3 records that evidence from GitHub, through webhooks plus a polling backstop in the reconcile pass. The guards fix what must come out: the head commit is the commit named by the newest `ci_run` on the node, so a `ci_run` may only ever be recorded for the PR's current head (D-178), with the payloads in `docs/guards.md`. M2.3 is built and tested against a fake GitHub; the real Apps are registered at M3 (D-178).

## Decision

### 1. Where webhooks arrive: a small receiver service

A new container service, `src/github-receiver/`, with the ADR 0111 conventions, connected to the store through its own narrow database role `factory_ingest`.

- Not a route on the state API: the API's role (`factory_api`) cannot write evidence a guard trusts, by design (essential 6, ADR 0102). Giving the API that power to receive webhooks would break that separation.
- Not Windmill webhooks: every delivery would be a Windmill execution, and the free tier's 1,000 a month (D-164) would be gone in days.
- It runs on the same host as the state API (one droplet, or one App Platform app with two components), so it adds no separate host.

### 2. Authenticity, before anything is parsed

- The body is read raw, capped at 1 MB. The events we use are far smaller; anything larger is rejected.
- `X-Hub-Signature-256` is checked with HMAC-SHA256 over the raw bytes, using the webhook secret read by path (`platform/github/runner-webhook-secret`, ADR 0111 section 4), compared in constant time (`crypto.timingSafeEqual`).
- A missing or wrong signature gets 401 and nothing is parsed, stored or logged beyond the delivery id.
- Only the events in the table below are processed; any other event type gets 202 and is counted, not stored.

### 3. Idempotency, at two levels

- **Deliveries:** a new table `factory.github_deliveries` (migration 0002): delivery id (`X-GitHub-Delivery`, primary key), event type, repository, received at, outcome (`recorded`, `ignored`, `rejected`) and a short reason. Payloads are never stored whole (size, and they can name people). A replayed delivery id records nothing new.
- **Evidence:** a new nullable, unique column `evidence.ingest_key` (same migration). Webhooks and the polling backstop build the same key for the same fact, for example `github:ci_run:<repo>#<pr>:<sha>:<conclusion>`, so the two paths never record the same fact twice.
- `factory_ingest` may insert into `github_deliveries` and insert evidence of the kinds below only (row level security), read nodes, runs and evidence, and nothing else.

### 4. Linking a PR to a node

A PR belongs to a node only when all of these hold:

1. The PR is in the node's project repository, from a branch in that same repository (fork PRs are never linked).
2. Its head branch is the branch named in the node's latest `dispatch_record` evidence, which the runner writes when it dispatches (M3.2).
3. The PR's author is the Developer or Designer App identity (D-156).

A PR body trailer is not used: anyone who can open a PR could write one and attach their CI result to someone else's item. Events for a PR that links to no node are acknowledged, recorded in `github_deliveries` as `ignored`, and counted for the daily check.

### 5. Events to evidence

| GitHub event                                          | Evidence                                                               | Rule                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request` `opened`, `reopened`, `synchronize`    | `ci_run` with `conclusion: pending`, `pr`, `changedPaths` (fetched)    | Recorded for `pull_request.head.sha`, the new head. This is what moves the head forward                                                                                                                                                                                          |
| `check_suite` `completed`, `workflow_run` `completed` | `ci_run` with `conclusion: success` or `failure`, `pr`, `changedPaths` | Only if the sha equals the PR's current head, fetched from GitHub at that moment. The conclusion is computed from all check runs on that sha, **excluding the runner's own `QA` check run** (D-160). A rerun on an older commit is ignored, so the head never moves back (D-178) |
| `pull_request` `closed` with `merged: true`           | `merge_commit` with `commitSha` = the merge commit on main, `pr`       | Written once per PR                                                                                                                                                                                                                                                              |
| `deployment_status`, `push` to main                   | None                                                                   | Not evidence by themselves: a deployment succeeding says nothing about whether the app works. They tell the runner to run its own preview or staging smoke check (ADR 0107), which writes `preview_check` or `staging_check`. M2.3 only records the delivery                     |

"Pending" from a `pull_request` event and the later "success" or "failure" are separate `ci_run` rows for the same sha; the guard reads the newest.

### 6. Polling backstop (reconcile pass, M2.4)

For each node with a linked open PR, the reconcile pass fetches the PR's current head, the check runs on that head, and whether it merged, and records the result through the same functions and the same `ingest_key`s as the webhooks. Missing a webhook therefore costs at most one reconcile interval, and never a duplicate row.

### 7. The GitHub adapter

`src/adapters/github/` exposes only what ingestion needs: `getPullRequest(repo, number)`, `listChangedPaths(repo, number)`, `listCheckRuns(repo, sha)`, `listOpenPullRequests(repo)` and webhook signature verification. A fake implementation in the same folder backs every test. The ingestion logic itself (event to evidence, the head rule, the keys) lives in the core as plain functions over an injected adapter interface, so the core stays free of HTTP (essential 5).

### 8. Secrets and logging

- The webhook secret and the runner App's private key are read by path and never logged, echoed or stored.
- Logs carry the delivery id, event type, repository, PR number and outcome. Never payload text, branch names from forks, or author names.

## Constraints

- No real GitHub App, webhook URL or secret is created in M2.3 (D-178). Everything runs against the fake.
- `factory_ingest` cannot move a node, write decisions, or write agent evidence kinds.
- Fork PRs are never linked.

## How success is judged

1. Replaying the same webhook delivery records one evidence row (build plan M2.3).
2. Dropping a webhook and running the polling backstop records the same evidence, with the same `ingest_key`.
3. A missing or wrong signature is rejected with nothing parsed or stored.
4. A CI rerun finishing on an older commit records nothing, and the head stays on the newest commit (D-178).
5. The runner's own `QA` check run never counts toward `ci_run`.
6. A PR from a fork, from another branch, or by another author links to no node.
7. Didi reviews this ADR.

## Reasons

- A separate receiver keeps the state API's narrow role intact and costs no Windmill executions.
- Verifying before parsing keeps forged or oversized requests from touching the store.
- Two levels of idempotency let webhooks and polling overlap freely.
- Linking by the runner's own dispatch record and App identity means only the runner decides which PR speaks for which item.

## Consequences

- A second small service to deploy beside the API, and migration 0002 (a table, a column and a role).
- A missed webhook delays evidence by up to one reconcile interval (2 hours until Kubernetes, D-164).
- At M3, the runner App's webhook must point at the receiver, which needs a public HTTPS URL on the host.
