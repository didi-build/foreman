# 0001. Template bootstrap on repository creation

- **Status:** accepted
- **Date:** 2026-10-11

## Context

Repositories created from the Launchpad GitHub template need placeholder replacement (`init-project`) and recommended GitHub settings (branch protection, auto-merge, Dependabot label) without manual steps. GitHub fires `push` workflows on the initial commit of a template-created repo, so we can automate setup in Actions.

We must not re-apply branch protection and related API changes on every push to `main` — that is noisy, increases API usage, and can mask intentional drift. External users of the public template will not have the `didi-build` org `BOOTSTRAP_TOKEN` secret.

## Decision

Add a **Bootstrap** workflow (`.github/workflows/bootstrap.yml`) that runs on `push` to `main` and `workflow_dispatch`. It computes a **plan** from repository state and event metadata:

| Initialized | Event / attempt                       | `init` | `settings` |
| ----------- | ------------------------------------- | ------ | ---------- |
| no          | (any)                                 | yes    | yes        |
| yes         | `push`, attempt 1                     | no     | no         |
| yes         | `workflow_dispatch` or attempt &gt; 1 | no     | yes        |

Settings apply **only** on first-time init (together with `init-project`) or on manual retry (`workflow_dispatch` / re-run). Ordinary pushes after initialization are a **no-op**.

The workflow reads the repo with the default `GITHUB_TOKEN`, computes the plan, and only then uses `BOOTSTRAP_TOKEN` (org secret) when the plan requires writes. Missing token in non–`didi-build` repos degrades with a warning and documented manual fallback.

## Reasons

- Separating plan from token use avoids exposing the PAT when the job would do nothing.
- No-op on later pushes keeps bootstrap safe to leave in derived repos indefinitely.
- Retry path re-applies settings without re-running `init-project` (templates already moved).

## Consequences

- `didi-build` derived repos require `BOOTSTRAP_TOKEN` on the org or bootstrap fails loudly.
- Other orgs/users must add their own repo secret or follow the manual checklist.
- `BOOTSTRAP_TOKEN` must not be referenced outside `bootstrap.yml` (enforced by `npm run secret-usage`).

## Amendment (2026-10-23): nodrift and Bootstrap env

See [0003. Nodrift guardrails kit in Launchpad](./0003-nodrift-in-launchpad.md) for `@didi-build/nodrift`, `LAUNCHPAD_COLLECTS_PERSONAL_DATA`, and when `npm run nodrift` runs in derived repos. Bootstrap still separates the read-only plan from token checkout; invalid personal-data env values fail in plan before the PAT is used.

## Amendment (2026-11-07): only protected code receives the token (D-358 lock 1, O-113)

Bootstrap now has three jobs. A first, protected step (`node .github/scripts/bootstrap-plan.mjs`) decides whether the repository still needs setting up: the plan table above, plus whether GitHub reports the default branch as protected, which no bot can change and which the settings step sets last. A protected default branch means set up, so Bootstrap acts only while the repository is new, and **Run workflow** or **Re-run jobs** on a set-up repository does nothing; settings changes after that go through `npm run repo-settings` by hand. The template's setup (`init-project`, `npm ci`, `nodrift init`) runs in its own job without the token and hands its changes over as a patch. The token job runs on a fresh runner and runs only `.github/scripts/`: it applies the patch with `git apply`, commits as `github-actions[bot]`, pushes, and applies the settings through GitHub's REST API with Node's `fetch`. `node .github/scripts/check-bootstrap-isolation.mjs` fails CI if any of that changes. Launchpad needs the same change in its own repository. See [the runbook](../runbooks/bootstrap.md).
