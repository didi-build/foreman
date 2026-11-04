// Seam: unit, plain logic over the memory store with the real contracts (D-162). The held-items
// list of Didi's daily check (D-272, O-90, src/core/held-items.ts) and the fresh release request
// it offers (`createHoldReleaseRequests`, src/core/hold-release.ts). The flows around them are
// in test/flows/triage-flows.test.ts, and two fresh requests at once on Postgres in
// test/db/triage.test.ts.
import { describe, expect, it } from "vitest";

import { approvalDecision, type ApprovalChoice } from "../src/core/approvals.ts";
import { listHeldItems } from "../src/core/held-items.ts";
import {
  createHoldReleaseRequests,
  createHoldReleases,
  HOLD_RELEASE_QUESTION,
  holdReleaseRequest,
  holdReleaseTopic,
} from "../src/core/hold-release.ts";
import { createLibrary } from "../src/core/library.ts";
import type { GateRequest, Node, Store } from "../src/core/store.ts";
import { createReconcileFixture } from "./reconcile-fixture.ts";

const IDEA_ID = "60000000-0000-4000-8000-000000000001";
const TRIAGE_NOTE =
  "The plan holds the old settings page until the new one has run a week.";

async function fixture() {
  const f = await createReconcileFixture();
  const library = createLibrary(f.deps);

  /** A held item as the Triage handoff leaves it, with its first release request. */
  async function heldItem(title = "Remove the old settings page") {
    const node = await f.node("ready_for_dev", {
      title,
      hold: true,
      body: { description: "Delete src/settings/old.ts.", ideaId: IDEA_ID },
    });
    const request = await library.openGateRequest(
      holdReleaseRequest(node, {
        title,
        description: "Delete src/settings/old.ts.",
        ideaId: IDEA_ID,
        note: TRIAGE_NOTE,
      }),
    );
    return { node, request };
  }

  /** Didi's answer on the approval page, recorded as the approval step records it. */
  const answer = (request: GateRequest, choice: ApprovalChoice, words: string | null) =>
    library.answerGateRequest(
      request.id,
      approvalDecision(request, { choice, words, approvers: ["anonymous"] }),
    );

  const openRequest = async (node: Node) =>
    f.store.findOpenGateRequest(node.projectId, holdReleaseTopic(node.id));

  return { ...f, library, heldItem, answer, openRequest };
}

/** The store with every write refused: anything but a read throws. */
function readOnly(store: Store): Store {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof key === "string" && !/^(get|list|find)/.test(key)) {
        return () => {
          throw new Error(`the held-items list called ${key}`);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the held-items list (unit: memory store, D-272)", () => {
  it("leaves out a held item that is finished, such as a cancelled one (D-308)", async () => {
    const f = await fixture();
    const node = await f.node("cancelled", {
      title: "Cancelled while held",
      hold: true,
    });
    expect((await listHeldItems(f.deps)).map((i) => i.nodeId)).toEqual([]);
    // Without the contracts, the list cannot tell an end state and keeps it.
    expect(
      (await listHeldItems({ store: f.store, clock: f.clock })).map((i) => i.nodeId),
    ).toEqual([node.id]);
  });

  it("leaves out a held item whose release request is still open", async () => {
    const f = await fixture();
    await f.heldItem();
    expect(await listHeldItems(f.deps)).toEqual([]);
  });

  it("lists a rejected item with how long it has been held and Didi's note, verbatim", async () => {
    const f = await fixture();
    const { node, request } = await f.heldItem();
    f.advanceMinutes(90);
    const words = "  Not yet.\nWait until the new page has run for a week.  ";
    await f.answer(request, "reject", words);
    f.advanceMinutes(3 * 24 * 60);
    expect(await listHeldItems(f.deps)).toEqual([
      {
        nodeId: node.id,
        projectId: f.projectId,
        title: "Remove the old settings page",
        state: "ready_for_dev",
        heldSince: node.createdAt,
        heldForMinutes: 90 + 3 * 24 * 60,
        reworkOf: null,
        lastNote: {
          text: words,
          outcome: "rejected",
          answeredAt: new Date(node.createdAt.getTime() + 90 * 60_000),
        },
      },
    ]);
  });

  it("shows Didi's latest note when Didi kept the item held more than once", async () => {
    const f = await fixture();
    await f.setting("dry_run", false);
    const { node, request } = await f.heldItem();
    await f.answer(request, "reject", "First: not yet.");
    f.advanceMinutes(15);
    const opened = await createHoldReleaseRequests(f.deps).requestAgain(node.id);
    if (opened.step !== "opened") throw new Error(opened.step);
    const second = (await f.store.getGateRequest(opened.gateRequestId)) as GateRequest;
    f.advanceMinutes(5);
    await f.answer(second, "changes_requested", "Split it from the migration first.");
    expect(await listHeldItems(f.deps)).toMatchObject([
      {
        nodeId: node.id,
        heldForMinutes: 20,
        lastNote: {
          text: "Split it from the migration first.",
          outcome: "changes_requested",
        },
      },
    ]);
  });

  it("leaves out a released item and one whose release is due", async () => {
    const f = await fixture();
    const released = await f.heldItem("Released");
    await f.answer(released.request, "approve", null);
    await f.setting("dry_run", false);
    expect(await createHoldReleases(f.deps).release(released.node.id)).toMatchObject({
      step: "released",
    });
    // Approved while a switch held the release: the hold release pass clears it, not Didi.
    await f.setting("dry_run", true);
    const due = await f.heldItem("Due");
    await f.answer(due.request, "approve", "Go ahead.");
    expect((await f.store.getNode(due.node.id))?.hold).toBe(true);
    expect(await listHeldItems(f.deps)).toEqual([]);
  });

  it("lists a rework item that inherited a hold (D-233), with no note", async () => {
    const f = await fixture();
    const original = await f.node("done", { title: "Settings page" });
    const rework = await f.node("ready_for_dev", {
      title: "Rework: Settings page",
      hold: true,
      body: {
        description: "This item reworks the settings page.",
        rework: { originalNodeId: original.id },
      },
    });
    f.advanceMinutes(45);
    expect(await listHeldItems(f.deps)).toEqual([
      expect.objectContaining({
        nodeId: rework.id,
        title: "Rework: Settings page",
        heldSince: rework.createdAt,
        heldForMinutes: 45,
        reworkOf: original.id,
        lastNote: null,
      }),
    ]);
  });

  it("lists the longest held first, leaves out ideas and items not held, and writes nothing", async () => {
    const f = await fixture();
    await f.node("ready_for_dev", { title: "Not held" });
    await f.node("triage", { type: "idea", track: null, hold: true, title: "An idea" });
    const older = await f.heldItem("Older");
    await f.answer(older.request, "reject", "No.");
    f.advanceMinutes(1);
    const newer = await f.node("ready_for_dev", { title: "Newer", hold: true });
    f.advanceMinutes(1);
    const deps = { ...f.deps, store: readOnly(f.store) };
    const before = JSON.stringify(await f.store.listOpenGateRequests(f.projectId));
    expect((await listHeldItems(deps)).map((i) => i.nodeId)).toEqual([
      older.node.id,
      newer.id,
    ]);
    expect(JSON.stringify(await f.store.listOpenGateRequests(f.projectId))).toBe(
      before,
    );
    expect((await f.store.getNode(newer.id))?.hold).toBe(true);
  });
});

