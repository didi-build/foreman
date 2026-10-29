# Product requirements: Project Factory v2

Status: draft, 2026-10-28. Owner: Didi (operator).

## 1. Summary

Project Factory v2 runs software work from idea to done with very little human attention. Didi submits ideas and answers product questions. A small set of bots does the thinking and the building. A deterministic runner decides every state change and checks proof before work moves on. Didi appears only at named gates.

v2 replaces a setup built on Grok bots and routines. That setup works, but it fails silently, depends on model usage for plain plumbing, copies rules into prompts, and keeps state in chat history. v2 keeps the good rules from it and moves them into code and a database we own.

## 2. The problem

Findings from the Grok setup (details in `docs/grok-mapping.md`):

- Event triggers fail silently. One watcher has not fired since Oct 22, an auto-breakdown routine never ran, and PR watches miss CI passes.
- Plain plumbing runs on model usage. When usage ran out on Oct 26 and 27, reviews died mid-run, sweeps failed, and nothing retried.
- Rules are copied into prompts and drift: old status names, hard-coded project ids, notes about statuses that no longer exist.
- State lives in chat and journals: deploy dedup, which agent owns which PR, hundreds of journal entries. Approvals reach QA only as text relayed by another bot.
- One bot (the CTO) is a bottleneck for triage, breakdown, cleanup, sign-offs, relays and deploy watching.
- Bots act under Didi's own account, so a bot comment and a Didi comment look the same without a text prefix.
- One status ("ready for maintainer") is used two different ways, and held tickets are handled inconsistently.
- The worst failure is silence: a request waiting on Didi with no visible entry.

## 3. Who it is for

- Didi, the operator. He works in short bursts, often late at night, mostly from his phone. He decides product behaviour, money, permissions, DNS and production deploys himself, and delegates the rest. He prefers verbatim, timestamped records and one question at a time.
- The bots and agents, which need clear contracts, a single source of truth, and proof requirements.
- Later: other people who may use a project's output. Not users of this system in v1.

Scale: 6 to 10 projects running at once, one operator.

## 4. Goals

1. No silent stalls. Every open item is running, blocked with a named reason, or done.
2. The runner, not a model, owns every transition. Plumbing never depends on model usage.
3. Proof before progress. Work leaves QA only with evidence from outside the agents (CI results, tests that ran, checks on preview and staging).
4. Didi's attention goes only to gates, and a blocked gate is never invisible.
5. Everything is auditable: who or what did what, when, under which spec version, with which evidence. Bots have their own identities.
6. Portable and observable: the rules are plain files and the state is in a database we own, so any bot runtime, any board and any frontend can be swapped.
7. Dogfooding: the first project through the system is the system itself.

## 5. Non-goals for v1

- A custom frontend. v1 uses Windmill approval pages, a push app and a mirror in Linear. The system builds the frontend later.
- The Scanner (Machine 3, the daily code scan).
- The Recruiter flows (job search). They stay their own flow on the same runner and are not part of this build.
- Generating Windmill flows from the spec automatically.
- A graph database or a temporal knowledge graph.
- Replacing Linear. It stays as a mirror until our own frontend covers the daily check, the attention list and gate approvals from the phone.
- Kubernetes. It is the planned second release. The first release uses infrastructure as code and is built so the switch is easy.

## 6. Principles

The principles in `docs/spec.md`, section 1, apply. In short: Didi is the operator, the runner decides every transition, every state has one owner role, humans appear only at gates, nothing sits idle, continue by default, and the rules live in the spec, not in any tool.

## 7. Scope

### In scope for the first release (cutover)

- The state store and its library and API (nodes, edges, transitions, evidence, decisions, gate requests, runs, counters, settings).
- Machine 2 (work items) end to end: the code, infrastructure and docs tracks and the design track, with all contracts in `docs/spec.md`.
- The reconcile loop (every 5 minutes; every 2 hours until Kubernetes exists, D-164) with stall detection.
- Evidence ingestion from GitHub and CI, preview and staging checks, and merging by the runner.
- Gates and the attention list: gate requests with topic keys, Windmill approval pages, push alerts, incident calls, and the daily check.
- The Linear mirror through Linear's API with the runner's own app identity, including the status changes in `docs/spec.md`.
- Bot assignments and the dispatch adapters for Claude Code (Developer), Claude (Council, Triage, Designer) and Grok (QA, subject to verification).
- Dry run, kill switch, and a single cutover from the Grok routines.
- A minimum of Machine 1 so that work can enter the system (see the build plan; this scope is proposed and needs confirmation).

