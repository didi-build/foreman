// How a work item is cancelled (D-308, O-97; first built for scanner ideas by D-305, O-95). One
// Cancelled end state for work items, whatever the item's source. Plain logic over an injected
// store, contracts, guards, clock and id source (D-162).
//
// What can stand as a cancel on a node (`readCancelOn`):
// - the Council's stop: its latest answer on the node's "is this still needed?" question is an
//   active `stop`. For an idea that is the scanner question (`scanner-gone:<idea id>`, D-301),
//   which covers every work item of the idea; for a work item it is its own question
//   (`still-needed:<item id>`, ./still-needed.ts).
// - Didi's own cancel: an active `answer` by Didi on the item with `scope.kind` `cancel`, which
//   the called flow `f/foreman/cancel_item` records with Didi's reason (`cancelByDidi`).
//
// Who may cancel follows who approved the plan (`cancelAuthority`, one pure function): Didi's
// cancel always stands. The Council's stop stands on its own only when the plan of the item's
// idea was accepted by the Council (the latest active `plan_accepted`, `acceptedBy` `council`,
// D-307, O-96) and the item is not waiting on Didi (Escalated to Didi). Otherwise, a plan Didi
// approved (a `plan_accepted` with no `acceptedBy` reads as Didi's), no accepted plan at all, or
// an item waiting on Didi, the Council's stop is a recommendation: the step opens one request for
// Didi on `cancel-request:<node id>`, of kind `scope`, not blocking, with the approval form's
// Decision and Feedback (as the hold release request, D-269). Approve cancels; Reject or Request
// changes keeps the work, and nothing asks again for that stop.
//
// The moves (contracts/machine-2/*.yaml, contracts/machine-1/idea.yaml): one runner-only move
// into Cancelled out of each state a work item can be in before its merge, for its track,
// including Escalated to Council and Escalated to Didi. Verifying on staging has none: a merged
// item finishes normally (D-308 (6)), and the step reports it as finishing. The idea moves to
// Rejected from Council planning, Plan accepted, Triage or Handed off once every work item is Done
// or Cancelled and at least one is Cancelled, or, for a scanner idea with no work items yet, once
// the Council's stop on it stands. Every move is guarded by `cancel_recorded`
// (./guards/cancel.ts) and taken only here. The trigger is `cancel:<decision id>`, kind `event`,
// naming the decision that lets the cancel stand (the Council's stop, Didi's Approve, or Didi's
// own cancel), so a repeat writes one row, and an idea Didi reopens is not rejected again for the
// same cancel. Each item's move cancels the item's open gate requests in the same transaction. A
// run in progress is never stopped: the item waits, and the run-end flow or the next reconcile
// pass takes the step again (flows/lib/council-runs.ts).
//
// Pull requests: a cancelled item's open pull request is not closed. D-308 (5) asks the item's
// own bot to close it in a short run, and neither the Developer's nor the Designer's run can do
// that today: their tools are git and npm only, their instructions have no close step, and the
// image's wrapper opens or reuses the branch's pull request after every successful run. That
// part waits for Didi's choice (O-97). The step reports the pull request the store records for
// each item, and the daily check lists it as left open.
//
// Switches: under the kill switch nothing is read past the switch and nothing is written; in dry
// run nothing is written and the step reports what it would cancel or ask.
import type { Contracts, GuardRegistry } from "./contracts.ts";
import { latest, readCiRun } from "./guards/evidence.ts";
import {
  createLibrary,
  type Clock,
  type IdSource,
  type NewGateRequest,
  type TransitionOutcome,
} from "./library.ts";
import { planAcceptedBy } from "./plans.ts";
import { scannerGoneTopic, WITHDRAWN_STATE } from "./scan-ideas.ts";
import type {
  CurrentDecision,
  Decision,
  GateKind,
  GateRequest,
  Json,
  Node,
  Run,
  Store,
  StoreOps,
} from "./store.ts";
import { cut } from "./task-input.ts";

/** The guard on every move of a cancel. */
export const CANCEL_GUARD = "cancel_recorded";
/** Where a cancelled work item goes, and where its idea goes (Rejected, as a withdrawal). */
export const CANCELLED_STATE = "cancelled";
export const CANCELLED_IDEA_STATE = WITHDRAWN_STATE;
/** The end states of a work item: Done and Cancelled. */
export const ITEM_END_STATES: readonly string[] = ["done", CANCELLED_STATE];
/** States where an item waits on Didi: the Council's stop there asks Didi first. */
export const WAITING_ON_DIDI_STATES: readonly string[] = ["escalated_to_didi"];
/** The trigger of each move names the decision that lets the cancel stand. */
export const CANCEL_TRIGGER_PREFIX = "cancel:";
export const CANCEL_ACTOR = { kind: "runner" as const, id: "cancel" };

