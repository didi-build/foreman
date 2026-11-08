# Bootstrap runbook

Launchpad-derived repositories run the **Bootstrap** workflow automatically. It replaces manual `init-project` and `repo-settings` steps for repos that have a bootstrap token configured.

## What it does

Bootstrap acts only while the repository is new, and only protected code under `.github/` ever receives the token (D-358 lock 1, O-113). It has three jobs, in order:

1. **decide** runs `node .github/scripts/bootstrap-plan.mjs` on a read-only checkout of the default branch. It reads the template files (`README.project.md`, and `"launchpadTemplate": true` in `package.json`), and asks GitHub, with the workflow's own read-only token, whether the default branch is protected. Bootstrap's settings step sets that protection last, so a protected default branch means the repository is already set up, and then nothing else runs. The step also checks `LAUNCHPAD_COLLECTS_PERSONAL_DATA` and, when init will run, the repository description, and works out the init arguments: slug and display name from the repository name, purpose from the GitHub repository description, and **owner** from `GITHUB_REPOSITORY_OWNER` (`didi-build` becomes `Didi Build`; other owners use the login as it is).
2. **prepare** runs the template's own setup without the token and with `contents: read`: `npm ci --ignore-scripts` when personal data is on, then `scripts/init-project.mjs`, which also runs `@didi-build/nodrift init` when personal data is on. The repository variable **`LAUNCHPAD_COLLECTS_PERSONAL_DATA`** (default `true`, D-359) controls that; set it to `false` to opt out (see [ADR 0003](../decisions/0003-nodrift-in-launchpad.md)). Init also removes Launchpad's example code and sets `package.json` `description` from the purpose. The job hands its changes over as a patch (`git diff --binary`), an artifact kept one day.
3. **apply** runs on a fresh runner and runs nothing but `.github/scripts/`. It checks out the same commit, applies the patch as data and commits it as `github-actions[bot]`, pushes the commit to the default branch with the token, then applies and verifies the repository settings with the token: the Dependabot auto-merge label, auto-merge, delete head branches, squash-only merges, and branch protection last.

When Bootstrap will actually run init, the GitHub repository description must be set; if it is empty, the decide step fails with a clear message (skipped runs and already-initialized repos are not affected).

### The token job: what runs and where the token goes

| Step             | Runs                                                                        | Token?                                 |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| Checkout         | `actions/checkout` at the decided commit, with `persist-credentials: false` | No: the workflow's own read-only token |
| Fetch the patch  | `actions/download-artifact` into `$RUNNER_TEMP`, outside the checkout       | No                                     |
| Apply and commit | `node .github/scripts/bootstrap-commit.mjs`                                 | No                                     |
| Push             | `node .github/scripts/bootstrap-push.mjs`                                   | Yes, in this step's env only           |
| Settings         | `node .github/scripts/bootstrap-settings.mjs --apply --verify`              | Yes, in this step's env only           |

- The patch is data. `git apply` runs no hook and no repository code, and the commit step refuses a patch that changes anything under `.github/`, because the steps after it run `.github/scripts/`. The template's setup changes nothing there today: Foreman's own init commit (0fb8cf5) touched no file under `.github/`.
- The push gives basic x-access-token auth to that one `git push` through `GIT_CONFIG_*`, never in argv, the remote URL or `.git/config`. It runs with hooks off, pushes `HEAD:refs/heads/<default branch>` without force, and prints git's output with the token replaced by `***`.
- The settings step calls GitHub's REST API with Node's built-in `fetch`, not the `gh` CLI, follows no redirect and prints no token.
- No `npm`, `npx` or `actions/setup-node` runs in this job, and its scripts import only Node built-ins and each other. `node .github/scripts/check-bootstrap-isolation.mjs`, which the **Bootstrap isolation** workflow runs on every pull request and every push to `main`, fails if any of this changes.

## Plan table

