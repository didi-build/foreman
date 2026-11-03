// The Council's call on a visual approval (D-263, D-270, N-63). In the first release Didi approves
// every visual change. For each `visual_approval` request owned by Didi, the Council also makes its
// own call from the same option screenshots Didi sees: "a small tweak the Council would approve"
// or "needs Didi". The runner records the call next to Didi's answer, so Didi can later decide
// whether small tweaks move to the Council once the two agree reliably.
//
// The call is a Council question kind of its own, `visual_call` (src/core/council.ts). It is open
// while a `visual_approval` request owned by Didi is open on an item and no call is recorded for
// that request. Its run has task type `council:visual`, so it is routed to a model that reads
// images; the routing policy has no entry for it until the model test picks one (D-249), and its
// dispatch is refused with `no_route` until then. The run gets the item, the request's options,
// and each option's screenshot as an image: the `screenshot` evidence the runner recorded for that
// option, read from CI's options bundle at its capture commit through the `ScreenshotBundles` port
// and checked against its SHA-256 (as QA's visual comparison reads it, ./visual-comparison.ts).
//
// The runner checks the answer against `output_schemas.visual_call` in the Council's bot file and
// the rules below (D-228), and records it itself (D-230) as a `council_decision` on the item with
// `scope {topicKey: "visual-call:<item id>", gateRequestId, call, runId}`. That topic is not the
// visual-approval topic, so `approval_recorded` and `changes_requested_recorded` never read it
// (./guards/design.ts). The call never answers or changes the request, opens nothing for Didi and
// changes nothing that reaches Didi. An unusable answer gets one re-run; after that the call is
// recorded as dropped (`call: "dropped"`) and nothing else happens.
//
// `visualCallPairs` is the read-only view for D-263's later handoff decision: each recorded call
// with Didi's answer on the same request.
//
// Plain logic over an injected store and screenshot port (D-162). Refusals and problems are fixed
// text and never quote a file, an answer or an id.
import { createHash } from "node:crypto";

import { visualApprovalTopic } from "./guards/design.ts";
import { latest } from "./guards/evidence.ts";
import type { CurrentDecision, GateRequest, Json, StoreOps } from "./store.ts";
import {
  readOptionScreenshot,
  type ScreenshotBundle,
  type ScreenshotBundles,
  type VisualImage,
} from "./visual-comparison.ts";

/** The topic key prefix of the call, `visual-call:<item id>`. */
export const VISUAL_CALL_PREFIX = "visual-call:";
export const visualCallTopic = (nodeId: string): string =>
  `${VISUAL_CALL_PREFIX}${nodeId}`;

/** The Council task type of the call (contracts/task-types.yaml). */
export const VISUAL_CALL_TASK_TYPE = "council:visual";

/** The two calls the Council may make (D-263). */
export const VISUAL_CALLS = [
  "small_tweak_council_would_approve",
  "needs_didi",
] as const;
export type VisualCall = (typeof VISUAL_CALLS)[number];

/** What the runner records when neither run gave a usable answer. */
export const VISUAL_CALL_DROPPED = "dropped";
export const VISUAL_CALL_DROPPED_TEXT =
  "The Council gave no usable call on this visual approval after its run and one re-run. The call was dropped.";

export const VISUAL_CALL_LIMITS = {
  /** The reason, after trimming. */
  reasonChars: 1000,
  /** Options shown in one run: one image each. */
  options: 10,
} as const;

export interface VisualCallQuestion {
  kind: "visual_call";
  topicKey: string;
  projectId: string;
  /** The item the request is on; the Council's run is on it. */
  nodeId: string;
  /** When the visual-approval request was opened. */
  openedAt: Date;
  gateRequestId: string;
  /** The option names the request lists (`payload.options`). */
  options: string[];
}

export interface VisualCallAnswer {
  call: VisualCall;
  reason: string;
}

export type VisualCallRefusal =
  | "no_options"
  | "too_many_options"
  | "no_screenshots_port"
  | "no_option_screenshot"
  | "option_bundle_missing"
  | "option_file_changed";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scopeOf = (decision: Pick<CurrentDecision, "scope">): { [key: string]: Json } =>
  isObject(decision.scope) ? (decision.scope as { [key: string]: Json }) : {};

