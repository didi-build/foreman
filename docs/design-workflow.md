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

Related: [component gallery](./component-gallery.md) directories, local dev, and previews. Decision record: [ADR 0004](./decisions/0004-component-gallery.md).
