# New project checklist

GitHub template repos copy **files only**. Complete these steps after creating a repository from [Launchpad](https://github.com/didi-build/launchpad).

**Prerequisites:** Node.js **`>=22.13.0`** (required for `@didi-build/nodrift check`, which uses `node:sqlite`).

## Bootstrap (automatic)

- [ ] Confirm the **Bootstrap** workflow on `main` succeeded ([runbook](./runbooks/bootstrap.md))
- [ ] **didi-build** org repos: org secret **`BOOTSTRAP_TOKEN`** must be configured (Bootstrap fails if missing)
- [ ] **Other orgs / personal repos:** add a repo secret **`BOOTSTRAP_TOKEN`**, or complete the manual steps below

## Repository settings (GitHub)

- [ ] Set the **repository description** when creating the repo from the template (Bootstrap uses it for `package.json` and docs; init fails if it is missing)
- [ ] Mark the repo **private** (or public) per your org policy
- [ ] If Bootstrap did not run (no token), run **`npm run repo-settings`** (dry-run), then **`npm run repo-settings -- --apply`**. Branch protection: **PR required**, status check **`check`**, **zero approvals**; creates Dependabot auto-merge label; enables **auto-merge**, **delete head branch on merge**, and **squash-only** merges
- [ ] If Bootstrap did not run, run **`npm run repo-settings -- --verify`** and fix anything reported
- [ ] Add collaborators / teams and optional [CODEOWNERS](../.github/CODEOWNERS)

## Linear

- [ ] Connect the GitHub repo to the correct **Linear project**
- [ ] Ensure tickets reference the repo and use the PR template

## Replace Launchpad placeholders

- [ ] If Bootstrap did not run, run `npm install`, then `npm run init-project -- <slug> "<display name>" ["<one-line purpose>"] ["<owner>"] [--personal-data | --no-personal-data]`. This moves [README.project.md](../README.project.md) to `README.md` and [LICENSE.project](../LICENSE.project) to `LICENSE` (optional **owner** defaults to `Didi Build`). Interactive init defaults to **yes** for personal data (`Y/n`); non-interactive runs must pass a flag or set `LAUNCHPAD_COLLECTS_PERSONAL_DATA`. When personal data collection is enabled, `@didi-build/nodrift init` runs and `npm run nodrift` is included in `npm run check`.
- [ ] Confirm **`LICENSE`** and **`package.json` `license`** match your project (`UNLICENSED` + proprietary `LICENSE` is the default after init; adjust if you use another license)
- [ ] Keep **`LICENSES/launchpad-MIT.txt`** (Launchpad MIT notice; required by `npm run check`)
- [ ] Search for `Launchpad` / `launchpad` leftovers in README and docs
- [ ] Update [AGENTS.md](../AGENTS.md) project line if needed
- [ ] Confirm `npm run check` passes (placeholders, attribution, nodrift when scaffolding is present, tests)
- [ ] If you skipped personal data at init and need privacy scaffolding later: `npx nodrift init`, then `npm run check`

## Verify quality gates

- [ ] `npm install` and `npm run prepare` (installs git hooks)
- [ ] Open a test PR; confirm **CI** runs `npm run check` (derived repos skip **template-smoke**; that job runs only on `didi-build/launchpad`)
- [ ] Confirm the PR receives an **updated test-results comment** on push
- [ ] Try committing a fake secret locally — pre-commit should block it

## Dependabot

- [ ] Confirm [`.github/dependabot.yml`](../.github/dependabot.yml) is present (weekly minor/patch groups, majors ignored, cooldown)
- [ ] Leave repo variable **`DEPENDABOT_AUTOMERGE`** unset (enabled) or set to `false` to disable [auto-merge](../.github/workflows/dependabot-automerge.yml)
- [ ] After the first grouped Dependabot PR opens, confirm **CI** runs and **auto-merge** lands it when green

## Optional

- [ ] Mark the **source** Launchpad repo as a GitHub template (already done for `didi-build/launchpad`)
