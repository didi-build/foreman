# 0119. Personas and tasks

- **Status:** proposed. Didi decided the model, the structure, the four first personas, the task-to-persona map, context, web lookups, Quality's browser and the Council's version 1 in the design interview of 2026-11-23 for roadmap sitting 5 (D-454 to D-464). Slice 1, the persona files and their check, came with this record, and Didi approved the persona wording by merging it (PR 206). Slice 2 composes the personas into each run's instructions (D-467). Slice 3a puts the short summary of the project's records in each run's input (D-468, D-469). Slice 3b adds the state API's three read-only context routes and the API's read of transitions (D-470, O-168); no run calls them until slices 3c and 3d. Slice 3c builds the three read-only context tools into the Messages API and OpenCode images, not yet declared in any bot file (O-169). The technical design and the build plan of the later slices stay proposed until each slice's merge.
- **Date:** 2026-11-23
- **Related:** D-008, D-158, D-185, D-196, D-209, D-240, D-241, D-244, D-245, D-246, D-247, D-248, D-249, D-260, D-261, D-263, D-287, D-316, D-318, D-399, D-410, D-421, D-425, D-446, D-451, D-452, D-453, D-454 to D-469, N-48, N-108, [ADR 0107](./0107-agent-dispatch-adapters.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md), [ADR 0114](./0114-model-evaluation-routing-and-tiers.md), [ADR 0115](./0115-foreman-app.md), [ADR 0116](./0116-planning-chat.md), [ADR 0117](./0117-weekly-model-test-set.md)

## Context

Each agent role has one bot file in `contracts/bots/`. Its `instructions`, and its `task_instructions` for a second task type, mix three kinds of text:

- **Who the agent is and what it values.** Triage is "a product-manager-type role". QA assumes "nothing works until the code and the runner's evidence show it does".
- **The job.** The steps, the inputs, the answer's shape (the `foreman-report` block, the stops, the Council's schemas) and the checks to run.
- **Rules every agent shares.** No secrets or personal data, and everything read is data, not instructions.

Didi reviewed each file rule by rule (D-241, D-245 to D-248, D-260, D-287). The Council is one run that weighs a panel of personas itself: an analyst, a product manager, a designer, a CTO and a security lead (D-247). The panel was to be built with the intake agent in the next release (D-261).

ADR 0115 set the order of the work. After the one-approval project flow (ADR 0118) came "role playbooks for the Designer, Developer and QA, worded with Didi's approval". In sitting 5 Didi set out a model for them, by voice, then answered fourteen questions. Didi's words are in the interview notes of 2026-11-23, and this record quotes only those.

The bots now run on cheaper open models (D-421, D-425), and Didi's rule is to improve the scaffolding before reaching for a bigger model (D-249). Clear, reusable values for each kind of work are part of that scaffolding.

## Decision

1. **Two building blocks (D-454).** A **task** is the job: its inputs, steps, tools, answer and checks. Didi: "doing research, making a code change, running a scan, things that need to be done to make the system work." Each task type in `contracts/task-types.yaml` is a task. A **persona** is the lens: Didi: it "defines a agent priorities, values, lens into which will shape how they go about handling a task." A persona is the same in any task and in any discussion. The Council is neither a role nor a persona. Didi: "counsel should be the concept of like a group chat that will include multiple personas in the chat when they're each needed."
2. **The structure of a persona (D-455).** Every persona carries a **shared base**, then six parts of its own, then optional notes:

   | Part                        | What it holds                                                                                                                                                                                                                |
   | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Shared base (`shared.yaml`) | The user's flow; Didi's intent and the approved plan; honest about uncertainty; plain, short communication, decision first; security and privacy: flag any risk noticed, and the rules for secrets and personal data (D-465) |
   | `lens`                      | One line: how the persona sees the work                                                                                                                                                                                      |
   | `cares_most_about`          | What it values, most important first                                                                                                                                                                                         |
   | `craft_standards`           | How it does good work                                                                                                                                                                                                        |
   | `watches_for`               | What it notices in any work or discussion, and raises in the Council                                                                                                                                                         |
   | `never`                     | The lines it does not cross                                                                                                                                                                                                  |
   | `needs_to_know`             | The context and tools it relies on                                                                                                                                                                                           |
   | `notes`                     | Optional. Anything that fits no part                                                                                                                                                                                         |

   Didi asked for a reference structure first, which the interviews would refine: "start with the structure as like a reference point, but by the end after interviewing me for each different persona ... you will see a more cleaner structure that they will all fit." This is that structure.

