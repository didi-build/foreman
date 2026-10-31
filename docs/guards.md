# Guards

The guards from ADR 0105's guard list: 24 built in M2.2, and `no_merge_conflict_on_head` and `qa_rounds_below_cap` added for the merge guard in M3.3 (D-218). Code: `src/core/guards/`, one pure function per guard, registered in `src/core/guards/index.ts` as `GUARDS`. Tests: next to each file, plus `test/guards-registry.test.ts` (the registry against the ADR) and `test/guards-walkthrough.test.ts` (a code item to Done with the real guards).

## Rules every guard follows

- A guard reads only its `GuardContext`: the node and read-only store calls (`getNode`, `listEdges`, `listEvidence`, `listTransitions`, `getDecision`, `getCounter`, `getSetting`, `getRun`, `listRuns`, `findOpenGateRequest`, `listOpenGateRequests`, `listDecisionsForNode`, `getProject`). M2.2 added the last four. It has no write call.
- A guard never throws on bad data. A malformed payload makes the guard fail with a detail that names the evidence kind.
- A guard never calls a model. `scope_matches_plan` fails with "needs Council" when the spec goes beyond the plan (D-177).
- Each guard returns `{guard, pass, evidenceIds, detail}`. The evidence ids name what it relied on.

## The head commit

A guard that reads "on the current head commit" takes the head from the most recent `ci_run` evidence on the node (latest `recordedAt`, then id). GitHub ingestion (M2.3) records a `ci_run` for every new head commit as soon as its checks start, with conclusion `pending`, so the latest `ci_run` names the head. Evidence for any other commit is stale and ignored. No `ci_run` means no linked PR yet, and every head-commit guard fails.

GitHub ingestion (`src/core/github-ingest.ts`, ADR 0113) keeps this true. It records a `ci_run` only when the commit is the PR's head as GitHub reports it at that moment, so a late event about an older commit records nothing. It skips a `pending` row when the commit already has a `ci_run`, so a late or repeated `pending` never hides a finished result. A check rerun that changes the result on the head records a new row, which becomes the newest.

Head-scoped guards: `ci_green_on_head`, `docs_updated_or_none`, `qa_verdict_independent_on_head`, `privileged_paths_approved`, `no_merge_conflict_on_head`, `spec_components_exist`.

A `docs_note` written by an agent through the state API carries no commit. It counts for the head when it names the head commit, or when it has no commit and was recorded at or after the head's `ci_run`.

## The merge guard (M3.3, D-218)

Every move on which the runner merges a PR (In QA review to Verifying on staging, on every track) carries the same checks: `qa_verdict_independent_on_head`, `docs_updated_or_none`, `ci_green_on_head`, `no_merge_conflict_on_head`, `qa_rounds_below_cap`, `privileged_paths_approved` and `prod_env_protected` (on the design track too, D-224). `test/contracts-consistency.test.ts` holds both files to this set.

`no_merge_conflict_on_head` reads the newest `merge_check` on the head commit. The runner records it itself, right before it merges (`src/core/merge.ts`): it reads the PR's `mergeable` from GitHub for the head GitHub reports, and records nothing when that head is not the node's head. The guard passes only on `true`. `false` (a conflict), `null` (GitHub has not worked it out yet) and a check for any other commit fail. A base branch that moves after the check is caught by GitHub, which refuses a merge it cannot make, and by the fresh check on the next attempt.

`qa_rounds_below_cap` passes while `qa_round < qa_round_cap`. The merge counts no round, so nothing is added to the count, unlike `not_third_failed_round` on the fail move, which runs before its own round is counted.

## The merge commit

`staging_check_on_merge_commit` and `staging_check_failed` read the most recent `merge_commit` evidence. Its `commitSha` is the merge commit on main, and the staging check must name that commit. The head commit does not count.

## Staging verification (M3.4)

The runner records what the staging guards read itself (`src/core/staging.ts`, essential 6). No agent writes a staging kind.

