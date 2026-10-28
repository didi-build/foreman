# Cutover: from the Grok routines to the runner

Status: draft, 2026-10-28. Decided (D-101): one cutover, all at once. A dry run comes first. The Grok routines are disabled, not deleted. A kill switch pauses the runner.

## 1. What changes at cutover

- The runner becomes the only writer of item states. Grok routines stop moving tickets.
- Linear becomes a mirror written by the runner under its own app identity.
- Plumbing (release, dispatch, sweeps, merge gates, deploy checks) runs as code in Windmill and no longer depends on model usage.
- Approvals and decisions become records in the state store, not chat messages.

## 2. What stays out of the cutover

- The Recruiter flows (job search). They stay their own flow and move to the same runner later.
- The CEO bot and the Assistant bot. No role is written down for them.
- The Scanner (Machine 3).

## 3. Preconditions

All of these are true before the go or no-go meeting.

1. Milestones 1 to 5 are done and their verification passed (`docs/test-plan.md`, section 4).
2. The spikes V-01 to V-04 have recorded results, and any "no" has a working fallback.
3. The one-time Linear setup (M5.1) has been run on the real team, with Ready for review and Ready for design dev still present but unused.
4. The Launchpad defaults exist: the standard component gallery path and the default privileged-path list. Every repo in scope has a privileged-path list (at least the default) and a gallery path.
5. Each repo in scope has its production environment set to require Didi's approval where deploys run on push to main.
6. Bot identities exist in GitHub and Linear.
7. The three tickets waiting on Didi that block Project Factory v1's first deploy (DIDI-907, DIDI-908, DIDI-910) are resolved or consciously carried over.
8. The kill switch has been tested.

## 4. Dry run

1. Import the current Linear state into the store (M1.5) with `dry_run` true.
2. Run the reconcile pass for at least two days, including a weekend, so the Friday evening to Monday morning gap in the old setup is visible.
3. Read the dry-run report (M2.5). For each difference from what a person would expect, either fix the cause or write down why it is correct.
4. Check by hand that the planned actions for a sample of items are right: a blocked item with a finished blocker, a ready item with no run, a stalled item, an item waiting on Didi, a design item with a merged spec, an item with a privileged path.

Pass criteria: no unexplained difference, no planned action that would violate a gate, and every item maps to a state.

## 5. Go or no-go checklist

Didi decides. Go only if every line is yes.

- [ ] Dry run passed (section 4).
- [ ] Preconditions are met (section 3).
- [ ] The rollback plan (section 8) has been read and the Grok routines can be re-enabled.
- [ ] Didi will be reachable for the first day.
- [ ] Gates are fully on. Nothing auto-approves.
- [ ] The first cycles will be watched (section 6).

## 6. Cutover day

1. Announce the window. Pause new idea submissions for the window.
2. Take a snapshot of Linear state and of the state store.
3. Disable the Grok routines that move tickets or merge (list in section 7). Disable, do not delete.
4. Set `dry_run` to false.
5. Watch the first three reconcile cycles. Check each planned and applied transition against the guard report.
6. Confirm the mirror: Linear matches the store within one cycle.
7. Confirm one rehearsal-style item moves end to end in a real project, with Didi's gates on.
8. Test the kill switch: set it, confirm the runner stops within one cycle, clear it, confirm it resumes.
9. Keep the Grok routines disabled but intact for one week.

## 7. Grok routines to disable

From `docs/grok-mapping.md`. Disable the ones the runner replaces.

- Unblock watcher and unblock sweep (replaced by release and the reconcile loop).
- Auto breakdown (replaced by the Triage transition).
- Daily cleanup (maintainer flow, triage rule, stale tickets, review queue, blockers and statuses).
- Weekly icebox review (replaced by an idea machine step; cadence is open, N-11).
- Production deploy watcher (replaced by a monitor and toolbox tools; the record of reports moves to the state store).
- Developer: pick up Ready for dev tickets, start tickets unblocked by Done, weekday morning ticket sweep.
- QA: review PRs when a ticket reaches Ready for review, backup sweep for unreviewed PRs, and the per-PR watches.
- Designer: pick up Ready to explore design tickets.

Keep running for now: the Recruiter routines (daily job standup and auto-apply, weekly skills-gap report).

## 8. Rollback

Trigger: the kill switch is set and the problem cannot be fixed within the day, or Didi says stop.

1. Set `kill_switch` to true. Confirm the runner has stopped.
2. Re-enable the Grok routines that were disabled.
3. Reconcile Linear by hand against the snapshot taken at the start of cutover. Items that moved during the window are checked one by one.
4. Write down what failed in `docs/decisions.md` and fix it before the next attempt.

## 9. After cutover

1. Day 1 to 7: watch the attention list, the daily check, and spend.
2. After one week: read the `runs` table, tune budgets (generous at first), and adjust thresholds.
3. Retire the unused Linear statuses (Ready for review, Ready for design dev) and re-enable nothing from Grok.
4. Decide what to do with the disabled Grok routines (delete, archive, or keep).
5. Plan Milestone 7 (the Kubernetes platform) and Milestone 8 (the intake agent, the viewer and the frontend).