### Later

- Second release: the Kubernetes platform (a pod per project, per-project isolation, monitoring, and eventually moving off Cloudflare). It runs as its own project through the factory.
- The full intake agent for Machine 1, with the interview as a chat with the Council.
- The viewer (read-only state machine with a live item overlay) and the frontend.
- The Scanner.
- Cursor agents, if given a role.

## 8. Operator workflows

1. Submit an idea. The Council sizes it, interviews Didi one question at a time (depth scales to the size of the idea), records his answers verbatim, and confirms a read-back summary. Then it plans, Triage splits the plan into work items, and the items run in Machine 2.
2. Approve a gate from the phone. A push alert carries a link to a Windmill approval page. Didi answers with a button or typed words. The answer is saved verbatim with a scope. A newer request on the same topic replaces an older one.
3. Review the daily check. A short summary grouped by project, ordered by what blocks the most work: what moved, what is blocked, staging links to try, questions waiting, and token and money spend. In v1 it includes the production deploy approval (approved on GitHub from the phone).
4. Be away. Nothing special happens. The Council decides everything not restricted, gates queue up, nothing auto-approves, and unanswered gates show again in the next daily check.
5. Urgent incident. A phone call for a failed production health check, data loss or PII exposure flagged by a bot, or daily spend over a set amount (starts at $25 per day, configurable).

## 9. Functional requirements

Each requirement is detailed in `docs/spec.md` and `docs/architecture/technical-architecture.md`.

| ID    | Requirement                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | The state store holds every idea, work item, edge, transition, evidence record, decision, gate request, run and counter. It is the source of truth.                                                                                                                                               |
| FR-2  | Only the runner changes a node's state. A change is one transaction that writes the transition and updates the node, and fails on a version mismatch.                                                                                                                                             |
| FR-3  | Transitions follow the contracts in the spec (trigger, guard, evidence, timeout, fallback). Contracts are data, loaded at a version, and each transition records the version used.                                                                                                                |
| FR-4  | A reconcile loop runs every 5 minutes (every 2 hours until Kubernetes exists, D-164). It releases blocked items whose blockers are done, dispatches items that are ready but not running, flags stalls, and cleans stale gate requests. Webhooks make it faster but are never the only trigger.   |
| FR-5  | Evidence is recorded as immutable rows that name the commit they cover. A verdict applies to one commit, and a new commit makes it stale.                                                                                                                                                         |
| FR-6  | QA checks the preview branch on a model from a different family than the builder (waived while QA runs on Claude, D-158). On pass the runner merges. After the merge, main deploys to staging and a bot checks staging. Only then is the item Done. A failed staging check reopens the same item. |
| FR-7  | Merging is a runner action gated in code: CI green on the head commit, no conflicts, not past the round cap, the privileged-path list satisfied, and the production environment protected where deploys run on push to main.                                                                      |
| FR-8  | Approvals and answers are verbatim records with a time and a scope. A reversed approval marks dependent work stale, and the Council decides what to redo.                                                                                                                                         |
| FR-9  | Gate requests carry a topic key. Only one request per topic key is open. They appear on the attention list and on Windmill approval pages, with push alerts for blocking gates.                                                                                                                   |
| FR-10 | An item that fails 3 times, loops, or runs over budget stops and goes to the Council. If the Council cannot resolve it, it goes to Didi.                                                                                                                                                          |
| FR-11 | Each run records model, turns, minutes, cost and outcome. Token and money spend alerts at a threshold and work continues. A looping item stops. Usage exhaustion queues and resumes work instead of killing runs.                                                                                 |
| FR-12 | The daily check is generated from the state store, grouped by project and ordered by what blocks the most work.                                                                                                                                                                                   |
| FR-13 | Linear is a mirror written through Linear's API under the runner's own app identity, behind an adapter. Status mapping is in the spec.                                                                                                                                                            |
| FR-14 | Every bot and agent has its own identity, and every action is attributable.                                                                                                                                                                                                                       |
| FR-15 | A kill switch pauses the runner. A dry run computes what the runner would do without acting.                                                                                                                                                                                                      |
| FR-16 | A minimum of Machine 1: ideas can be created, decisions recorded verbatim, and plans split into work items by Triage.                                                                                                                                                                             |
| FR-17 | Infrastructure is declared as code. An infrastructure change shows its plan, and a plan with DNS changes, new secrets or wider permissions, or deletions goes through its gate before the runner applies it.                                                                                      |