/** A work item's own "is this still needed?" question (./still-needed.ts). */
export const STILL_NEEDED_PREFIX = "still-needed:";
export const stillNeededTopic = (nodeId: string): string =>
  `${STILL_NEEDED_PREFIX}${nodeId}`;

/** The request for Didi to confirm a Council stop on a plan Didi approved. */
export const CANCEL_REQUEST_PREFIX = "cancel-request:";
export const cancelRequestTopic = (nodeId: string): string =>
  `${CANCEL_REQUEST_PREFIX}${nodeId}`;
/** Its gate kind: whether planned work is still done is Didi's scope call (spec section 5). */
export const CANCEL_REQUEST_KIND: GateKind = "scope";
export const CANCEL_REQUEST_QUESTION =
  "The Council recommends cancelling this work: it says the work is no longer needed. Approve to cancel it; Reject to keep it.";

/** `scope.kind` of Didi's own cancel, an `answer` by Didi on the item. */
export const DIDI_CANCEL_KIND = "cancel";
/** The longest reason Didi's cancel keeps. */
export const DIDI_CANCEL_REASON_CHARS = 2000;

/** The reason recorded on each move, by who let the cancel stand. Fixed text, no ids. */
export const CANCEL_REASONS = {
  council:
    "The Council cancelled this work, which it says is no longer needed, on a plan the Council accepted (D-308).",
  didi_confirmed:
    "Didi approved the Council's recommendation to cancel this work, on a plan Didi approved (D-308).",
  didi: "Didi cancelled this work (D-308).",
} as const;

/** Who approved the plan the work comes from, or null when no accepted plan is recorded. */
export type PlanApprover = "council" | "didi";
export type CancelHow = keyof typeof CANCEL_REASONS;

/**
 * Who may cancel (D-308 (2)), one pure function. Didi may always cancel. The Council cancels
 * itself only work from a plan the Council accepted, and not while the work waits on Didi; in
 * every other case its stop is a recommendation for Didi to confirm.
 */
export function cancelAuthority(input: {
  decidedBy: "council" | "didi";
  planAcceptedBy: PlanApprover | null;
  waitingOnDidi: boolean;
}): "cancel" | "ask_didi" {
  if (input.decidedBy === "didi") return "cancel";
  return input.planAcceptedBy === "council" && !input.waitingOnDidi
    ? "cancel"
    : "ask_didi";
}

const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) ? value[key] : undefined;

/** The node's "is this still needed?" topic: the scanner question for an idea (D-301). */
export const questionTopicOf = (node: Pick<Node, "id" | "type">): string =>
  node.type === "idea" ? scannerGoneTopic(node.id) : stillNeededTopic(node.id);

/**
 * The Council's stop that stands on a node: its latest answer on the node's question, when that
 * answer is `stop` and has not been reversed or superseded. A later `keep` or `cannot_decide`
 * replaces it. Null otherwise.
 */
export function standingStop(
  node: Pick<Node, "id" | "type">,
  decisions: readonly CurrentDecision[],
): CurrentDecision | null {
  const topic = questionTopicOf(node);
  const answer = decisions
    .filter(
      (d) =>
        d.kind === "council_decision" &&
        d.byActor === "council" &&
        field(d.scope, "topicKey") === topic,
    )
    .at(-1);
  return answer &&
    answer.status === "active" &&
    field(answer.scope, "verdict") === "stop"
    ? answer
    : null;
}

/** Didi's own cancel of the node that stands: the latest active one recorded on it. */
export function didiCancelOf(
  nodeId: string,
  decisions: readonly CurrentDecision[],
): CurrentDecision | null {
  return (
    decisions
      .filter(
        (d) =>
          d.nodeId === nodeId &&
          d.kind === "answer" &&
          d.byActor === "didi" &&
          d.status === "active" &&
          field(d.scope, "kind") === DIDI_CANCEL_KIND,
      )
      .at(-1) ?? null
  );
}

