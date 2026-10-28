# 0100. Place the Project Factory v2 handoff in the Launchpad layout

- **Status:** proposed (review point M0.0: Didi skims this before M0.1 starts)
- **Date:** 2026-10-28
- **Related:** [docs/build-plan.md, task M0.0](../build-plan.md#m00-place-the-handoff-files-in-the-repos-layout), decision D-131 and proposal P-11 in [docs/decision-log.md](../decision-log.md)

## Context

The handoff package was committed unmodified to `handoff/` (commit `857cf59`). Its documents use a generic layout: `docs/...`, `docs/adr/NNNN-title.md`, `docs/decisions.md`, `docs/architecture.md`, `contracts/`, and a root `README.md` and `AGENTS.md`. The handoff says Launchpad's conventions win where they conflict (D-131).

This repo comes from Launchpad, and four things collide:

1. **ADR folder and numbers.** Launchpad keeps ADRs in `docs/decisions/NNNN-title.md`, and numbers 0000 (the template) to 0005 are taken. The handoff plans ADRs 0001 to 0011 in `docs/adr/`, and task M0.0 names this ADR `0000-handoff-placement.md`, which is the number of Launchpad's template.
2. **Decision log name.** The handoff's `docs/decisions.md` would sit next to Launchpad's `docs/decisions/` folder of ADRs. Two different things with nearly the same name.
3. **Architecture.** Launchpad has a `docs/architecture/` folder with an unfilled template, `overview.md`. The handoff has one file, `docs/architecture.md`.
4. **`AGENTS.md` and `README.md`.** Both exist on each side. Launchpad's `AGENTS.md` says it is the single source of truth for agent rules.

## Decision

### Files

| Handoff path                           | Placed at                                     | Reason                                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handoff/AGENTS.md`                    | merged into `AGENTS.md`                       | Launchpad's `AGENTS.md` is the single source of truth. Every existing rule is kept word for word. The handoff rules are added under "Project Factory v2 rules". Section 1a is rewritten to say where things are now. A new section 9 lists the rules that conflict (see below).      |
| `handoff/README.md`                    | merged into `README.md`                       | Added as a "Project Factory v2" section after the attribution block. The reading list links to the placed files. "Where the files live" now points here. Every Launchpad section is unchanged.                                                                                       |
| `handoff/docs/prd.md`                  | `docs/prd.md`                                 | No conflict. Same path as the handoff's logical path, so no reference changes.                                                                                                                                                                                                       |
| `handoff/docs/spec.md`                 | `docs/spec.md`                                | Same as above.                                                                                                                                                                                                                                                                       |
| `handoff/docs/schema.md`               | `docs/schema.md`                              | Same as above.                                                                                                                                                                                                                                                                       |
| `handoff/docs/build-plan.md`           | `docs/build-plan.md`                          | Same as above.                                                                                                                                                                                                                                                                       |
| `handoff/docs/test-plan.md`            | `docs/test-plan.md`                           | Same as above.                                                                                                                                                                                                                                                                       |
| `handoff/docs/cutover.md`              | `docs/cutover.md`                             | Same as above.                                                                                                                                                                                                                                                                       |
| `handoff/docs/grok-mapping.md`         | `docs/grok-mapping.md`                        | Same as above.                                                                                                                                                                                                                                                                       |
| `handoff/docs/implementation-brief.md` | `docs/implementation-brief.md`                | Same as above. The "read first" sentence in the prompt template now lists the placed paths, because later sessions reuse it. The first-session notes still say `handoff/`, because they describe what happened.                                                                      |
| `handoff/docs/architecture.md`         | `docs/architecture/technical-architecture.md` | Launchpad's `docs/architecture/` folder is for system shape. The file keeps its content. `overview.md` stays the short entry point: its unfilled template sections now link to the matching sections of the placed documents, and its Purpose and Environments content is unchanged. |
| `handoff/docs/decisions.md`            | `docs/decision-log.md`                        | Avoids the near-clash with `docs/decisions/`. It is a log, not an ADR.                                                                                                                                                                                                               |
| `docs/adr/NNNN-title.md` (planned)     | `docs/decisions/NNNN-title.md`                | Launchpad's ADR folder.                                                                                                                                                                                                                                                              |
| `contracts/` (planned, M2.1)           | `contracts/` at the repo root                 | No conflict. Nothing to move now.                                                                                                                                                                                                                                                    |
| `0000-handoff-placement.md`            | `docs/decisions/0100-handoff-placement.md`    | 0000 is Launchpad's ADR template.                                                                                                                                                                                                                                                    |

`handoff/` is removed once the checks below pass. The unmodified originals stay in git history at commit `857cf59`, for example `git show 857cf59:handoff/docs/spec.md`. (Do not rely on `git log --follow`: the table re-padding is large enough that git does not always pair the old and new files as a rename.)

### ADR numbering

Launchpad's ADRs keep 0000 to 0099. Project Factory v2 ADRs start at 0100. The ADRs the handoff planned keep their last two digits:

| Handoff ADR | Repo ADR | Subject                                            |
| ----------- | -------- | -------------------------------------------------- |
| (M0.0)      | 0100     | This placement                                     |
| 0001        | 0101     | Repo layout, language and tooling                  |
| 0002        | 0102     | State API hosting and agent authentication         |
| 0003        | 0103     | Managed Postgres provider and region               |
| 0004        | 0104     | Final schema, decision reversal, counter rules     |
| 0005        | 0105     | Contracts format and consistency test              |
| 0006        | 0106     | Agent execution environment and budget enforcement |
| 0007        | 0107     | Dispatch adapters per runtime and the Grok result  |
| 0008        | 0108     | Linear adapter, statuses setup and app identity    |
| 0009        | 0109     | Notification providers                             |
| 0010        | 0110     | Infrastructure as code                             |
| 0011        | 0111     | Conventions that make the move to Kubernetes cheap |

Every ADR number in the placed documents was rewritten to match. References to Launchpad's own ADRs (for example ADR 0004, the component gallery, in `docs/component-gallery.md`) are unchanged. New ADRs that the handoff did not plan take the next free number from 0112.

Project Factory v2 ADRs use Launchpad's template and add `## Constraints` and `## How success is judged`, because the handoff's `AGENTS.md` asks every ADR to cover them. This is written in `docs/decisions/README.md`.

### Path rewrites inside the documents

Only in the files that came from the handoff:

- `docs/adr/` to `docs/decisions/`
- `docs/decisions.md` to `docs/decision-log.md`
- `docs/architecture.md` to `docs/architecture/technical-architecture.md`
- `0000-handoff-placement.md` to `0100-handoff-placement.md`
- ADR numbers 0001 to 0011 to 0101 to 0111

No other words in the handoff documents were changed, except the rewrites listed in the Files table for `AGENTS.md` section 1a, the README sections and the prompt template.

### Formatting

The repo's `npm run check` runs Prettier on every file. The handoff markdown was not Prettier-formatted, so `main` has failed `format:check` since the handoff commit. Prettier was run on the placed files. It only re-pads markdown table columns. To confirm this, every placed file was compared with its handoff original after stripping spaces, line breaks and dashes, and they match exactly.

### Rule conflicts in `AGENTS.md`

M0.0 says to stop and ask where rules conflict. These are kept side by side, word for word, listed in `AGENTS.md` section 9, and logged as Open for Didi:

- N-16: Linear ticket as the source of scope (Launchpad) against the state store and build plan (handoff).
- N-17: no PR for decision-only tasks (Launchpad) against every decision recorded in an ADR or the log (handoff).
- N-18: the no-em-dash style rule (handoff) against existing Launchpad text that uses them.
- P-09, already Proposed in the handoff, covers who merges PRs.

One more difference is mine to decide later, not a conflict to stop on. The handoff says tests live next to the seam they test, and Launchpad keeps tests under `test/`. Test layout is O-06, decided in ADR 0101 (M0.1).

## Constraints

- No existing Launchpad rule or file is deleted or weakened. The only Launchpad files whose text changed are `AGENTS.md` and `README.md` (additions only), `docs/README.md` (new rows and one added sentence), `docs/decisions/README.md` (new sections) and the template placeholders in `docs/architecture/overview.md`.
- No code, config, workflow or dependency changes.
- No change in meaning to any handoff document.

## Reasons

- Keeping the planned ADRs' last two digits means "ADR 0007" in a conversation maps to 0107 without a lookup, and no number ever means two different decisions. Renumbering straight after 0005 would have made 0007 mean "dispatch adapters" in the handoff and "repo layout" here.
- One ADR folder and one template keep Launchpad's convention. A separate Project Factory v2 ADR folder would split the record.
- Flat `docs/*.md` matches the handoff's own logical paths, so most references needed no change. That keeps the diff small and easy to check.

Alternatives considered:

- Renumber the planned ADRs from 0006: rejected for the reason above.
- Keep the handoff's own `docs/adr/` folder: rejected, because Launchpad's convention wins and there would be two ADR folders.
- Replace `overview.md` with the handoff architecture: rejected, because M0.0 forbids overwriting an existing file without merging. Launchpad's Environments table (preview Worker notes) would have been lost.

## How success is judged

1. A link and path check over every markdown file finds no broken references.
2. `npm run check` passes.
3. Every handoff file appears in the Files table above.
4. `README.md` links to the placed documents in reading order.
5. `git diff` of `AGENTS.md` and `README.md` against `main` shows only added lines.

Results are in the pull request description.

## Consequences

- Readers of older copies of the handoff need the ADR table above to translate numbers.
- Every later ADR follows this numbering. The build plan, architecture and decision log already use it.
- `npm run check` on this branch is green again, which `main` currently is not.
