# 0117. The weekly model test set

- **Status:** decided by Didi on 2026-11-19 (D-427 to D-430). The first slice builds the cases, their loader and their checks. The run, its results table and its daily line are the next slice.
- **Date:** 2026-11-19
- **Related:** D-204, D-206, D-207, D-209, D-249, D-425, D-427, D-428, D-429, D-430, O-152, [ADR 0101](./0101-repo-layout-and-tooling.md), [ADR 0106](./0106-agent-execution-environment.md), [ADR 0107](./0107-agent-dispatch-adapters.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md), [ADR 0114](./0114-model-evaluation-routing-and-tiers.md) section 7, `spikes/visual-model-test/`

## Context

D-204 approved a weekly evaluation set: about 10 past items, replayed on candidate models, open models on DeepInfra Flex only, a hard cap of 10 USD a week held as a setting, and Claude once a month as a baseline inside the cap. ADR 0114 section 7 calls it "an optional evaluation set".

The rehearsal showed why live runs cannot answer which model suits which role:

- Triage split a plan for one small helper into two items, the helper and then its tests (didi-build/rehearsal#9 and #10). Whether another model would have kept it whole can only be seen by giving it the same plan.
- QA passed three tiny helpers (#7, #8 and #9). They were correct, so the passes were right, but a model that passes everything would have done the same. A pass on correct work does not show strictness. Only a defect planted on purpose shows whether QA catches it.
- QA, the Council and Triage moved to DeepSeek V4 Pro on Flex on 2026-11-18 (D-425), and D-209's switch of QA independence to model family waits on a quality check.

Live runs give one answer per item on whatever work comes, so two models never see the same input. A fixed set, given to each model the same way every week and scored the same way, gives that comparison.

## Decision

1. **A separate harness outside the work pipeline (D-427).** Like `spikes/visual-model-test/`, each fixed case goes to each model through the same instructions (the bot files in `contracts/bots/`), the same input builders, the same Messages API frame and loop (`src/agent-images/claude-api/`) and the same answer checks the real runs use, and is scored. It never touches a real repository, never creates a work item and never merges. v1 covers QA's review (`qa:review`), Triage and the Council. The Developer comes later, since judging code needs running it. Rejected: full replays through Foreman on a scratch project.
2. **Twelve cases that mature with Foreman (D-428).** The v1 list is below. Each case is a versioned file that records its source and the date it was added. New cases come from real work: a QA miss found later, Didi or the Council correcting a bot, a new role or task type, the first real project. Each is proposed in a pull request that Didi approves by merging. Once real project work exists, the tiny-helper cases are replaced. A case that every tested model has passed 8 weeks in a row is flagged in the weekly summary as a candidate to replace with a harder one.
3. **The models (D-429).** Each week, all on DeepInfra Flex: `deepseek-ai/DeepSeek-V4-Pro-0813` (today's QA, Council and Triage model, D-425), `deepseek-ai/DeepSeek-V4.1-Flash-1017` (a cheap challenger) and `moonshotai/Kimi-K2.6` (another family, D-209's example). Once a month, Claude as the baseline: Claude Opus 5.5 for the QA cases, Claude Sonnet 5.5 for the Triage and Council cases. Estimated cost: about 0.30 USD a week on DeepInfra, about 2 USD a month on Claude.
4. **Results (D-430).** A results table in Foreman's database (one migration, in the next slice) and a short line in the daily check: which model got which cases right, what it cost, and what changed since last week.

### The v1 cases

| Id                            | Role    | Source                                                           | A correct answer                                                                                         |
| ----------------------------- | ------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `qa-format-duration-pass`     | QA      | didi-build/rehearsal#7 as merged                                 | pass                                                                                                     |
| `qa-slugify-pass`             | QA      | #8 as merged                                                     | pass                                                                                                     |
| `qa-truncate-pass`            | QA      | #9 as merged                                                     | pass                                                                                                     |
| `qa-truncate-off-by-one`      | QA      | planted on #9: the result is one character too long, tests bent  | fail, with a finding on `src/truncate.ts` or `test/truncate.test.ts`                                     |
| `qa-slugify-skipped-test`     | QA      | planted on #8: one test switched off with `it.skip`              | fail, with a finding on `test/slugify.test.ts`                                                           |
| `qa-format-duration-fake-key` | QA      | planted on #7: a fake API key written into the helper            | fail, with a finding on `src/format-duration.ts`                                                         |
| `qa-truncate-readme-change`   | QA      | planted on #9: an unrelated section added to `README.md`         | fail, with a finding on `README.md`                                                                      |
| `triage-truncate-plan`        | Triage  | Didi's truncate plan                                             | exactly 1 item, covering `src/truncate.ts` and `test/truncate.test.ts`                                   |
| `triage-slugify-plan`         | Triage  | Didi's slugify plan                                              | exactly 1 item, covering `src/slugify.ts` and `test/slugify.test.ts`                                     |
| `triage-helper-then-page`     | Triage  | written: a helper, then one page that uses it                    | exactly 2 items, the page item (`gallery/App.tsx`) blocked by the helper item                            |
| `council-answer-in-plan`      | Council | written: a Developer's question the item already answers         | `resolve`, with `changesProductDirection` and `passesGate` false                                         |
| `council-product-decision`    | Council | written: two rules in the item that only Didi can choose between | goes to Didi, with `outcome: cannot_resolve` or `changesProductDirection: true` (not `passesGate` alone) |

Why each expectation is the right one:

- **The off-by-one accepts either file.** The defect is the slice in `src/truncate.ts`. The tests were changed to expect the longer result, which QA's instructions name as a weakened test, a blocking defect of its own. A finding on either file names a real problem the pull request introduced, and the fix is the same. The skipped test accepts only the test file, since the code is right.
- **The fake key says it is fake.** Its value contains `not-a-real-key`, the form this repository's tests use for made-up keys, so secretlint passes it here and the rehearsal's CI would stay green. A model may call it harmless. The verdict must still fail: QA's instructions fail any secret in code, and the constant is also a change beyond the item.
- **The product decision case is a contradiction.** A question that only asks whether to add something can be answered correctly by declining it, which keeps the plan, and the Council may decide that itself. So the case gives the Council an item whose two display rules cannot both hold for some titles: every way forward changes what readers see compared with the approved item, and scope and user flows are Didi's. The runner sends an item to Didi when the answer is `cannot_resolve` or either flag is true (`council_decision_recorded`). The case accepts the first two reasons only: `passesGate` alone also reaches Didi, but names a gate this question does not touch.

## How it works

### Where the cases and the code live

- **The cases are data in `eval/cases/`**, one folder per case: `case.yaml` and, for QA and Triage, `tree/`, the small repository the run works on. They sit at the root like `contracts/`, outside every folder the TypeScript compiler, Vitest and the build read (`tsconfig.json` and `vitest.config.ts` include `src/`, `test/`, `spikes/` and a few named files, never `eval/`). That matters because the trees hold TypeScript: under `src/` or `test/` a fixture's own tests would run inside Foreman's suite, and its files would be compiled as Foreman code. ESLint, Prettier and secretlint still read the trees, which keeps every fixture file valid, formatted code, as a real pull request's would be.
- **The code is in `src/eval/`**: plain TypeScript with unit tests next to it (ADR 0101). It reads files and YAML, so it cannot be in `src/core/`, which has no file access. It is not a spike: it runs every week from the next slice on. It is not in `flows/`: D-427 keeps it outside the work pipeline.

### A case

`case.yaml` holds the id (also the folder's name), a version, the role and its one task type (`qa:review`, `triage` or `council`), a title, the date added, the source, the input, the expected answer with the reason it is right, and an example of a correct answer. The source is `real` (merged work or a submitted plan), `planted` (a real case with a planted defect) or `written` (written for the set), with a reference and a note on anything shortened or made up.

The loader (`src/eval/cases.ts`) refuses a malformed case with an error that names the case file and the field. It checks exact fields, the role's task type, ids, commits and paths in their forms, and that every file a case names is in its tree. Provenance is checked too:

- A file from merged work is listed with its git blob id at the source commit, and the file in the tree must hash to it, so it is the merged file byte for byte.
- A planted case names the case it is built from and its exact edits. Its tree must be the base's tree with those edits applied and nothing else, and its changed files the base's plus the edited ones.
- No tree holds the case file. QA's tools read only the tree, so the expected answer can never reach the model.

Trees are kept small: the helper, its test, `README.md`, and `package.json` cut to its scripts and the two packages the code needs. Triage's trees hold the code files at the commit the plan was split at, and the gallery files for the page case.

### Inputs, built by the runner's own builders

`src/eval/inputs.ts` builds each case's task file as the runner builds a real run's, and checks it with the runner's own task file check (`taskFileJson`). The instructions come from the role's bot file. Nothing in the harness writes an instruction or a rule of its own.

- **QA:** `taskInput` (`src/core/task-input.ts`) over the work item, the repository, the pull request and the head commit, as `flows/lib/start-run.ts` calls it, and the evidence ids the run may cite. QA's read-only tools (`src/agent-images/claude-api/files.ts`) read the case's tree. QA's answer schema is the verdict contract the image holds.
- **Triage:** the repo map built from the case's tree at the case's commit by the repo map adapter (`buildRepoMap`, `readCheckout`), checked as the runner checks a map (`checkRepoMap`), then `triageInput` (`src/core/triage.ts`) with the plan, and the bot file's answer schema.
- **The Council:** `escalationInput` (`src/core/council-input.ts`) over the escalation as the runner gathers it, and the bot file's escalation schema. A builder's stop carries exactly the two reasons the runner records: its own reason on the escalation move and the escalation guard's detail with the bot's words. A test checks both against the runner.

QA's input has no diff and no list of changed files, because today's builder gives a real QA run neither. ADR 0112 says the runner builds a default context with the diff and the changed files, but `taskInput` does not yet. Each case records its changed files for the checks. If the runner's builder gains them, the harness gains them through the same builder.

### The run (next slice)

For each model and case, the harness sends one run through the Messages API loop (`runLoop`) with the image's frame: `systemText` around the bot file's instructions and `fencedInput` around the input, with QA's head commit and evidence ids as the image adds them. QA gets its three read-only tools over the case's tree. On DeepInfra, which has no structured outputs, the answer comes through the answer tool and the run's id goes as `prompt_cache_key` (O-152). Claude answers through structured outputs. Turn, minute and dollar limits come from the role's bot file. Each case runs once per model per week. A repeated run per case, to measure consistency as the vision model test does, can come later if one run proves too noisy.

### Scoring

`src/eval/scoring.ts` scores the run's final text. An answer the runner's own check for its role refuses is `unusable`, whatever it says. A usable answer is `correct` when it meets the case's expectation and `wrong` otherwise. No model judges an answer.

- **QA:** `parseVerdict` with the case's evidence ids, as the image checks a verdict. Then ADR 0112's citation rule, which the runner is to apply when it records a verdict but does not yet: every finding names a file at the head commit and lines inside it. A pass case wants `pass`. A fail case wants `fail` with at least one finding on a file the case accepts.
- **Triage:** `checkTriageAnswer` against the case's repo map, as the runner checks an answer before it creates anything. Then the items: as many as expected, each expected item matched to its own answer item that covers all its paths (a path or a folder that holds it), each blocked by exactly the items the case names, and needsDidi and hold as expected.
- **The Council:** the escalation schema and `readEscalationAnswer`, as the runner reads an answer. Then where the item goes, by the runner's rule: it stays with the Council only for `resolve` with both flags false. A test checks the harness's rule against the `council_decision_recorded` guard on every combination. A case routed to Didi also names the reasons that count.

### Cost and the weekly cap

Each response is priced from the model catalog entry of the route, at the tier the response reports, or at Standard when it reports none (ADR 0114 section 8), as the loop already prices a run. A model the catalog does not price is refused (ADR 0114 hard rule 2). The cap of 10 USD a week is a setting. Before each run, the harness adds up the costs recorded this week. It stops when they have reached the cap, and otherwise gives the run a dollar limit of the smaller of the bot file's limit and what is left. The loop stops before a request once a run's cost reaches its limit, so a week can pass the cap by at most one request. Claude's monthly baseline counts toward the same cap.

### Results and the daily line

Each run writes one row to the results table: the week, the case id and version, the model, its provider and served tier, the outcome and its detail, the cost, tokens, turns and time. The daily check gets one short line after each weekly run: per model, how many cases were correct, what the week cost, and which cases changed outcome since last week. A case every tested model has passed 8 weeks in a row, at the same version, is named there as a candidate to replace.

## What it does not do

- It never touches a real repository, never creates a work item, never writes a `runs` row and never merges. ADR 0114 section 7 had the set's results in the scorecard under a `:eval` task type suffix. D-430 puts them in their own table instead, so the set never feeds the scorecard or a routing proposal by itself. Results inform Didi; a routing change stays a migration Didi approves.
- No Developer cases in v1, and so no runtime comparison yet (D-206 expected the set to compare runtimes; QA, Triage and the Council have one runtime). No visual cases: `qa:visual` and `council:visual` have their own model test (D-249).
- No model judges another model's answer. Every score comes from the runner's checks and a fixed rule per role.
- No real personal data and no real secret in any case.

## How the set matures

A case changes only by a pull request Didi merges. Editing a case's input, tree or expectation raises its version, so results are compared only within one version. A new case records where it came from: the item and the run that missed, or the decision that corrected a bot. Once the first real project has merged work, its items replace the tiny-helper cases, one pull request each. The 8-week flag in the daily line proposes which case to replace next; Didi decides.

## Constraints

- Spending stays inside D-204's cap of 10 USD a week, enforced before each run, Claude's baseline included.
- Open models run on DeepInfra Flex only (D-204, D-207).
- Agents never hold a model key (ADR 0106 section 5). The weekly run reaches the providers through an egress proxy that adds the key, as agent runs do.
- No case holds a real secret or personal data. A planted key is fake, says so, and passes the secret scanners.
- The harness never carries its own copy of a rule: instructions, schemas and checks are the runner's, read where the runner reads them.

## How success is judged

- `npm run check` loads every case, builds every case's input with the runner's builders, and shows that each case's example answer passes the runner's check and scores correct, and that wrong answers score wrong. (This slice.)
- Each week the daily check names, per model, the cases it got right and the week's cost, and the week stays under the cap.
- Within a month the set shows a difference between models that live runs did not: a QA model that passes a planted defect, or a Triage model that splits a one-helper plan.

## Consequences

- A model change for QA, Triage or the Council can point to the set's results, not only to live runs.
- Changing a bot file's instructions or a runner check changes the set's runs with it, since the set reads both from where the runner does. A change that makes a model worse shows in the next weekly line.
- The cases need care: each new role or task type, and each real miss, adds a case through review.
- `eval/` is a new folder at the repository root. The README's layout table does not list it yet.

## What the next slice builds

1. One migration: the results table, the weekly cap setting, and catalog entries for `deepseek-ai/DeepSeek-V4.1-Flash-1017` and `moonshotai/Kimi-K2.6`, which the catalog does not have yet (only DeepSeek V4 Pro, from migration 0026), with prices read on the day from DeepInfra's model list (docs/costs.md section 4 has them as last read).
2. The run: for each model and case, the image's frame and `runLoop`, QA's tools over the tree, the answer tool on DeepInfra, scoring, and one results row. The QA facts the image adds after the fenced input (the head commit and the evidence ids) are built inside its QA run today; the next slice exports them from the image so the harness does not copy them.
3. The daily check's line, and the 8-week flag.
4. Where the weekly run executes and how it is started, for Didi's review (see the open points), then a dry run with a fake model, as the vision model test has, before the first real week.

## Open points

- **Where the weekly run executes.** A Windmill flow may import only `flows/lib/`, `src/core/` and `src/adapters/` (ADR 0101, build plan M3.1), so a flow cannot call `src/eval/` as it stands. Either a flow starts a Job whose image is built from `src/eval/`, behind an egress proxy that adds the key, or the flow boundary widens. The next slice proposes one.
- **QA's missing diff.** QA's real input has no diff and no changed-file list, unlike ADR 0112's default context. In a fixture of three files that costs QA nothing; in a real repository it may be part of why tiny helpers pass without a strict reading. It is a question about the runner's QA input, outside this set.
- **Recorded texts.** The work items of the QA cases are written for the set from the pull requests and the plans, since the items Triage made are in Foreman's database and were not read. The truncate plan was given with its middle part left out, and the case uses it that way. A later version of those cases should use the texts exactly as Foreman recorded them.
- **One run per case.** Whether one run per model and case is steady enough to compare models week to week, or each case needs three runs as the vision model test uses.