3. **Four personas first (D-456).** Product, the Developer, the Designer and Quality. Next, "soon after ... and maybe other things that we encounter as we go forward": Security and Privacy, and Cost. Later, a Platform engineer with an infrastructure lens (how the infrastructure works today, clean infrastructure, its best practices, horizontal and vertical scaling), which then takes `developer:infra`.
4. **What each persona says (D-457).** Each part holds Didi's own points first, then the research additions Didi accepted for that persona (Q4 to Q7, all "A"), written as instructions to the model in `contracts/personas/`. Points that cross personas are written into both: the Developer builds the error, empty, loading and offline states as the Designer designs them. Every persona cares about the user's flow (Didi: "they all care about the flow. They all do."), so it is in the shared base.
5. **One persona per task (D-458).** Only the Council mixes personas.

   | Task type                           | Persona                                                                                  |
   | ----------------------------------- | ---------------------------------------------------------------------------------------- |
   | `triage`                            | Product. Didi: "someone who behaves in a project manager type lens"                      |
   | `developer:code`, `developer:infra` | The Developer. `developer:infra` moves to the Platform engineer once that persona exists |
   | `designer`                          | The Designer, who also carries the Developer's code standards for the code it writes     |
   | `qa:review`                         | Quality. It reviews UI-only changes too, as today                                        |
   | `qa:visual`                         | Quality, with the Designer's craft standards                                             |
   | `council`, `council:visual`         | The Council discussion (point 9)                                                         |
   | `developer:close`, `designer:close` | None. No model runs (D-318)                                                              |
   | Later: the planning chat            | Led by Product (ADR 0116)                                                                |
   | Later: research                     | The persona of the question                                                              |

   The Designer builds components and screens in code, unwired, and the Developer wires them. Didi's reason, from working with Grok and MagicPath: "a lot that gets lost in translation between the design and the spec and then the final creation".

6. **Context: a short summary, then tools (D-459).** Each run's input starts with a short summary of the context its persona needs. For the details the run gets read-only tools: search the decision log, find similar items, and read an item's history. Didi, on Product's context: "or alternatively, it intelligently is able to call tools ... MCP tools available for it that will check these things for them, and they'll know that they should use it."
7. **Web lookups on trusted documentation sites (D-460).** A read-only lookup tool reaches trusted documentation sites only, through the run's egress proxy. An agent that finds a useful site off the list asks Didi to approve it, and an approved site joins the list. Didi: "the list can grow dynamically, if an agent finds a documentation thats not in the approved list, they can send me a request to approve".
8. **A real browser for Quality (D-461).** Quality's run image gets a real browser, so Quality can exercise the flows and find visual bugs, as Didi asked of Quality.
9. **The Council as a discussion, version 1 (D-462 to D-464).**
   - **Product chairs every discussion (D-462).** Each persona the question needs gives its view once. Product then decides and gives its reasons. Didi's calls still go to Didi (D-008). Until the Security and Privacy persona exists, so does any question with a security or privacy risk (D-465). Didi weighed consensus too: "C, they must agree, would obviously be the best in terms of fidelity ... for like small changes, that would be like overkill. For something big and important, like a big feature or something that will truly shake up the code base, I think that fidelity might be worth the time and the cost ... version 1, it could just be A, but over time we will fine tune this."
   - **A fixed base cast, plus pull-ins (D-463).** Each question kind (`src/core/council.ts`) starts with a fixed cast. Any participant, not only the chair, may pull in another persona when it finds a reason. Didi: "a base that is predictable, but they can call in as they see fit".

     | Question kind  | When it is asked                                                                                    | Base cast, with Product as chair                                  |
     | -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
     | `escalation`   | A builder stopped for a decision, or an item escalated by its failure count or QA round cap (D-466) | The builder's persona (the Developer or the Designer) and Quality |
     | `reversal`     | A past decision is reconsidered                                                                     | The persona that owns the decision's topic                        |
     | `plan`         | The Council plans a Scanner idea, or an idea from a bot's finding (D-316)                           | The Developer, and the Designer when the work touches the UI      |
     | `still_needed` | Is a work item still needed?                                                                        | The Developer                                                     |
     | `visual_call`  | The Council's call on a visual approval (D-263)                                                     | The Designer and Quality                                          |
     | `scanner_gone` | The Scanner no longer finds an idea's problem                                                       | The Developer, as for `still_needed` (D-466)                      |

   - **At most two extra personas, every pull-in traced (D-464).** A question may pull in at most two personas beyond its base cast, each with its reason. A question that needs more goes to Didi. Every pull-in is recorded: who was pulled in, by whom, and why, so the weekly persona review can spot the same pull-in repeating. Didi: "this should also be traceable because during the scans & self improvement, if we have the same repeated pull ins, we should probably fix something".

