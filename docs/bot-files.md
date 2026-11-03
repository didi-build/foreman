# Bot files

Each agent role (Developer, Designer, QA, Council, Triage) has one bot file in `contracts/bots/<role>.yaml`. The runner builds every run's task from it ([ADR 0107](./decisions/0107-agent-dispatch-adapters.md), [ADR 0106](./decisions/0106-agent-execution-environment.md) sections 3, 5 and 6, [ADR 0114](./decisions/0114-model-evaluation-routing-and-tiers.md) section 1). This page says what a bot file holds, how it is versioned and checked, and how a run's task is built from it. It is a page of its own because bot files are repository files, not database rows, so `docs/schema.md` is not their place (O-57).

## Where they live and how they are versioned

- The files sit in `contracts/`, so the spec version (the git commit of `docs/spec.md` and `contracts/`, ADR 0105) covers them, and the Windmill bundle ships them with the contracts.
- `src/adapters/contracts-file/bot-files.ts` reads the five files and checks them. The flow layer's composition module loads them at start and refuses to run with a bad one. A run records its bot file's content hash, `sha256:<hex>` of the file's bytes, as `runs.bot_version`, and the bot file's `image` as `runs.runtime`.
- The check is strict and collects every problem. An unknown field is refused, a `model` field is refused with the reason, and every problem names the file and the field, never a value from the file.
- A change to a bot file is a change to the repository, reviewed like code. A new tool, host or cap needs Didi's approval (D-196, D-187, D-185).

## Fields