- `staging_deploy`: GitHub reports a deployment of exactly the merge commit to the `staging` environment whose latest status is `success` (O-34). The runner reads it from GitHub's deployments of that commit, so a deploy of the head or of any other commit on main records nothing. It is a fact, recorded in dry run too, under the key `github:staging_deploy:<repo>:deployment-<id>`. The check runs only once one exists.
- `staging_check`: the runner's own smoke check of staging (ADR 0107), run in live mode only. It counts only when staging reports it serves the merge commit, and is recorded once per merge commit under the key `runner:staging_check:<repo>@<sha>` (O-35).
- `staging_no_result`: a check that could not reach staging, ran out of time, or found staging serving another commit. Keyed `runner:staging_no_result:<repo>@<sha>:<state since>:<attempt>`. The first is re-dispatched on the next call; the second sends the item to the Council (O-36).

A passed check takes the move to Done, which resets `failure` and `qa_round` in the same transaction, then asks for the release of every item the Done item blocks (trigger `done:<node id>`; `blockers_done` and `design_spec_merged` decide). A failed check takes the fallback move back to In development or Building components, which adds one to `failure` in the same transaction, then asks for the escalation, which `escalation_trigger_met` allows once `failure` reaches `failure_threshold` (O-37). Both moves have the trigger `staging_check:<evidence id>`, so a repeated call writes one row and counts once.

## Evidence payloads

| Kind                                                  | Payload                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci_run`                                              | `{conclusion: "success" \| "failure" \| "pending", pr: positive integer, changedPaths?: string[]}`                                           |
| `preview_check`, `staging_check`, `visual_comparison` | `{pass: boolean}`                                                                                                                            |
| `merge_check`                                         | `{pr: positive integer, mergeable: true \| false \| null}`: GitHub's mergeable state for `commitSha`, the head (written by the runner, M3.3) |
| `merge_commit`                                        | `{pr: positive integer}`                                                                                                                     |
| `staging_deploy`                                      | `{environment: "staging", deploymentId: positive integer}`: GitHub's successful deployment of `commitSha`, the merge commit (runner, M3.4)   |
| `staging_no_result`                                   | `{reason: "unreachable" \| "timed_out" \| "another_commit", attempt: positive integer}` on the merge commit (runner, M3.4)                   |
| `dispatch_record`                                     | `{repo: "owner/name", branch: string}`: where the node's PR must come from (written by the runner at dispatch, M3.2; ADR 0113)               |
| `docs_note`                                           | `{impact: "updated" \| "none", note?: string}`                                                                                               |
| `qa_verdict`                                          | `{verdict: "pass" \| "fail", findings: [{path, startLine, endLine, note}], evidenceIds: string[]}` (as `src/api/routes.ts` stores it)        |
| `spec_paths`                                          | `{paths: non-empty string[], components: string[], commits: non-empty [{sha, author}], newFeatures: string[], newFlows: string[]}`           |
| `test_report`                                         | `{suite: string, pass: boolean, galleryComponents?: string[]}`                                                                               |
| `agent_report`                                        | `{summary?: string, escalate?: boolean, reason?: string}`                                                                                    |

The runner's merge writes `merge_commit` under the same ingest key as GitHub ingestion, with `recordedBy` `runner`, so the merge is recorded once whichever writes first. `merge_check` rows have `recordedBy` `runner` and a `ref` of `github:merge_check:<repo>#<pr>:<sha>`; there is one per attempt and the newest counts.

`ci_run` and `merge_commit` rows written by GitHub ingestion have `recordedBy` `github`, no run, and a `ref` equal to their ingest key (`github:ci_run:<repo>#<pr>:<sha>:pending`; a final result adds its CI attempt, `github:ci_run:<repo>#<pr>:<sha>:<conclusion>:check-run-<id>` with the highest counted check run id, so every rerun is a new row; `github:merge_commit:<repo>#<pr>`). Ingestion always fills `changedPaths`.

## Topic keys and decision conventions

