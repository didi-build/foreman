# AGENTS.md: rules for agents and contributors in this repo

These rules apply to every coding agent and every human working here. They come from how Didi (the operator) works and from the failures of the Grok setup this project replaces. If a rule here conflicts with a task, stop and ask. Do not work around it.

## 1. Read first

1. `README.md`, then `docs/prd.md`, `docs/spec.md`, `docs/architecture.md`, `docs/schema.md`, `docs/decisions.md`, `docs/build-plan.md`.
2. You do not have the chat history that produced these documents. Do not assume it. If something is missing or contradicts itself, record the gap in `docs/decisions.md` under Open and ask.

## 1a. Repo layout

Paths in these documents (`docs/...`, `docs/adr/`, `contracts/`) are logical. The real locations follow this repo's own layout, which comes from the Launchpad template. Launchpad's conventions win over this package where they conflict. Task M0.0 in `docs/build-plan.md` places the files and records where each one went. When you merge this file into the repo's own `AGENTS.md`, keep every existing rule and ask about any conflict.

## 2. How to work

- Architecture first. Before writing production code for a task, write a short design note (ADR) in `docs/adr/NNNN-title.md` covering what, why, how, constraints and how success is judged. Wait for review where `docs/build-plan.md` says "review point".
- One milestone at a time, one task at a time, in the order of `docs/build-plan.md`. Do not start the next milestone until the current one's verification passes.
- Keep changes small and reviewable. Prefer small, clean, extensible code over clever code.
- Verification is part of the task. After you implement something, run the checks listed for the task, record the results as evidence in the PR description, and do not mark the task done until they pass.
- Do not bend production code to satisfy a weak test. If a test is wrong, fix the test. If a guard has no test that exercises it, that is a defect.
- When you are unsure, say so clearly and ask. Do not guess on product behaviour, security, permissions or money.

## 3. Architecture rules

- The runner decides every state change. Agents and bots propose; the runner authorizes. No code path lets a bot write a node's state directly.
- The state store is the source of truth. Linear and every other channel only render it. After cutover, never read Linear as truth.
- A state change is one database transaction: write the transition row and update the node together, and fail if the node's version changed.
- Transitions and evidence are append-only. Never edit or delete them.
- Contracts (guards, evidence, timeouts, fallbacks) are data loaded at a version. Do not hard-code them in flows. Each transition records the spec version it used.
- Plumbing is plain code and never depends on model usage. Models do judgment only.
- Keep core logic in a plain TypeScript library with no Windmill or HTTP dependency, and put Windmill flows, the API and the adapters around it. Integrations (GitHub, Linear, agent runtimes, notifications) sit behind adapters so each can be swapped.
- Linear specifically: write through Linear's own API under the runner's own app identity, behind an adapter. Do not use the Linear MCP for runner writes.
- Cloudflare appears only in the deploy adapter. The library and the state API stay portable: no Cloudflare-specific APIs, bindings or runtime features outside that adapter.
- Infrastructure is declared as code (Terraform or OpenTofu, chosen in ADR 0010). A change made by hand is a defect. Infrastructure changes show their plan on the PR. A plan that includes DNS changes, new secrets or wider permissions, or deleting data goes through the matching gate first. Plans and state never contain secret values. Production applies are Didi's.
- Services are container-ready: each ships a Dockerfile, reads config only from the environment, exposes a health endpoint, logs structured JSON, and shuts down cleanly. They run on the droplet or on-demand compute in the first release and on Kubernetes in the second. Reference secrets by path through an interface (Windmill resources now, Vault later). Keep each project's boundary (credentials, secrets path, network rules, resource limits) explicit so it can become a namespace later.

## 4. Code and repo conventions

- Language: TypeScript, unless an ADR says otherwise.
- Pin dependencies to exact versions. Pin GitHub Actions to commit SHAs.
- Squash-only merges. No force pushes. Merge main into a branch instead of rebasing a shared branch.
- Every PR body states the head commit it covers and the verification run. Every PR has a Privacy section.
- Naming is concrete and readable. No duplicated logic. Small modules with clear seams.
- Tests live next to the seam they test (see `docs/test-plan.md`). CI must be green on the PR's head commit before review.
- Document decisions in `docs/decisions.md`, and add or update an ADR for anything architectural.

## 5. Security and gates

- Never print, log, commit, paste into chat or write into Linear any secret value, database id or personal data. Secrets live in the vault or Windmill resources only.
- Agents get no production database access and no credentials that reach real personal data. They work from schemas, fixtures and synthetic data. Access to real personal data is a gate: Didi approves one request, and the runner issues a temporary credential (default lifetime 1 hour) that it enforces.
- The runner holds credentials for the state store, GitHub (read CI, merge PRs), the Linear API and staging deploys. Anything more needs the new-credentials gate. Production deploy credentials never go to the runner or to any agent.
- These need Didi and block until he acts: spending money or starting a paid plan, sending personal messages or emails (agents write drafts, Didi sends), production deploys, and playbook rule changes (the system proposes, Didi approves).
- These are approve-once: new secrets, credentials or wider permissions; dropping data; DNS changes (each change needs its own approval); access to real personal data. Each approval covers one request only.
- Changes to privileged paths (migrations, PII, privacy, deploy workflows, `.github`, secrets) are never auto-merged. The runner checks the privileged-path list and creates a gate request.
- Before merging into a repo whose deploy runs on push to main, confirm its production environment requires Didi's approval.
- Each bot and agent has its own identity (a GitHub App or equivalent) so that its actions are never mistaken for Didi's.

## 6. Scope and product decisions

- Do not add features, change user flows, or change product behaviour compared with the approved plan. If you think something should change, raise it as a question. It goes to the Council or to Didi.
- Anything in `docs/decisions.md` marked "decide during build" is yours to decide within these rules. Record each decision with a date and the reason.
- Anything marked "needs Didi" is not yours to decide.

## 7. Changing the spec

- `docs/spec.md` is the rule book. Change it only with a PR that states the change, the reason, and the transitions or contracts affected.
- If a contract changes, update the machine-readable contracts and the consistency test in the same PR.
- Never let a tool, bot or flow carry its own copy of a rule. Read the rule from the spec version in use.

## 8. Writing style in this repo

- Plain, concrete language. Short sentences. No em dashes.
- State what is decided, what is proposed, and what is open. Do not blur them.