/** The option names a request lists. Only text entries count. */
function optionsOf(gate: GateRequest): string[] {
  const options = isObject(gate.payload) ? gate.payload.options : undefined;
  return Array.isArray(options)
    ? options.filter((o): o is string => typeof o === "string")
    : [];
}

/**
 * The call question a gate request opens, before checking for a recorded call: an open
 * `visual_approval` request owned by Didi on its item's visual-approval topic. Null otherwise.
 */
export function visualCallRequest(gate: GateRequest): VisualCallQuestion | null {
  if (
    gate.status !== "open" ||
    gate.kind !== "visual_approval" ||
    gate.owner !== "didi" ||
    gate.nodeId === null ||
    gate.topicKey !== visualApprovalTopic(gate.nodeId)
  ) {
    return null;
  }
  return {
    kind: "visual_call",
    topicKey: visualCallTopic(gate.nodeId),
    projectId: gate.projectId,
    nodeId: gate.nodeId,
    openedAt: gate.createdAt,
    gateRequestId: gate.id,
    options: optionsOf(gate),
  };
}

/** The call recorded for a request, if any: an answer or a drop. */
export function recordedCall(
  decisions: readonly CurrentDecision[],
  nodeId: string,
  gateRequestId: string,
): CurrentDecision | undefined {
  const topic = visualCallTopic(nodeId);
  return decisions.find(
    (d) =>
      d.kind === "council_decision" &&
      scopeOf(d).topicKey === topic &&
      scopeOf(d).gateRequestId === gateRequestId,
  );
}

/**
 * Reads a call that already fits the bot file's schema, by the runner's own rules: exactly `call`
 * and `reason`, `call` one of the two, `reason` 1 to 1,000 characters after trimming. Problems name
 * the field, never its value.
 */
export function readVisualCallAnswer(
  value: unknown,
): { answer: VisualCallAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const keys = Object.keys(value).sort().join();
  if (keys !== "call,reason")
    return { problem: "the answer must hold exactly call and reason" };
  const { call, reason } = value;
  if (typeof call !== "string" || !(VISUAL_CALLS as readonly string[]).includes(call)) {
    return { problem: "call must be small_tweak_council_would_approve or needs_didi" };
  }
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text === "" || text.length > VISUAL_CALL_LIMITS.reasonChars) {
    return {
      problem: `reason must be 1 to ${VISUAL_CALL_LIMITS.reasonChars} characters`,
    };
  }
  return { answer: { call: call as VisualCall, reason: text } };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The option screenshots for the call, one per option in the request's order, each labelled by
 * the runner: the latest `screenshot` evidence the runner recorded for the option (with its
 * capture commit), read from CI's options bundle at that commit and checked against its hash.
 * Any missing piece refuses, so the run is not started.
 */
export async function visualCallImages(
  store: Pick<StoreOps, "listEvidence" | "getNode" | "getProject">,
  screenshots: ScreenshotBundles | undefined,
  q: Pick<VisualCallQuestion, "nodeId" | "options">,
): Promise<{ images: VisualImage[] } | { refused: VisualCallRefusal }> {
  if (q.options.length === 0) return { refused: "no_options" };
  if (q.options.length > VISUAL_CALL_LIMITS.options)
    return { refused: "too_many_options" };
  if (!screenshots) return { refused: "no_screenshots_port" };
  const node = await store.getNode(q.nodeId);
  const project = node && (await store.getProject(node.projectId));
  if (!project) return { refused: "no_option_screenshot" };
  const shots = await store.listEvidence({ nodeId: q.nodeId, kind: "screenshot" });
  const bundles = new Map<string, ScreenshotBundle | null>();
  const images: VisualImage[] = [];
  for (const [i, name] of q.options.entries()) {
    const shot = latest(
      shots.filter(
        (e) => e.commitSha !== null && readOptionScreenshot(e.payload)?.option === name,
      ),
    );
    const payload = shot ? readOptionScreenshot(shot.payload) : null;
    if (!shot?.commitSha || !payload) return { refused: "no_option_screenshot" };
    if (!bundles.has(shot.commitSha)) {
      bundles.set(
        shot.commitSha,
        await screenshots.read(project.repo, shot.commitSha, "options"),
      );
    }
    const bundle = bundles.get(shot.commitSha);
    if (!bundle) return { refused: "option_bundle_missing" };
    const bytes = await bundle.file(payload.file);
    if (!bytes || sha256(bytes) !== payload.sha256)
      return { refused: "option_file_changed" };
    // The name passed the option pattern (readOptionScreenshot), so the label is the runner's.
    images.push({ label: `Image ${i + 1}: option ${payload.option}`, png: bytes });
  }
  return { images };
}

