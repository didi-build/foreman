// The release request for a held work item (D-269). Triage sets `hold` on an item only when the
// plan says it must not start yet (O-75); the handoff then opens one release request for Didi on
// the item, in the handoff's transaction (src/core/triage.ts). It uses the approval form of D-254:
// Decision and Feedback, and no options. Its gate kind is `scope`: whether an item the plan holds
// back may start now is Didi's scope call (spec section 5), and no guard reads that kind, so no new
// kind or migration is needed. It is not blocking: a held item is not work waiting to run, so it
// sits on the attention list and raises no phone alert.
//
// Didi's Approve is recorded by the approval resume step as on any request (flows/approval-resume.ts).
// Then the runner, and only the runner, clears the item's `hold` flag here (`release`), so the item
// can start like any other item once its other guards hold. Reject, or Request changes, records
// Didi's words and the item stays held. Nothing acts while the kill switch or dry run is on (D-201):
// the answer waits, and the reconcile flow's hold release pass clears the flag once both are off.
// One transaction locks only the item, up front, and reads the latest request on the topic and its
// answer: a request still open, or answered by anything but Didi's active approval, keeps the item
// held, and an item no longer held writes nothing, so a repeated or concurrent call releases once.
import type { Clock } from "./library.ts";
import type { GateKind, GateRequest, Json, Node, Store, StoreOps } from "./store.ts";
import { cut } from "./task-input.ts";

/** The topic of a held item's release request. */
export const HOLD_RELEASE_PREFIX = "hold-release:";
export const holdReleaseTopic = (nodeId: string): string =>
  `${HOLD_RELEASE_PREFIX}${nodeId}`;

/** The gate kind of a release request: Didi's scope call (spec section 5). */
export const HOLD_RELEASE_KIND: GateKind = "scope";

/** The fixed question on every release request. */
export const HOLD_RELEASE_QUESTION =
  "The plan says this item must not start yet. Approve to release it so it can start; Reject to keep it held.";

/** The bounds of the text a release request quotes from Triage's answer. */
export const HOLD_RELEASE_LIMITS = {
  descriptionChars: 8_000,
  noteChars: 8_000,
} as const;

/** The release request's payload: the question, the item and why the plan holds it. */
export function holdReleasePayload(input: {
  title: string;
  description: string;
  ideaId: string;
  note?: string;
}): { [key: string]: Json } {
  return {
    question: HOLD_RELEASE_QUESTION,
    title: input.title,
    description: cut(input.description, HOLD_RELEASE_LIMITS.descriptionChars),
    ideaId: input.ideaId,
    ...(input.note && input.note.trim() !== ""
      ? { note: cut(input.note, HOLD_RELEASE_LIMITS.noteChars) }
      : {}),
  };
}

/** What `release` did for one item. */
export type HoldReleaseStep =
  | { nodeId: string; step: "released" }
  | {
      nodeId: string;
      step:
        | "no_node"
        | "not_held"
        | "no_request"
        | "waiting"
        | "kept_held"
        | "kill_switch"
        | "dry_run";
    };

export interface HoldReleaseOptions {
  store: Store;
  clock: Clock;
}

/** The newest request on the item's release topic, whatever its status. */
async function latestRequest(
  tx: StoreOps,
  node: Node,
): Promise<GateRequest | undefined> {
  const requests = await tx.listGateRequests(node.projectId, holdReleaseTopic(node.id));
  return [...requests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

export function createHoldReleases({ store, clock }: HoldReleaseOptions) {
  return {
    /**
     * Held items whose latest release request Didi answered with Approve: the ones the hold
     * release pass looks at. `release` checks it all again under the item's lock.
     */
    async pending(): Promise<string[]> {
      const held = (await store.listNodes({})).filter(
        (n) => n.type === "work_item" && n.hold,
      );
      const due: string[] = [];
      for (const node of held) {
        const latest = await latestRequest(store, node);
        if (latest?.status !== "answered" || !latest.decisionId) continue;
        const decision = await store.getDecision(latest.decisionId);
        if (decision?.kind === "approval") due.push(node.id);
      }
      return due;
    },

    /** Clears the item's hold flag when Didi approved its latest release request (runner only). */
    release(nodeId: string): Promise<HoldReleaseStep> {
      return store.transaction(async (tx): Promise<HoldReleaseStep> => {
        if ((await tx.getSetting("kill_switch"))?.value === true) {
          return { nodeId, step: "kill_switch" };
        }
        if ((await tx.getSetting("dry_run"))?.value !== false) {
          return { nodeId, step: "dry_run" };
        }
        const node = await tx.getNodeForUpdate(nodeId);
        if (!node) return { nodeId, step: "no_node" };
        if (!node.hold) return { nodeId, step: "not_held" };
        const request = await latestRequest(tx, node);
        if (!request) return { nodeId, step: "no_request" };
        if (request.status === "open") return { nodeId, step: "waiting" };
        if (request.status !== "answered" || !request.decisionId) {
          return { nodeId, step: "kept_held" };
        }
        const decision = await tx.getDecision(request.decisionId);
        if (
          decision?.kind !== "approval" ||
          decision.byActor !== "didi" ||
          decision.status !== "active" ||
          decision.nodeId !== node.id
        ) {
          return { nodeId, step: "kept_held" };
        }
        await tx.setNodeFlags(node.id, { hold: false }, clock.now());
        return { nodeId, step: "released" };
      });
    },
  };
}

export type HoldReleases = ReturnType<typeof createHoldReleases>;
