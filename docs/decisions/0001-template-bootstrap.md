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
