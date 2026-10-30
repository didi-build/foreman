# 0113. GitHub evidence ingestion

- **Status:** accepted at the M2.3 review point (D-180, 2026-10-29).
- **Amended by D-193** (2026-10-30): the receiver shares the cluster's platform pool with the state API, instead of one droplet or App Platform host.
- **Date:** 2026-10-29
- **Related:** build plan M2.3 and M2.4, D-156, D-160, D-164, D-178, D-193, essentials 1 and 6, `docs/guards.md`, [ADR 0102](./0102-state-api-hosting-and-agent-auth.md), [ADR 0104](./0104-state-store-schema.md), [ADR 0111](./0111-kubernetes-ready-conventions.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md)

## Context

The guards (M2.2) read evidence the runner records from outside the agents: CI results on a PR's head commit, merge commits, and later preview and staging checks. M2.3 records that evidence from GitHub, through webhooks plus a polling backstop in the reconcile pass. The guards fix what must come out: the head commit is the commit named by the newest `ci_run` on the node, so a `ci_run` may only ever be recorded for the PR's current head (D-178), with the payloads in `docs/guards.md`. M2.3 is built and tested against a fake GitHub; the real Apps are registered at M3 (D-178).

## Decision

### 1. Where webhooks arrive: a small receiver service

A new container service, `src/github-receiver/`, with the ADR 0111 conventions, connected to the store through its own narrow database role `factory_ingest`.

- Not a route on the state API: the API's role (`factory_api`) cannot write evidence a guard trusts, by design (essential 6, ADR 0102). Giving the API that power to receive webhooks would break that separation.
- Not Windmill webhooks: every delivery would be a Windmill execution, and the free tier's 1,000 a month (D-164) would be gone in days.
- It runs next to the state API on the platform pool of the one DigitalOcean Kubernetes cluster (D-193, [ADR 0106](./0106-agent-execution-environment.md) section 1), so it adds no separate host. It accepts inbound webhooks only.

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

### 9. Settled by the implementation (M2.3)

Details the sections above left open, as built in `src/core/github-ingest.ts`, `src/adapters/github/`, `src/github-receiver/` and `db/migrations/0002_github_ingest.sql`:

- **Dispatch record payload:** `{repo: "owner/name", branch}`. Linking reads the repository from it, so `factory_ingest` needs no read on `projects`.
- **App identities:** the receiver reads the Developer and Designer App logins from `GITHUB_DEVELOPER_APP_LOGIN` and `GITHUB_DESIGNER_APP_LOGIN`, and the runner App's slug from `GITHUB_RUNNER_APP_SLUG`. They are set when the Apps are registered at M3.
- **Secret by path:** `secret(path)` in `src/service-kit/config.ts` reads the path from one environment variable, `SECRET_` plus the path in upper snake case (`SECRET_PLATFORM_GITHUB_RUNNER_WEBHOOK_SECRET`), which the host fills from the secret store. This is the first piece of the ADR 0111 section 4 interface.
- **Every `ci_run` checks the live head,** the pending one too: an out-of-order `synchronize` for an older commit records nothing. A `pending` row is skipped when the commit already has a `ci_run`, so it never hides a finished result.
- **Conclusion:** the latest check run of each name on the sha, except a run named `QA` created by the runner's own App (its slug from config). A project's own check named `QA`, or one from any other App, counts like any other check. Nothing is recorded while any of them is unfinished or when there are none. `success`, `neutral` and `skipped` pass; any other conclusion fails.
- **Keys and refs:** a pending result is `github:ci_run:<repo>#<pr>:<sha>:pending`. A final result also names its CI attempt: `github:ci_run:<repo>#<pr>:<sha>:<conclusion>:check-run-<id>`, where `<id>` is the highest id among the counted check runs. A rerun creates new check runs with higher ids, so failure, success, failure on one commit records three rows and the newest is the failure; without the attempt the third would share the first's key, record nothing, and leave a failing commit green. The webhook and the polling backstop both read the id from the same check run listing, so one attempt is recorded once. The merge key is `github:merge_commit:<repo>#<pr>`. The evidence `ref` is the key. A check constraint allows a key only on `ci_run` and `merge_commit`, so no other writer can take a key first and block a real result.
- **Outcomes:** `ignored` covers linked-nothing, stale and not-evidence events, with a short fixed reason. `rejected` is a signed payload ingestion cannot read (answered 400). A bad signature (401) and an event type outside the table (202) store nothing. The delivery row and its evidence commit in one transaction, so a replayed id writes nothing even when two copies race.
- **Delivery ids:** "on conflict do nothing" needs to see existing ids, so `factory_ingest` may read `github_deliveries.delivery_id` and no other column.
- **Polling:** `pollRepository(deps, repo)` records the current head's result for each open PR (pending while checks run), and the merge for each dispatched node whose last PR is no longer open.
- **Real client:** `src/adapters/github/client.ts` checks signatures and refuses every read until M3.

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
- At M3, the runner App's webhook must point at the receiver, which is reached at a public HTTPS name on `didi.build` through a Cloudflare Tunnel (D-195). The tunnel token and the DNS record are gates at first hosting.
