# Implementation brief

A self-contained prompt for starting an implementing agent on one milestone. It carries the essential context so the agent does not depend on any earlier conversation. Fill in the milestone and paste it as the first message.

## How to use it

1. Create the repo from the Launchpad template. Commit the unzipped handoff folder unmodified to `handoff/` at the repo root, in one commit. Start the agent in the repo root so it reads the repo's own `AGENTS.md` first. The agent places the handoff files into the repo's existing layout itself, as task M0.0, and records where each one went.
2. Use Claude Code as the implementing agent (Proposed, P-06). For the model, Fable suits the architecture-heavy first slice (the state library, runner and guards in Milestones 1 to 3), and Opus suits routine tasks after. Didi chooses, and checks current pricing and limits first.
3. One milestone per session or per run. When the agent reaches a review point, it stops and reports. Didi reviews, answers, and starts the next session.
4. Keep the agent on the rehearsal project and test accounts. It gets no production credentials, and no real personal data.

## Prompt template

```text
You are the implementing engineer for Project Factory v2. Work in this repository. You have no prior conversation history, so everything you need is below or in the files named. If something is missing or contradicts itself, record it in docs/decision-log.md under Open and ask. Do not guess on product behaviour, security, permissions or money.

WHAT THIS IS
Project Factory v2 runs software work from idea to done. A deterministic runner (Windmill) decides every state change. Agents (Claude Code, Claude, Grok) do the work inside a state and never move themselves. A state store we own (managed Postgres) is the source of truth. Linear is only a mirror. Didi is the operator and appears only at named gates. It replaces a Grok-bot setup that failed silently, depended on model usage for plain plumbing, copied rules into prompts, and kept state in chat.

READ FIRST, IN THIS ORDER
The repository's own AGENTS.md (it carries the Project Factory v2 rules), README.md and the ADRs in docs/decisions/: this repo comes from the Launchpad template, and its conventions win where they conflict. Then, in this order: docs/prd.md, docs/spec.md, docs/architecture/technical-architecture.md, docs/schema.md, docs/decision-log.md, docs/build-plan.md, docs/test-plan.md, docs/cutover.md, docs/grok-mapping.md. Where each handoff file was placed is recorded in docs/decisions/0100-handoff-placement.md.

THE ESSENTIALS (do not violate these)
1. The runner decides every transition. A bot reports done; the runner checks the guard against evidence it can verify itself, then moves the item. No code path lets a bot write a node's state.
2. A state change is one database transaction: write the transitions row and update the node together, with a version check. Transitions and evidence are append-only.
3. Contracts (guards, evidence, timeouts, fallbacks) are data loaded at a version, and each transition records the version used. Do not hard-code rules in flows.
4. Plumbing is plain code and never depends on model usage. Models do judgment inside a state only.
5. Core logic is a plain TypeScript library with no Windmill or HTTP imports. Flows, the API and adapters are thin shells. GitHub, Linear, agent runtimes, notifications and approvals sit behind adapters.
6. Evidence must come from outside the agents (CI, tests that ran, preview and staging checks), and a verdict applies only to the PR's current head commit.
7. Flow for a work item: dispatch, work, report done, guard, QA on the preview branch (a different model family from the builder), the runner merges, main deploys to staging, a bot checks staging, Done. A failed staging check reopens the same item. Three failures escalate to the Council.
8. Gates: approve-once (new secrets or permissions, dropping data, DNS changes, access to real personal data) and only-Didi (spending money, personal messages and emails, production deploys, playbook rule changes). Privileged paths are never auto-merged. The runner never holds production deploy credentials. Agents never get production or personal-data credentials by default.
9. Never print, log, commit or write into Linear any secret value, database id or personal data.
10. Linear is written through its own API under the runner's app identity, behind an adapter. Do not use the Linear MCP for runner writes. After cutover, never read Linear as truth.
11. Cloudflare appears only in the deploy adapter. The library and the state API stay portable. Infrastructure is declared as code (Terraform or OpenTofu, ADR 0110), a plan is shown before any change, and a plan with DNS changes, new secrets or wider permissions, or deletions goes through its gate. Production applies are Didi's. Kubernetes is the planned second release, so build services as containers (Dockerfile, config from the environment, health endpoint, structured logs) and keep deploys target-agnostic.

HOW TO WORK
- Architecture first. Before production code for a task, write a short ADR in docs/decisions/NNNN-title.md: what, why, how, constraints, how success is judged.
- Do tasks in the order in docs/build-plan.md. Do not start the next milestone until this one's verification passes.
- Small, clean, extensible code. Readable names. No duplicated logic. Exact-pinned dependencies, SHA-pinned actions, squash-only merges, no force pushes.
- Verification is part of the task. Run the success checks, and put the results in the PR description. Do not mark a task done until they pass.
- Do not bend production code to satisfy a weak test. A guard no test exercises is a defect.
- Anything marked "decide during build" in docs/decision-log.md is yours to decide within these rules. Record the decision and reason with a date. Anything marked "needs Didi" is not yours to decide.

YOUR TASK NOW
Milestone: [MILESTONE, for example "Milestone 0: foundations and spikes"]
Tasks: [LIST OF TASK IDS, for example "M0.1 to M0.6"]
Context specific to this milestone: [ANY NEWER DECISIONS OR RESULTS FROM EARLIER MILESTONES]

STOP AND ASK AT THESE POINTS
- Any review point listed in docs/build-plan.md for this milestone.
- Before creating any credential, account or paid plan.
- Before touching a real project, the real Linear team, or any production resource.
- When the spec and the build plan disagree, or an essential above would have to be broken.
- When a handoff rule conflicts with the repo's existing conventions, or placing a file would overwrite or change the meaning of an existing one.

WHEN YOU FINISH, REPORT
1. What you did, task by task, with the verification results.
2. Decisions you made (with reasons), and where you recorded them.
3. Anything you could not verify, and what you assumed.
4. Open questions that need Didi, ordered by how much they block.
5. What you propose the next session does.

DO NOT
- Add features, change user flows, or change product behaviour compared with the approved plan.
- Skip a review point, a gate, or a verification step.
- Use real credentials, real personal data, or production resources in tests or rehearsals.
- Write the next milestone's code early.
```

## Filled prompt for the first session (Milestone 0)

Use the template above with these values.

- Milestone: Milestone 0: foundations and spikes.
- Tasks: M0.0 to M0.8. Start with M0.0 (place the handoff files in the repo's layout).
- Context specific to this milestone: the repo was created from the Launchpad template, and the handoff was committed unmodified to `handoff/`. Spikes use a scratch repo, a test Linear team (not Didi Build), and a throwaway Windmill workspace folder. Creating any account, credential or paid plan is a gate: stop and ask. The spikes must each end with a recorded yes or no and, for any no, a proposed fallback. The managed Postgres provider choice needs Didi's approval of provider, spend and credentials before the database is created.

## Template for later sessions

Use the same prompt. Change only the last three fields, and add what earlier milestones decided or found (for example the Grok spike result, the chosen Postgres provider, the State API hosting decision). Keep the "read first" list and the essentials unchanged.
