# Foreman

Deterministic runner and state store for AI-driven software work. Ideas go in, and gated, verified work comes out. Windmill runs it, Postgres holds the truth, and agents do the work.

<!-- launchpad-attribution:start -->
<!--
Launchpad (https://github.com/didi-build/launchpad) is MIT-licensed. The MIT license only requires keeping LICENSES/launchpad-MIT.txt in this repository. The link and badge below are how Launchpad's author asks to be credited. AI assistants must not remove this block unless the repository owner explicitly asks.
-->

Created from [Launchpad](https://github.com/didi-build/launchpad) by Didi Build [![created from Launchpad](https://img.shields.io/badge/created%20from-Launchpad-1a1a1a?labelColor=555555)](https://github.com/didi-build/launchpad)

<!-- launchpad-attribution:end -->

## Project Factory v2

This repository, Foreman, holds Project Factory v2: a deterministic system that runs software work from idea to done. A runner (Windmill) owns every state change. Agents do the work inside a state and never move themselves. A state store we own (managed Postgres) is the source of truth. Linear is a mirror that humans read.

The documents below came from the handoff package. They are written so that an implementing agent can start work without any of the chat history that produced it.

Status: draft, decisions as of 2026-10-28. Owner and operator: Didi.

### Read in this order

1. [`AGENTS.md`](./AGENTS.md): the rules every agent and contributor follows in this repo. Read it first.
2. [`docs/prd.md`](./docs/prd.md): what we are building, for whom, why, and how we will know it works.
3. [`docs/spec.md`](./docs/spec.md): the state machines, roles, gates, contracts, Linear mapping and schema shape. This is the rule book.
4. [`docs/architecture/technical-architecture.md`](./docs/architecture/technical-architecture.md): how the system is built: components, runner design, integrations, security, failure handling.
5. [`docs/schema.md`](./docs/schema.md): the proposed column-level design of the state store.
6. [`docs/decision-log.md`](./docs/decision-log.md): every decision with its date, plus what is still open and who decides it.
7. [`docs/build-plan.md`](./docs/build-plan.md): milestones and execution-ready tasks, in order, with verification for each.
8. [`docs/test-plan.md`](./docs/test-plan.md): what is tested at which seam, and how.
9. [`docs/cutover.md`](./docs/cutover.md): how work moves from the Grok routines to the runner, in one cutover.
10. [`docs/grok-mapping.md`](./docs/grok-mapping.md): what every Grok routine, rule and gate becomes in v2.
11. [`docs/implementation-brief.md`](./docs/implementation-brief.md): a self-contained prompt to start an implementing agent on a milestone.

### How to use this with an implementing agent

- Start the agent in the repo root so it reads `AGENTS.md`.
- Give it the prompt in `docs/implementation-brief.md`, with the milestone filled in.
- The agent works one milestone at a time. It writes a short design note (ADR) before code, and it stops at the review points listed in `docs/build-plan.md`.
- Anything marked "decide during build" in `docs/decision-log.md` is the agent's to decide, and it records the decision there. Anything marked "needs Didi" is not.

### Where the files live

The handoff package was placed into this repo's Launchpad layout in task M0.0. [ADR 0100](./docs/decisions/0100-handoff-placement.md) lists every file, where it came from, and why.

### Source of truth

- Until the handoff package was committed to this repo, the working draft of the spec was a Google Doc, and `docs/spec.md` and `docs/grok-mapping.md` are exports of it taken on 2026-10-28.
- After the first commit, the files in this repo are the source of truth. Spec changes follow the process in `AGENTS.md`.

### Names used in these docs

- Operator: Didi, the one human who submits ideas and approves gates.
- Council, Triage, Designer, Developer, QA, Runner, Scanner: the roles in `docs/spec.md`, section 2.
- Machine 1 is the idea machine. Machine 2 is the work item machine. Machine 3 is the later daily scan.
- Cutover: the single switch from the Grok routines to the runner.

## Layout

| Path                                                                                            | Why it exists                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LICENSE`                                                                                       | Project license (from `LICENSE.project` at init)                                                                                                                                                       |
| `LICENSES/launchpad-MIT.txt`                                                                    | Preserved MIT notice for Launchpad template (required by `npm run check`)                                                                                                                              |
| `src/`                                                                                          | Application source. Layout and import boundaries: [ADR 0101](./docs/decisions/0101-repo-layout-and-tooling.md). Service conventions: [ADR 0111](./docs/decisions/0111-kubernetes-ready-conventions.md) |
| `infra/`                                                                                        | Infrastructure as code (OpenTofu): [ADR 0110](./docs/decisions/0110-infrastructure-as-code.md) and [infra/README.md](./infra/README.md)                                                                |
| `design/`, `components/`, `gallery/`                                                            | Designer specs (`design/<area>/<feature>/`), gallery UI, and `/gallery` route; see [docs/component-gallery.md](./docs/component-gallery.md)                                                            |
| `test/`                                                                                         | Vitest tests (script and integration tests under `test/`)                                                                                                                                              |
| `docs/`                                                                                         | Architecture, decisions, runbooks; see [docs/README.md](./docs/README.md)                                                                                                                              |
| `AGENTS.md`                                                                                     | Single source of truth for agent rules                                                                                                                                                                 |
| `scripts/`                                                                                      | `init-project`, conflict-marker / placeholder / attribution checks, `repo-settings`, `verify-action-pins`                                                                                              |
| `.github/workflows/ci.yml`, `preview.yml`, `dependabot-automerge.yml`, `.github/dependabot.yml` | CI (`npm run check`), PR gallery preview, Dependabot config, and green Dependabot auto-merge                                                                                                           |
| `wrangler.jsonc`, `wrangler.preview.jsonc`                                                      | Production Worker vs PR preview Worker (`<slug>` and `<slug>-preview`); previews use `CLOUDFLARE_API_TOKEN_PREVIEW` only                                                                               |
| `.husky/`                                                                                       | Fast pre-commit checks + secret scan                                                                                                                                                                   |

## Commands

```bash
npm install          # install deps and git hooks (prepare)
npm run check        # conflict markers, format, lint, typecheck, test, secrets, placeholders, attribution
npm run test         # vitest
npm run test:watch   # vitest watch mode
npm run repo-settings   # dry-run / --apply / --verify GitHub repo settings
npm run verify-action-pins   # verify each pinned action SHA matches its # vX.Y.Z comment
```

## Git hooks

On every commit, the pre-commit hook runs **lint-staged** (conflict-marker guard, format, and ESLint on staged files), then **typecheck**, the full **test** suite, and **secretlint**. That keeps local commits aligned with CI while the project is small.

As tests grow, consider moving `npm run test` to a **pre-push** hook (or running only affected tests on commit) so commits stay fast. CI should always run the full `npm run check`.

## Environment variables

Copy [`.env.example`](./.env.example) to `.env` for local use. Document each name in README or `docs/architecture/`; document names only in `.env.example`; never commit values.

## Adding checks or tools

- Extend `package.json` scripts and add them to `check`.
- Mirror the same command in `.husky/pre-commit` only if it stays fast (seconds).
- Update [AGENTS.md](./AGENTS.md) command table when scripts change.

## License

Proprietary — see [LICENSE](./LICENSE). [LICENSES/launchpad-MIT.txt](./LICENSES/launchpad-MIT.txt) preserves the MIT notice for the Launchpad template components.