/** Who approved the idea's plan: its latest active `plan_accepted`, or null with none. */
export function planApproverOf(
  decisions: readonly CurrentDecision[],
): PlanApprover | null {
  const accepted = decisions
    .filter(
      (d) =>
        d.kind === "council_decision" &&
        d.status === "active" &&
        field(d.scope, "kind") === "plan_accepted",
    )
    .at(-1);
  return accepted ? planAcceptedBy(accepted) : null;
}

export type CancelReads = Pick<
  StoreOps,
  | "getNode"
  | "getDecision"
  | "listEdges"
  | "listDecisionsForNode"
  | "listGateRequests"
  | "listRuns"
>;

/** The idea's work items (`split_into`), in edge order. */
export async function workItemsOf(
  store: Pick<StoreOps, "getNode" | "listEdges">,
  ideaId: string,
): Promise<Node[]> {
  const items: Node[] = [];
  for (const edge of await store.listEdges({ fromNode: ideaId, type: "split_into" })) {
    const item = await store.getNode(edge.toNode);
    if (item) items.push(item);
  }
  return items;
}

/** The idea a node belongs to: the node itself if an idea, else its `split_into` parent. */
export async function ideaOf(
  store: Pick<StoreOps, "getNode" | "listEdges">,
  node: Node,
): Promise<Node | null> {
  if (node.type === "idea") return node;
  const parent = (await store.listEdges({ toNode: node.id, type: "split_into" }))[0];
  return parent ? await store.getNode(parent.fromNode) : null;
}

/** A cancel that stands on a node. */
export interface StandingCancel {
  /** The node it was decided on: the item, or its idea for the scanner question. */
  nodeId: string;
  /** The decision that lets it stand, named by the moves' trigger. */
  decisionId: string;
  how: CancelHow;
  /** The Council's stop, when the Council decided or recommended it. */
  councilDecisionId: string | null;
  /** The Council's note, or Didi's reason, verbatim (data). */
  note: string;
  at: Date;
}

/** What stands on one node: a cancel, a Council stop waiting for Didi, or nothing. */
export type CancelOn =
  | { status: "cancel"; cancel: StandingCancel }
  | { status: "ask_didi"; nodeId: string; stop: CurrentDecision }
  | null;

/** Didi's Approve on the cancel request for this stop, when Didi gave it. */
async function confirmedBy(
  store: Pick<StoreOps, "listGateRequests" | "getDecision">,
  node: Pick<Node, "id" | "projectId">,
  stop: Decision,
): Promise<CurrentDecision | null> {
  for (const g of await store.listGateRequests(
    node.projectId,
    cancelRequestTopic(node.id),
  )) {
    if (field(g.payload, "councilDecisionId") !== stop.id) continue;
    if (g.status !== "answered" || !g.decisionId) continue;
    const answer = await store.getDecision(g.decisionId);
    if (
      answer?.kind === "approval" &&
      answer.byActor === "didi" &&
      answer.status === "active"
    )
      return answer;
  }
  return null;
}

/** Whether a request for Didi on this stop was ever opened, whatever its status. */
export async function askedDidiAbout(
  store: Pick<StoreOps, "listGateRequests">,
  node: Pick<Node, "id" | "projectId">,
  stop: Pick<Decision, "id">,
): Promise<GateRequest | undefined> {
  return (
    await store.listGateRequests(node.projectId, cancelRequestTopic(node.id))
  ).find((g) => field(g.payload, "councilDecisionId") === stop.id);
}

/**
 * What stands on one node (an idea or a work item) by itself, read from the store: Didi's
 * cancel, the Council's stop under the approver rule, or nothing. `idea` is the node's idea
 * (itself for an idea), whose plan says who approved it; null for an item with no idea.
 */
