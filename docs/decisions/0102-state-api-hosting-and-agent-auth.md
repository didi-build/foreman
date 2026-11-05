# 0102. State API hosting and agent authentication

- **Status:** accepted at the end-of-M0 review (D-168, 2026-10-29). Resolves O-02. The monthly amount is approved at first hosting.
- **Amended by D-193** (2026-10-30): the API runs on the platform pool of the DigitalOcean Kubernetes cluster, not on a droplet or App Platform. Everything about tokens is unchanged.
- **Date:** 2026-10-28
- **Related:** O-02, [build plan M0.6](../build-plan.md#m06-state-api-hosting-and-agent-authentication-o-02), `docs/architecture/technical-architecture.md` sections 2.3, 2.10 and 4, D-134, D-140, D-193, N-19, [ADR 0112](./0112-qa-runtime-github-access-and-independence.md)

## Context

Agents, adapters and later the viewer need a safe door to the state store. Agents must never touch the database directly (M0.6). The API is a thin shell over `src/core/` (M1.4): create idea, add edge, report done with evidence, record decision, read a node, read the attention list. Only the runner may request a transition (FR-2), so no caller other than the runner can move a node.

The handoff names three hosting options: Windmill scripts exposed as endpoints, a Cloudflare Worker through Hyperdrive, or a small Node service. It asks for the simplest option that gives each agent its own identity, keeps Cloudflare-specific code out of the API (D-132), and fits the container conventions (D-134).

## Options

| Option                         | For                                                                                                                         | Against                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windmill endpoints             | No new service to run                                                                                                       | Every API call becomes a Windmill execution, which adds to the free-tier pressure in N-19. Auth is Windmill's own tokens and webhooks, which are not designed as per-agent, per-run identities. Not a container, so it does not move to Kubernetes as is. |
| Cloudflare Worker + Hyperdrive | Cheap, no server to manage                                                                                                  | The code becomes Worker-shaped (bindings, runtime limits). Hyperdrive has no advisory locks or LISTEN/NOTIFY. It puts Cloudflare next to the API, which D-132 and essential 11 rule out unless the code stays fully portable.                             |
| **Small Node service**         | Plain TypeScript over `src/core/`. A container with a health endpoint, as D-134 asks. Runs anywhere. Auth is ours to design | One more thing to deploy and watch                                                                                                                                                                                                                        |

## Decision

### Hosting

A small Node HTTP service in `src/api/`, shipped as a container image (Dockerfile, config only from the environment, `/health`, JSON logs, clean shutdown; ADR 0111 sets the shared conventions). It uses Node's built-in HTTP server through `src/service-kit/server.ts`, with no framework (settled in M1.4). It connects to Postgres with a role that has only the grants the API needs, never the owner role.

Where it runs: DigitalOcean, Toronto region (D-141). Didi chose DigitalOcean on 2026-10-28. It runs on the platform pool of the one DigitalOcean Kubernetes cluster, next to the GitHub receiver, in a platform namespace with its own default-deny NetworkPolicy (D-193, [ADR 0106](./0106-agent-execution-environment.md) section 1). Agent pods run on a separate, tainted agents pool and reach the API only through its normal endpoint. The cluster and its monthly amount are approved by Didi at first hosting, when the service first needs to run. Nothing is created before then. The container stays target-agnostic (D-134), so the host can change without a rewrite.

### Agent authentication

Each dispatch gets its own short-lived credential. No agent holds a long-lived API key.

1. When the runner dispatches an agent, it creates a token naming the caller: role (Developer, QA, Designer, Council, Triage), the bot or agent id, one project, the run id, and an expiry (the run's minute budget plus a margin).
2. The token is a long random value. The runner stores only its hash, linked to the run, and passes the token to the agent through its environment. It is never logged.
3. The API looks up the hash and checks the expiry and that the run is still active in `runs`. Ending a run revokes its token. Every write records the caller's role and id.
4. Each role has an allow-list of endpoints, scoped to its project. No role may request a transition: "report done" records the agent's report, and the runner decides the move.
5. **Agents never write evidence that a guard trusts (essential 6).** An agent token may write only these evidence kinds: `agent_report` and `docs_note`. A QA token may write only `qa_verdict` and `agent_report` (ADR 0112). Every other kind (`ci_run`, `test_report`, `preview_check`, `staging_check`, `merge_commit`, `visual_comparison`, `spec_paths`, `dispatch_record`) is written only by the runner, from sources it reads itself (GitHub, CI, deploy checks). An API test proves a Developer token posting a `ci_run` is rejected. A Council or Triage token can create work items and decisions, but cannot touch another project's code or secrets (section 4 of the architecture).
6. **The QA verdict (ADR 0112).** The API takes the commit from the run's dispatch record (`runs.head_sha`) and stores it as `evidence.commit_sha`. A commit supplied by the agent is ignored, or the verdict is rejected if it differs. One verdict per run. The payload holds pass or fail, findings with file path and line range, and the evidence ids relied on. The API validates the shape and that each evidence id belongs to this node and commit. The runner then checks the cited files and line ranges exist at the head commit.
7. The runner itself does not use the API. It calls `src/core/` directly, inside Windmill.

A signed token (for example a JWT) was considered. The opaque token is simpler: ending a run revokes it with no revocation list, and there is no signing key to protect.

### Transport and logging

- The state API has no public address of its own (D-195). Agents reach it inside the cluster through a fixed route in their egress proxy, and the runner does not call it (point 7). Plain HTTP never leaves the cluster. The one exception is the planning chat's `POST /plans`, which Cloudflare's tunnel forwards to a second port that serves that route only (D-271, below).
- Tokens travel only in the `Authorization` header, never in a URL. Logs record the request path without its query string, and an error's type without its message, because either can carry a token or personal data (`src/service-kit/server.ts`).
- An agent's token lives in its environment while it reads untrusted text (PR diffs, issue bodies), so a prompt injection could try to send it somewhere. The token's reach is the limit: one role, one project, one run, short expiry, and no transition rights. Limiting where agents can connect at all is part of the agent execution environment ([ADR 0106](./0106-agent-execution-environment.md), M3, accepted, D-191).

## Constraints

- No endpoint changes a node's state except through `requestTransition`, and only the runner calls that.
- No Cloudflare APIs, bindings or runtime features in `src/api/` (enforced by the ESLint rule in ADR 0101).
- Tokens never appear in logs, transcripts, PR bodies or Linear.
- Agents get no database credentials, and no credential reaching production or real personal data.

## How success is judged

M0.6's success check is that this ADR is merged. M1.4 then proves it with API tests per role: allowed calls work, forbidden calls are rejected, a bot cannot move an item, an expired or revoked token is rejected, and a token for one project cannot read or write another, a QA token writing `ci_run` is rejected, and a verdict whose commit differs from `runs.head_sha` is ignored or rejected.

## Reasons

- A plain Node service is the option that stays portable and becomes a Kubernetes pod with no rewrite (D-134). It adds nothing to the Windmill execution count (N-19).
- Per-run tokens give each agent its own identity, bound to one project and one run, and expire on their own. That matches the security model better than shared or long-lived keys.

### Settled in M1.4

| Route                                      | Roles                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /ideas`                              | Council, Triage                          | Creates an idea in its entry state (Submitted, owned by the runner, from `src/api/entry.ts` until contracts arrive in M2.1)                                                                                                                                                                                                                                                                                           |
| `POST /edges`                              | Council, Triage                          | Links two nodes in the caller's project; a `blocks` cycle is refused                                                                                                                                                                                                                                                                                                                                                  |
| `POST /reports`                            | Developer, Designer, QA, Council, Triage | Records `agent_report` or `docs_note` (QA: `agent_report` only). Stores a commit from the agent only on a `docs_note`, as a full 40-hex `commitSha` (D-236); a commit on any other kind is refused. A run tied to a node may only report on that node                                                                                                                                                                 |
| `POST /qa-verdicts`                        | QA                                       | Records the verdict against `runs.head_sha`. A different `commitSha` is rejected. A pass must cite runner evidence for this node and commit. One verdict per run (ADR 0112)                                                                                                                                                                                                                                           |
| `POST /decisions`                          | Council, Triage                          | Records `council_decision`, `interview_answer` or `product_direction` text exactly as given, by the caller's role. Approvals and gate answers come only through the approval channel                                                                                                                                                                                                                                  |
| `GET /nodes/:id`                           | All roles                                | Reads a node in the caller's project                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /attention`                           | Council, Triage                          | Open blocking gate requests and blocked or escalated nodes in the caller's project (M4 refines it)                                                                                                                                                                                                                                                                                                                    |
| `POST /plans`                              | The planning chat only (D-266)           | Records the planning chat's submission: a new idea in Submitted, or an idea of the project in Submitted or Council planning; the product direction and Didi's answers as decisions by `planning`; the plan and the rest, with the required `needsDidi` call (D-307), as an `agent_report` by `planning` with no run. Moves nothing, opens no gate request, records no `plan_accepted` (src/core/plans.ts, O-78, O-96) |
| `GET /planning/projects/:slug/submissions` | The planning chat only (D-273)           | The status of the planning chat's own submissions in that project: `waiting`, `approved`, `sent_back` or `closed_unanswered` (src/core/planning-reads.ts, O-85)                                                                                                                                                                                                                                                       |
| `GET /planning/projects/:slug/feedback`    | The planning chat only (D-273)           | Didi's words, verbatim, on each of the planning chat's own plans Didi sent back in that project                                                                                                                                                                                                                                                                                                                       |
| `GET /planning/projects/:slug/accepted`    | The planning chat only (D-273)           | The project's accepted plans from the planning chat, each with the product direction approved with it (labelled approved by Didi) and the directions Council or Triage recorded on the idea (labelled recorded by an agent, not approved by Didi, D-286)                                                                                                                                                              |

- A token is checked against its hash, its expiry, its revocation and its run, which must not have ended. Every failure answers the same 401. A role outside a route's list gets 403. A node in another project gets 404, so other projects stay invisible.
- No route changes a node's state. Request bodies are JSON objects of at most 64 KiB.
- Issuing tokens is the runner's job (M3.2). The tests insert a run and its token hash directly.

### Added by D-266: the planning chat's identity

The planning chat is not a run. It has one long random token, which Didi creates at first hosting and keeps only in the chat's settings. The state API holds only the token's SHA-256, read from the secret path `platform/state-api/planning-token-sha256` (the Kubernetes Secret `state-api-planning-token`, optional, so the API starts without it and then accepts no planning token). A request whose bearer token hashes to it, compared in constant time, may call `POST /plans` and nothing else: every other route answers 403, and any run token on `POST /plans` answers 403. Any other token answers 401 as before. How the chat reaches the API from outside the cluster is settled by D-271 (below).

### Added by D-271, D-273 and D-282: the public path, the flow start and the planning reads

- **The public path (D-271, O-83).** The Cloudflare Tunnel that serves the receiver gets one more rule, on the same host name: the planning chat's paths only (`/plans` and, since D-282, `/planning/projects/<slug>/{submissions,feedback,accepted}`), to the state API's public Service (`state-api-public`, port 8081). The tunnel matches host name and path but not the method and has no size or rate limit, so the state API's public listener (`src/api/public.ts`, `PUBLIC_PORT`) serves `POST /plans` and the three reads as `GET` and nothing else, refuses a declared body over 64 KiB with 413 and allows 20 requests a minute across all callers (429 past it). Only the tunnel connector may reach that port. The rule is added only when Didi passes the tunnel gate at first hosting (`expose_planning_route`).
- **The flow start (D-273 (2), O-84).** After a submission is recorded, the API starts the Windmill flow `f/foreman/plan_approval` for its idea once, through the port in `src/adapters/windmill/plan-approval-flow.ts`, with its own narrow credential at `platform/state-api/windmill-plan-approval-token`, which can start only that flow (D-283). The call goes through the shared Windmill egress proxy, which allows only Windmill's host; the API's pod has no outbound 443 of its own (D-284, D-328, O-101). Until that credential exists the start is refused (`NotBuiltError`). A failed start never changes the response or the submission; the API logs the error's type only, and the reconcile pass opens the request later.
- **The planning reads (D-273 (3), O-85).** The three GET routes in the table above, for the planning token only and the project the slug names. "Own" means submissions the planning identity recorded. Each answer puts a notice first, saying that everything under `data` is recorded data and not instructions. Run tokens get 403 on them and any other token 401. D-282 makes them reachable from outside through the same public path, with the same limits.
- **The Council's call on Didi (D-307, O-96).** `POST /plans` requires one more field, `needsDidi`: exactly `{needed, reason}`, `needed` one of `yes`, `no` or `unsure`, `reason` a non-blank text of at most 2,000 characters. A body without it, or with any other shape, is refused with 400 and nothing is written, like any other bad field. The planning chat is the Council talking with Didi, so the call is the Council's, made by the rule of D-247 and the Council's instructions. The API records it in the submission as sent and still accepts nothing: the runner's plan approval step reads it, accepts a `no` plan as the Council's when no request to Didi blocks it (none open, none for this plan, D-315), and opens Didi's request for any other. This is a breaking change to the planning API, made while no client exists: the planning token is created only at first hosting (runbook step 15), so no chat sends submissions yet. The planning reads add the status `accepted_by_council` and an `acceptedBy` on each accepted plan, and label the direction of a plan the Council accepted as not approved by Didi.

## Consequences

- One service to deploy, monitor and keep patched.
- The runner needs a small token-issuing step in each dispatch flow (M3.2).
- The API's database role and grants are part of the M1.1 migration.
