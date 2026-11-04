// The held-items list in Didi's daily check (D-272, O-90): every work item that is held now and
// has no open release request. That is an item whose release request Didi rejected (or answered
// with Request changes, which keeps it held as a Reject does, O-77), and a rework item that
// inherited its original's hold (D-233, O-55), which never had a request. Each entry gives the
// item, how long it has been held and Didi's last note on its release requests, verbatim.
//
// How long: the hold starts when the item is created. Only the Triage handoff (Triage's `hold`)
// and the rework step (the original's flag) set it, both on the new row, and nothing sets it
// again once the runner clears it (./hold-release.ts), so the item's `createdAt` is when its hold
// started. The duration is counted from the clock passed in (D-162), in whole minutes.
//
// Left out: a finished item (Done, or Cancelled, D-308), when the contracts are
// given; an item with an open release request (that request is on the attention list
// already), and an item whose latest request Didi approved (its release is due, and the hold
// release pass clears the flag once the switches allow it).
//
// Read-only: it writes nothing and opens nothing. A fresh request opens only when Didi asks for
// one (`createHoldReleaseRequests` in ./hold-release.ts); nothing here or in any pass asks Didi
// again on a timer.
import { isTerminalState, type Contracts } from "./contracts.ts";
import type { Clock } from "./library.ts";
import {
  answeredWithApproval,
  holdReleaseTopic,
  releaseRequestsNewestFirst,
} from "./hold-release.ts";
import type { Json, Store } from "./store.ts";

/** Didi's last note on an item's release requests: the words of Didi's latest answer that kept it held. */
export interface HeldItemNote {
  /** Verbatim, as recorded. */
  text: string;
  /** `rejected` or `changes_requested`, as the answer recorded it. */
  outcome: string;
  answeredAt: Date;
}

export interface HeldItem {
  nodeId: string;
  projectId: string;
  title: string;
  state: string;
  /** When the hold started: the item's creation (see above). */
  heldSince: Date;
  heldForMinutes: number;
  /** For a rework item (D-233): the merged item it reworks, whose hold it inherited. */
  reworkOf: string | null;
  lastNote: HeldItemNote | null;
}

/**
 * How Didi asks for a fresh release request for one held item (O-90, D-295): the Windmill path of
 * the called flow and the input to start it with. A path, not a URL. Nothing starts it on its own.
 */
export interface FreshReleaseRequest<Flow extends string = string> {
  flow: Flow;
  input: { nodeId: string };
}

export interface HeldItemWithRequest<Flow extends string = string> extends HeldItem {
  freshRequest: FreshReleaseRequest<Flow>;
}

/** Each held item with the flow that opens a fresh release request for it. */
export const withFreshRequest = <Flow extends string>(
  items: readonly HeldItem[],
  flow: Flow,
): HeldItemWithRequest<Flow>[] =>
  items.map((item) => ({
    ...item,
    freshRequest: { flow, input: { nodeId: item.nodeId } },
  }));

const MINUTE_MS = 60_000;

const fieldOf = (value: Json | undefined, key: string): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;

export interface HeldItemsOptions {
  store: Pick<
    Store,
    "listNodes" | "findOpenGateRequest" | "listGateRequests" | "getDecision"
  >;
  clock: Clock;
  /** With the contracts, a finished item (an end state, such as Cancelled) is left out (D-308). */
  contracts?: Contracts;
}

/** Every held work item with no open release request, the longest held first. Reads only. */
export async function listHeldItems({
  store,
  clock,
  contracts,
}: HeldItemsOptions): Promise<HeldItem[]> {
  const now = clock.now().getTime();
  const held = (await store.listNodes({})).filter(
    (n) =>
      n.type === "work_item" &&
      n.hold &&
      !(contracts && isTerminalState(contracts, n.state)),
  );
  const items: HeldItem[] = [];
  for (const node of held) {
    if (await store.findOpenGateRequest(node.projectId, holdReleaseTopic(node.id)))
      continue;
    const requests = await releaseRequestsNewestFirst(store, node);
    if (await answeredWithApproval(store, requests[0])) continue;
    let lastNote: HeldItemNote | null = null;
    for (const request of requests) {
      if (request.status !== "answered" || !request.decisionId) continue;
      const decision = await store.getDecision(request.decisionId);
      if (decision?.byActor !== "didi" || decision.kind !== "answer") continue;
      const outcome = fieldOf(decision.scope, "outcome");
      lastNote = {
        text: decision.textVerbatim,
        outcome: typeof outcome === "string" ? outcome : "",
        answeredAt: request.answeredAt ?? decision.recordedAt,
      };
      break;
    }
    const reworkOf = fieldOf(fieldOf(node.body, "rework"), "originalNodeId");
    items.push({
      nodeId: node.id,
      projectId: node.projectId,
      title: node.title,
      state: node.state,
      heldSince: node.createdAt,
      heldForMinutes: Math.max(
        0,
        Math.floor((now - node.createdAt.getTime()) / MINUTE_MS),
      ),
      reworkOf: typeof reworkOf === "string" ? reworkOf : null,
      lastNote,
    });
  }
  return items.sort(
    (a, b) =>
      a.heldSince.getTime() - b.heldSince.getTime() || a.nodeId.localeCompare(b.nodeId),
  );
}