export async function readCancelOn(
  store: CancelReads,
  node: Node,
  idea: Node | null,
): Promise<CancelOn> {
  const decisions = await store.listDecisionsForNode(node.id);
  const didi = didiCancelOf(node.id, decisions);
  if (didi) {
    return {
      status: "cancel",
      cancel: {
        nodeId: node.id,
        decisionId: didi.id,
        how: "didi",
        councilDecisionId: null,
        note: didi.textVerbatim,
        at: didi.recordedAt,
      },
    };
  }
  const stop = standingStop(node, decisions);
  if (!stop) return null;
  const ideaDecisions =
    idea === null
      ? []
      : idea.id === node.id
        ? decisions
        : await store.listDecisionsForNode(idea.id);
  const items = node.type === "idea" ? await workItemsOf(store, node.id) : [];
  const waitingOnDidi = [node, ...items].some((n) =>
    WAITING_ON_DIDI_STATES.includes(n.state),
  );
  const authority = cancelAuthority({
    decidedBy: "council",
    planAcceptedBy: planApproverOf(ideaDecisions),
    waitingOnDidi,
  });
  const base = { nodeId: node.id, councilDecisionId: stop.id, note: stop.textVerbatim };
  if (authority === "cancel") {
    return {
      status: "cancel",
      cancel: { ...base, decisionId: stop.id, how: "council", at: stop.recordedAt },
    };
  }
  const approval = await confirmedBy(store, node, stop);
  if (approval) {
    return {
      status: "cancel",
      cancel: {
        ...base,
        decisionId: approval.id,
        how: "didi_confirmed",
        at: approval.recordedAt,
      },
    };
  }
  return { status: "ask_didi", nodeId: node.id, stop };
}

/**
 * The cancel that stands on a work item: its own, else its idea's (the scanner question covers
 * every item of the idea). A cancel wins over a stop waiting for Didi. Null when neither stands.
 */
export async function readCancelOfItem(
  store: CancelReads,
  item: Node,
  idea: Node | null,
): Promise<CancelOn> {
  const own = await readCancelOn(store, item, idea);
  if (own?.status === "cancel") return own;
  const ideaOn = idea ? await readCancelOn(store, idea, idea) : null;
  if (ideaOn?.status === "cancel") return ideaOn;
  return own ?? ideaOn;
}

const isFinished = (node: Pick<Node, "state">): boolean =>
  ITEM_END_STATES.includes(node.state);
const hasActiveRun = (runs: readonly Run[]): boolean =>
  runs.some((r) => r.endedAt === null);

/**
 * Whether the idea's move to Rejected is due, and the decision it names (D-308 (5)): every work
 * item is Done or Cancelled and at least one is Cancelled, or the idea has no work items and the
 * Council's stop on it stands as a cancel; and no run is active on the idea. The decision named
 * is the idea's own cancel, else the latest item cancel's.
 */
export async function ideaRejectionDue(
  store: CancelReads & Pick<StoreOps, "listTransitions">,
  idea: Node,
): Promise<{ due: true; decisionId: string } | { due: false; why: string }> {
  const items = await workItemsOf(store, idea.id);
  if (!items.every(isFinished))
    return { due: false, why: "a work item is not finished" };
  const own = await readCancelOn(store, idea, idea);
  let decisionId: string | null =
    own?.status === "cancel" ? own.cancel.decisionId : null;
  if (items.length > 0) {
    const cancelled = items.filter((i) => i.state === CANCELLED_STATE);
    if (cancelled.length === 0)
      return { due: false, why: "no work item was cancelled" };
    if (!decisionId) {
      const moves = [];
      for (const item of cancelled) {
        for (const t of await store.listTransitions(item.id)) {
          if (
            t.mode === "applied" &&
            t.toState === CANCELLED_STATE &&
            t.triggerRef?.startsWith(CANCEL_TRIGGER_PREFIX)
          )
            moves.push(t);
        }
      }
      moves.sort((a, b) => a.at.getTime() - b.at.getTime());
      const ref = moves.at(-1)?.triggerRef;
      decisionId = ref ? ref.slice(CANCEL_TRIGGER_PREFIX.length) : null;
    }
  }
  if (!decisionId) return { due: false, why: "no cancel stands on the idea" };
  if (hasActiveRun(await store.listRuns({ nodeId: idea.id }))) {
    return { due: false, why: "a run is active on the idea" };
  }
  return { due: true, decisionId };
}

/** The pull request the store records for an item: its latest dispatch's repo and CI's PR. */
export async function recordedPullRequest(
  store: Pick<StoreOps, "listEvidence">,
  nodeId: string,
): Promise<{ repo: string; number: number } | null> {
  const ci = latest(await store.listEvidence({ nodeId, kind: "ci_run" }));
  const pr = ci ? readCiRun(ci.payload)?.pr : undefined;
  const repo = field(
    latest(await store.listEvidence({ nodeId, kind: "dispatch_record" }))?.payload,
    "repo",
  );
  return typeof pr === "number" && typeof repo === "string" && repo !== ""
    ? { repo, number: pr }
    : null;
}

