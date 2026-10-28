# Project Factory v2

Project Factory v2 is a deterministic system that runs software work from idea to done. A runner (Windmill) owns every state change. Agents do the work inside a state and never move themselves. A state store we own (managed Postgres) is the source of truth. Linear is a mirror that humans read.

This folder is the handoff package. It is written so that an implementing agent can start work without any of the chat history that produced it.

Status: draft, decisions as of 2026-10-28. Owner and operator: Didi.

## Read in this order

1. `AGENTS.md`: the rules every agent and contributor follows in this repo. Read it first.
2. `docs/prd.md`: what we are building, for whom, why, and how we will know it works.
3. `docs/spec.md`: the state machines, roles, gates, contracts, Linear mapping and schema shape. This is the rule book.
4. `docs/architecture.md`: how the system is built: components, runner design, integrations, security, failure handling.
5. `docs/schema.md`: the proposed column-level design of the state store.
6. `docs/decisions.md`: every decision with its date, plus what is still open and who decides it.
7. `docs/build-plan.md`: milestones and execution-ready tasks, in order, with verification for each.
8. `docs/test-plan.md`: what is tested at which seam, and how.
9. `docs/cutover.md`: how work moves from the Grok routines to the runner, in one cutover.
10. `docs/grok-mapping.md`: what every Grok routine, rule and gate becomes in v2.
11. `docs/implementation-brief.md`: a self-contained prompt to start an implementing agent on a milestone.

## How to use this with an implementing agent

- Start the agent in the repo root so it reads `AGENTS.md`.
- Give it the prompt in `docs/implementation-brief.md`, with the milestone filled in.
- The agent works one milestone at a time. It writes a short design note (ADR) before code, and it stops at the review points listed in `docs/build-plan.md`.
- Anything marked "decide during build" in `docs/decisions.md` is the agent's to decide, and it records the decision there. Anything marked "needs Didi" is not.

## Where the files live

This README and the documents refer to `docs/...` paths. Before task M0.0 they sit under `handoff/` at the repo root. M0.0 moves them to where the repo's own layout (from the Launchpad template) expects them, merges `AGENTS.md` and `README.md` into the repo's existing ones, and updates every reference.

## Source of truth

- Until this folder is committed to the Project Factory v2 repo, the working draft of the spec is a Google Doc, and `docs/spec.md` and `docs/grok-mapping.md` are exports of it taken on 2026-10-28.
- After the first commit, the files in this repo are the source of truth. Spec changes follow the process in `AGENTS.md`.

## Names used in these docs

- Operator: Didi, the one human who submits ideas and approves gates.
- Council, Triage, Designer, Developer, QA, Runner, Scanner: the roles in `docs/spec.md`, section 2.
- Machine 1 is the idea machine. Machine 2 is the work item machine. Machine 3 is the later daily scan.
- Cutover: the single switch from the Grok routines to the runner.
