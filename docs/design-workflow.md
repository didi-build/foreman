# Design ticket flow

Every **design ticket** in Linear tracks gallery work through design as code in three steps: **MagicPath exploration**, then **design as code** (spec and gallery components), then **app wiring**. The **developer counterpart ticket** is created at breakdown and stays blocked until the design ticket reaches **Done**. The **Developer's** job on the counterpart ticket is wiring gallery components into the app. When the design ticket is **Done**, it unblocks the developer ticket so implementation can proceed against the approved spec and gallery components.

The **`design/` tree is designer-only.** See [Who edits what](./component-gallery.md#who-edits-what) in the component gallery doc for who may edit specs versus gallery components.

## Statuses

Statuses below match Linear exactly. Move tickets through them in order.

| #   | Status                              | Who acts | What happens                                                                                               |
| --- | ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Ready to explore design             | Designer | Waiting for Designer                                                                                       |
| 2   | In design exploration               | Designer | MagicPath iterations with Diadem                                                                           |
| 3   | Ready for maintainer                | Diadem   | Design approval (reused status; the only Diadem approval)                                                  |
| 4   | Ready for design dev                | Designer | Spec PR (`design/` only) merged; QA merges on green CI                                                     |
| 5   | In design dev                       | Designer | Builds or updates gallery components from the spec                                                         |
| 6   | Ready for review, then In QA Review | QA       | QA checks gallery components match the approved spec                                                       |
| 7   | Done                                | Designer | Unblocks the developer counterpart ticket; Designer adds the Spec section (merge commit, file paths) to it |

Row 6 is two Linear statuses in sequence: **Ready for review**, then **In QA Review**.

### Spec and gallery pull requests

Spec files live at `design/<area>/<feature>/spec.md` (see [component gallery](./component-gallery.md#directories) and [design/README.md](../design/README.md)).

- **(a)** Gallery work is a separate PR from the spec PR. QA reviews it against the spec at row 6 and merges it on green CI.
- **(b)** Merging the gallery PR moves the design ticket to **Done** and unblocks the developer counterpart ticket. Merging the spec PR at row 4 does not close the design ticket.
- **(c)** When a design needs no gallery change (a copy-only spec), skip rows 5 and 6. The ticket goes **Done** when the spec PR merges.
- **(d)** This v2 flow (approved by Diadem Oct 25, 2026, 10:50 PM ET on [DIDI-848](https://linear.app/didi-build/issue/DIDI-848)) replaces the earlier Oct 22 rule on when the design ticket goes **Done**.

### The visual comparison at QA (Project Factory v2, D-242, D-250)

In the factory's design track, QA's check of the gallery components against the approved option is a run of its own (`qa:visual`). The runner gives it, per component and variant, the approved option's crop, CI's screenshot of the built component at the PR head, where the two differ in pixels, and the spec section. It answers match, differs or cannot tell per component, and the runner records the result; the PR merges only when every component matches and QA's review passes. A comparison that differs sends the item back to Building components with its findings, like any QA fail, and counts toward the three-fails escalation; one that cannot tell runs once more on the same head, and a second cannot tell sends the item to the Council (D-252). The approved option is the one Didi's visual approval names: the approval page is one form with Decision (Approve, Request changes or Reject), Options (the request's options) and Feedback, and Approve names exactly one option (D-254). Request changes may name several options to combine, with the feedback, and the Designer builds one combined option that comes back for approval. Each component on an option page is marked with `data-component` and `data-variant` so it can be cropped exactly (D-255). An item keeps one branch and one PR: in the spec step the Designer deletes the options Didi did not pick and keeps the approved one (D-253). Before it merges, the runner checks that the PR no longer carries an option folder Didi did not approve, and refuses the merge naming the folders if it does (D-258). That refusal is a QA fail: the item goes back to Building components, the Designer is told exactly which folders to delete, and it counts as a failed round, so repeats escalate (D-259). CI renders the gallery and the changed option pages at each PR head and uploads them as the bundles the runner reads (`scripts/render-screenshots.ts`, O-81). See [docs/guards.md](./guards.md) and [docs/bot-files.md](./bot-files.md).

Related: [component gallery](./component-gallery.md) directories, local dev, and previews. Decision record: [ADR 0004](./decisions/0004-component-gallery.md).