/** The request for Didi to confirm a Council stop (D-308 (2)). */
export function cancelRequest(
  node: Pick<Node, "id" | "projectId" | "title">,
  stop: Pick<Decision, "id" | "textVerbatim">,
  itemIds: readonly string[],
): NewGateRequest {
  return {
    projectId: node.projectId,
    nodeId: node.id,
    topicKey: cancelRequestTopic(node.id),
    kind: CANCEL_REQUEST_KIND,
    owner: "didi",
    blocking: false,
    payload: {
      question: CANCEL_REQUEST_QUESTION,
      title: node.title,
      councilDecisionId: stop.id,
      councilNote: stop.textVerbatim,
      itemIds: [...itemIds],
    },
  };
}

/** What the step did, or would do, for one work item. */
export interface CancelItemStep {
  nodeId: string;
  result:
    /** Moved to Cancelled now. */
    | "cancelled"
    /** Already Done or Cancelled: left as it is. */
    | "finished"
    /** Merged and in Verifying on staging: it finishes normally (D-308 (6)). */
    | "finishes_normally"
    /** A run is active on it: it waits for the run to end. */
    | "waiting_for_run"
    /** The Council's stop waits for Didi's answer on the cancel request. */
    | "with_didi"
    /** In dry run: the move the step would ask for. */
    | "would_cancel"
    /** The library refused the move; `reason` and `failedGuards` say why. */
    | "refused";
  how?: CancelHow;
  reason?: string;
  failedGuards?: string[];
  /** The pull request the store records for it, left open (O-97). */
  pullRequest: { repo: string; number: number } | null;
}

/** What the cancel step found or did for one idea, or one work item with no idea. */
export type CancelStep =
  | {
      nodeId: string;
      step: "not_due";
      why:
        /** No such node. */
        | "no_node"
        /** No cancel or Council stop stands on it or its items. */
        | "nothing_stands"
        /** Everything is finished, and the idea's move, if any, was taken. */
        | "finished";
    }
  /** Not acted on: the kill switch or dry run holds it. In dry run, what it would do. */
  | {
      nodeId: string;
      step: "held";
      reason: "kill_switch" | "dry_run";
      items: CancelItemStep[];
      /** Nodes a request for Didi would be opened on. */
      wouldAsk: string[];
      ideaMove: "would_reject" | "waits" | null;
    }
  /** The cancel, as far as it went: each request for Didi, each item, then the idea's move. */
  | {
      nodeId: string;
      step: "acted";
      /** Requests for Didi to confirm a Council stop, opened now or already open. */
      requests: { nodeId: string; gateRequestId: string }[];
      items: CancelItemStep[];
      idea:
        | { outcome: TransitionOutcome; reason?: string; failedGuards: string[] }
        /** An item is not finished yet, no item was cancelled, or a run is active on the idea. */
        | "waits"
        /** No idea, or the idea has no cancel move out of its state. */
        | null;
    };