## 10. Non-functional requirements

- Reliability: no single missed event can leave an item idle. Plumbing keeps running when model usage is exhausted.
- Safety: gates are enforced by the system, not by instructions to a model. Agents never hold production or personal-data credentials by default.
- Auditability: transitions and evidence are append-only. Any state can be explained from the log.
- Portability: contracts are plain files, bots are plain files, and integrations sit behind adapters.
- Cost control: generous per-run budgets at first, tuned from run data after a week. Spend alerts, no daily cap.
- Operability: one place (the state store) answers "what is running, what is blocked, why".

## 11. Success criteria for the first release

The release is successful when all of these hold. Each one has a check in `docs/test-plan.md` and `docs/cutover.md`.

1. The dry run against the imported Linear state produces planned actions that match what a person would expect, with every difference explained.
2. After cutover, every Machine 2 transition is taken by the runner, and the Grok routines that moved tickets are disabled.
3. A full item passes through each track in a rehearsal project: from Ready, through development or design, QA on the preview branch, merge by the runner, staging check, Done. A deliberate failure at each fail path reopens the item and increments the counter, and the third failure reaches the Council.
4. A missed webhook is caught by the next reconcile loop.
5. With model usage exhausted, the runner still releases, dispatches (queues) and records state, and nothing is killed mid-transition.
6. Didi can approve a gate and the production deploy from his phone, and the answer is recorded verbatim.
7. A privileged-path PR is never merged without his approval, and a repo whose deploy runs on push to main is never merged unless its production environment requires approval.
8. Linear mirrors the store within one reconcile cycle, and a mismatch is reported, not silently overwritten.
9. The kill switch stops all transitions within one cycle and the system restarts cleanly.

## 12. Risks and mitigations

| Risk                                                                         | Mitigation                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| All-at-once cutover is a big switch                                          | Dry run, a go/no-go checklist, disable (not delete) the Grok routines, and a kill switch                                                 |
| Grok or Cursor cannot be started and read by the runner                      | Verify early (milestone 0 spike). If Grok cannot be driven, QA moves to another non-Claude agent. The bot file makes the model a setting |
| Linear's API cannot create statuses or let an app act under its own identity | Verify early. The one-time status setup can be done by hand, and the audit trail lives in the state store regardless                     |
| The Council (Opus) or another model becomes unavailable                      | The model is a setting per bot. Plumbing does not depend on any model                                                                    |
| Counting failures too eagerly escalates healthy work                         | The counter increments only when a transition guard fails after a bot reports done, not on every red CI run                              |
| Self-modifying system risk (the system builds itself)                        | Didi's gates stay fully on during bootstrap, production deploys stay with him, and the kill switch exists                                |
| Spec and contracts drift apart                                               | Contracts are data, and a consistency test compares them with the spec                                                                   |

## 13. Assumptions and dependencies

- Windmill Cloud is the runner. A managed Postgres is the state store. GitHub is the code host. Linear is the mirror. Infrastructure is declared as code (Terraform or OpenTofu). Cloudflare Workers hosts staging first, and Cloudflare appears only in the deploy adapter. Kubernetes is the planned second release.
- Launchpad (the repo template) will carry the standard component gallery path and a default privileged-path list.
- Project Factory v1 already creates a repo from the template, creates a Linear project, and provisions Cloudflare Workers. Its tools are the seed of the toolbox.
- To verify: the runner can start Grok and read its verdict; Linear's API can create statuses and let an app act under its own identity; Windmill approval pages work well on a phone.

## 14. Glossary

- Bot: a coordinator for one role. It can dispatch agents. It never moves an item itself.
- Agent: a temporary worker scoped to one task in one project.
- Runner: deterministic code (Windmill) that owns all transitions.
- Gate: a point where Didi must act. Listed in `docs/spec.md`, section 5.
- Contract: the declared trigger, guard, evidence, timeout and fallback of a transition, and the purpose, input, output, evidence, tools, budget, side effects and failure of a state.
- Evidence: immutable proof recorded against a node and a commit.
- Topic key: a key on a gate request so a newer request replaces an older one.
- Handed off: the end of Machine 1. The idea is Done as far as that machine goes. Its work items are Machine 2's to finish.
