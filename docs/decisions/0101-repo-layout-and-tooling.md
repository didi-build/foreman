# 0101. Repo layout, language and tooling

- **Status:** accepted at the end-of-M0 review (D-168, 2026-10-29).
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
| `src/service-kit/`     | Shared service conventions: config from the environment, JSON logs, `/health`, clean shutdown (ADR 0111)                | M0.8       |
| `src/sample-service/`  | The reference service that follows every container rule; CI builds and checks it (ADR 0111)                             | M0.8       |
| `flows/`               | Windmill flows, thin shells that call the library and adapters                                                          | M3.1       |
| `contracts/`           | Contracts as data                                                                                                       | M2.1       |
| `infra/`               | Infrastructure as code                                                                                                  | M0.7       |

Folders are created when their first task needs them. This task creates none of them, because M0.1 adds no product code.

### Import boundaries, enforced by ESLint

- **The core is an allow-list.** A file in `src/core/`, of any extension (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`), may import only other files inside `src/core/` and three pure Node modules: `node:assert`, `node:crypto`, `node:util`. Everything else is rejected, including any package, any other `node:` module, and type-only imports from outside the core. A custom rule in `eslint/core-boundary.mjs` resolves each import path to enforce this. It also rejects dynamic `import()`, `require` and `createRequire`. The globals `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `process`, `globalThis`, `global`, `require`, `module`, `Bun` and `Deno` are banned in the core, and so is `Function`. Code built from strings is rejected too: `eval`, `new Function`, a string passed to `setTimeout`, and calling or constructing through `.constructor`. The core reaches the outside world only through interfaces it defines and adapters implement.
- **The core is deterministic (D-162).** Core code may not read the clock or generate random values: `Date.now()`, `new Date()` with no argument, `Date()`, `performance`, `Math.random`, the `crypto` global, and the random functions of `node:crypto` (`randomUUID`, `randomBytes`, `randomInt`, `randomFill`, `randomFillSync`, `getRandomValues`, `webcrypto`) are rejected. The time comes from an injected clock and ids from an injected id source. Hashing from `node:crypto` stays allowed.
- **Core unit tests may import the test runner.** Unit tests sit next to the code, so a core test file (`src/core/**/*.test.*`) may also import `vitest`. Every other core rule still applies to it, and core code that is not a test still may not import `vitest`.
- **Inline comments cannot switch the boundary off.** `linterOptions.noInlineConfig` is set for `src/core/`, so `// eslint-disable...` and `/* eslint ... */` comments there have no effect.
- **Cloudflare stays in the deploy adapter (essential 9).** Every code file in the repo, of any extension and in any folder, may not import `cloudflare`, `cloudflare/*`, `cloudflare:*`, `@cloudflare/*` or `wrangler`, except under `src/adapters/deploy/`. Didi settled the rest of essential 9 on 2026-10-28: in `infra/`, Cloudflare is declared only in `infra/modules/platform/cloudflare/` (D-146, enforced by `npm run infra-boundaries`), and Launchpad's gallery Worker config is a known violation until the gallery moves to another host (D-145).

These are lint errors, so `npm run check` fails on them in CI. Tests in `test/import-boundaries.test.ts` try every bypass found in the outside review of 2026-10-28 (other file extensions, other network modules and packages, `globalThis.fetch`, `process.env`, `createRequire`, and each form of disable comment) and show each is rejected. With either protection removed, its tests fail.

### Tests

| Seam (from `docs/test-plan.md`)                                      | Where                                           |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Unit tests of library and adapter logic                              | Next to the code, as `src/**/*.test.ts`         |
| Database integration, contract consistency, API, flow tests          | `test/<seam>/`, for example `test/integration/` |
| Repo tooling and guards (Launchpad's existing tests and this task's) | `test/`, as today                               |

Vitest runs both `src/**/*.test.ts` and `test/**/*.test.ts`. Every test file states the seam it covers in its top-level `describe`, as `AGENTS.md` asks.

### Exact pins

`.npmrc` sets `save-exact=true`, so `npm install <pkg>` writes an exact version. A test fails if any entry in `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` or `overrides` is not an exact version. Exact pre-release and build versions such as `1.2.3-rc.1` count as exact.

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