export interface CancelDeps {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/** What `cancelByDidi` did with Didi's cancel. */
export type DidiCancel =
  | { recorded: true | "already_recorded"; decisionId: string; step: CancelStep }
  | {
      recorded: false;
      reason:
        | "kill_switch"
        | "dry_run"
        | "no_node"
        | "not_a_work_item"
        | "finished"
        /** Merged and in Verifying on staging: it finishes normally (D-308 (6)). */
        | "finishes_normally"
        | "no_reason";
      /** In dry run: what the cancel would do. */
      plan?: CancelItemStep;
    };

const failedGuards = (report: { name: string; pass: boolean }[]): string[] =>
  report.filter((c) => !c.pass).map((c) => c.name);

export function createCancels(deps: CancelDeps) {
  const { store, contracts, clock, ids } = deps;
  const library = createLibrary(deps);

  async function switches(): Promise<"kill_switch" | "dry_run" | null> {
    if ((await store.getSetting("kill_switch"))?.value === true) return "kill_switch";
    // A missing setting means dry run, as in the library.
    if ((await store.getSetting("dry_run"))?.value !== false) return "dry_run";
    return null;
  }

  /** Whether the contracts have a cancel move out of the node's state for its track. */
  const hasCancelMove = (node: Node, to: string): boolean =>
    contracts.transitions.some(
      (m) =>
        m.from === node.state &&
        m.to === to &&
        m.guards.includes(CANCEL_GUARD) &&
        (!m.tracks || (node.track !== null && m.tracks.includes(node.track))),
    );

  /** The idea, or the item when it has no idea, the step works on for a node. */
  async function rootOf(
    nodeId: string,
  ): Promise<{ root: Node; idea: Node | null } | null> {
    const node = await store.getNode(nodeId);
    if (!node) return null;
    const idea = await ideaOf(store, node);
    return { root: idea ?? node, idea };
  }

  /** The item's step without a move: finished, merged, waiting on a run; null when a move is due. */
  async function before(item: Node): Promise<CancelItemStep["result"] | null> {
    if (isFinished(item)) return "finished";
    if (!hasCancelMove(item, CANCELLED_STATE)) return "finishes_normally";
    if (hasActiveRun(await store.listRuns({ nodeId: item.id })))
      return "waiting_for_run";
    return null;
  }

  /** Every node of the root with a stop waiting for Didi, and the items it covers. */
  async function asks(
    idea: Node | null,
    items: readonly Node[],
  ): Promise<{ node: Node; stop: CurrentDecision; itemIds: string[] }[]> {
    const found: { node: Node; stop: CurrentDecision; itemIds: string[] }[] = [];
    if (idea) {
      const on = await readCancelOn(store, idea, idea);
      if (on?.status === "ask_didi")
        found.push({
          node: idea,
          stop: on.stop,
          itemIds: items.filter((i) => !isFinished(i)).map((i) => i.id),
        });
    }
    for (const item of items) {
      if (isFinished(item)) continue;
      const on = await readCancelOn(store, item, idea);
      if (on?.status === "ask_didi")
        found.push({ node: item, stop: on.stop, itemIds: [item.id] });
    }
    return found;
  }

  /** Opens the request for Didi on a stop once; a request already opened for it is kept. */
  async function ask(
    node: Node,
    stop: CurrentDecision,
    itemIds: string[],
  ): Promise<string> {
    return store.transaction(async (tx) => {
      await tx.getNodeForUpdate(node.id);
      const earlier = await askedDidiAbout(tx, node, stop);
      if (earlier) return earlier.id;
      const gate = await library.openGateRequestWith(
        tx,
        cancelRequest(node, stop, itemIds),
      );
      return gate.id;
    });
  }

  async function due(
    nodeId: string,
  ): Promise<
    | { root: Node; idea: Node | null; items: Node[] }
    | Extract<CancelStep, { step: "not_due" }>
  > {
    const found = await rootOf(nodeId);
    if (!found) return { nodeId, step: "not_due", why: "no_node" };
    const { root, idea } = found;
    const items = idea ? await workItemsOf(store, idea.id) : [root];
    let stands = false;
    let work = false;
    const notAsked = async (on: CancelOn): Promise<boolean> => {
      if (on?.status !== "ask_didi") return false;
      const node = on.nodeId === root.id ? root : await store.getNode(on.nodeId);
      return (
        node !== null && (await askedDidiAbout(store, node, on.stop)) === undefined
      );
    };
    for (const item of items) {
      const on = await readCancelOfItem(store, item, idea);
      if (!on) continue;
      stands = true;
      if (isFinished(item)) continue;
      if (on.status === "cancel" && hasCancelMove(item, CANCELLED_STATE)) work = true;
      if (await notAsked(on)) work = true;
    }
    if (idea) {
      const ideaOn = await readCancelOn(store, idea, idea);
      if (ideaOn) stands = true;
      if (await notAsked(ideaOn)) work = true;
      if (items.some((i) => i.state === CANCELLED_STATE)) stands = true;
      if ((await rejectionStep(idea)) === "due") work = true;
    }
    if (!stands) return { nodeId: root.id, step: "not_due", why: "nothing_stands" };
    if (!work) return { nodeId: root.id, step: "not_due", why: "finished" };
    return { root, idea, items };
  }

  /** Whether the idea's move is due now, already taken, or not possible from its state. */
  async function rejectionStep(
    idea: Node,
  ): Promise<"due" | "taken" | "waits" | "no_move"> {
    const check = await ideaRejectionDue(store, idea);
    if (!check.due) return "waits";
    const taken = (await store.listTransitions(idea.id)).some(
      (t) =>
        t.toState === CANCELLED_IDEA_STATE &&
        t.triggerRef === `${CANCEL_TRIGGER_PREFIX}${check.decisionId}`,
    );
    if (taken) return "taken";
    return hasCancelMove(idea, CANCELLED_IDEA_STATE) ? "due" : "no_move";
  }

  async function cancelItem(
    item: Node,
    cancel: StandingCancel,
  ): Promise<CancelItemStep> {
    const result = await library.requestTransitionOnce(
      {
        nodeId: item.id,
        toState: CANCELLED_STATE,
        trigger: { kind: "event", ref: `${CANCEL_TRIGGER_PREFIX}${cancel.decisionId}` },
        actor: CANCEL_ACTOR,
        reason: CANCEL_REASONS[cancel.how],
        runnerOnly: true,
        guardedBy: CANCEL_GUARD,
      },
      async (tx) => {
        // The item's open requests end with it: nobody needs to answer them now.
        const at = clock.now();
        for (const gate of await tx.listGateRequestsForNode(item.id)) {
          if (gate.status === "open")
            await tx.closeGateRequest(gate.id, { status: "cancelled", at });
        }
        return null;
      },
    );
    const moved = result.outcome === "applied" || result.outcome === "noop";
    return {
      nodeId: item.id,
      result: moved ? "cancelled" : "refused",
      how: cancel.how,
      ...(moved
        ? {}
        : {
            reason: result.reason ?? result.outcome,
            failedGuards: failedGuards(result.guardReport),
          }),
      pullRequest: await recordedPullRequest(store, item.id),
    };
  }

  const cancels = {
    /**
     * The ideas, and work items with no idea, the step is due on: a cancel or a Council stop
     * stands and something is still to do. Reads only.
     */
    async pending(): Promise<string[]> {
      const roots = new Set<string>();
      for (const node of await store.listNodes({})) {
        if (node.type === "work_item" && isFinished(node)) continue;
        const decisions = await store.listDecisionsForNode(node.id);
        const recorded =
          didiCancelOf(node.id, decisions) !== null ||
          standingStop(node, decisions) !== null;
        if (!recorded && node.type === "work_item") continue;
        const found = await due(node.id);
        if (!("step" in found)) roots.add(found.root.id);
      }
      return [...roots];
    },

    /** The root the step works on for a node whose run just ended, when the step is due. */
    async pendingRootOf(nodeId: string): Promise<string | null> {
      const found = await due(nodeId);
      return "step" in found ? null : found.root.id;
    },

    /**
     * One step of the cancel on an idea, or a work item with no idea (D-308): open a request for
     * Didi on each Council stop that needs Didi's word, cancel each work item a cancel stands on,
     * then move the idea to Rejected once that is due. Repeating it writes nothing more.
     */
    async step(nodeId: string): Promise<CancelStep> {
      const held = await switches();
      if (held === "kill_switch") {
        return {
          nodeId,
          step: "held",
          reason: held,
          items: [],
          wouldAsk: [],
          ideaMove: null,
        };
      }
      const found = await due(nodeId);
      if ("step" in found) return found;
      const { root, idea, items } = found;
      const pending: { node: Node; stop: CurrentDecision; itemIds: string[] }[] = [];
      for (const p of await asks(idea, items)) {
        if (!(await askedDidiAbout(store, p.node, p.stop))) pending.push(p);
      }

      if (held === "dry_run") {
        const planned: CancelItemStep[] = [];
        for (const item of items) {
          const on = await readCancelOfItem(store, item, idea);
          if (!on) continue;
          const early = await before(item);
          planned.push({
            nodeId: item.id,
            result: early ?? (on.status === "cancel" ? "would_cancel" : "with_didi"),
            ...(on.status === "cancel" ? { how: on.cancel.how } : {}),
            pullRequest: await recordedPullRequest(store, item.id),
          });
        }
        const rejection = idea ? await rejectionStep(idea) : null;
        const willFinish = planned.every((p) =>
          ["finished", "would_cancel"].includes(p.result),
        );
        return {
          nodeId: root.id,
          step: "held",
          reason: held,
          items: planned,
          wouldAsk: pending.map((p) => p.node.id),
          ideaMove:
            idea === null
              ? null
              : rejection === "due" ||
                  (willFinish && planned.some((p) => p.result === "would_cancel"))
                ? "would_reject"
                : "waits",
        };
      }

      const requests: { nodeId: string; gateRequestId: string }[] = [];
      for (const p of pending) {
        requests.push({
          nodeId: p.node.id,
          gateRequestId: await ask(p.node, p.stop, p.itemIds),
        });
      }
      const steps: CancelItemStep[] = [];
      for (const item of items) {
        const on = await readCancelOfItem(store, item, idea);
        if (!on) continue;
        const early = await before(item);
        if (early || on.status === "ask_didi") {
          steps.push({
            nodeId: item.id,
            result: early ?? "with_didi",
            ...(on.status === "cancel" ? { how: on.cancel.how } : {}),
            pullRequest: await recordedPullRequest(store, item.id),
          });
          continue;
        }
        steps.push(await cancelItem(item, on.cancel));
      }

      if (!idea)
        return { nodeId: root.id, step: "acted", requests, items: steps, idea: null };
      const fresh = (await store.getNode(idea.id)) ?? idea;
      const rejection = await rejectionStep(fresh);
      if (rejection !== "due") {
        return {
          nodeId: root.id,
          step: "acted",
          requests,
          items: steps,
          idea: rejection === "no_move" || rejection === "taken" ? null : "waits",
        };
      }
      const check = await ideaRejectionDue(store, fresh);
      if (!check.due) {
        return {
          nodeId: root.id,
          step: "acted",
          requests,
          items: steps,
          idea: "waits",
        };
      }
      const how = await howOf(check.decisionId);
      const moved = await library.requestTransitionOnce({
        nodeId: fresh.id,
        toState: CANCELLED_IDEA_STATE,
        trigger: { kind: "event", ref: `${CANCEL_TRIGGER_PREFIX}${check.decisionId}` },
        actor: CANCEL_ACTOR,
        reason: CANCEL_REASONS[how],
        runnerOnly: true,
        guardedBy: CANCEL_GUARD,
      });
      return {
        nodeId: root.id,
        step: "acted",
        requests,
        items: steps,
        idea: {
          outcome: moved.outcome,
          ...(moved.reason ? { reason: moved.reason } : {}),
          failedGuards: failedGuards(moved.guardReport),
        },
      };
    },

    /**
     * Didi's own cancel of a work item (D-308 (2)), from the called flow `f/foreman/cancel_item`:
     * records Didi's reason as an `answer` by Didi on the item, once while it stands, then takes
     * the step. An item already finished, a merged item in Verifying on staging (it finishes
     * normally), or a blank reason, records nothing. Under the kill
     * switch nothing is written; in dry run nothing is written and the result says what it would
     * do.
     */
    async cancelByDidi(nodeId: string, reason: string): Promise<DidiCancel> {
      const held = await switches();
      if (held === "kill_switch") return { recorded: false, reason: held };
      const node = await store.getNode(nodeId);
      if (!node) return { recorded: false, reason: "no_node" };
      if (node.type !== "work_item")
        return { recorded: false, reason: "not_a_work_item" };
      if (isFinished(node)) return { recorded: false, reason: "finished" };
      if (!hasCancelMove(node, CANCELLED_STATE))
        return { recorded: false, reason: "finishes_normally" };
      const text = reason.trim();
      if (text === "") return { recorded: false, reason: "no_reason" };
      if (held === "dry_run") {
        return {
          recorded: false,
          reason: held,
          plan: {
            nodeId,
            result: (await before(node)) ?? "would_cancel",
            how: "didi",
            pullRequest: await recordedPullRequest(store, nodeId),
          },
        };
      }
      const written = await store.transaction(async (tx) => {
        await tx.getNodeForUpdate(nodeId);
        const earlier = didiCancelOf(nodeId, await tx.listDecisionsForNode(nodeId));
        if (earlier)
          return { recorded: "already_recorded" as const, decisionId: earlier.id };
        const decision: Decision = {
          id: ids.next(),
          projectId: node.projectId,
          nodeId,
          kind: "answer",
          scope: { kind: DIDI_CANCEL_KIND, via: "cancel_item" },
          textVerbatim: cut(text, DIDI_CANCEL_REASON_CHARS),
          byActor: "didi",
          recordedAt: clock.now(),
        };
        await tx.insertDecision(decision);
        return { recorded: true as const, decisionId: decision.id };
      });
      return { ...written, step: await cancels.step(nodeId) };
    },
  };

  /** How a decision a move names let the cancel stand, from the decision itself. */
  async function howOf(decisionId: string): Promise<CancelHow> {
    const d = await store.getDecision(decisionId);
    if (!d || d.byActor !== "didi") return "council";
    return d.kind === "approval" ? "didi_confirmed" : "didi";
  }

  return cancels;
}

export type Cancels = ReturnType<typeof createCancels>;

/** `f/foreman/cancel_item`'s reason, cut as it is kept. */
export const didiCancelReason = (text: string): string =>
  cut(text.trim(), DIDI_CANCEL_REASON_CHARS);
