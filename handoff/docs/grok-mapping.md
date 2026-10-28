# Grok rules to v2 spec: mapping (draft v0)

> Exported from the working Google Doc on 2026-10-28. This is the record of what every Grok routine, role, rule and gate becomes in v2. Read it with `docs/cutover.md`.


Draft, Oct 27, 2026. This maps every routine, role, rule and gate from the Grok export (the "grok bot routines" doc) to what happens to it in the v2 spec. Source: the exports from the CTO, Developer, Designer, QA and Recruiter bots (Oct 27, 2026). Journals and shared notes that were cut off in the bots' views are covered where it matters.

**Status key.** Kept: carried over as is. Changed: carried over with a change. Replaced: a new mechanism covers it. Dropped: no longer needed. Open: needs a decision or more information.

## Routines

| Grok routine | Status | In v2 |
|---|---|---|
| Unblock watcher (Linear event when a ticket is Done) | Replaced | The runner releases dependents when an item reaches Done, using our own event trigger. Broken since Oct 22. Keep two guards: a design counterpart is released only when the design PR merged, and its description gets a Spec section (merge commit, file paths on main, final decisions). |
| Unblock sweep (hourly, weekdays only) | Changed | The runner dispatches immediately, so a ready item that is not running is a bug. Keep a reconciliation sweep as a safety net, and run it every day of the week. Today nothing is released from Friday evening to Monday morning. |
| Auto breakdown (Linear event, never fired) | Replaced | The Triage bot splits plans into work items as a state transition. Keep the rules: one PR per child, acceptance criteria, blocked-by links in execution order, a project on every item, exactly one next status, a developer counterpart for every design ticket, and parts that need Didi become their own gate items. Skip personal and non-engineering items. The hard-coded exclusion of DIDI-713 becomes a hold flag on an item. |
| Daily cleanup: maintainer flow | Kept | Becomes the gate model: the waiting item is blocked with a named reason, and a request lands on the attention list. Urgent when it blocks a bot, Low otherwise (the blocking and non-blocking alert tiers). |
| Daily cleanup: triage rule v2 | Kept | Continue by default. Follow-ups of approved work proceed. Only new features, new projects and product-behaviour changes wait for Didi (the scope gate). |
| Daily cleanup: breakdown watchdog (over a day in Ready for CTO breakdown) | Dropped | Covered by nothing sits idle. |
| Daily cleanup: icebox sweep (14 days of no activity) | Open | The idea machine needs a Parked state. Decide the threshold, and keep the pull-back when new activity appears. |
| Daily cleanup: stale tickets (close shipped ones with evidence, ask about others) | Changed | The runner closes items only with evidence. Cancelling or deleting stays with Didi. |
| Daily cleanup: review queue (4 hours with no QA activity, merged PR means Done) | Replaced | Stall detection plus evidence-based Done, read from GitHub. |
| Daily cleanup: blockers, statuses, fleshing out thin tickets | Replaced | Relations and statuses are data in the state store and the runner owns transitions. Fleshing out thin items stays a Triage duty. |
| Daily cleanup: report to Didi, silent when nothing changed | Changed | The daily check always shows what moved, staging links, questions waiting, and spend. |
| Weekly icebox review (propose revive, cancel or merge, then wait for Didi's yes) | Kept | An idea-machine step: the Council proposes, Didi approves. Cadence is open. |
| Production deploy watcher (we-met) | Changed | Becomes a monitor plus toolbox tools. The record of which runs were reported moves from chat history to the state store. Setting secrets from values in a bot's private memory goes through the approve-once credential gate, with values held in a vault. |

## Roles

| Grok role | Status | In v2 |
|---|---|---|
| CTO | Changed | Splits into the Council (planning, breakdown, architecture rulings, sign-offs) and Triage. Keep: never merges unless asked, escalates only product calls and risky or irreversible changes. Decisions are recorded in the state store, mirrored to Linear. |
| Designer | Changed | Keep MagicPath exploration, sole ownership of the spec directory, and building gallery components. Change: Didi approves the visual before the spec is written. The Cursor cloud agents are agents under the bot. |
| Developer | Changed | Keep wiring gallery components and escalating unclear scope. Drop the hard-coded list of project ids that decides what it picks up, because every item carries a project in the state store. Update the old Todo and In Progress wording. |
| QA | Changed | Keep the 3-round cap, merging on green CI, and merging design-only PRs without a second approval. Add outside evidence rules and a different model from the builder. |
| Recruiter | Open | Outside the build flow. It keeps its own rules (job applications run freely, email-only applications become drafts Didi sends). Decide whether it joins the shared bots later. |
| CEO, Assistant | Open | No role is written down for CEO, and Assistant is personal. Out of scope for v2 for now. |

## Rules

| Grok rule | Status | In v2 |
|---|---|---|
| Maintainer flow and priority rule | Kept | See the gate model above. |
| Approval relay (Didi's approval in the CTO chat counts for QA, tied to the exact head commit) | Changed | An approval is a record in the state store with a scope, such as one exact commit, a time, and Didi's words verbatim. Chat is not the source of truth. A new commit that changes user-facing text, secrets or permissions needs a fresh approval. |
| Product direction rules 1 to 4 (locked block with Didi's words verbatim, changes become Urgent gate items, bots relay his exact words) | Kept | The scope check against the approved plan. Rule 3 adds an is/was diff against the locked block, posted before Didi approves a design. Rule 4 has every bot send Didi's exact product calls to the Council, which adds them verbatim to the block. |
| Triage rules (three versions) | Changed | Keep v2. The two earlier versions are superseded. |
| Linear statuses and labels | Replaced | The state machines define states and Linear mirrors them. A mapping table from our states to Linear statuses is still needed. |
| Design handoff and design-as-code | Changed | Keep the spec layout design/area/feature/ with spec.md and mockups, the Spec section on the developer ticket, and QA checking components against the spec. Change: visual approval comes before the spec, and there is no spec approval. |
| Code conventions (AGENTS.md, exact-pinned dependencies, SHA-pinned actions, squash-only merges, a check before done, ADR before code) | Kept | They belong to each repo and Launchpad. The playbook points to them. |
| Security rules (no token reachable by PR-branch code gets D1 or R2 edit, provisioning only from main, D1 ids never printed, secrets never in chat, Linear or repos) | Kept | Become credential rules for the toolbox and the approve-once credential gate. |
| Project factory rulings (factory mints Worker-scoped tokens and logs every mint, factory sets up production environments, new repos public by default) | Kept | Same pattern as approve once, then agents act. |
| Every ticket must have a Linear project | Dropped as a rule | The state store requires a project on every item. |
| Only make DNS changes after Didi approves each one | Kept | DNS changes are now an approve-once gate in the spec (Oct 27, 2026). |

## Gates

| Grok gate | Status | In v2 |
|---|---|---|
| Privileged-change gate (CI blocks privileged PRs without a label, and the CTO may add the label at its own discretion after sign-off) | Changed | The runner decides from a list of privileged paths, not the bot. New access or capability is an approve-once gate for Didi. The boundary between new access and existing values is fuzzy today. |
| Production deploy gate (GitHub production environment) | Kept | The v1 morning approval. |
| Design approval gate | Changed | Visual approval before the spec. |
| Product direction gate and triage gate | Kept | The scope gate. |
| DNS gate | Kept | Added to the spec's gate list as approve once. |
| Merge gate (CI green, no conflicts, no open CTO question, at most 3 rounds) | Kept | Part of done and the QA contract. |

## Hidden behaviours

| Behaviour | Status | In v2 |
|---|---|---|
| Sign-offs name an exact head commit and a new commit cancels them | Kept | Approval scope. |
| Reviews and comments appear under Didi's own account | Dropped | Each bot gets its own identity and an audit trail. Today a reader cannot tell the CTO bot from Didi without a text prefix. |
| Mutation checks during reviews | Kept | Optional QA evidence. |
| Review nits go into separate low-priority follow-up items | Kept | Playbook rule. |
| A journal of every ruling in CTO memory | Replaced | A decision log in the state store. |
| Bots are woken only when they must act | Kept | Dispatch immediately when ready. |
| Never print secret values or D1 ids | Kept | Toolbox rule. |
| The deploy watcher remembers reports by reading chat history | Replaced | State store. |
| Didi's words are copied verbatim and other bots are paraphrased | Kept | Verbatim records of Didi's words. |

## Other bots' routines

These routines belong to the Developer, Designer, QA and Recruiter bots.

| **Other bot routine** | **Status** | **In v2** |
|---|---|---|
| Pick up Ready for dev tickets (Developer; fires when a ticket reaches Ready for dev or is created in one of four projects) | Replaced | The runner dispatches ready items. Keep the guards: only items marked agent-ready (today the Delegatable label) with no open blockers, build only from the merged spec on main, one agent per item, never merge, and hold migrations, PII, privacy and deploy-config work for Council sign-off. Spikes get a draft PR that is never merged, and the Council reviews them. The hard-coded project list goes away. |
| Start tickets unblocked by Done (Developer) | Replaced | Same step as the Unblock watcher: the runner releases and dispatches in one transition. |
| Weekday morning ticket sweep (Developer, 8 AM on weekdays) | Replaced | Covered by the reconcile loop, run every day. Keep its stalled-fix check as a transition driven by evidence: when an agent has pushed QA's fixes and CI is green, the item moves to review and QA is dispatched. |
| Review PRs when a ticket reaches Ready for review (QA) | Changed | The review verdict stays a model task. The merge gate becomes code: CI green, no conflicts, at most 3 rounds, no open Council question, and a sign-off pinned to the head commit. Design PRs are checked for files only under design/ and the spec layout. Gallery PRs are checked against the approved spec. Sensitive changes escalate. Verdicts are re-read right before merging. |
| Backup sweep for unreviewed PRs (QA, every 30 minutes) | Replaced | The reconcile loop. |
| Eleven per-PR watches (nodrift 8 to 11, we-met 55, 57, 59, 60 and 61, portfolio 8 and 9) | Dropped | Stale: the PRs are finished. Per-PR watches are replaced by state-based review dispatch. Two of them also count rounds from GitHub reviews, which QA cannot post, so the count is always zero. |
| Pick up Ready to explore design tickets (Designer) | Replaced | The runner dispatches design items. Keep the steps: import the repo's design system into MagicPath, create a project per ticket, build a baseline and 3 to 4 variants, send previews, and ask Didi which direction he likes. Never advance without his approval. |
| Daily job standup and auto-apply (Recruiter, every day at 7:30 AM) | Open | Outside the build flow. It moves to the same runner as its own flow. Keep: a cap of 50 submissions a day, any application site except LinkedIn, hold on password accounts, captchas and unanswerable questions, email-only applications become Gmail drafts Didi sends, and every submission logged and deduped by company. Plumbing (fetch, filter, dedupe, log) becomes code, and models keep only form filling and essays. |
| Weekly skills-gap report to the CEO bot (Recruiter, Fridays at 9 AM) | Open | Keep as a weekly job. It depends on the CEO bot, whose role is unknown. |

## Other bots' rules and behaviours

These rules and habits come from the Developer, Designer, QA and Recruiter exports.

| **Other bot rule or behaviour** | **Status** | **In v2** |
|---|---|---|
| Developer: after every cloud agent fix run, check the push and CI, move the ticket to Ready for review and ping QA, in the same turn (Didi's firm rule) | Replaced | The runner does it from CI evidence, with no ping. |
| Developer: launch prompts require a Privacy section, a passing check, the head commit in the PR body, merging main instead of rebasing, no force push, no deploys, no secret values, and SHA-pinned actions | Kept | These belong in Launchpad's PR template and the Developer bot definition. |
| Developer: cloud agents never query production or remote databases | Kept | A credential rule: agents get no production database access, which fits the PII gate. |
| Developer: Quorum UI screenshots go to Didi in chat, taken from the CI artifacts of the exact PR head, until preview deploys work | Changed | Screenshots become evidence items on the attention list. The preview deploy tickets (DIDI-816, DIDI-911 and DIDI-912) are still open. |
| Designer: ask Didi one question at a time and send each answer verbatim to the CTO bot | Changed | Each answer is recorded once in the state store, so there is no relay. |
| Designer: read Didi's MagicPath comments in a signed-in browser, because the connector cannot read them | Open | A toolbox gap. A replacement needs a signed-in browser. |
| Designer: where the component gallery lives in we-met, physio-poc and Quorum is not written anywhere | Open | Decide the gallery path per repo, ideally in Launchpad. |
| QA: never auto-merge sensitive changes (we-met migrations, data, PII, privacy, deploy workflows and secrets; workflow, deploy or secrets changes in autopilot and portfolio; .github, publishing and secrets in project-factory and Launchpad) | Kept | The privileged-path list decides. Only we-met has one today, in scripts/lib/privileged-paths.mjs. Launchpad and Quorum have no check, so new projects start without one. |
| QA: before merging to main in a repo whose deploy runs on push, confirm the production environment requires Didi's approval (the lesson from project-factory, which was held until DIDI-908) | Kept | A precondition on the deploy gate, checked as code. |
| QA: verdicts are PR comments starting with QA verdict, and rounds are counted from them, because the connector account authored the PRs | Changed | Give QA its own identity so it can post real reviews, and count rounds in the state store. |
| QA: mutation testing, and a guard that no test exercises counts as a defect | Kept | Optional QA evidence. QA keeps finding the same classes of defect (untested guards, bypasses), which makes them the first proposed playbook rules. |
| Recruiter: never treat another bot's report of Didi's approval as his approval, and never send messages to employers or recruiters | Kept | Same rule as the approval record and the drafts-only gate. |
| Recruiter: shortens an answer itself when a field has a character limit, without review | Open | Decide whether shortened answers need Didi's review. One went out on Oct 26 without it. |

## Findings from the exports

Patterns across the CTO, Developer, Designer, QA and Recruiter exports.

### How Didi works

- He decides in short bursts, often late at night, and the bots turn each decision into a rule. The triage rule had three versions in two days, statuses were renamed three times in a week, and one decision was reversed within a minute. Decisions have to be cheap to change.
- He delegates widely and keeps tight control of three things: product behaviour (recipients, counts and user-facing content), money, permissions, DNS and production deploys, and anything irreversible. The Oct 24 we-met misalignment is why the locked Product direction block exists.
- The worst failure is silence: a request waiting on him with no visible entry. His words were that it should have been triaged and had an entry in waiting for maintainer.
- He prefers verbatim, timestamped records and one question at a time.

### Where the Grok setup breaks

- Event triggers fail silently, so every flow has a polling backstop. The Unblock watcher has not fired since Oct 22, Auto breakdown never ran, and PR watches miss CI passes. The result is several sweeps and 11 stale watches.
- Plain plumbing runs on model usage. When usage ran out on Oct 26 and 27, reviews died mid-run, sweeps failed, and nothing retried.
- Rules are copied into prompts and drift. Role descriptions still say Backlog and Todo, Developer's pickup uses hard-coded project IDs (Quorum, project-factory and Career are missing), and notes still describe statuses that were dropped.
- State lives in chat and journals: deploy-run dedup, which cloud agent owns which PR, and about 466 Developer journal entries. Didi's approvals reach QA only as text relayed by the CTO bot.
- The CTO bot is a bottleneck. Triage, breakdown, cleanup, sign-offs, relays and deploy watching all go through it, and every new commit on a privileged PR needs a fresh sign-off.
- Bots act under Didi's account, so a CTO bot comment and a Didi comment differ only by a text prefix.
- Ready for maintainer is used two ways (parking a design ticket itself, or a separate ticket that blocks the waiting one), and held tickets are handled inconsistently: project-factory 3 went to Blocked, while 4 and 5 stayed in QA review.

### What to solidify in the state machines and Windmill

1. A versioned rules and registry store (projects, repos, states, bots, gates) that bots read at run time instead of copying into prompts.
2. A Windmill reconcile loop in plain code, every few minutes and every day of the week: release dependents, dispatch ready items, flag stalls, and clean stale gate requests. Models only for judgment.
3. Approvals and decisions as verbatim records with a scope and a superseding record. A reversal marks dependent work stale.
4. One gate-request form with topic keys.
5. Merge and done gates as code: CI, head commit, conflicts, round count, and a sign-off pinned to the head. The privileged-path list lives in Launchpad so every new project has it.
6. Bot identities and an audit trail, separate from Didi's account.
7. Budgets, and usage-exhaustion handling that queues and resumes work instead of killing runs.

### Decisions made from these findings

- User-facing copy (Oct 27, 2026): the Council decides it unless it changes the approved product direction, in which case it comes to Didi. The spec is updated to match.
- Product interview (Oct 27, 2026): every new idea starts with an interview of Didi on the product design and decisions before any work. The spec has a new Interview state.

### Open points in Grok's own setup

- DIDI-705, the job search ticket, is outdated: it says weekdays and three application sites, and sits in Ready for CTO breakdown although the work is live.
- Whether quorum is formally in QA's routines, whether the spike label still exists, and whether we-met PRs 67 and 68 are still open were not checked.
- The Recruiter's answer bank holds personal details such as an address and phone number as a file. It should move as a file and not be retyped.

## Still missing

- The bots' journals: about 466 Developer entries, 322 QA entries (55 recovered), and the CTO's recent rulings. They are history and can be rebuilt from GitHub and Linear.
- One profile note each in the Developer, QA and Designer memories that could not be retrieved, and the platform's built-in instructions for each bot
- A privileged-path check for Launchpad, Quorum and project-factory (only we-met has one)
- Each repo's AGENTS.md and the ADRs
- Which model each bot runs on
