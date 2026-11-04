# 0105. Contracts as data, and the consistency test

- **Status:** accepted at the M2.1 review point (D-176, 2026-10-29).
- **Date:** 2026-10-29
- **Related:** P-01, P-07, O-09, essential 3, `docs/spec.md` section 9, [ADR 0104](./0104-state-store-schema.md), `src/core/contracts.ts` (the minimal types from M1.3)

## Context

Essential 3: contracts (guards, evidence, timeouts, fallbacks) are data loaded at a version, and each transition records the version it used. Rules must never live in flows. `docs/spec.md` section 9 has the Machine 2 contracts as prose tables. M1.3 built the library against minimal contract types and a test machine. M2.1 turns the spec tables into files the library loads, and adds a test that fails if the files and the spec drift apart. O-09 also asks for one settled list of guard names, because the documents disagree.

## Decision

### Format and place

- **YAML files in `contracts/`**, one per part of Machine 2: `contracts/machine-2/code.yaml` (the code, infrastructure and docs tracks, which share one path), `design.yaml` and `escalation.yaml`. Machine 1 gets its own files when M3.6 needs them: `contracts/machine-1/idea.yaml` (M3.6) declares its states and the two moves the minimum Machine 1 automates, and the runner loads both folders as one contract set (`loadAllContractFiles`).
- YAML, not JSON, because Didi and the agents read and review these files, and YAML allows comments. The `yaml` package is already pinned in the repo. It moves from a development dependency to a runtime one, because the runner and the API load contracts.
- **Parsing stays out of the core.** A small adapter (`src/adapters/contracts-file/`) reads and parses the files. The core gets a plain object and validates it with its own function (`validateContracts`), which returns every problem at once: an unknown state, a guard name that is not registered, a duplicate move, a missing required field.
- **The spec version** is the git commit of `docs/spec.md` and `contracts/`, as the architecture already says. The content hash is a SHA-256 of the loaded files, so two loads of the same commit are provably the same.

### What a file holds

States, with an id in `snake_case` and the spec's own words as the label:

| Field                                                                                          | Meaning                                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `label`                                                                                        | The spec's name, for example "In QA review". The consistency test reads it                                |
| `owner`                                                                                        | The role that owns the state (Developer, Designer, QA, Operator, Runner)                                  |
| `initial`                                                                                      | A node may be created in this state                                                                       |
| `requires_blocked_reason`                                                                      | Entering needs a written reason (invariant 4)                                                             |
| `escalated`                                                                                    | Nothing in this state is dispatched (invariant 6)                                                         |
| `purpose`, `input`, `output`, `evidence_to_exit`, `tools`, `budget`, `side_effects`, `failure` | The spec's contract fields, as text. `budget` stays "not set" until budgets are decided (spec section 10) |

Transitions:

