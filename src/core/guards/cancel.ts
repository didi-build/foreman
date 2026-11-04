// The guard on the moves of a cancel (D-308, O-97, ../cancel.ts): each work item's move into
// Cancelled and its idea's move into Rejected. For a work item it passes only when a cancel
// stands on the item or on its idea (Didi's own cancel, the Council's stop on a plan the Council
// accepted, or the Council's stop Didi approved on the cancel request), and no run is active on
// the item. For an idea it passes only when every work item is Done or Cancelled and at least one
// is Cancelled, or the idea has no work items and a cancel stands on it, and no run is active on
// the idea (`ideaRejectionDue`). It names no evidence: it reads decisions, requests and runs.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import { CANCEL_GUARD, ideaOf, ideaRejectionDue, readCancelOfItem } from "../cancel.ts";
import { result } from "./evidence.ts";

export { CANCEL_GUARD };

export async function cancelRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const fail = (detail: string) => result(CANCEL_GUARD, false, [], detail);
  const { node, store } = ctx;
  if (node.type === "idea") {
    const due = await ideaRejectionDue(store, node);
    return due.due
      ? result(
          CANCEL_GUARD,
          true,
          [],
          "the idea's work was cancelled and every item is finished",
        )
      : fail(due.why);
  }
  const on = await readCancelOfItem(store, node, await ideaOf(store, node));
  if (!on) return fail("no cancel stands on the item or its idea");
  if (on.status === "ask_didi") {
    return fail("the Council's stop waits for Didi's answer on the cancel request");
  }
  if ((await store.listRuns({ nodeId: node.id })).some((r) => r.endedAt === null)) {
    return fail("a run is active on it");
  }
  return result(CANCEL_GUARD, true, [], `a cancel stands (${on.cancel.how})`);
}
