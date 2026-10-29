# Agent instructions

**Project:** Foreman — Deterministic runner and state store for AI-driven software work. Ideas go in, and gated, verified work comes out. Windmill runs it, Postgres holds the truth, and agents do the work.

This file is the single source of truth for how agents work in this repository. Other agent entry points only link here.

## Before you write code

1. Read `docs/architecture/` and `docs/decisions/` for this feature.
2. If architecture or an accepted decision is missing, stop and produce a decision or architecture note first. **No implementation before the shape of the feature is decided.**

## Engineering standards

- **`design/` is designer-only.** Developers edit `components/` only for props or tiny non-design wiring fixes; Designers build gallery components from approved specs under `design/<area>/<feature>/spec.md` (see `docs/component-gallery.md` and `docs/decisions/0004-component-gallery.md`).
- Prefer clean, modular boundaries; small extensions over clever hacks; readable names; minimal duplication.
- Follow this repo’s docs and config over your general habits.
- Mark unknowns as unknown. Do not guess requirements or infrastructure.
- Do not add personal data to logs, queues, or tables without updating the data map (`docs/privacy/data-map.yml` when nodrift scaffolding is present).

## Testing

- State which seam a test covers (unit, integration, or broader).
- Pick the seam that gives confidence without bending production code to satisfy weak tests.
- Never weaken production code only to make a test pass.

## Verification

- Run `npm run check` before claiming work is done. Do not skip verification after implementation.

## Launchpad attribution

- Do **not** remove the `<!-- launchpad-attribution:start -->` … `<!-- launchpad-attribution:end -->` block in `README.md` or delete `LICENSES/launchpad-MIT.txt` unless the **repository owner** explicitly asks you to.

## Secrets

- Never commit secrets. Use `.env` locally; document variable **names** only in `.env.example`.
- Never reference, print, or move `BOOTSTRAP_TOKEN` outside `.github/workflows/bootstrap.yml` (enforced by `npm run secret-usage`).

## Scope and tickets

- The linked Linear ticket is the source of truth for scope. (In this repo the handoff rule applies instead: see D-136 in section 9 below.)
- Read-only or decision-only tasks: no code, no branches, no PR — post the answer where the ticket asks. (In this repo ADRs and decisions must be committed: see D-137 in section 9 below.)

## Pull requests

- Keep PRs small and link the Linear ticket.
- Describe what changed, why, and how you verified (include `npm run check`).
- **Open a PR and wait for human review.** Do not merge your own PR unless the ticket explicitly says **merge when green**.
- **Dependabot** dependency PRs are the exception: when CI passes, [Dependabot auto-merge](./.github/workflows/dependabot-automerge.yml) may merge them without a human review. Set repo variable `DEPENDABOT_AUTOMERGE=false` to disable.

## Commands

