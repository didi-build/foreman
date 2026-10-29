# Guards

The 24 guards from ADR 0105's guard list, as built in M2.2. Code: `src/core/guards/`, one pure function per guard, registered in `src/core/guards/index.ts` as `GUARDS`. Tests: next to each file, plus `test/guards-registry.test.ts` (the registry against the ADR) and `test/guards-walkthrough.test.ts` (a code item to Done with the real guards).

## Rules every guard follows

- A guard reads only its `GuardContext`: the node and read-only store calls (`getNode`, `listEdges`, `listEvidence`, `listTransitions`, `getDecision`, `getCounter`, `getSetting`, `getRun`, `listRuns`, `findOpenGateRequest`, `listOpenGateRequests`, `listDecisionsForNode`, `getProject`). M2.2 added the last four. It has no write call.
- A guard never throws on bad data. A malformed payload makes the guard fail with a detail that names the evidence kind.
- A guard never calls a model. `scope_matches_plan` fails with "needs Council" when the spec goes beyond the plan (D-177).
- Each guard returns `{guard, pass, evidenceIds, detail}`. The evidence ids name what it relied on.

## The head commit

A guard that reads "on the current head commit" takes the head from the most recent `ci_run` evidence on the node (latest `recordedAt`, then id). GitHub ingestion (M2.3) records a `ci_run` for every new head commit as soon as its checks start, with conclusion `pending`, so the latest `ci_run` names the head. Evidence for any other commit is stale and ignored. No `ci_run` means no linked PR yet, and every head-commit guard fails.

Head-scoped guards: `ci_green_on_head`, `docs_updated_or_none`, `qa_verdict_independent_on_head`, `privileged_paths_approved`, `spec_components_exist`.

A `docs_note` written by an agent through the state API carries no commit. It counts for the head when it names the head commit, or when it has no commit and was recorded at or after the head's `ci_run`.

## The merge commit

`staging_check_on_merge_commit` and `staging_check_failed` read the most recent `merge_commit` evidence. Its `commitSha` is the merge commit on main, and the staging check must name that commit. The head commit does not count.

## Evidence payloads

