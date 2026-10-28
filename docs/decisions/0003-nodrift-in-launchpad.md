# 0003. Nodrift guardrails kit in Launchpad

- **Status:** accepted
- **Date:** 2026-10-23
- **Related:** [0001 Template bootstrap](./0001-template-bootstrap.md)

## Context

Launchpad must not copy privacy guardrails into the template repo. Derived projects should call the versioned [`@didi-build/nodrift`](https://www.npmjs.com/package/@didi-build/nodrift) package for `init` scaffolding and `check` in CI. The kit requires **Node.js `>=22.13.0`** (`node:sqlite` for migration replay).

Bootstrap runs `init-project` in a job that checks out with `BOOTSTRAP_TOKEN`. We need clear rules for when nodrift runs, how `npm run check` stays a no-op for opted-out repos, and how installs and git pushes use the token safely.

## Decision

### 1. Bootstrap install and token use

- Token checkout uses `persist-credentials: false` so the PAT is not written to `.git/config`.
- When init runs nodrift, Bootstrap runs `npm ci --ignore-scripts` and `init-project` (including `nodrift init`) with **no** `GH_TOKEN`, `BOOTSTRAP_TOKEN`, or `GITHUB_TOKEN` in the child process environment.
- The init commit runs with `HUSKY=0` so Husky hooks do not run.
- `git push` passes basic x-access-token auth only via `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` on that process; the token is not in argv, the remote URL, or on disk.
- `repo-settings` receives `GH_TOKEN` only for those subprocess calls.

This is the documented exception to the bootstrap runbook table row that forbids unrestricted `npm ci` and lifecycle scripts in the token job.

### 2. Personal data defaults (opt-out)

- **Bootstrap:** `LAUNCHPAD_COLLECTS_PERSONAL_DATA` repository variable, default `true` when unset.
- **Interactive TTY:** prompt defaults to **yes** (`(Y/n)`; empty answer collects personal data).
- **Non-interactive** without `--personal-data`, `--no-personal-data`, or `LAUNCHPAD_COLLECTS_PERSONAL_DATA`: exit **1** before any file writes, naming those three options.
- **Slug and display name** are validated before the personal-data prompt or env resolution.

### 3. Gating `npm run nodrift`

- `npm run nodrift` runs `nodrift check` when **either** `.nodrift/manifest.json` **or** `docs/privacy/data-map.yml` exists.
- When neither exists, print one line explaining both paths are absent, and exit 0.
- Launchpad itself (no scaffolding) skips the kit check.

### Other

- **Pinned dependency:** `@didi-build/nodrift` exact-pinned in devDependencies (Dependabot bumps).
- **No vendored kit:** only `nodrift init` output in derived repos.
- **Plan validation:** invalid `LAUNCHPAD_COLLECTS_PERSONAL_DATA` fails in the Bootstrap **plan** step before token checkout.
- **Preflight:** when personal data is yes, resolve the kit CLI before placeholder writes.

## Reasons

- Versioned kit upgrades via Dependabot avoid guardrails drift in the template.
- Opt-out defaults match org expectations for new repos while still allowing `false` or `--no-personal-data`.
- Manifest or data-map gating covers partial scaffolding.
- Token isolation limits PAT exposure during dependency install and init.

## Consequences

- Derived repos need Node `>=22.13.0` when nodrift check runs.
- Opt-out repos set `LAUNCHPAD_COLLECTS_PERSONAL_DATA=false` or `--no-personal-data`; they can add scaffolding later with `npx nodrift init`.
- Bootstrap runbook token-job table keeps the historical no unrestricted-`npm-ci` rule; nodrift uses `npm ci --ignore-scripts` without token in the child env, as in section 1.
