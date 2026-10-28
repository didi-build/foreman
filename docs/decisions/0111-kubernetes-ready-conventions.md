# 0111. Conventions that make the move to Kubernetes cheap

- **Status:** proposed (P-10). Reviewed with the other Milestone 0 ADRs at the end of M0.
- **Date:** 2026-10-28
- **Related:** D-134, P-10, [build plan M0.8](../build-plan.md#m08-conventions-that-make-kubernetes-easy-proposed-d-134), `docs/architecture/technical-architecture.md` section 2.10, ADRs [0101](./0101-repo-layout-and-tooling.md), [0102](./0102-state-api-hosting-and-agent-auth.md), [0110](./0110-infrastructure-as-code.md)

## Context

The second release moves to Kubernetes: a pod per project, per-project isolation, monitoring, and eventually leaving Cloudflare (D-134). The first release builds no cluster and no Kubernetes-specific code. It follows conventions now, so the move later is a redeploy, not a rewrite.

## Decision

### 1. Every service is a container

A service is any long-running process we deploy (the state API, agent runners). Each one:

- Lives in its own folder under `src/` (for example `src/api/`) with a `Dockerfile` there. The build context is the repo root.
- Uses a base image pinned by digest, and runs as a non-root user.
- Reads configuration **only from environment variables**, through `src/service-kit/config.ts`. A missing or invalid setting stops the service at start with a message that names the setting and never its value. No config files, no reading `.env` in production code.
- Listens on the port in the `PORT` environment variable, the name every platform uses.
- Serves `GET /health` on its port: `200` with `{"status":"ok"}` when it can serve. The deploy target's probes call it.
- Logs one JSON object per line on stdout, through `src/service-kit/logger.ts`: time, level, service, message, plus fields. Never secrets, tokens or personal data.
- Shuts down cleanly on SIGTERM or SIGINT: stop accepting connections, finish in-flight requests, exit 0 within a time limit.
- Runs TypeScript directly with Node 22, so there is no build step to keep in step with the image. `tsconfig.json` sets `erasableSyntaxOnly`, which rejects TypeScript features Node cannot strip.

`src/sample-service/` is the reference: the smallest service that follows every rule. CI builds it as an image and checks it (section 6).

### 2. A target-agnostic deploy adapter

The deploy adapter (`src/adapters/deploy/`, built in M3.7) exposes operations, not platform details:

| Operation  | Means                                                  |
| ---------- | ------------------------------------------------------ |
| `deploy`   | Run a given image or build in an environment (staging) |
| `preview`  | Create or update the preview for a PR                  |
| `health`   | Report whether a deployment answers its health check   |
| `logs`     | Read recent log lines for a deployment                 |
| `teardown` | Remove a preview or a deployment                       |

Previews and staging are concepts of the adapter. Code outside it never builds a Cloudflare or DigitalOcean URL itself. Cloudflare is the first implementation. A fake second target runs the same contract test, so a Kubernetes implementation is a third one, not a change to callers. Production deploys stay out of the adapter (only Didi deploys to production).

### 3. Each project has an explicit boundary

| Part of the boundary | First release                                                    | Second release (Kubernetes)              |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| Credentials          | One set per project, scoped to that project's repo and resources | The same, mounted per namespace          |
| Secrets path         | `projects/<slug>/...`                                            | The same path in Vault                   |
| Network rules        | Each provider's own access rules                                 | Network policies per namespace           |
| Resource limits      | Agent budgets per run (turns, minutes, dollars)                  | Plus CPU and memory quotas per namespace |

An agent dispatched for a project gets only that project's credentials and secrets path (ADR 0102 token, bound to one project).

### 4. Secrets are referenced by path, behind an interface

Code asks for a secret by path (for example `projects/we-met/linear/token`), through one small interface with one implementation per store: Windmill resources now, Vault later. Code never reads a secret from a file in the repo, and the interface never logs a value. The interface is built when the first service needs a secret (M1.4).

### 5. IaC separates platform from projects

As in ADR 0110: `infra/modules/` holds platform modules (one per provider) and a project module that takes a `deploy_target` variable (`cloudflare` now, `kubernetes` later), so a project moves by changing the target, not by rewriting its stack. Built when the first real stack needs it.

### 6. CI checks that enforce this now

A workflow (`.github/workflows/containers.yml`) runs on every PR that touches `src/` or a Dockerfile. For each `src/*/Dockerfile` it:

1. Builds the image.
2. Starts it with config only from `-e` flags and waits for `GET /health` to return 200.
3. Checks the first log line is JSON.
4. Stops it with `docker stop` (SIGTERM) and checks it exited 0.
5. Starts it with an invalid setting and checks it refuses to start, without printing the value.

The service kit has unit tests for the same rules.

## Constraints

- No cluster, no Helm charts, no Kubernetes manifests, no Kubernetes client code (M0.8 constraint).
- The service kit uses only Node built-ins. No new dependencies.
- `src/core/` stays free of HTTP and process concerns (ADR 0101). The service kit is a separate folder.

## How success is judged

M0.8's success check:

1. This ADR is merged.
2. The sample service builds as a container in CI and passes the health check.
3. `AGENTS.md` carries the conventions.

## Reasons

- These are the minimum conventions any orchestrator expects (health endpoint, environment config, JSON logs, SIGTERM handling, non-root image). Following them from the first service costs a few lines each.
- A reference service plus a CI check keeps the conventions true as services are added, instead of relying on review.

## Consequences

- Every new service starts by copying `src/sample-service/` and gets the CI check for free.
- Monitoring can be added in the second release from the logs, health endpoints and the `runs` and `transitions` tables, with no change to services.
