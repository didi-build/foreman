# Launchpad

**Launchpad** is the [didi-build](https://github.com/didi-build) GitHub template for new repositories. It ships repo hygiene, a documentation layout, [AGENTS.md](./AGENTS.md), and quality gates (`npm run check`, Husky, CI) so every project starts consistent.

This repository **is** the template: it stays green with `launchpadTemplate: true` in `package.json`, which skips placeholder verification until you run `init-project` in a derived repo.

## Use this template

1. On GitHub, click **Use this template** and create your repository.
2. Wait for the **Bootstrap** workflow on `main` to finish (runs `init-project`, commits, and applies [repo settings](./scripts/repo-settings.mjs)). See [docs/runbooks/bootstrap.md](./docs/runbooks/bootstrap.md).
3. Clone your new repo and follow [docs/new-project-checklist.md](./docs/new-project-checklist.md) for anything Bootstrap did not cover.
4. Replace any remaining Launchpad-specific wording in docs as needed.

> **Outside the didi-build org:** Bootstrap needs a repository secret named `BOOTSTRAP_TOKEN` (fine-grained PAT with Administration, Contents, and Issues write). Without it, the workflow warns and you use the [manual init and repo-settings steps](./docs/new-project-checklist.md) instead.

## Layout (template)

| Path                                         | Purpose                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`                                    | MIT license for the Launchpad template                                                                                                             |
| `LICENSE.project`                            | Proprietary license template swapped in by `init-project`                                                                                          |
| `LICENSES/launchpad-MIT.txt`                 | Preserved MIT notice (required by `npm run check` in derived repos)                                                                                |
| `README.project.md`                          | Project README template swapped in by `init-project`                                                                                               |
| `src/`, `test/`                              | Minimal TypeScript + Vitest example                                                                                                                |
| `design/`, `components/`, `gallery/`         | Designer specs (`design/<area>/<feature>/`), gallery components, and `/gallery` SPA (see [docs/component-gallery.md](./docs/component-gallery.md)) |
| `docs/`                                      | Architecture, ADRs, runbooks, new-project checklist                                                                                                |
| `.github/workflows/preview.yml`              | PR gallery preview on Cloudflare Workers (same-repo PRs)                                                                                           |
| `scripts/init-project.mjs`                   | Placeholder replacement and package rename                                                                                                         |
| `.github/workflows/bootstrap.yml`            | Auto `init-project` + repo settings on template create / retry                                                                                     |
| `.github/workflows/ci.yml`                   | PR/push CI and test-results comment                                                                                                                |
| `.github/workflows/dependabot-automerge.yml` | Merge green Dependabot PRs (only automation exception)                                                                                             |
| `scripts/repo-settings.mjs`                  | Recommended branch protection via `gh`                                                                                                             |

## Maintainer commands

```bash
npm install
npm run check        # full gate (template skips placeholder check)
npm run dev:gallery  # local component gallery (Vite)
npm run build        # build gallery assets for Workers
npm run init-project -- <slug> "<name>" ["purpose"]   # test locally only
```

### PR gallery preview (optional)

Same-repo pull requests run [.github/workflows/preview.yml](./.github/workflows/preview.yml). Previews deploy to a dedicated Worker (`launchpad-preview` in this template; `<slug>-preview` after `init-project`) via `wrangler.preview.jsonc`, not the production Worker in `wrangler.jsonc`. To enable previews, add repository secrets `CLOUDFLARE_API_TOKEN_PREVIEW` and `CLOUDFLARE_ACCOUNT_ID`. The preview token must be **Workers Scripts Edit** only on the preview Worker; do not grant D1 or R2 Edit because pull request branch code can reach this token. Until secrets exist, the Preview job ends neutral and updates one PR comment that previews are not configured (expected for a new template). Fork PRs skip preview deploy.

## Contributing to Launchpad

Open a PR against `didi-build/launchpad` and wait for review; do not merge your own PR unless the ticket says **merge when green**. See [AGENTS.md](./AGENTS.md) for agent rules (Dependabot auto-merge is the only exception).

## License

[MIT](./LICENSE) — Copyright (c) 2026 Didi Build. If you use this template, a link back to [Launchpad](https://github.com/didi-build/launchpad) is appreciated (derived repos get their own license via `init-project`).