// ---- The pairing with Didi's answer (D-263) ------------------------------------------------------

export type DidiOutcome = "approved" | "changes_requested" | "rejected";

export interface VisualCallPair {
  nodeId: string;
  gateRequestId: string;
  /** The `council_decision` that holds the call. */
  callDecisionId: string;
  call: VisualCall | typeof VISUAL_CALL_DROPPED;
  calledAt: Date;
  /** Didi's latest active answer on the same request, if any. */
  didi: { decisionId: string; outcome: DidiOutcome; answeredAt: Date } | null;
  /**
   * Measured against Didi's own judgement of size on the approval form (D-278): `agree` when
   * the Council's call (small tweak or needs Didi) matches Didi's answer to "this was a small
   * tweak", `disagree` when it does not, `unmeasured` when Didi answered but skipped that field.
   * `no_answer_yet`: the request is still open. `no_answer`: the request closed without Didi's
   * answer (cancelled or superseded). `dropped`: the Council gave no usable call.
   */
  agreement:
    "agree" | "disagree" | "unmeasured" | "no_answer_yet" | "no_answer" | "dropped";
}

const DIDI_OUTCOMES: readonly string[] = ["approved", "changes_requested", "rejected"];

/**
 * Each recorded call with Didi's answer on the same request, oldest call first per item, on the
 * given items or on every item. Reads only; it writes and decides nothing.
 */
export async function visualCallPairs(
  store: Pick<StoreOps, "listNodes" | "listDecisionsForNode" | "getGateRequest">,
  nodeIds?: readonly string[],
): Promise<VisualCallPair[]> {
  const ids = nodeIds ?? (await store.listNodes({})).map((n) => n.id);
  const pairs: VisualCallPair[] = [];
  for (const nodeId of ids) {
    const decisions = await store.listDecisionsForNode(nodeId);
    const topic = visualCallTopic(nodeId);
    for (const d of decisions) {
      const scope = scopeOf(d);
      if (d.kind !== "council_decision" || scope.topicKey !== topic) continue;
      const gateRequestId = scope.gateRequestId;
      const call = scope.call;
      if (
        typeof gateRequestId !== "string" ||
        (call !== VISUAL_CALL_DROPPED &&
          !(VISUAL_CALLS as readonly Json[]).includes(call ?? null))
      ) {
        continue;
      }
      const answer = latest(
        decisions.filter(
          (a) =>
            a.status === "active" &&
            a.byActor === "didi" &&
            (a.kind === "approval" || a.kind === "answer") &&
            scopeOf(a).gateRequestId === gateRequestId &&
            DIDI_OUTCOMES.includes(String(scopeOf(a).outcome)),
        ),
      );
      const didi = answer
        ? {
            decisionId: answer.id,
            outcome: scopeOf(answer).outcome as DidiOutcome,
            answeredAt: answer.recordedAt,
          }
        : null;
      let agreement: VisualCallPair["agreement"];
      if (call === VISUAL_CALL_DROPPED) agreement = "dropped";
      else if (didi && answer) {
        const didiSmall = scopeOf(answer).smallTweak;
        const councilSmall = call === "small_tweak_council_would_approve";
        agreement =
          typeof didiSmall !== "boolean"
            ? "unmeasured"
            : councilSmall === didiSmall
              ? "agree"
              : "disagree";
      } else {
        const gate = await store.getGateRequest(gateRequestId);
        agreement = gate?.status === "open" ? "no_answer_yet" : "no_answer";
      }
      pairs.push({
        nodeId,
        gateRequestId,
        callDecisionId: d.id,
        call: call as VisualCallPair["call"],
        calledAt: d.recordedAt,
        didi,
        agreement,
      });
    }
  }
  return pairs;
}