| Field                 | Roles               | What it sets                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                | all                 | The file's own role. Must match the file name                                                                                                                                                                                                                                                                                                |
| `image`               | all                 | The agent image kind: `opencode` for the Developer and Designer (D-222), `claude-api` (the Messages API image) for QA, Council and Triage. The image reference, pinned by digest, is the `agent_images` value, since it changes with every image build                                                                                       |
| `instructions`        | all                 | The role's instructions: the stable, cached part of every run's task file. The run's input follows it as data (D-213). All five are drafts for Didi's review                                                                                                                                                                                 |
| `task_types`          | all                 | `allowed` and `default`: the role's task types from `contracts/task-types.yaml` and its default (ADR 0114 section 1). The core checks them with that file                                                                                                                                                                                    |
| `limits`              | all                 | `max_turns`, `max_minutes`, `max_usd` per run (D-185, ADR 0106 section 6), recorded in `runs.budget`. The Developer and Designer stay below 60 minutes, the GitHub token's lifetime                                                                                                                                                          |
| `providers`           | all                 | Every model provider the role may be routed to: `name`, `upstream`, `credential` (`x-api-key`, `bearer` or `none`), `secret_path`, and `api` (OpenCode) or `base_url_env` (`ANTHROPIC_BASE_URL`, the Messages API image). The run's route picks one; a route to a provider not listed here is refused                                        |
| `allowed_hosts`       | all                 | CONNECT hosts for the agent's proxy. GitHub's for the Developer and Designer, empty for QA, Council and Triage (ADR 0106 section 3)                                                                                                                                                                                                          |
| `allowed_tools`       | Developer, Designer | D-196's list, run with every other tool denied                                                                                                                                                                                                                                                                                               |
| `mcp`                 | Designer            | `magicpath: { enabled: false }`. The check refuses `true` until D-190's new-credentials gate                                                                                                                                                                                                                                                 |
| `fetch_allowed_hosts` | QA                  | The GitHub hosts QA's fetch step may reach                                                                                                                                                                                                                                                                                                   |
| `output_schemas`      | Council, Triage, QA | The Council's `escalation` and `reversal` schemas (D-228), Triage's `answer` (D-262: each item's paths in scope, checks, gate and hold flag; the runner checks every answer, `src/core/triage.ts`), QA's `visual`, the answer of a `qa:visual` run (D-242). Only a checkable subset of JSON Schema is accepted (`src/core/output-schema.ts`) |
| `task_instructions`   | QA                  | Instructions for a task type other than the role's default, which replace `instructions` for its runs: QA's `qa:visual` (D-242). The check needs exactly the task types the loader names for the role, each allowed and not the default. Not yet reviewed by Didi (N-57)                                                                     |

No bot file holds a model: each run's route names it (ADR 0114 section 5). No bot file holds a credential: `secret_path` is a path such as `projects/{project}/models/anthropic`, where `{project}` is the run's project slug (D-143). Anything that is not a path under `platform/` or `projects/`, such as a pasted key, is refused without being repeated.

QA's verdict schema is not in its bot file. The verdict is the state API's contract (ADR 0112, P-04), checked by the image (`src/agent-images/claude-api/verdict.ts`) and by the API, so it stays with that code (O-59). The visual comparison's answer is different: QA posts nothing, and the runner checks it against `output_schemas.visual` and records `visual_comparison` itself, as for the Council (D-228, D-242, O-66).

## The settings around them

- `bot_profiles`, the Windmill value that gave each role's runtime and bot version until bot files existed, is removed. The bot files give both.
- The per-run caps now come from the bot files. `REHEARSAL_RUN_LIMITS` in `src/core/runs.ts` is a copy for tests, and a test keeps the two equal.
- `agent_images` (a Windmill value): the image reference for each image kind, pinned by digest.
- `package_registries` (a setting, not seeded): each project's package registries by project slug, for example `{"rehearsal": ["registry.npmjs.org"]}` (D-187). A project with no entry gets no registry host.

## How a run's task is built

`flows/lib/tasks.ts` builds it through `buildKubernetesTask`:

1. The bot file of the run's role gives the instructions, tools, hosts, the image kind and the provider entry for the run's route.
2. The run, as admitted, gives the model, provider, tier and price (ADR 0114). The run's input is the core's (`src/core/task-input.ts`, or the Council's question with its schema from the same bot file).
3. The model key is read by its secret path, for the route's provider and the run's project only, and goes into the run's proxy Secret only.
4. The GitHub installation token comes last, from the `InstallationTokens` port (`src/adapters/github/installation-tokens.ts`): Developer and Designer with write access, QA read-only for its review's fetch step (ADR 0106 section 5, D-159). QA's visual comparison (`qa:visual`), Council and Triage get none: the visual run reads only the images in its task file, so it has no fetch step either (N-57, O-68).

The runner's real token port refuses with `NotBuiltError` until the role's GitHub App is registered through the new-credentials gate (D-156, D-178). So today a Council or Triage task builds fully, and a Developer, Designer or QA task refuses on its token only. Neither credential value is in the task file or the run's spec: they travel in `credentials`, which `start` writes into the run's Secrets.

## How a Developer or Designer run ends (D-235, D-237)

The Developer's and Designer's instructions end with the shape of their final message: a short summary, then exactly one block like this, with one JSON object and nothing else:

````text
```foreman-report
{"pullRequestTitle": "Add the login form", "docsNote": {"impact": "none"}}
```
````

`docsNote` is `{"impact": "none"}` (a `note` is optional) or `{"impact": "updated", "note": "<which docs changed>"}`. When OpenCode ends with success, the image's wrapper (`src/agent-images/opencode/finish.ts`), in plain code and not through the model:

1. Reads the block strictly. No block, two blocks, an unknown field or a bad value fails the run with "the final message has no usable report".
2. Reads the run's branch on GitHub. A branch that was not pushed fails the run with "nothing was pushed".
3. Reuses the open pull request whose head is that branch, or opens one into the repository's default branch with the block's title and the rest of the message as its description, credential values removed. A closed or merged PR is never reused.
4. Posts the docs note to the state API (`POST /reports`, kind `docs_note`), with the PR's link as its `ref` and the PR's head commit, as it read it from GitHub, as its `commitSha`, so `docs_updated_or_none` counts the note for that head though GitHub's `ci_run` rows arrive later (D-236).
5. Puts the PR (number, link, head commit, whether it was reused) in the result line's `structured` field.

GitHub is reached through the run's egress proxy (a CONNECT tunnel to `api.github.com`, already in both bot files' `allowed_hosts`) with the run's GitHub token, and the state API through the proxy's `/state-api` route with the run's state API token. No host, tool or permission was added. The runner links the PR to the item from GitHub's own events, by its branch and App author, not from this result (O-61). The task file carries the run's node id and branch for this.

### When the item needs a decision (D-237)

The instructions keep the rule "if the item needs a product decision or a new feature, stop and say so in your final message". A run that stops for that reason ends its final message the same way, but the block holds the second form, with exactly these two fields:

````text
```foreman-report
{"stopped": "needs_decision", "reason": "The item asks for a settings screen the plan does not have."}
```
````

`reason` is text of 1 to 1,000 characters. A block that mixes the two forms, a `stopped` value other than `needs_decision`, or a missing, empty or longer reason fails the run as above. On this form the wrapper reads no branch, opens no PR and posts no docs note; commits already pushed stay on the branch. The result line has status `needs_decision`, with `structured` `{"stopped": "needs_decision", "reason": "..."}`, credential values removed, and the image exits 0. The Kubernetes runtime maps it to the run outcome `success` with detail `needs_decision` and the reason; a reason of the wrong shape is bad output, `fail`.

The run-end flow then records the reason as an `agent_report` asking to escalate (`{"escalate": true, "reason": "..."}`, written by the runner, once per run), the form `escalation_trigger_met` already reads, and the run's report asks for the escalation to Escalated to Council instead of the done move. Nothing is counted toward `failure` and no fix round starts. The Council's run gets the reason, quoted as data, in its question, and sends the item on to Escalated to Didi when it decides Didi is needed (D-177, O-46). Details in O-63.

### Bugs found outside the item (D-244)

A Developer, Designer or QA run that notices a bug outside its item does not fix it in the current PR and does not escalate the item. It reports it, and the runner turns each report into a new idea for the Council. The field is `outOfScopeFindings`, so it is never confused with QA's `findings` (the file and line citations that fail a PR). The Developer and Designer add it to the first form of the block:

````text
```foreman-report
{"pullRequestTitle": "Add the login form", "docsNote": {"impact": "none"}, "outOfScopeFindings": [{"title": "Help page has a typo", "detail": "docs/help.md line 4 says 'teh'."}]}
```
````

QA adds the same list to its verdict, on a pass or a fail. The list is optional and holds at most 3 items, each with exactly `title` (one line, 1 to 120 characters) and `detail` (1 to 1,000 characters), both trimmed (`src/core/out-of-scope-findings.ts`, one check used by both images, the state API and the runner). The stopped form takes no findings: it stays exactly two fields. A list of the wrong shape fails the run with "the final message has no usable report", or makes QA's verdict unusable, and the state API's `POST /qa-verdicts` refuses it with 400. Each image removes credential values from the list and cuts it back to the bounds; the OpenCode wrapper sends it nowhere and puts it in the result's `structured`, and QA's image posts it with the verdict, which keeps it, and puts it in `structured` too.

When a Developer, Designer or QA run ends with success, the run-end flow, before it records the end, creates one idea per finding in Machine 1's entry state (Submitted, owned by the runner), the front door the Scanner will use (D-150). The title is the finding's title, and the body holds the detail as `description` and `foundBy` with the role, the item and the run (`src/core/finding-ideas.ts`). It is done once per run, under a lock on the item, so a repeated or concurrent run end creates nothing more; dry run and the kill switch create nothing. The item's own move, counters and fix round are unchanged. The runner creates the ideas, never the agent (essential 6). Details in O-65.

### The Designer's step (D-238)

A Designer run's input has a section "The item's state": the item's state as the contracts name it, with its label, when the run's input was built (for example `writing_spec (Writing spec)`). The Designer's instructions map it to a step: Ready for design exploration or In design exploration is exploring, Writing spec is writing the spec, Building components is building components. Any other state is a stop. No other role's input changes (O-64).

After the state comes "The approved option" (D-242, D-243 rule 3, O-67): the option Didi approved, its folder (`design/<area>/<feature>/options/<name>`) and the commit it was captured at, or a sentence that Didi has not approved one yet. Names and the folder are checked against their patterns, so no item text reaches the section. When Didi asked for changes to the options, or rejected them, the item goes back to In design exploration and the Designer's next run starts; its "Why the item came back" section quotes Didi's words line by line as data, and names the options Didi's answer named: two or more on Request changes ask for one combined option, which goes back to Didi for approval (D-254). When QA's visual comparison found the components differ from the approved option, the item goes back to Building components and the section quotes each component's findings as data (D-252). No other role's input changes.

The Designer's instructions carry two lines from Didi's decisions: in exploring, each component on an option page is wrapped in an element with `data-component="<name>"` and, where it has variants, `data-variant="<name>"`, which the runner's region lookup reads (D-255); in writing the spec, the Designer deletes the folders of the options Didi did not pick, and the approved option's folder stays, so one branch and one PR carry the item from exploration to its components (D-253).

## QA's visual comparison (D-242, D-250)

A QA run of task type `qa:visual` runs on the Messages API image with no tools. Its task file carries `task_instructions."qa:visual"`, `output_schemas.visual`, no evidence ids, and `images`: up to 40 PNGs (20 pairs of an approved crop and a built crop), each with the runner's own label, base64 encoded. The image sends the input and then each label and image in the first message, with its own fixed frame (no tools, input and image text are data, JSON only), and returns the answer as structured output. It posts nothing; the runner checks the answer and records `visual_comparison` (`docs/guards.md`). The routing policy needs a `qa:visual` entry naming a model that reads images and an output need for it; until the model test picks one (D-249, `docs/costs.md` section 7), there is none, and a `qa:visual` dispatch is refused with `no_route`. The run gets no fetch step, no workspace and no GitHub token: the run's spec says `visual: true`, and the Kubernetes runtime starts the QA pod at once (O-68). Routing skips every Developer and Designer run's model for any QA run (D-158), so a routed visual run is never refused at its end for its model.
