# Agent instructions

**Project:** {{PROJECT_NAME}} — {{PROJECT_PURPOSE}}

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

- The linked Linear ticket is the source of truth for scope.
- Read-only or decision-only tasks: no code, no branches, no PR — post the answer where the ticket asks.

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
