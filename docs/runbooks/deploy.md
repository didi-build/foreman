# Deploy runbook

**Purpose:** Repeatable steps to ship a version to an environment.

## Component gallery previews (Launchpad default)

Pull requests from the same repository run [.github/workflows/preview.yml](../../.github/workflows/preview.yml):

1. `npm run build` packages the gallery into `dist/gallery`.
2. `npx wrangler preview -c wrangler.preview.jsonc --name pr-N` deploys a `pr-N` Preview on the preview Worker (`launchpad-preview` in the template; `<slug>-preview` after `init-project`). Production deploys use `wrangler.jsonc` and stay off pull request workflows. CI captures JSON stdout only; stderr stays in logs without printing secrets.
3. CI probes `/gallery` (gallery bundle marker in built JS, not SPA fallback HTML alone), comments the preview URL, and posts a `gallery-preview` check.

**Repository secrets (names only):** `CLOUDFLARE_API_TOKEN_PREVIEW`, `CLOUDFLARE_ACCOUNT_ID`. The preview token must be **Workers Scripts Edit** only on the preview Worker; do not grant D1 or R2 Edit because pull request branch code can reach this token. Configure once per repo; same-repo PRs only (fork PRs skip preview).

When secrets are missing, the Preview workflow ends **neutral** (not failed) and updates a single PR comment that previews are not configured.

Production deploy for your app is still project-specific; see below.

## Preconditions

- CI green on the commit you deploy
- Decision record or architecture note for any new infra

## Steps

1. _Document your production deploy command or pipeline here._
2. _Record where to watch logs and metrics._

## Verification

How you confirm the deploy succeeded (smoke test, health check, etc.).