- Visual approval topic: `visual-approval:<nodeId>`. Escalation topic: `escalation:<nodeId>`.
- A node's decisions are the ones recorded on it plus the ones linked through `node_decisions`. Only `active` decisions count.
- `plan_attached`: an active `product_direction`, and an active `council_decision` with `scope.kind` `plan_accepted`.
- `privileged_paths_approved`: an active `approval` by `didi` with `scope {kind: "privileged_path", commitSha: <head>}`. A new commit needs a fresh approval. The merge opens a `privileged_path` gate request owned by `didi` on the topic `privileged-path:<nodeId>`, with payload `{commitSha, repo, pr, paths}`, and the approval page's answer copies `kind` and `commitSha` from it into the decision's scope (`src/core/approvals.ts`). A request for a newer head supersedes the older one.
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

| Guard                            | Passes when                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockers_done`                  | every node with a `blocks` edge into this one is Done                                                                                                                                                                                                                                                                   |
| `design_spec_merged`             | a design item has a `merge_commit`; another item's design blockers each have one                                                                                                                                                                                                                                        |
| `no_pending_gate`                | no open gate request names the node                                                                                                                                                                                                                                                                                     |
| `agent_ready_not_on_hold`        | the node is agent-ready and not on hold                                                                                                                                                                                                                                                                                 |
| `plan_attached`                  | see the decision conventions above                                                                                                                                                                                                                                                                                      |
| `ci_green_on_head`               | the head `ci_run` concluded `success`                                                                                                                                                                                                                                                                                   |
| `docs_updated_or_none`           | a `docs_note` for the head says `updated` or `none`                                                                                                                                                                                                                                                                     |
| `qa_verdict_independent_on_head` | CI green and a passing `preview_check` on the head, a passing `qa_verdict` on the head from a QA run whose model differs from every builder run's model (D-158), and for the design track a passing `visual_comparison` on the head                                                                                     |
| `privileged_paths_approved`      | the head `ci_run`'s `changedPaths` touch no privileged path, or Didi approved this head                                                                                                                                                                                                                                 |
| `prod_env_protected`             | `project.prodRequiresApproval` is true                                                                                                                                                                                                                                                                                  |
| `qa_failed_with_findings`        | the latest `qa_verdict` on the head is `fail` with at least one finding                                                                                                                                                                                                                                                 |
| `not_third_failed_round`         | `qa_round + 1 < qa_round_cap`                                                                                                                                                                                                                                                                                           |
| `no_merge_conflict_on_head`      | the newest `merge_check` on the head says `mergeable: true`                                                                                                                                                                                                                                                             |
| `qa_rounds_below_cap`            | `qa_round < qa_round_cap`                                                                                                                                                                                                                                                                                               |
| `staging_check_on_merge_commit`  | the `staging_check` on the latest merge commit passed                                                                                                                                                                                                                                                                   |
| `staging_check_failed`           | the `staging_check` on the latest merge commit failed                                                                                                                                                                                                                                                                   |
| `options_attached`               | screenshot evidence on the node and an open `visual_approval` gate on the visual topic                                                                                                                                                                                                                                  |
| `approval_recorded`              | see the decision conventions above                                                                                                                                                                                                                                                                                      |
| `changes_requested_recorded`     | see the decision conventions above                                                                                                                                                                                                                                                                                      |
| `spec_edited_by_designer_only`   | every commit in the latest `spec_paths` is by `designer_identity`                                                                                                                                                                                                                                                       |
| `scope_matches_plan`             | see the decision conventions above; otherwise fails with "needs Council"                                                                                                                                                                                                                                                |
| `spec_components_exist`          | every component the latest spec lists is in the latest `gallery` `test_report` on the head                                                                                                                                                                                                                              |
| `escalation_trigger_met`         | the failure counter reaches `failure_threshold`, the QA round counter reaches `qa_round_cap`, a run in the current state ended `budget_exceeded`, two `staging_no_result` rows on the latest merge commit in the current state (M3.4), or an `agent_report` in the current state asks to escalate with a written reason |
| `council_decision_recorded`      | see the decision conventions above                                                                                                                                                                                                                                                                                      |
| `didi_question_open`             | an open gate request on the escalation topic owned by `didi`                                                                                                                                                                                                                                                            |
| `didi_answer_recorded`           | see the decision conventions above                                                                                                                                                                                                                                                                                      |

## Not yet checked

- Citation checks for `qa_verdict` (cited files and lines exist at the head commit) need the repository and land with the runner (M3.2). Until then the guard trusts the stored findings shape.