| Field                 | Meaning                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`          | State ids. `from: any` and `to: return` are allowed only in `escalation.yaml` (see below)                              |
| `tracks`              | Which tracks the move applies to (`code`, `infra`, `docs`, `design`). States can be shared across tracks, moves cannot |
| `trigger`             | What starts it: an event name, the reconcile pass, a bot report, a human answer                                        |
| `guards`              | Guard names, every one must pass                                                                                       |
| `evidence`            | The evidence kinds the guards read, for the record and the dry-run report                                              |
| `timeout`, `fallback` | As text for now. M3 turns the timeouts it needs into settings                                                          |

### Escalation from any state, and the way back

The spec escalates "from any state" and returns "to the state it came from". In the files that is `from: any` and `to: return`. The library resolves `return` from the node's transition history: the state the node was in when it entered the escalation. Nothing else may use `any` or `return`, and the loader rejects them elsewhere.

### The guard list (settles O-09)

One name per check, used everywhere. Each is a pure function over the store's read calls (M1.3 already gives guards only read calls) and never calls a model.

| Guard                            | Passes when                                                                                                                                                                                                                       | Used on                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `blockers_done`                  | Every `blocks` edge into the node comes from a node in Done                                                                                                                                                                       | Blocked to Ready for dev, Ready for dev to In development               |
| `design_spec_merged`             | Each design blocker's spec is merged on main (a merge-commit record exists)                                                                                                                                                       | Blocked to Ready for dev, design Verifying on staging to Done           |
| `no_pending_gate`                | No open gate request on the node                                                                                                                                                                                                  | Every dispatch                                                          |
| `agent_ready_not_on_hold`        | The node is agent-ready, not on hold and not stale (O-45)                                                                                                                                                                         | Every dispatch                                                          |
| `ci_green_on_head`               | A linked PR exists and CI passed on its current head commit                                                                                                                                                                       | Into In QA review, QA pass (D-218)                                      |
| `docs_updated_or_none`           | A docs note exists for the head commit, saying what changed or that there is no docs impact                                                                                                                                       | Into In QA review, QA pass                                              |
| `qa_verdict_independent_on_head` | ADR 0112: CI green and a preview check on the head commit, a pass with verified citations, the independence rule                                                                                                                  | QA pass                                                                 |
| `privileged_paths_approved`      | The PR touches no privileged path, or Didi approved this head commit                                                                                                                                                              | QA pass (every track since D-218)                                       |
| `prod_env_protected`             | The repo does not deploy on push to main, or its production environment requires Didi                                                                                                                                             | QA pass (code track)                                                    |
| `qa_failed_with_findings`        | A fail verdict on the head commit lists findings                                                                                                                                                                                  | QA fail                                                                 |
| `not_third_failed_round`         | The QA round count is below `qa_round_cap`                                                                                                                                                                                        | QA fail                                                                 |
| `no_merge_conflict_on_head`      | GitHub reports the PR's current head merges with no conflict, as the runner recorded it (added by D-218, M3.3)                                                                                                                    | QA pass                                                                 |
| `qa_rounds_below_cap`            | The item is not past the round cap: failed QA rounds are below `qa_round_cap` (added with M3.3; the merge counts no round)                                                                                                        | QA pass                                                                 |
| `no_failed_qa_verdict_on_head`   | QA has not failed the current head commit: no failed QA verdict on it (added with M3.5, O-42)                                                                                                                                     | Into In QA review                                                       |
| `staging_check_on_merge_commit`  | A staging check passed for the merge commit, on staging serving it or a commit on main that contains it, and no failed staging deploy covers it (D-225)                                                                           | Verifying on staging to Done                                            |
| `staging_check_failed`           | A staging check failed for the merge commit, or a staging deploy of it or of a commit on main that contains it failed (D-225)                                                                                                     | Verifying on staging back to work                                       |
| `plan_attached`                  | The approved plan and the product direction are linked to the node                                                                                                                                                                | Design dispatch                                                         |
| `options_attached`               | The Designer's options are attached and one visual-approval request exists for them                                                                                                                                               | Into Waiting for Didi                                                   |
| `approval_recorded`              | An approval decision exists for this request, verbatim, with time and scope                                                                                                                                                       | Waiting for Didi to Writing spec                                        |
| `changes_requested_recorded`     | Didi's answer asks for changes or rejects, verbatim                                                                                                                                                                               | Waiting for Didi back to exploration                                    |
| `spec_edited_by_designer_only`   | Every commit touching the spec paths was made by the Designer's identity                                                                                                                                                          | Writing spec to Building components                                     |
| `scope_matches_plan`             | No new feature or user flow beyond the plan. A judgment call escalates to the Council, which involves Didi only if needed (D-177); it never asks a model (M2.2)                                                                   | Writing spec to Building components                                     |
| `spec_components_exist`          | Every component the spec lists exists in the gallery build                                                                                                                                                                        | Building components to In QA review                                     |
| `escalation_trigger_met`         | The failure counter or QA rounds reached their limit, the budget ran over, the staging check gave no result twice (M3.4), or a bot's escalation request has a written reason                                                      | Into Escalated to Council                                               |
| `council_decision_recorded`      | A Council decision for this escalation exists, does not say it cannot resolve the item (M3.5), and changes no product direction or gate                                                                                           | Council back to work                                                    |
| `didi_question_open`             | The question for Didi is saved as a gate request with a topic key                                                                                                                                                                 | Council to Escalated to Didi                                            |
| `didi_answer_recorded`           | Didi's answer is saved verbatim with time and scope                                                                                                                                                                               | Didi back to work                                                       |
| `council_redo_recorded`          | The item is stale and not merged, every decision it relies on that was reversed since its last way out of stale has a Council verdict for it that is not `cannot_decide`, and the latest active one gives `redo` (added by D-231) | Back to the start of the track (redo)                                   |
| `unpicked_options_removed`       | The PR at the head carries no exploration option folder other than the approved option's; fails closed when the head's changed paths are not recorded (added by D-258)                                                            | QA pass (design track only)                                             |
| `plan_approval_recorded`         | Didi approved, on the plan-approval request, the latest plan the planning chat submitted for the idea (added by D-266)                                                                                                            | Submitted or Council planning to Plan accepted (Machine 1)              |
| `plan_return_recorded`           | Didi rejected the latest plan or asked for changes, with feedback, on the plan-approval request (added by D-266)                                                                                                                  | Submitted to Council planning (Machine 1)                               |
| `scanner_finding_gone`           | The idea is the Scanner's and in Submitted, and the latest scan of its project that ran, after the idea was filed, found none of its findings, with every check they need run in full (added by D-301)                            | Submitted to Rejected (Machine 1, runner only)                          |
| `council_plan_accepted`          | The idea's latest plan, from the planning chat or the Council's planning run, carries the Council's call that Didi is not needed, and no plan-approval request was ever opened for the idea (added by D-307)                      | Submitted or Council planning to Plan accepted (Machine 1, runner only) |

M3.3 added `no_merge_conflict_on_head` (D-218) and `qa_rounds_below_cap` (the build plan's "not past the round cap", O-30) for the merge guard. M3.5 added `no_failed_qa_verdict_on_head`, so a done report on a head QA already failed does not send it back to QA (O-42). D-231 added `council_redo_recorded` for the moves that send a stale item back to the start of its track on a Council `redo` verdict. D-301 added `scanner_finding_gone` for the runner's withdrawal of a scanner idea that is no longer found. D-258 added `unpicked_options_removed` to the design track's merge only, since only design items have exploration options (O-69). D-266 added `plan_approval_recorded` and `plan_return_recorded` for Machine 1's moves on Didi's answer to the planning chat's plan (O-78). D-307 added `council_plan_accepted` for the Council's own way into Plan accepted (O-96). The list has 33 names.

`failure_counter_below_threshold` from the test plan is folded into `escalation_trigger_met`, which is its other side. The names in `docs/architecture/technical-architecture.md` section 2.6, the build plan M2.2 and the test plan are updated to this list when the code lands.

### The consistency test

`test/contracts-consistency.test.ts` parses the three transition tables in `docs/spec.md` section 9 ("Code, infrastructure and docs tracks", "Design track", "Escalation"). From each row's first column ("Blocked to Ready for dev", "In QA review to In development (fail)") it takes the from and to labels, maps them to state ids through the contract labels, and compares the set of moves with the contract file for that table. It fails on a move in one and not the other, and on a label the contracts do not know. It does not parse guards or evidence out of prose; those are reviewed by people.

Some legal moves exist only in a row's prose fallback ("if the check fails, the item goes back to In development"), not as table rows. The files mark these `fallback_move: true`. The test pins them with an explicit list, each entry naming its spec row and quoting the fallback words, checks that those words are in that row, and requires the files' fallback moves to equal the list exactly. So a fallback move can be neither invented nor lost without the test failing.

A move marked `runner_only: true` is applied only by the runner step that owns it and makes the writes that go with it: the Council's redo moves (D-231) and the escalation's two `to: return` moves (O-46). The library rejects any other request for such a move with `runner_only_move`; the owning step sets `runnerOnly` on its request, and the transition flow never can. The consistency test requires the flag exactly on the moves guarded by `council_redo_recorded`, `council_decision_recorded` and `didi_answer_recorded` (O-54).

## Constraints

- No rule outside contracts and guard functions (essential 3). The placeholder entry state in `src/api/entry.ts` moves into the contracts.
- The core parses no files and imports nothing new; the adapter does the reading.
- All rows stay Proposed until Didi confirms them (P-01). Reviewing this ADR is that confirmation for the shape; the row contents follow the spec.

## How success is judged

1. The consistency test passes, and removing one transition from either the spec or a contract file fails it (build plan M2.1).
2. The loader rejects, with every problem listed: an unknown state, an unregistered guard, a duplicate move, `any` or `return` outside escalation. Since D-307 two runner-only moves between the same states with different guards are not a duplicate: they are two ways in, each owned by its runner step, which names the one it takes by a guard (`guardedBy`); the Council's acceptance and Didi's approval into Plan accepted are the only such pair (O-96).
3. The library runs the real contracts: a work item can walk the code track and the design track in the memory store with fake evidence, and escalate and return.
4. Didi reviews this ADR. Done 2026-10-29 (D-176).

## Reasons

- Files reviewed like code keep rules visible and versioned; the spec version on every transition says which rules applied.
- Parsing in an adapter keeps the core pure, so the dry run and tests use the same contracts without file access.
- Settling one guard list now stops the three documents drifting further, and M2.2 builds against it.

## Consequences

- `yaml` becomes a runtime dependency.
- The library learns `tracks`, `any` and `return`.
- A change to the spec's transition tables needs the same change in `contracts/`, or CI fails. That is the point.