describe("a fresh release request (unit: memory store, D-272)", () => {
  it("opens the handoff's request again on Didi's ask, and the item leaves the list", async () => {
    const f = await fixture();
    await f.setting("dry_run", false);
    const { node, request } = await f.heldItem();
    await f.answer(request, "reject", "Not yet.");
    const step = await createHoldReleaseRequests(f.deps).requestAgain(node.id);
    expect(step).toMatchObject({ nodeId: node.id, step: "opened" });
    const fresh = await f.openRequest(node);
    expect(fresh).toMatchObject({
      id: (step as { gateRequestId: string }).gateRequestId,
      nodeId: node.id,
      topicKey: holdReleaseTopic(node.id),
      kind: "scope",
      owner: "didi",
      blocking: false,
      payload: {
        question: HOLD_RELEASE_QUESTION,
        title: "Remove the old settings page",
        description: "Delete src/settings/old.ts.",
        ideaId: IDEA_ID,
        note: TRIAGE_NOTE,
      },
    });
    expect(await listHeldItems(f.deps)).toEqual([]);
    // Asked again while it is open: the same request, nothing new.
    expect(await createHoldReleaseRequests(f.deps).requestAgain(node.id)).toEqual({
      nodeId: node.id,
      step: "already_open",
      gateRequestId: fresh?.id,
    });
    expect(
      await f.store.listGateRequests(f.projectId, holdReleaseTopic(node.id)),
    ).toHaveLength(2);
  });

  it("opens one for a rework item with no idea and no earlier note", async () => {
    const f = await fixture();
    await f.setting("dry_run", false);
    const rework = await f.node("ready_for_dev", {
      title: "Rework: Settings page",
      hold: true,
      body: { description: "Rework it.", rework: { originalNodeId: "x" } },
    });
    expect(
      await createHoldReleaseRequests(f.deps).requestAgain(rework.id),
    ).toMatchObject({
      step: "opened",
    });
    expect((await f.openRequest(rework))?.payload).toEqual({
      question: HOLD_RELEASE_QUESTION,
      title: "Rework: Settings page",
      description: "Rework it.",
    });
  });

  it("refuses an item that is not held, a missing item and one whose release is due", async () => {
    const f = await fixture();
    await f.setting("dry_run", false);
    const requests = createHoldReleaseRequests(f.deps);
    const free = await f.node("ready_for_dev");
    expect(await requests.requestAgain(free.id)).toEqual({
      nodeId: free.id,
      step: "not_held",
    });
    const missing = "70000000-0000-4000-8000-000000000001";
    expect(await requests.requestAgain(missing)).toEqual({
      nodeId: missing,
      step: "no_node",
    });
    const { node, request } = await f.heldItem();
    await f.answer(request, "approve", null);
    expect(await requests.requestAgain(node.id)).toEqual({
      nodeId: node.id,
      step: "release_due",
    });
    expect(await f.openRequest(node)).toBeNull();
    expect(await f.openRequest(free)).toBeNull();
  });

  it("writes nothing under the kill switch or dry run", async () => {
    const f = await fixture();
    const { node, request } = await f.heldItem();
    await f.answer(request, "reject", "Not yet.");
    const requests = createHoldReleaseRequests(f.deps);
    expect(await requests.requestAgain(node.id)).toEqual({
      nodeId: node.id,
      step: "dry_run",
    });
    await f.setting("dry_run", false);
    await f.setting("kill_switch", true);
    expect(await requests.requestAgain(node.id)).toEqual({
      nodeId: node.id,
      step: "kill_switch",
    });
    expect(await f.openRequest(node)).toBeNull();
    expect(await listHeldItems(f.deps)).toHaveLength(1);
  });
});
