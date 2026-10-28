# 0101. Repo layout, language and tooling

- **Status:** proposed (reviewed with the other Milestone 0 ADRs at the end of M0)
- **Date:** 2026-10-28
- **Related:** [docs/build-plan.md, task M0.1](../build-plan.md#m01-repo-and-tooling), O-06 in [docs/decision-log.md](../decision-log.md), [ADR 0100](./0100-handoff-placement.md)

## Context

Task M0.1 asks for TypeScript, lint, formatting, a test runner and CI, adding only what Launchpad does not already provide. O-06 (repo layout, tooling, test runner) is "decide during build".

Launchpad already provides:

- TypeScript 5.9 in strict mode (`tsconfig.json`), ESLint with typescript-eslint, Prettier, and Vitest.
- CI (`.github/workflows/ci.yml`) that runs `npm run check` on every pull request and push to `main`. The check covers format, lint, typecheck, tests, build and secret scans.
- GitHub Actions pinned to commit SHAs, checked by `npm run verify-action-pins`.
- Squash-only merges (Launchpad ADR 0002), Dependabot, and a PR template with a Privacy section.
- A Node version in `.nvmrc` (22) and `engines` in `package.json`.

What is missing:

1. There is no layout for the project's code, so nothing enforces two of the essentials. The core library must have no Windmill or HTTP imports (`AGENTS.md`, architecture rules). Cloudflare may appear only in the deploy adapter.
2. Vitest only runs tests under `test/`. The handoff says tests live next to the seam they test.
3. Every dependency is pinned to an exact version today, but nothing stops a `^` range from being added.
4. The PR template does not ask for the head commit the PR covers.

## Decision

### Language and runtime

TypeScript on Node 22 (from `.nvmrc`), ES modules, with Launchpad's strict `tsconfig.json` unchanged. One npm package for now, with no workspaces. A second package is added only when a container image needs a separate dependency set (decided in ADR 0111).

### Code layout

| Path                   | Holds                                                                                                                   | First used |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| `src/core/`            | The state library: transitions, guards, contracts loading, the store interface. Plain TypeScript.                       | M1.2       |
| `src/adapters/<name>/` | One folder per integration: `store-postgres`, `github`, `linear`, `agent-runtime`, `deploy`, `notification`, `approval` | M1.2       |
| `src/api/`             | The tiny state API, a thin shell over `src/core/`                                                                       | M1.4       |
| `flows/`               | Windmill flows, thin shells that call the library and adapters                                                          | M3.1       |
| `contracts/`           | Contracts as data                                                                                                       | M2.1       |
| `infra/`               | Infrastructure as code                                                                                                  | M0.7       |

Folders are created when their first task needs them. This task creates none of them, because M0.1 adds no product code.

### Import boundaries, enforced by ESLint

- Files in `src/core/` may not import Windmill, HTTP or network modules (`windmill-client`, `node:http`, `node:https`, `node:net`, `undici`, `axios`, `node-fetch`), a database driver (`pg`, `postgres`), any Cloudflare package, or anything under `src/adapters/`, `src/api/` or `flows/`. They may not use the global `fetch`. The core reaches the outside world only through interfaces that it defines and that adapters implement.
- Files under `src/` other than `src/adapters/deploy/` may not import Cloudflare packages (`cloudflare`, `@cloudflare/*`, `wrangler`).

These are lint errors, so `npm run check` fails on them in CI. A test proves that each rule rejects a forbidden import and accepts a clean file.

### Tests

| Seam (from `docs/test-plan.md`)                                      | Where                                           |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Unit tests of library and adapter logic                              | Next to the code, as `src/**/*.test.ts`         |
| Database integration, contract consistency, API, flow tests          | `test/<seam>/`, for example `test/integration/` |
| Repo tooling and guards (Launchpad's existing tests and this task's) | `test/`, as today                               |

Vitest runs both `src/**/*.test.ts` and `test/**/*.test.ts`. Every test file states the seam it covers in its top-level `describe`, as `AGENTS.md` asks.

### Exact pins

`.npmrc` sets `save-exact=true`, so `npm install <pkg>` writes an exact version. A test fails if any entry in `dependencies`, `devDependencies` or `overrides` is not an exact `x.y.z` version.

### PR template

The "How verified" section gets a `Head commit:` line. The handoff asks every PR to state the head commit its verification covers.

## Constraints

- No new dependencies. Everything above uses ESLint, Vitest and npm, which are already installed.
- No change to Launchpad's CI workflow. The new rules run inside `npm run check`, which CI already calls.
- No Milestone 1 code. No product folders are created.

## Reasons

- Lint rules catch a boundary break when it is written, not in review. They cost a few lines of config and need no new tool.
- A single package is the simplest thing that works. Workspaces add build and versioning steps before there is a second deployable.
- Putting unit tests next to the code follows the handoff rule. Cross-cutting tests stay under `test/`, which keeps Launchpad's convention for its own tests.
- Using `save-exact` plus a test means a range cannot slip in from a hand edit, from `npm install`, or from a Dependabot change.

Alternatives considered:

- npm workspaces with a separate `core` package: this would enforce the boundary through the package graph. Rejected for now as more setup than the lint rule. It can be revisited in ADR 0111 if containers need it.
- dependency-cruiser for boundaries: a new dependency for what ESLint already does.

## How success is judged

1. CI runs lint, typecheck and the tests on the PR, and passes. (M0.1 success check.)
2. A test shows that the core boundary rule rejects a Windmill import, an HTTP import, a database driver import, an import from an adapter, and a `fetch` call in `src/core/`, and accepts a clean file.
3. A test shows that the Cloudflare rule rejects a Cloudflare import in `src/core/` and `src/api/`, and allows it in `src/adapters/deploy/`.
4. A test shows that the exact-pin check passes on today's `package.json` and fails on a `^` or `~` range.
5. A Vitest test file under `src/` is picked up. Shown by temporarily adding one, recorded in the PR.

## Consequences

- Breaking a core boundary fails `npm run check` locally and in CI.
- New integrations must go under `src/adapters/<name>/` to use network or vendor packages.
- `src/core/` cannot call `fetch`, so any data the core needs comes in through an interface.
