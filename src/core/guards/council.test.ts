import { describe, expect, it } from "vitest";

import type { Json } from "../store.ts";
import { REDO_TRIGGER, REWORK_EDGE } from "./council.ts";
import { MERGE, NODE, fixture, type Fixture } from "./testing.ts";

const GUARD = "council_redo_recorded";

/** A decision the node relies on (linked), reversed, and the node marked stale. */
async function reversedBasis(f: Fixture): Promise<string> {
  const basis = await f.decision(
    "approval",
    "didi",
    {},
    "Use the blue layout.",
    "other",
  );
  await f.store.linkNodeToDecision(NODE, basis);
  await f.reverse(basis);
  await f.store.setNodeFlags(NODE, { stale: true }, new Date(Date.UTC(2026, 9, 29, 1)));
  return basis;
}

/** The Council's reversal answer for the reversal, linked to the node as the runner links it. */
async function answer(
  f: Fixture,
  reversedDecisionId: string,
  verdict: string,
  extra: { [key: string]: Json } = {},
): Promise<string> {
  const id = await f.decision(
    "council_decision",
    "council",
    {
      topicKey: `decision-reversed:${reversedDecisionId}`,
      runId: "run",
      reversedDecisionId,
      verdicts: [{ nodeId: NODE, verdict, note: "" }],
      clearedNodeIds: [],
      ...extra,
    },
    "The Council's note.",
    "owner",
  );
  await f.store.linkNodeToDecision(NODE, id);
  return id;
}

describe("council_redo_recorded (unit: guards on the memory store, D-229, D-231)", () => {
  it("passes for a stale item whose reversal the Council answered with redo", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    const redo = await answer(f, basis, "redo");
    expect(await f.check(GUARD)).toMatchObject({
      pass: true,
      detail: `Council decision ${redo} gives redo`,
    });
  });

  it("fails with no redo verdict: none recorded, still_valid, or cannot_decide", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    expect((await f.check(GUARD)).detail).toMatch(/has no Council verdict for it yet/);
    await answer(f, basis, "still_valid");
    expect(await f.check(GUARD)).toMatchObject({
      pass: false,
      detail: "no Council redo verdict for it",
    });
    const g = await fixture();
    const other = await reversedBasis(g);
    await answer(g, other, "cannot_decide");
    expect((await g.check(GUARD)).detail).toMatch(/has no Council verdict for it yet/);
  });

  it("fails for another reversal's verdict while this item's reversal has none", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    // A redo for a reversal of a decision this item does not rely on, and its own still open.
    const unrelated = await f.decision("approval", "didi", {}, "Other.", "other");
    await f.reverse(unrelated);
    await answer(f, unrelated, "redo");
    expect(await f.check(GUARD)).toMatchObject({
      pass: false,
      detail: `reversal of decision ${basis} has no Council verdict for it yet`,
    });
  });

  it("fails when the item is not stale, or is merged: a merged item gets a rework item (D-233)", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    await answer(f, basis, "redo");
    await f.evidence("merge_commit", MERGE, { pr: 7 });
    expect((await f.check(GUARD)).detail).toMatch(/merged/);
    const g = await fixture();
    await answer(g, await reversedBasis(g), "redo");
    await g.store.setNodeFlags(
      NODE,
      { stale: false },
      new Date(Date.UTC(2026, 9, 29, 1)),
    );
    expect(await g.check(GUARD)).toMatchObject({ pass: false, detail: "not stale" });
  });

  it("fails once the redo is taken or the flag was cleared, until a later reversal is answered with redo", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    const redo = await answer(f, basis, "redo");
    await f.store.insertTransition({
      id: "30000000-0000-4000-8000-000000000001",
      nodeId: NODE,
      fromState: "in_qa_review",
      toState: "ready_for_dev",
      fromSubstate: null,
      toSubstate: null,
      triggerKind: "event",
      triggerRef: `${REDO_TRIGGER}${redo}`,
      actorKind: "runner",
      actorId: "council",
      guardResult: [],
      evidenceIds: [],
      specVersion: "v",
      mode: "applied",
      at: new Date(Date.UTC(2026, 9, 29, 2)),
      reason: null,
    });
    // Stale again, from a later reversal: the earlier redo was taken and does not count.
    const later = await f.decision("approval", "didi", {}, "Later.", "other");
    await f.store.linkNodeToDecision(NODE, later);
    // The fixture's clock is behind the transition above: reverse after it.
    await f.store.insertDecisionEvent({
      id: "30000000-0000-4000-8000-000000000002",
      decisionId: later,
      kind: "reversed",
      byDecisionId: null,
      reason: "test",
      recordedBy: "test",
      recordedAt: new Date(Date.UTC(2026, 9, 29, 3)),
    });
    expect((await f.check(GUARD)).detail).toMatch(
      `reversal of decision ${later} has no Council verdict`,
    );

    // An answer that cleared the flag ends the episode the same way.
    const g = await fixture();
    const first = await reversedBasis(g);
    await answer(g, first, "redo", { clearedNodeIds: [NODE] });
    expect(await g.check(GUARD)).toMatchObject({
      pass: false,
      detail: "no Council redo verdict for it",
    });
  });

  it("takes a redo the Council gave for one reversal once the other is answered still_valid", async () => {
    const f = await fixture();
    const first = await reversedBasis(f);
    const second = await f.decision("approval", "didi", {}, "Short copy.", "other");
    await f.store.linkNodeToDecision(NODE, second);
    await f.reverse(second);
    const redo = await answer(f, first, "redo");
    expect((await f.check(GUARD)).detail).toMatch(`reversal of decision ${second}`);
    await answer(f, second, "still_valid");
    expect(await f.check(GUARD)).toMatchObject({
      pass: true,
      detail: `Council decision ${redo} gives redo`,
    });
  });

  it("reads the latest Council answer on each reversal: a follow-up answer replaces the earlier one (D-234)", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    // The first answer could not decide: the question went to Didi.
    await answer(f, basis, "cannot_decide");
    expect((await f.check(GUARD)).detail).toMatch(
      `reversal of decision ${basis} has no Council verdict`,
    );
    // The follow-up after Didi's answer gives redo: it stands.
    const redo = await answer(f, basis, "redo");
    expect(await f.check(GUARD)).toMatchObject({
      pass: true,
      detail: `Council decision ${redo} gives redo`,
    });
    // A later answer on the same reversal replaces it, whatever it says.
    await answer(f, basis, "cannot_decide");
    expect((await f.check(GUARD)).detail).toMatch(
      `reversal of decision ${basis} has no Council verdict`,
    );
    await answer(f, basis, "still_valid");
    expect(await f.check(GUARD)).toMatchObject({
      pass: false,
      detail: "no Council redo verdict for it",
    });
  });

  it("ends the stale episode when a rework item was opened for the item (D-233)", async () => {
    const f = await fixture();
    const basis = await reversedBasis(f);
    await answer(f, basis, "redo");
    expect((await f.check(GUARD)).pass).toBe(true);
    const rework = "10000000-0000-4000-8000-000000000003";
    await f.node(rework, { state: "ready_for_dev" });
    await f.store.insertEdge({
      id: "30000000-0000-4000-8000-000000000003",
      fromNode: rework,
      toNode: NODE,
      type: REWORK_EDGE,
      createdAt: new Date(Date.UTC(2026, 9, 29, 2)),
    });
    expect(await f.check(GUARD)).toMatchObject({
      pass: false,
      detail: "no Council redo verdict for it",
    });
  });
});
