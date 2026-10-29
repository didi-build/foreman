# 0102. State API hosting and agent authentication

- **Status:** accepted at the end-of-M0 review (D-168, 2026-10-29). Resolves O-02. The DigitalOcean product and monthly amount are still approved at M1.4.
- **Date:** 2026-10-28
- **Related:** O-02, [build plan M0.6](../build-plan.md#m06-state-api-hosting-and-agent-authentication-o-02), `docs/architecture/technical-architecture.md` sections 2.3, 2.10 and 4, D-134, D-140, N-19, [ADR 0112](./0112-qa-runtime-github-access-and-independence.md)

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

A small Node HTTP service in `src/api/`, shipped as a container image (Dockerfile, config only from the environment, `/health`, JSON logs, clean shutdown; ADR 0111 sets the shared conventions). It uses Node's built-in HTTP server, or one small framework chosen in M1.4. It connects to Postgres with a role that has only the grants the API needs, never the owner role.

Where it runs: DigitalOcean, Toronto region (D-141). There is no existing droplet, so this is new spend. Didi chose DigitalOcean on 2026-10-28. The DigitalOcean product (App Platform or a droplet) and the monthly amount are approved by Didi at M1.4, when the service first needs to run. Nothing is created before then. The container stays target-agnostic (D-134), so the host can change without a rewrite.

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

- TLS ends at the hosting platform's load balancer (DigitalOcean, D-141). Plain HTTP is never exposed. The exact product is chosen at M1.4.
- Tokens travel only in the `Authorization` header, never in a URL. Logs record the request path without its query string, and an error's type without its message, because either can carry a token or personal data (`src/service-kit/server.ts`).
- An agent's token lives in its environment while it reads untrusted text (PR diffs, issue bodies), so a prompt injection could try to send it somewhere. The token's reach is the limit: one role, one project, one run, short expiry, and no transition rights. Limiting where agents can connect at all is part of the agent execution environment (ADR 0106, M3).

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

## Consequences

- One service to deploy, monitor and keep patched.
- The runner needs a small token-issuing step in each dispatch flow (M3.2).
- The API's database role and grants are part of the M1.1 migration.