## How it works, in short

Proposed. The build plan below delivers it in six slices, the third in four parts.

- **The persona files (slice 1).** `contracts/personas/shared.yaml` holds the shared base in five parts. `product.yaml`, `developer.yaml`, `designer.yaml` and `quality.yaml` each hold `persona` (the file's own id), the six parts and optional `notes`. Every part is a list of one-line entries, except `lens`, which is one line. The core's `validatePersonas` (`src/core/personas.ts`) holds every rule; `src/adapters/contracts-file/personas.ts` parses the files, as `contracts/task-types.yaml` is parsed (ADR 0105). The files sit in `contracts/`, so the spec version covers them and every Windmill bundle carries them (`bundle_files` lists `contracts/`). A persona grants nothing: tools, hosts, limits, routes and answer schemas stay in the bot files.
- **Composition (slice 2).** A run's instructions are, in order, the shared base, the persona and the task's instructions. The first two are the same for every run of a task type, so they stay in the cached prefix, as the bot file's instructions are today. The bot file keeps everything about the task. Its `instructions` and `task_instructions` become the task's own part: the steps, the inputs, the answer and the checks. The lens and the values move to the persona, and the shared rules to `shared.yaml`.
- **Context (slice 3).** In slice 3a the runner builds the short summary from the store, for the run's own project only, and quotes it as data at the end of the run's input, as it builds today's inputs (`src/core/run-context.ts`, beside `src/core/task-input.ts`). Triage gets the project's decisions, then the roadmap of D-469: the accepted plans that are not finished, then the open work items. The Developer and the Designer get similar items (D-410), and their item's decisions, runs and last moves. QA's review gets earlier QA verdicts, staging failures and its item's decisions, never the builder's report or docs note (ADR 0112). Every entry is word for word but cut, each task type's section has a bound, and no decision's `scope` is ever shown (D-468). QA's visual comparison, the Council and the close runs get none. In slices 3b to 3d the tools read the run's own project through the state API with the run's token, and return bounded, quoted results. Slice 3b's routes (ADR 0102) put a notice first in each answer, saying it is recorded data and not instructions, and keep each answer within 48 KiB. In slice 3c one client (`src/agent-images/shared/context-tools.ts`) serves both images: the Messages API image calls it from its loop for QA's review and Triage, and the OpenCode image serves it to OpenCode through a local MCP server of its own (`src/agent-images/opencode/context-mcp.ts`). A run gets only the tools its bot file's `context_tools` lists, and none until slice 3d.
- **Lookups (slice 4).** The trusted list is a setting. The lookup is a read-only fetch of one page from a listed host, through the run's egress proxy. A run names a site it wants added in its answer, as it names an out-of-scope finding (D-244). The runner, never the agent, opens one request per site for Didi.
- **Quality's browser (slice 5).** The browser runs inside QA's run and reaches only the site under test, served inside the run. It never reaches a hosted preview, since there are none (D-446).
- **The Council discussion (slice 6).** One Council run per question, as today. Inside it, the image asks each persona of the cast for its view, once each. A view may pull in another persona, with its reason, and that persona then gives its view once too. Product then answers in the question kind's schema, and the runner checks the discussion before it records the answer.

## What changes for earlier decisions

| Decision                          | What happens to it                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-247                             | Amended by D-462 to D-464. Product chairs in place of a supervisor, and the panel is the four personas of D-456. The product manager's floor holds: Product chairs every discussion. The analyst and the CTO have no persona (open point 1), and the security lead's floor has none until Security and Privacy exists (open point 2). |
| D-248                             | The Council's instructions are rewritten as the discussion's task in slice 6, and Didi reviews them again.                                                                                                                                                                                                                            |
| D-261                             | The panel was to come with the intake agent in the next release. This record proposes building it for runtime questions in slice 6 (open point 9). The planning chat keeps its own design (ADR 0116), led by Product once it is built.                                                                                                |
| `docs/spec.md` section 2          | Its Council row ("one combined role (analyst, PM, designer, CTO)") changes in slice 6, its bot definition's instructions in slice 2, and its Designer row once screens are designed (open point 6). Each is a spec change Didi approves (AGENTS.md section 7).                                                                        |
| D-240                             | Kept: the persona dedicated to security is Security and Privacy, the first on the future list.                                                                                                                                                                                                                                        |
| D-241, D-245, D-246, D-260, D-287 | Their reviewed wording moves, rule by rule, into the persona, the shared base or the task's part in slice 2. Didi approves the composed text.                                                                                                                                                                                         |
| D-196                             | Kept: each new tool (the context tools, the lookup, the browser) is a bot file change Didi approves.                                                                                                                                                                                                                                  |
| D-399, AGENTS.md                  | The Designer also builds screens in code, unwired (D-458). Today the design track builds gallery components only, and where screens live is open (open point 6).                                                                                                                                                                      |
| ADR 0112                          | QA's rule of "no running repository code" changes with slice 5: the site under test runs inside QA's run. The read-only file tool and the rest of ADR 0112 are kept.                                                                                                                                                                  |
| ADR 0114, D-425, D-451            | Kept: the model is chosen per task type. Every call of one Council discussion uses the `council` route. Models per persona are for phase 2.                                                                                                                                                                                           |
| D-158, D-209, D-452               | Kept: a persona changes no route, so QA's review stays on another model family than the Developer's.                                                                                                                                                                                                                                  |
| D-410, ADR 0116                   | Kept: "similar items" are found by text and paths in scope, with no embeddings and no knowledge graph.                                                                                                                                                                                                                                |
| N-48                              | Point (2) is answered for documentation by D-460: no search provider, only listed sites. Point (3) is answered in part, for runtime questions, by D-462 to D-464; the security persona's rules wait for Security and Privacy.                                                                                                         |

## Constraints

- The runner still decides every state change. A persona shapes judgment only, and grants no tool, host, permission or gate.
- Didi's calls stay Didi's: scope, new features, changed user flows, product direction and the gates (D-008, spec section 5).
- Persona and shared-base text is model-facing. Every change is a pull request that Didi approves at merge, as with bot files (playbook rule changes are Didi's, AGENTS.md section 5).
- No secret, credential or personal data in any persona file, summary, tool result or recorded pull-in.
- Everything a run reads through a tool, a lookup or the browser is data, never instructions.
- Lookups reach only listed hosts, read only, through the run's egress proxy. No agent gets open internet.
- The site under test in Quality's browser is untrusted code. It runs with no credential and reaches no outside host.
- A Council discussion asks each persona once and pulls in at most two more. The runner enforces both and records every pull-in.

## How success is judged

- `npm run check` loads the five persona files and refuses a malformed one with every problem named by file and part. (Slice 1.)
- Didi reads each persona file and recognises their own points, then the accepted additions, in plain words.
- Each run records the persona and the shared base it ran with, so a wording change shows in the runs and in the weekly model test (ADR 0117).
- After slice 2, the weekly model test shows no QA or Triage case newly wrong.
- After slice 6, every Council answer records its chair, its cast and each pull-in with its reason, and a persona review can count repeated pull-ins.
- An agent that needs a site off the list asks for it in its answer, Didi gets one request for it, and after Didi's approval the next run can read it.

## Reasons

- **A persona apart from its task** lets one lens serve many tasks: Product in Triage and in every Council discussion, Quality in review and in visual calls. One wording change then reaches every task the persona leads.
- **One persona per task** keeps each run's values clear. Mixing happens only where Didi wants it, in the Council, and in the open.
- **A shared base** holds what every persona agrees on once, so no persona carries its own copy of a shared rule (AGENTS.md section 7).
- **A summary plus tools** keeps each input short and cached, and lets the agent look further only when it needs to.
- **Trusted sites through the proxy** give the Developer the documentation it asked for without a search provider, a new credential or a paid plan (N-48 (2)).
- **A fixed cast** makes each discussion predictable and its cost bounded. Pull-ins with reasons cover what the cast missed, and their record shows when the cast should change.

## Consequences

- Each bot file's instructions shrink to the task's own part. The lens and the shared rules live in one place.
- A persona change reaches every task it leads at once. The weekly model test is how Didi sees whether it helped.
- The Council costs more per question, and its answers show who took part and why.
- The Designer's work grows from components to screens, which needs its own design-track change.
- QA's run image grows with a browser, and QA's runs get longer.
- Adding a persona is a new file and an entry in `PERSONAS` (`src/core/personas.ts`), so the task map and the Council's cast can name it.

## Costs

- **Slices 1 and 2:** no new service, credential or setting. Each run's instructions gain the shared base and one persona, about 1,000 tokens (estimate), in the cached prefix. The persona-like lines that leave the bot files offset part of it.
- **Slice 3:** the summary (3a) adds at most its bound to each run's input: 12,000 characters for Triage, about 3,000 tokens (estimate), and 4,000 to 6,000 characters for the others. It sits in the input, after the cached instructions, so it is not cached. Tool calls (3b to 3d) add turns inside each run's limits (D-185).
- **Slice 4:** no search provider, so no new credential or plan. Pages come from listed sites only.
- **Slice 5:** a larger QA image and longer QA runs. Measured when built.
- **Slice 6:** today a Council question is one model conversation. In version 1 it is one call per persona in the cast, then Product's decision:

  | Question kind  | Calls, with no pull-in               |
  | -------------- | ------------------------------------ |
  | `still_needed` | 2                                    |
  | `scanner_gone` | 2                                    |
  | `reversal`     | 2, or 1 when Product owns the topic  |
  | `plan`         | 2, or 3 when the work touches the UI |
  | `escalation`   | 3                                    |
  | `visual_call`  | 3                                    |

  Two pull-ins add two calls, so a question makes at most five. Each call carries the question's input again, mostly read from the cache. The Council runs on DeepSeek V4 Pro at Flex (D-425: 1.04 USD input and 2.08 output per million tokens). Every question stays inside the Council's per-run limit of 3 USD (D-185). Windmill's executions do not change: still one run per question (D-453).

## What comes later: "Personas and Council, phase 2" (N-108)

A later sitting, with Didi:

- **Fidelity by importance.** Consensus (Didi's option C) for big questions, such as a big feature or a change that will shake up the code base. Product's decision with reasons for small ones.
- **Models per persona or task.** Today the model is chosen per task type (ADR 0114): Triage light, while the chair's weighing may need a heavier model. Whether the model belongs to the persona, the task or the pair is a later optimization.
- **Self-improving personas.** A weekly persona review, like the weekly model test, that learns from mistakes and proposes wording changes as pull requests for Didi. Didi: "each of the personas to learn from their mistakes ... once a week, like the same way we do the model scans ... persona scans ... a PR to update and change them." Repeated pull-ins (D-464) are one of its inputs.
- **A decision model for the chair.** Didi: "the task is to make a decision". How Product weighs the views, designed properly later.
- **The future personas** of D-456: Security and Privacy, Cost, and the Platform engineer.

## Open points

1. **The analyst and the CTO.** D-247's panel has them, and the interview did not name them. This record reads the four personas as replacing that panel. Didi confirms.
2. **The owner of a reversal's topic.** How the runner finds the persona that owns a decision's topic. Proposed: from the kind of the reversed decision, with Product when no other persona fits.
3. **Screens.** Where the Designer's screens live in a project, how the gallery shows them, and how they are checked. Until this is decided, the Designer builds components only, as today.
4. **The roadmap Product needs.** Decided (D-469): Foreman keeps no roadmap of its own. Product's roadmap is the accepted plans that are not finished, then the open work items in order, with each item's state and whether a run is on it, built from the store. Rejected: a roadmap file Didi keeps in each project.
5. **The trusted list.** Its first entries (proposed in slice 4's pull request for Didi's approval), which runs get the lookup first (the Developer, whose notes ask for it), and whether a site request is a new gate kind or the approve-once kind for wider permissions.
6. **When the Council discussion is built.** D-261 put the panel in the next release, with the intake agent. This record proposes slice 6 for runtime questions sooner. Didi decides the timing.
7. **How a discussion runs.** Proposed: one run, with each persona seeing the views before it, as in a group chat. The alternative is one run per persona, which adds a Windmill run and a Job for each call.
8. **A question that needs a third pull-in.** Proposed: it goes to Didi through each kind's existing way (`cannot_resolve`, `cannot_decide`, `needsDidi: yes` or `needs_didi`).
9. **Quality's browser.** Decided (D-461): the site under test runs inside QA's own sandboxed run, with no credential and no outside host, driven only through a browser tool, still with no shell and no editing. Open: what it tests against (proposed: the site CI built, served inside the run, as CI's `preview-check` serves it), whether Quality reads the page as text or as screenshots (screenshots need a model that reads images, D-249's vision test), which image holds the browser, and QA's new limits.

Decided after the first draft, on 2026-11-23: the security floor until Security and Privacy exists (D-465), and the casts for `scanner_gone` and for escalations that are not a builder's stop (D-466). On 2026-11-24: runs read their project's decisions of all five kinds, word for word but cut, and never a decision's `scope` (D-468), and the roadmap (D-469).

## Build plan

Each slice is one pull request, in this order. No slice needs a new credential or a paid plan.

1. **The persona files and their check** (`foreman`). Comes with this record.
   - Delivers: `contracts/personas/shared.yaml`, `product.yaml`, `developer.yaml`, `designer.yaml` and `quality.yaml`; `src/core/personas.ts` (`validatePersonas`, `PERSONAS`, the parts); `src/adapters/contracts-file/personas.ts` (`loadPersonaFiles`, `readPersonas`); `src/core/personas.test.ts` (unit) and `test/contracts-personas.test.ts` (repo guard). No run reads the files.
   - Privileged paths: none.
   - Didi after: approves the wording of the five files, part by part, and merges.
2. **Runs compose the shared base, the persona and the task** (`foreman`).
   - Delivers: the task-to-persona map of D-458 (proposed: a `task_personas` field in each bot file beside `task_types`, checked against its allowed task types); one composition function used by `flows/lib/tasks.ts`, the Kubernetes task builder (`src/adapters/agent-runtime/kubernetes/build-task.ts`) and the weekly model test's inputs (`src/eval/inputs.ts`), so the test measures the text that runs get; each bot file's `instructions` and `task_instructions` rewritten as the task's part; the Developer's craft standards added for `designer`, and the Designer's for `qa:visual`; the run's `bot_version` covering the bot file, the persona and the shared base (proposed: one hash of the three, no migration); the composed text checked against the bot files' 32,000-character limit; `contracts/personas/` copied into the weekly test's image (`src/agent-images/eval/Dockerfile`); `docs/bot-files.md`, and the bot definition in `docs/spec.md` section 2, a spec change. `council` and `council:visual` keep today's instructions until slice 6, since Product chairing is the discussion itself.
   - Privileged paths: none expected.
   - Didi after: approves the composed text of each task type rule by rule, as in D-241 and D-245 to D-248, and merges. The next weekly model test shows its effect on QA and Triage.
3. **Read-only context tools** (`foreman`), in four pull requests:
   - **3a. The short summary in each run's input.** Delivers: `src/core/run-context.ts` (`rankSimilarItems`, `gatherRunContext`, `contextSection`); the store's `listProjectDecisions`, on the runner's existing grant, with no migration; the section at the end of the Developer's, the Designer's, QA's review and Triage's inputs, gathered in `flows/lib/start-run.ts` and in Triage's own task; the weekly model test's cases end with "No records yet.", since their format holds no project records yet (a known gap for a later slice); the data map's state store item (D-468). Privileged paths: `docs/privacy/data-map.yml`. Didi after: approves the data map change and merges.
   - **3b. Three read-only state API routes** for the run's own project: search the decisions, find similar items by text and paths in scope (with 3a's ranking), and read an item's history. Privileged paths: a migration that lets the state API's role, `factory_api`, read transitions, own project only, which Didi decided to grant (D-470). Didi after: reviews the wider read for run tokens (each reads only its own project), approves the migration's apply, and merges. **Built** (O-168): `src/core/context-reads.ts` (`createContextReads`, `readDecisionSearch`, `readSimilarSearch`, `CONTEXT_DATA_NOTICE`, `CONTEXT_LIMITS`); `GET /context/decisions?q=`, `GET /context/similar-items?q=&path=` and `GET /context/items/:id/history` for run tokens of Triage, QA, the Developer and the Designer (the Council 403 until slice 6), each answer `{notice, data, truncated}` and at most 48 KiB; the query string passed to the routes (`RouteContext.query`); `db/migrations/0032_api_reads_transitions.sql`; ADR 0102's route table. No store method, no proxy change and no public route.
   - **3c. The tools in the images:** the Messages API image, beside QA's file tools, and the OpenCode image. Built (O-169). Delivers: `src/agent-images/shared/context-tools.ts` (`CONTEXT_TOOLS`, `createContextTools`: one GET per call with the run's token, results framed as `<context_result>` data, cut at 16 KiB, secrets removed, fixed error texts, at most 30 calls, a log of tool, status and size only); QA's review gets the tools after its file tools and Triage gets them alone, the answer tool last, and their frames name the listed tools, with every frame unchanged when none is listed; `src/agent-images/opencode/context-mcp.ts`, a stdio MCP server with no dependency, as the local server `foreman` in OpenCode's config with `foreman_<tool>` allowed after `"*": "deny"`, the token only in OpenCode's environment, checked with the real OpenCode 1.19.5; the task file's `contextTools` and the bot files' optional `context_tools`, both strictly checked and declared by no bot file; the weekly model test's runs list a bot file's declared tools and call them against a state API with no records. Privileged paths: none. Didi after: reviews the new tools and merges.
   - **3d. The bot files declare the tools** (D-196), once 3b and 3c are deployed. Didi after: approves each tool in the bot files and merges.
4. **The trusted documentation lookup and its approval request** (`foreman`).
   - Delivers: the trusted list as a setting; the lookup through the run's egress proxy (GET only, listed hosts only, a bounded response framed as data); the site-request field in each answer (proposed: at most 3 a run, each a host and why, like `outOfScopeFindings`); one approve-once request per host, opened by the runner; Didi's Approve adds that one host.
   - Privileged paths: `db/migrations/00NN_*.sql` (the setting, and the gate kind if a new one is chosen).
   - Didi after: approves the first list and the tool (D-196), merges, and approves the migration's apply. From then on, answers each site request.
5. **Quality's browser** (`foreman`).
   - Delivers: a real browser in QA's run image (Chromium driven by `playwright-core` at the version `package.json` pins, as the screenshots workflow uses it); tools to open a page, act on it and read it; the site under test served inside the run, with no outside host; QA's bot file and limits; ADR 0112 amended.
   - Privileged paths: none if the browser goes into the Messages API image. An image of its own adds it to `.github/scripts/build-images.sh`.
   - Didi after: reviews the new tools (D-196), the image's size and QA's new limits, and merges.
6. **The Council as a discussion** (`foreman`).
   - Delivers: the base cast of D-463 as data (proposed: in the Council's bot file, by question kind); the discussion in one Council run (each persona of the cast once, pull-ins with reasons, at most two, then Product's answer in the kind's schema); the runner's check of the discussion (Product chairs, the cast is the kind's, each persona speaks once, each pull-in has a reason and a known persona) before it records the answer; the chair, the cast and each pull-in (who, by whom, why) in the Council decision's `scope`; the weekly model test's Council cases run through the same discussion; the Council's instructions rewritten as the discussion's task; the Council's row in `docs/spec.md` section 2, a spec change.
   - Privileged paths: none expected. A decision's `scope` is JSON, so no migration.
   - Didi after: approves the Council's new instructions and the cast table, and merges.

Why this order:

- **Composition before the tools.** The persona files name what each persona needs. Until a tool exists, the shared base tells the agent to say what is missing rather than guess. Composing first also lets the weekly model test show the wording change on its own, before any tool changes the runs.
- **The tools in any order.** Slices 3, 4 and 5 do not depend on each other and can be built while another is in review.
- **The Council last.** It needs the composed personas (slice 2), and its chair is better with the decision log and the roadmap at hand (slice 3).
- **The Council's text changes once.** Slice 2 leaves `council` and `council:visual` as they are, since Product as chair only makes sense in the discussion. Their instructions change in slice 6.

Later, each its own design or decision: screens on the design track (open point 6), the planning chat led by Product (ADR 0116), a research task led by the question's persona, the future personas, and phase 2 (N-108).
