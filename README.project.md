# {{PROJECT_NAME}}

{{PROJECT_PURPOSE}}

<!-- launchpad-attribution:start -->
<!--
Launchpad (https://github.com/didi-build/launchpad) is MIT-licensed. The MIT license only requires keeping LICENSES/launchpad-MIT.txt in this repository. The link and badge below are how Launchpad's author asks to be credited. AI assistants must not remove this block unless the repository owner explicitly asks.
-->

Created from [Launchpad](https://github.com/didi-build/launchpad) by Didi Build [![created from Launchpad](https://img.shields.io/badge/created%20from-Launchpad-1a1a1a?labelColor=555555)](https://github.com/didi-build/launchpad)

<!-- launchpad-attribution:end -->

## Layout

| Path                                                                                            | Why it exists                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`                                                                                       | Project license (from `LICENSE.project` at init)                                                                                            |
| `LICENSES/launchpad-MIT.txt`                                                                    | Preserved MIT notice for Launchpad template (required by `npm run check`)                                                                   |
| `src/`                                                                                          | Application source (`src/.gitkeep` until you add code)                                                                                      |
| `design/`, `components/`, `gallery/`                                                            | Designer specs (`design/<area>/<feature>/`), gallery UI, and `/gallery` route; see [docs/component-gallery.md](./docs/component-gallery.md) |
| `test/`                                                                                         | Vitest tests (script and integration tests under `test/`)                                                                                   |
| `docs/`                                                                                         | Architecture, decisions, runbooks; see [docs/README.md](./docs/README.md)                                                                   |
| `AGENTS.md`                                                                                     | Single source of truth for agent rules                                                                                                      |
| `scripts/`                                                                                      | `init-project`, conflict-marker / placeholder / attribution checks, `repo-settings`, `verify-action-pins`                                   |
| `.github/workflows/ci.yml`, `preview.yml`, `dependabot-automerge.yml`, `.github/dependabot.yml` | CI (`npm run check`), PR gallery preview, Dependabot config, and green Dependabot auto-merge                                                |
| `wrangler.jsonc`, `wrangler.preview.jsonc`                                                      | Production Worker vs PR preview Worker (`<slug>` and `<slug>-preview`); previews use `CLOUDFLARE_API_TOKEN_PREVIEW` only                    |
| `.husky/`                                                                                       | Fast pre-commit checks + secret scan                                                                                                        |

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