| Script                       | Purpose                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`              | Conflict markers, workflow YAML guards, format, lint, typecheck, test, gallery build, secret scan, placeholders, attribution, nodrift (when `.nodrift/manifest.json` or `docs/privacy/data-map.yml` exists)                                                                                                                                                                |
| `npm run workflow-yaml`      | Parse `.github/workflows/*.yml` and fail on bare `if: !…` conditions (invalid YAML tags)                                                                                                                                                                                                                                                                                   |
| `npm run infra-boundaries`   | Fail if Cloudflare is declared in `infra/` outside `infra/modules/platform/cloudflare/` (D-146)                                                                                                                                                                                                                                                                            |
| `npm run build`              | Vite build of the component gallery for Cloudflare Workers static assets                                                                                                                                                                                                                                                                                                   |
| `npm run dev:gallery`        | Local Vite dev server for `/gallery`                                                                                                                                                                                                                                                                                                                                       |
| `npm run nodrift`            | `@didi-build/nodrift check` when `.nodrift/manifest.json` or `docs/privacy/data-map.yml` exists; skipped otherwise                                                                                                                                                                                                                                                         |
| `npm run lint`               | ESLint                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run format`             | Prettier write                                                                                                                                                                                                                                                                                                                                                             |
| `npm run format:check`       | Prettier check                                                                                                                                                                                                                                                                                                                                                             |
| `npm run typecheck`          | `tsc --noEmit`                                                                                                                                                                                                                                                                                                                                                             |
| `npm run test`               | Vitest (CI uses JUnit output)                                                                                                                                                                                                                                                                                                                                              |
| `npm run secrets`            | Secretlint                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run secret-usage`       | Fail if `BOOTSTRAP_TOKEN` appears outside `bootstrap.yml` workflows                                                                                                                                                                                                                                                                                                        |
| `npm run preview-workflow`   | Regression guard for PR workflows (not a security boundary; the preview-scoped token is): exactly one normalized `-c`/`--config` equal to `wrangler.preview.jsonc` per wrangler line; reject production `CLOUDFLARE_API_TOKEN` references and `secrets: inherit`; static `environment: production`; reject any wrangler subcommand other than `preview` / `preview delete` |
| `npm run init-project`       | Replace `{{…}}` placeholders; optionally run `nodrift init` when the project collects personal data                                                                                                                                                                                                                                                                        |
| `npm run repo-settings`      | Dry-run, `--apply`, or `--verify` recommended GitHub repo settings                                                                                                                                                                                                                                                                                                         |
| `npm run verify-action-pins` | Verify each pinned action SHA matches its version comment (`# vX.Y.Z`)                                                                                                                                                                                                                                                                                                     |

`npm run preview-workflow` does not catch dynamic `environment:` expressions, `github-script` exec, composite actions, shell variables holding wrangler commands, or direct `wrangler.js` invocation. See [ADR 0005](./docs/decisions/0005-preview-worker-isolation.md).

## Project Factory v2 rules

These rules apply to every coding agent and every human working here. They come from how Didi (the operator) works and from the failures of the Grok setup this project replaces. If a rule here conflicts with a task, stop and ask. Do not work around it.

### 1. Read first

1. The rules above in this file, then `README.md`, `docs/prd.md`, `docs/spec.md`, `docs/architecture/technical-architecture.md`, `docs/schema.md`, `docs/decision-log.md`, `docs/build-plan.md`.
2. You do not have the chat history that produced these documents. Do not assume it. If something is missing or contradicts itself, record the gap in `docs/decision-log.md` under Open and ask.

### 1a. Repo layout

The handoff package was placed into this repo's Launchpad layout in task M0.0. [ADR 0100](./docs/decisions/0100-handoff-placement.md) records where each file went. Launchpad's conventions win over the handoff where they conflict. In particular, ADRs live in `docs/decisions/` (Launchpad's own ADRs are numbered 0000 to 0099, Project Factory v2 ADRs from 0100), the decision log is `docs/decision-log.md`, and the technical architecture is `docs/architecture/technical-architecture.md`. `contracts/` is a planned folder at the repo root (task M2.1).

### 2. How to work

- Architecture first. Before writing production code for a task, write a short design note (ADR) in `docs/decisions/NNNN-title.md` covering what, why, how, constraints and how success is judged. Wait for review where `docs/build-plan.md` says "review point".
- One milestone at a time, one task at a time, in the order of `docs/build-plan.md`. Do not start the next milestone until the current one's verification passes.
- Keep changes small and reviewable. Prefer small, clean, extensible code over clever code.
- Verification is part of the task. After you implement something, run the checks listed for the task, record the results as evidence in the PR description, and do not mark the task done until they pass.
- Do not bend production code to satisfy a weak test. If a test is wrong, fix the test. If a guard has no test that exercises it, that is a defect.
- When you are unsure, say so clearly and ask. Do not guess on product behaviour, security, permissions or money.

### 3. Architecture rules

- The runner decides every state change. Agents and bots propose; the runner authorizes. No code path lets a bot write a node's state directly.
- The state store is the source of truth. Linear and every other channel only render it. After cutover, never read Linear as truth.
- A state change is one database transaction: write the transition row and update the node together, and fail if the node's version changed.
- Transitions and evidence are append-only. Never edit or delete them.
- Contracts (guards, evidence, timeouts, fallbacks) are data loaded at a version. Do not hard-code them in flows. Each transition records the spec version it used.
- Plumbing is plain code and never depends on model usage. Models do judgment only.
- Keep core logic in a plain TypeScript library with no Windmill or HTTP dependency, and put Windmill flows, the API and the adapters around it. Integrations (GitHub, Linear, agent runtimes, notifications) sit behind adapters so each can be swapped.
- Linear specifically: write through Linear's own API under the runner's own app identity, behind an adapter. Do not use the Linear MCP for runner writes.
- Cloudflare appears only in the deploy adapter. The library and the state API stay portable: no Cloudflare-specific APIs, bindings or runtime features outside that adapter.
- Infrastructure is declared as code (Terraform or OpenTofu, chosen in ADR 0110). A change made by hand is a defect. Infrastructure changes show their plan on the PR. A plan that includes DNS changes, new secrets or wider permissions, or deleting data goes through the matching gate first. Plans and state never contain secret values. Production applies are Didi's.
- Services are container-ready: each ships a Dockerfile, reads config only from the environment, exposes a health endpoint, logs structured JSON, and shuts down cleanly. They run on the droplet or on-demand compute in the first release and on Kubernetes in the second. Reference secrets by path through an interface (Windmill resources now, Vault later). Keep each project's boundary (credentials, secrets path, network rules, resource limits) explicit so it can become a namespace later.

### 4. Code and repo conventions

- Language: TypeScript, unless an ADR says otherwise.
- Code layout, import boundaries and where tests live: [ADR 0101](./docs/decisions/0101-repo-layout-and-tooling.md). ESLint enforces the boundaries: `src/core/` has no Windmill, HTTP, network, database driver or Cloudflare imports, and Cloudflare packages appear only in `src/adapters/deploy/`.
- Pin dependencies to exact versions. Pin GitHub Actions to commit SHAs.
- Squash-only merges. No force pushes. Merge main into a branch instead of rebasing a shared branch.
- Every PR body states the head commit it covers and the verification run. Every PR has a Privacy section.
- Naming is concrete and readable. No duplicated logic. Small modules with clear seams.
- Tests live next to the seam they test (see `docs/test-plan.md`). CI must be green on the PR's head commit before review.
- Document decisions in `docs/decision-log.md`, and add or update an ADR for anything architectural.

### 4a. Container and Kubernetes-ready conventions

From [ADR 0111](./docs/decisions/0111-kubernetes-ready-conventions.md). They hold for every service from the first release, so the move to Kubernetes is a redeploy, not a rewrite.

- Each service lives in `src/<service>/` with its own `Dockerfile` (base image pinned by digest, non-root user). Start a new one by copying `src/sample-service/`.
- Configuration comes only from environment variables, through `src/service-kit/config.ts`. The port is `PORT`. A bad setting stops the service at start and names the setting, never its value.
- Every service serves `GET /health`, logs one JSON object per line on stdout (`src/service-kit/logger.ts`), and exits 0 on SIGTERM after finishing in-flight requests.
- Deploys go through the target-agnostic deploy adapter (deploy, preview, health, logs, teardown). Code outside it never builds a platform URL.
- Each project has an explicit boundary: its own credentials, secrets under `projects/<slug>/...`, its own network rules and resource limits.
- Secrets are read by path through one interface (Windmill resources now, Vault later), never from files in the repo.
- Agent runtime adapters read the model endpoint and API key from the bot file as settings (the key as a secret path, never its value). There is no model gateway in the first release: adapters call model providers directly. A self-hosted gateway arrives with Kubernetes in the second release (D-142).
- Infrastructure modules separate platform from project, and the project module takes a deploy target (ADR 0110). Cloudflare is declared only in `infra/modules/platform/cloudflare/`; stacks never name a provider (D-146, `npm run infra-boundaries`).
- Known violation of essential 9 until moved: Launchpad's gallery is hosted on Cloudflare (`wrangler.jsonc`, `wrangler.preview.jsonc`, the preview workflow). Do not build on it; the gallery moves to another host (D-145, N-23).
- No Kubernetes manifests, charts or client code until the second release.

### 5. Security and gates

- Never print, log, commit, paste into chat or write into Linear any secret value, database id or personal data. Secrets live in the vault or Windmill resources only.
- Agents get no production database access and no credentials that reach real personal data. They work from schemas, fixtures and synthetic data. Access to real personal data is a gate: Didi approves one request, and the runner issues a temporary credential (default lifetime 1 hour) that it enforces.
- The runner holds credentials for the state store, GitHub (read CI, merge PRs), the Linear API and staging deploys. Anything more needs the new-credentials gate. Production deploy credentials never go to the runner or to any agent.
- These need Didi and block until he acts: spending money or starting a paid plan, sending personal messages or emails (agents write drafts, Didi sends), production deploys, and playbook rule changes (the system proposes, Didi approves).
- These are approve-once: new secrets, credentials or wider permissions; dropping data; DNS changes (each change needs its own approval); access to real personal data. Each approval covers one request only.
- Changes to privileged paths (migrations, PII, privacy, deploy workflows, `.github`, secrets) are never auto-merged. The runner checks the privileged-path list and creates a gate request.
- Before merging into a repo whose deploy runs on push to main, confirm its production environment requires Didi's approval.
- Each bot and agent has its own identity (a GitHub App or equivalent) so that its actions are never mistaken for Didi's.

### 6. Scope and product decisions

- Do not add features, change user flows, or change product behaviour compared with the approved plan. If you think something should change, raise it as a question. It goes to the Council or to Didi.
- Anything in `docs/decision-log.md` marked "decide during build" is yours to decide within these rules. Record each decision with a date and the reason.
- Anything marked "needs Didi" is not yours to decide.

### 7. Changing the spec

- `docs/spec.md` is the rule book. Change it only with a PR that states the change, the reason, and the transitions or contracts affected.
- If a contract changes, update the machine-readable contracts and the consistency test in the same PR.
- Never let a tool, bot or flow carry its own copy of a rule. Read the rule from the spec version in use.

### 8. Writing style in this repo

- Plain, concrete language. Short sentences. No em dashes.
- State what is decided, what is proposed, and what is open. Do not blur them.

### 9. How conflicts with the Launchpad rules above are settled

The Launchpad rules above are kept word for word. Where they conflict with the handoff rules, these decisions apply in this repo. Each one is recorded in `docs/decision-log.md`.

- D-136. Scope source. Follow the handoff, not the Launchpad rule "The linked Linear ticket is the source of truth for scope". Scope comes from the task in `docs/build-plan.md`. After cutover it comes from the state store, and Linear is a mirror that is never read as truth. Didi: "the handoff is what were building towards. launchpad is still using the old rules. follow the handoff".
- D-137. Decision-only tasks. Every ADR and decision must exist in this repo and stay in sync with the other documents. A PR for an ADR-only task is not required for now. In the new system, these tasks get a PR for the Council to review. Didi: "in the new system, they will get a pr for the council to review. right now, its less important, as long as the adrs are there and everything is in sync".
- D-138. Writing style. Any new text follows the handoff style, with no em dashes. Existing Launchpad text is left as it is. Didi: "Any new text generated".
- P-09 (still Proposed). Merging. Launchpad: agents open a PR and wait for human review unless the ticket says merge when green. Handoff: the runner merges after QA passes. P-09 proposes that the runner rule applies only to repos the runner manages. Until Didi decides, agents in this repo open a PR and wait for review.
