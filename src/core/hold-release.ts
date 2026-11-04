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
//
// A fresh release request (D-272, O-90): after a Reject nothing asks Didi again, and a rework item
// that inherits a hold (D-233) never had a request. Didi's daily check lists those items
// (./held-items.ts), and each entry names the called flow that opens a fresh request for one item
// (`requestAgain` below). It opens the same request the handoff opens (`holdReleaseRequest`), only
// when Didi starts that flow: no pass and no timer calls it. It refuses an item that is not held,
// one that already has an open request, and one whose latest request Didi approved (the release
// is due, and a fresh request would hold it back); the kill switch and dry run write nothing.
import {
  createLibrary,
  type Clock,
  type LibraryOptions,
  type NewGateRequest,
} from "./library.ts";
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
  /** The idea the item came from; a rework item (D-233) has none of its own. */
  ideaId?: string;
  note?: string;
}): { [key: string]: Json } {
  return {
    question: HOLD_RELEASE_QUESTION,
    title: input.title,
    description: cut(input.description, HOLD_RELEASE_LIMITS.descriptionChars),
    ...(input.ideaId === undefined ? {} : { ideaId: input.ideaId }),
    ...(input.note && input.note.trim() !== ""
      ? { note: cut(input.note, HOLD_RELEASE_LIMITS.noteChars) }
      : {}),
  };
}

/**
 * The release request for a held item, as the Triage handoff opens it and as a fresh request
 * opens it again (D-269, D-272): Didi's, not blocking, of kind `scope`, on the item's topic.
 */
export function holdReleaseRequest(
  node: Pick<Node, "id" | "projectId">,
  payload: Parameters<typeof holdReleasePayload>[0],
): NewGateRequest {
  return {
    projectId: node.projectId,
    nodeId: node.id,
    topicKey: holdReleaseTopic(node.id),
    kind: HOLD_RELEASE_KIND,
    owner: "didi",
    blocking: false,
    payload: holdReleasePayload(payload),
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

/** Every request on the item's release topic, whatever its status, newest first. */
export async function releaseRequestsNewestFirst(
  tx: Pick<StoreOps, "listGateRequests">,
  node: Pick<Node, "id" | "projectId">,
): Promise<GateRequest[]> {
  const requests = await tx.listGateRequests(node.projectId, holdReleaseTopic(node.id));
  return [...requests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The newest request on the item's release topic, whatever its status. */
async function latestRequest(
  tx: StoreOps,
  node: Node,
): Promise<GateRequest | undefined> {
  return (await releaseRequestsNewestFirst(tx, node))[0];
}

/**
 * Whether the request was answered with an approval: the hold release pass's test (`pending`). A
 * held item whose latest request passes it is waiting for its release, not for Didi.
 */
export async function answeredWithApproval(
  ops: Pick<StoreOps, "getDecision">,
  request: GateRequest | undefined,
): Promise<boolean> {
  if (request?.status !== "answered" || !request.decisionId) return false;
  return (await ops.getDecision(request.decisionId))?.kind === "approval";
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
        if (await answeredWithApproval(store, await latestRequest(store, node))) {
          due.push(node.id);
        }
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

/** What a fresh release request did for one item (D-272). */
export type HoldReleaseRequestStep =
  | { nodeId: string; step: "opened"; gateRequestId: string }
  | { nodeId: string; step: "already_open"; gateRequestId: string }
  | {
      nodeId: string;
      step: "no_node" | "not_held" | "release_due" | "kill_switch" | "dry_run";
    };

const textField = (value: Json | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const fieldOf = (value: Json | undefined, key: string): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;

/**
 * Opens a fresh release request for one held item, only when Didi asks for it from the daily
 * check (D-272). One transaction: the switches first (either writes nothing), then the item's
 * lock, then the checks, so two calls at once open one request. The request is the handoff's
 * (`holdReleaseRequest`): the item's title and description, its idea, and Triage's note from the
 * first request on the topic, which the handoff opened; a rework item has no earlier request and
 * so no note.
 */
export function createHoldReleaseRequests(options: LibraryOptions) {
  const { store } = options;
  const library = createLibrary(options);
  return {
    requestAgain(nodeId: string): Promise<HoldReleaseRequestStep> {
      return store.transaction(async (tx): Promise<HoldReleaseRequestStep> => {
        if ((await tx.getSetting("kill_switch"))?.value === true) {
          return { nodeId, step: "kill_switch" };
        }
        if ((await tx.getSetting("dry_run"))?.value !== false) {
          return { nodeId, step: "dry_run" };
        }
        const node = await tx.getNodeForUpdate(nodeId);
        if (!node) return { nodeId, step: "no_node" };
        if (node.type !== "work_item" || !node.hold)
          return { nodeId, step: "not_held" };
        const open = await tx.findOpenGateRequest(
          node.projectId,
          holdReleaseTopic(node.id),
        );
        if (open) return { nodeId, step: "already_open", gateRequestId: open.id };
        const requests = await releaseRequestsNewestFirst(tx, node);
        if (await answeredWithApproval(tx, requests[0])) {
          return { nodeId, step: "release_due" };
        }
        const note = textField(fieldOf(requests.at(-1)?.payload, "note"));
        const ideaId = textField(fieldOf(node.body, "ideaId"));
        const request = await library.openGateRequestWith(
          tx,
          holdReleaseRequest(node, {
            title: node.title,
            description: textField(fieldOf(node.body, "description")) ?? "",
            ...(ideaId === undefined ? {} : { ideaId }),
            ...(note === undefined ? {} : { note }),
          }),
        );
        return { nodeId, step: "opened", gateRequestId: request.id };
      });
    },
  };
}

export type HoldReleaseRequests = ReturnType<typeof createHoldReleaseRequests>;