| Kind                                                  | Payload                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ci_run`                                              | `{conclusion: "success" \| "failure" \| "pending", pr: positive integer, changedPaths?: string[]}`                                    |
| `preview_check`, `staging_check`, `visual_comparison` | `{pass: boolean}`                                                                                                                     |
| `merge_commit`                                        | `{pr: positive integer}`                                                                                                              |
| `docs_note`                                           | `{impact: "updated" \| "none", note?: string}`                                                                                        |
| `qa_verdict`                                          | `{verdict: "pass" \| "fail", findings: [{path, startLine, endLine, note}], evidenceIds: string[]}` (as `src/api/routes.ts` stores it) |
| `spec_paths`                                          | `{paths: non-empty string[], components: string[], commits: non-empty [{sha, author}], newFeatures: string[], newFlows: string[]}`    |
| `test_report`                                         | `{suite: string, pass: boolean, galleryComponents?: string[]}`                                                                        |
| `agent_report`                                        | `{summary?: string, escalate?: boolean, reason?: string}`                                                                             |

## Topic keys and decision conventions

- Visual approval topic: `visual-approval:<nodeId>`. Escalation topic: `escalation:<nodeId>`.
- A node's decisions are the ones recorded on it plus the ones linked through `node_decisions`. Only `active` decisions count.
- `plan_attached`: an active `product_direction`, and an active `council_decision` with `scope.kind` `plan_accepted`.
- `privileged_paths_approved`: an active `approval` by `didi` with `scope {kind: "privileged_path", commitSha: <head>}`. A new commit needs a fresh approval.
- `approval_recorded`: the latest active decision on the visual topic is an `approval` by `didi` with non-empty verbatim text.
- `changes_requested_recorded`: an active `answer` by `didi` on the visual topic with `scope.outcome` `changes_requested` or `rejected`.
- `scope_matches_plan`: passes when the latest `spec_paths` declares nothing beyond the plan, or when an active `council_decision` with `scope.kind` `scope_approved` was recorded after that spec.
- `council_decision_recorded`: an active `council_decision` since the node entered its state, with `scope.changesProductDirection === false` and `scope.passesGate === false`. Anything else goes to Didi (D-177).
- `didi_answer_recorded`: an active decision by `didi` on the escalation topic since the node entered its state, with non-empty verbatim text.

## Settings and project fields read

- `failure_threshold` and `qa_round_cap` (settings) against the `failure` and `qa_round` counters.
- `designer_identity` (setting): the only author allowed on spec commits.
- `project.privilegedPathsExtra` adds to the default privileged paths: `**/migrations/**`, `.github/**`, `docs/privacy/**`, `**/*secret*`, `**/*secret*/**`, `**/.env*`.
- `project.prodRequiresApproval` for `prod_env_protected`.

## What each guard reads

| Guard                            | Passes when                                                                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockers_done`                  | every node with a `blocks` edge into this one is Done                                                                                                                                                                               |
| `design_spec_merged`             | a design item has a `merge_commit`; another item's design blockers each have one                                                                                                                                                    |
| `no_pending_gate`                | no open gate request names the node                                                                                                                                                                                                 |
| `agent_ready_not_on_hold`        | the node is agent-ready and not on hold                                                                                                                                                                                             |
| `plan_attached`                  | see the decision conventions above                                                                                                                                                                                                  |
| `ci_green_on_head`               | the head `ci_run` concluded `success`                                                                                                                                                                                               |
| `docs_updated_or_none`           | a `docs_note` for the head says `updated` or `none`                                                                                                                                                                                 |
| `qa_verdict_independent_on_head` | CI green and a passing `preview_check` on the head, a passing `qa_verdict` on the head from a QA run whose model differs from every builder run's model (D-158), and for the design track a passing `visual_comparison` on the head |
| `privileged_paths_approved`      | the head `ci_run`'s `changedPaths` touch no privileged path, or Didi approved this head                                                                                                                                             |
| `prod_env_protected`             | `project.prodRequiresApproval` is true                                                                                                                                                                                              |
| `qa_failed_with_findings`        | the latest `qa_verdict` on the head is `fail` with at least one finding                                                                                                                                                             |
| `not_third_failed_round`         | `qa_round + 1 < qa_round_cap`                                                                                                                                                                                                       |
| `staging_check_on_merge_commit`  | the `staging_check` on the latest merge commit passed                                                                                                                                                                               |
| `staging_check_failed`           | the `staging_check` on the latest merge commit failed                                                                                                                                                                               |
| `options_attached`               | screenshot evidence on the node and an open `visual_approval` gate on the visual topic                                                                                                                                              |
| `approval_recorded`              | see the decision conventions above                                                                                                                                                                                                  |
| `changes_requested_recorded`     | see the decision conventions above                                                                                                                                                                                                  |
| `spec_edited_by_designer_only`   | every commit in the latest `spec_paths` is by `designer_identity`                                                                                                                                                                   |
| `scope_matches_plan`             | see the decision conventions above; otherwise fails with "needs Council"                                                                                                                                                            |
| `spec_components_exist`          | every component the latest spec lists is in the latest `gallery` `test_report` on the head                                                                                                                                          |
| `escalation_trigger_met`         | the failure counter reaches `failure_threshold`, the QA round counter reaches `qa_round_cap`, a run in the current state ended `budget_exceeded`, or an `agent_report` in the current state asks to escalate with a written reason  |
| `council_decision_recorded`      | see the decision conventions above                                                                                                                                                                                                  |
| `didi_question_open`             | an open gate request on the escalation topic owned by `didi`                                                                                                                                                                        |
| `didi_answer_recorded`           | see the decision conventions above                                                                                                                                                                                                  |

## Not yet checked

- Citation checks for `qa_verdict` (cited files and lines exist at the head commit) need the repository and land with the runner (M3.2). Until then the guard trusts the stored findings shape.
