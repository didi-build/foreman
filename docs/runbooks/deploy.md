# Deploy runbook

**Purpose:** Repeatable steps to ship a version to an environment.

## The preview check in CI (D-354)

Hosted branch previews are dropped (D-354): nothing is deployed for a pull request, and no repository holds a preview token. Instead the `preview-check` job of [.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs on CI's own machine, on pull requests from the same repository and on pushes to main, with `contents: read` and no secret:

1. It checks out the commit it checks: the PR's head on a pull request (`github.event.pull_request.head.sha`, never the merge ref), the pushed commit on main.
2. `npm ci` and `npm run build` package the gallery into `dist/gallery`, the folder `wrangler.jsonc` serves.
3. `node .github/scripts/preview-check.mjs marker dist/gallery <commit>` writes the commit marker `foreman-commit.txt` at the site's root: the commit and a newline. The path is fixed; on a push to main the runner's staging deploy (D-353, O-116) uploads this same marker with the build, after checking that it names the run's commit.
4. `node .github/scripts/serve-site.mjs dist/gallery 4173` serves the build on 127.0.0.1 with Node's built-in modules only, and `node .github/scripts/preview-check.mjs probe http://127.0.0.1:4173 <commit>` checks that the app loads (the gallery bundle marker in the built JavaScript, not the single-page HTML alone) and that `/foreman-commit.txt` is the commit. Each failure prints one fixed line and fails the job.

The runner records this job's conclusion as `preview_check` on the PR's head commit, passing only on `success` (O-111). It reads the job with the runner App's `actions: read` (D-267), and only the job named `preview-check` of `.github/workflows/ci.yml`, in a run that a `pull_request` event started from the same repository on that head. The merge guard `qa_verdict_independent_on_head` needs a passing one (ADR 0112). The scripts live in `.github/scripts/`, a privileged path, so changing what the check does needs Didi's approval.

To run it locally, run `npm run build`, then the three commands above with any 40-character commit.

Every project carries the same job and the same two scripts (D-387): the Launchpad template has them, so a new project starts with them, and a project made before has them added in its own pull request. Foreman reads them from the project as it does here, so the job's name, `.github/workflows/ci.yml`, `foreman-commit.txt` and `staging-site` stay as they are; a project without the job can pass CI and QA and still never merge. Each project records this as its own ADR (0006 in the rehearsal repository).

Production deploy for your app is still project-specific; see below.

## Preconditions

- CI green on the commit you deploy
- Decision record or architecture note for any new infra

## Steps

1. _Document your production deploy command or pipeline here._
2. _Record where to watch logs and metrics._

## Verification

How you confirm the deploy succeeded (smoke test, health check, etc.).