| Default branch protected | Template files | Trigger                                | `init` | `settings` |
| ------------------------ | -------------- | -------------------------------------- | ------ | ---------- |
| no                       | present        | any                                    | yes    | yes        |
| not read                 | absent         | `push` to `main`, first attempt        | no     | no         |
| no                       | absent         | **Re-run jobs** (attempt &gt; 1)       | no     | yes        |
| no                       | absent         | **Run workflow** (`workflow_dispatch`) | no     | yes        |
| yes                      | any            | any                                    | no     | no         |

A push to `main` of an initialized repository, such as each of Foreman's own pushes, ends in the decide step without a request to GitHub, as before. A repository whose default branch is protected is set up: Bootstrap does nothing there, even on **Run workflow** or **Re-run jobs**, and warns when the template files are back. To change a set-up repository's settings, use the [manual fallback](#manual-fallback). If GitHub's answer cannot be read, the decide step fails and nothing else runs.

The template repository `didi-build/launchpad` skips Bootstrap entirely.

## `BOOTSTRAP_TOKEN` (organization secret)

For **didi-build** derived **public** repositories:

1. Create a **fine-grained PAT** (or classic PAT with equivalent scopes) with:
   - **Repository access:** all repositories that use the template (or the org).
   - **Permissions:** Administration (read/write), Contents (read/write), Issues (read/write) — as required by `repo-settings` and pushing the init commit.
2. In the **didi-build** org, add an Actions secret named `BOOTSTRAP_TOKEN` with the PAT value.
3. Share the secret with **all repositories** (or the repos that are created from Launchpad).

Derived repos created outside **didi-build** do not receive this org secret. They either:

- Add a **repository** secret also named `BOOTSTRAP_TOKEN`, or
- Follow the [manual fallback](#manual-fallback) in [new-project-checklist.md](../new-project-checklist.md).

### Expiry and rotation

1. Generate a new PAT before the old one expires.
2. Update the org (or repo) secret `BOOTSTRAP_TOKEN`.
3. A rotation needs no Bootstrap run. Bootstrap acts only while a repository is new; to re-apply the settings of a set-up repository, use the [manual fallback](#manual-fallback).

### Retry a failed run

- **Re-run all jobs** on a failed Bootstrap workflow run (re-applies **settings** only if init already completed). Re-run reuses the original event payload, so it does **not** pick up a repository description you added after the failure. **Re-run failed jobs** reuses the first decision: it works when the push did not happen, and fails at the push once the setup commit has landed, so use **Re-run all jobs** or **Run workflow** then.
- **Run workflow** manually from the Actions tab to retry with the **current** repository description and settings (use this after fixing a missing description).
- Both do nothing once the settings step has protected the default branch.

### Missing repository description

If Bootstrap fails in the decide step with _This repository has no description_:

1. Open the repository on GitHub, edit **About** (repository description), and save a one-line summary.
2. In **Actions → Bootstrap**, choose **Run workflow** (not **Re-run jobs**) so the workflow sees the updated description.

### Troubleshooting: malformed token

If Bootstrap fails in the push or settings step with _BOOTSTRAP_TOKEN is malformed_:

1. The org or repo secret `BOOTSTRAP_TOKEN` likely contains a stray newline, carriage return, space or other invisible character inside the value (often pasted with a line break).
2. Open **Organization settings, Secrets and variables, Actions** (or the repository's **Settings, Secrets and variables, Actions**), edit `BOOTSTRAP_TOKEN`, and paste the PAT again with **no quotes** and **no trailing whitespace**.
3. Save the secret, then start Bootstrap again with **Run workflow**.

Bootstrap trims leading and trailing whitespace and warns in the log; a token with a newline or space **inside** the value is refused before the push or any API request, and the log never shows the value.

## Manual fallback

If Bootstrap skips because no token is configured, or a set-up repository needs its settings again:

```bash
npm install
npm run init-project -- <slug> "<display name>" ["<purpose>"] ["<owner>"] [--personal-data | --no-personal-data]
export GITHUB_REPOSITORY=<owner>/<repo>
export GH_TOKEN="$(gh auth token)"   # any token of a repository admin
npm run repo-settings -- --apply
npm run repo-settings -- --verify
```

`npm run repo-settings` runs `.github/scripts/bootstrap-settings.mjs`, the same script as Bootstrap's settings step. With no flag it changes nothing and prints what `--apply` would send, as `gh api` commands. `--apply` and `--verify` need `GITHUB_REPOSITORY` and `GH_TOKEN`. It is for running by hand only: no workflow runs it through npm, and `node .github/scripts/check-bootstrap-isolation.mjs` fails if the token job ever runs npm.

## Security note

`BOOTSTRAP_TOKEN` is an org (or repo) secret **readable by any workflow** in repositories the secret is shared with. Keep permissions minimal, rotate on schedule, and never reference or log the secret outside `.github/workflows/bootstrap.yml` (see `npm run secret-usage` and [AGENTS.md](../../AGENTS.md)). In that workflow only the push and settings steps receive it, and `node .github/scripts/check-bootstrap-isolation.mjs` holds that (O-113).

## To verify at the first real run

Built and tested with fakes (a fake GitHub API, git stubs, local repositories), without a real GitHub or token (O-113). At the first real run, with no real personal data, check and record each result with the date in O-113:

- The token job sees no repository code: in the `apply` job's log, only `actions/checkout`, `actions/download-artifact` and the three `node .github/scripts/...` steps run; no `npm`, `npx` or `setup-node` step appears; only the push and settings steps show `GH_TOKEN` (masked) in their env; and the job's `.git/config` holds no `extraheader` (checkout with `persist-credentials: false`).
- Foreman's pushes stay no-ops: a push to Foreman's `main` ends in the `decide` job with _Already initialized_ and `prepare` and `apply` skipped, with no request to GitHub; a **Run workflow** on Foreman reads `protected: true` for `main` and does nothing.
- A new repository: GitHub answers `protected: false` for its default branch before Bootstrap and `protected: true` after it. GitHub's docs count rulesets too, so an organization ruleset on default branches would make every new repository read as set up.
- The hand-over: the patch artifact uploads and downloads, `git apply` takes it on the fresh runner, the setup commit is `github-actions[bot]`'s, and the push with `GIT_CONFIG_*` auth lands on the default branch.
- The settings: the label, merge settings and branch protection apply through `fetch` with the token, and `--verify` passes.

## GitHub REST API used by `repo-settings`

Bootstrap's settings step and `npm run repo-settings` call these REST endpoints with Node's `fetch` (`.github/scripts/bootstrap-settings.mjs`). The `gh` column is the method of the `gh api` command the dry run prints for each write:

| Operation                 | `gh` usage | REST endpoint                                                                                                                                                              |
| ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read branch protection    | `GET`      | [Get branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection) — `GET /repos/{owner}/{repo}/branches/{branch}/protection`       |
| Apply branch protection   | `PUT`      | [Update branch protection](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection) — `PUT /repos/{owner}/{repo}/branches/{branch}/protection` |
| Read repository settings  | `GET`      | [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository) — `GET /repos/{owner}/{repo}`                                                             |
| Patch repository settings | `PATCH`    | [Update a repository](https://docs.github.com/en/rest/repos/repos#update-a-repository) — `PATCH /repos/{owner}/{repo}`                                                     |

Creating the Dependabot auto-merge label uses the Issues API: [Get a label](https://docs.github.com/en/rest/issues/labels#get-a-label), `GET /repos/{owner}/{repo}/labels/{name}`, then, when it is missing, [Create a label](https://docs.github.com/en/rest/issues/labels#create-a-label), `POST /repos/{owner}/{repo}/labels`. The decide step reads [Get a branch](https://docs.github.com/en/rest/branches/branches#get-a-branch), `GET /repos/{owner}/{repo}/branches/{branch}`, with the workflow's own token (Contents: read). The Dependabot auto-merge workflow keeps its own `gh` helper (`scripts/lib/dependabot-label.mjs`).
