// The reply an approval page sends back when a suspended flow resumes (M0.4, D-170, D-200,
// D-254). Windmill hands the step after a `suspend` two values: `resume`, the form's fields, or an
// error object when the request timed out or was cancelled; and `approvers`, which is
// `["anonymous"]` on the free plan. The form (flows/windmill.yaml) has three fields: `decision`,
// one of the page's three labels; `options`, the request's options Didi picked (a multi-select
// whose choices the approval step fills per request, `approvalFormEnums`); and `feedback`, Didi's
// words. A request opened before D-254 shows the older form, `answer` (Approve, Reject or Changes
// requested), `reply` and, on a visual approval, an `option` field; that shape is still read.
// This reads the shape and nothing more; whether the answer keeps the form's rules is
// `approvalAnswerProblem` in the core, and what an answer records is `approvalDecision`.
import {
  APPROVAL_CHOICE_LABELS,
  OLDER_FORM_CHOICE_LABELS,
  approvalAnswerProblem,
  type ApprovalPageAnswer,
} from "../../src/core/approvals.ts";
import {
  REVERSAL_PREFIX,
  STILL_NEEDED_PREFIX,
  type FollowUpStep,
} from "../../src/core/council.ts";
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import {
  createHoldReleases,
  HOLD_RELEASE_PREFIX,
  type HoldReleaseStep,
} from "../../src/core/hold-release.ts";
import {
  CANCEL_REQUEST_PREFIX,
  createCancels,
  type CancelStep,
} from "../../src/core/cancel.ts";
import { createLibrary } from "../../src/core/library.ts";
import {
  createMerges,
  privilegedPathTopic,
  type MergeResult,
} from "../../src/core/merge.ts";
import {
  createStillNeeded,
  type StillNeededOpen,
} from "../../src/core/still-needed.ts";
import {
  councilPlanTopic,
  createPlanApprovals,
  PLAN_APPROVAL_PREFIX,
  type PlanApprovalStep,
} from "../../src/core/plans.ts";
import type { GateRequest, Json } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import type { BuilderRunStart } from "./builder-runs.ts";
import {
  afterEscalationReturned,
  councilPass,
  followUpPass,
  type CouncilPassStep,
} from "./council-runs.ts";
import { startReadyRuns, type ReadyRunStart } from "./ready-runs.ts";
import { heldBy } from "./switches.ts";
import { triagePass, type TriagePassStep } from "./triage-runs.ts";

/**
 * An answer, or why there is none: Windmill's error name for a timeout or a cancel, `no_choice`
 * when the form came back without one of the three labels, or `bad_options` when its options are
 * not a list of names. `replyVerbatim` keeps any words that came back without an answer, so the
 * flow's result holds them.
 */
export type ApprovalReply =
  | ({ answered: true } & ApprovalPageAnswer & { options: string[] })
  | {
      answered: false;
      reason: string;
      replyVerbatim: string | null;
      approvers: string[];
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readApprovalReply(resume: unknown, approvers: unknown): ApprovalReply {
  const names = Array.isArray(approvers)
    ? approvers.filter((a): a is string => typeof a === "string")
    : [];
  if (isObject(resume) && isObject(resume.error)) {
    const name = resume.error.name;
    return {
      answered: false,
      reason: typeof name === "string" && name !== "" ? name : "no_answer",
      replyVerbatim: null,
      approvers: names,
    };
  }
  const fields = isObject(resume) ? resume : {};
  // The form's shape since D-254, or the older form's for a request opened before it.
  const current = Object.hasOwn(fields, "decision");
  const labels = current ? APPROVAL_CHOICE_LABELS : OLDER_FORM_CHOICE_LABELS;
  const label = current ? fields.decision : fields.answer;
  const text = current ? fields.feedback : fields.reply;
  const words = typeof text === "string" ? text : null;
  const choice =
    typeof label === "string" && Object.hasOwn(labels, label)
      ? labels[label]
      : undefined;
  if (!choice) {
    return {
      answered: false,
      reason: "no_choice",
      replyVerbatim: words,
      approvers: names,
    };
  }
  let options: string[];
  if (current) {
    const picked = fields.options ?? [];
    if (!Array.isArray(picked) || !picked.every((o) => typeof o === "string")) {
      return {
        answered: false,
        reason: "bad_options",
        replyVerbatim: words,
        approvers: names,
      };
    }
    options = picked as string[];
  } else {
    // The older form's one option name, when its page sent one (O-66).
    options = typeof fields.option === "string" ? [fields.option] : [];
  }
  // D-278: Didi's own call on the change's size, only when Didi picked one of the two labels.
  const size = current ? SMALL_TWEAK_LABELS[String(fields.small_tweak)] : undefined;
  return {
    answered: true,
    choice,
    words,
    approvers: names,
    options,
    ...(size === undefined ? {} : { smallTweak: size }),
  };
}

/** The labels of the form's optional size field (flows/windmill.yaml, D-278). */
export const SMALL_TWEAK_LABELS: Readonly<Record<string, boolean>> = {
  "Yes, a small tweak": true,
  "No, not a small tweak": false,
};

/** A fresh request opened because an answer broke one of the form's rules (D-254). */
export interface ReopenedRequest {
  /** The fresh request on the same topic; the answered one is superseded and records nothing. */
  gateRequestId: string;
  /** The one-line note on the fresh request saying why, fixed text. */
  note: string;
}

/**
 * The form's rules, checked after it was sent (D-254). An answer that keeps them returns null.
 * One that breaks a rule records nothing: a fresh request opens on the same topic, with the same
 * kind, owner and payload and the one-line note as `payload.note`, through the library's
 * `openGateRequest`, which supersedes the answered one (schema invariant 5). Windmill closed the
 * old page with that answer, so this is the only way the question stays open; like recording an
 * answer (D-201), it is done whatever the kill switch and dry run say. The approval step sends
 * the fresh request's page as it sends any (M4.1).
 */
export async function reopenIfAnswerBreaksRules(
  deps: FlowDeps,
  gate: GateRequest,
  answer: ApprovalPageAnswer,
): Promise<ReopenedRequest | null> {
  const note = approvalAnswerProblem(gate, answer);
  if (note === null) return null;
  const payload: { [key: string]: Json } = isObject(gate.payload)
    ? { ...(gate.payload as { [key: string]: Json }) }
    : {};
  const fresh = await createLibrary(deps).openGateRequest({
    projectId: gate.projectId,
    nodeId: gate.nodeId,
    topicKey: gate.topicKey,
    kind: gate.kind,
    owner: gate.owner,
    blocking: gate.blocking,
    payload: { ...payload, note },
  });
  return { gateRequestId: fresh.id, note };
}

/** What the step reports after an answer is recorded. */
export interface AfterAnswer {
  /** Why nothing acts on the answer yet, if anything holds it (D-201). */
  heldBy: "kill_switch" | "dry_run" | null;
  /** For an escalation question: what the move out of Escalated to Didi did. */
  escalation?: EscalationStep;
  /**
   * After that move took a work item back to its building state: its fix round (O-41, O-104), as
   * the Council's answer starts it at its run's end. Only when no switch holds the runner.
   */
  builderRuns?: BuilderRunStart[];
  /** After that move took an idea back to Triage: its next Triage run (M3.6). */
  triage?: TriagePassStep[];
  /**
   * For a reversal's question to Didi (D-234): the follow-up Council question it opened, if any,
   * and the Council pass on the topic, which starts the follow-up run.
   */
  reversal?: { followUp: FollowUpStep[]; council: CouncilPassStep[] };
  /**
   * For a held item's release request (D-269): whether the runner cleared the hold flag. Only
   * Didi's Approve releases it; the reconcile flow's hold release pass asks again if this step
   * is held by a switch or cut short.
   */
  holdRelease?: HoldReleaseStep;
  /**
   * For a plan-approval request (D-266): the idea's move on Didi's answer, and on Approve the
   * Triage pass for the idea, which starts Triage as M3.6 built. The reconcile flow's plan
   * approval pass asks again if this step is held by a switch or cut short.
   */
  plan?: {
    step: PlanApprovalStep;
    triage: TriagePassStep[];
    /**
     * On Reject or Request changes on a Council plan: the Council pass on the idea's planning
     * topic, which starts the replan with Didi's words (D-316 (3)). Empty when no replan is due.
     */
    council: CouncilPassStep[];
  };
  /**
   * For a request to confirm a Council stop (D-308): the cancel step, which cancels on Didi's
   * Approve and does nothing on Reject. The reconcile flow's cancel pass asks again if this step
   * is held by a switch or cut short.
   */
  cancel?: CancelStep;
  /**
   * The first run of the request's item when the answer left it ready (D-329): its hold
   * released, its escalation returned it to a ready state, or the closed request was all that
   * held it (a needsDidi request from the Triage handoff). Only when no switch holds the runner.
   */
  firstRuns?: ReadyRunStart[];
  /**
   * For a privileged-path request (N-82): on Didi's Approve, the item's merge at once through the
   * same merge path and guards as the reconcile flow's merge pass, then the merged-change check
   * (D-308 (3)) and the Council pass on any question it opened. Only when no switch holds the
   * runner; the merge pass takes it on otherwise.
   */
  privilegedMerge?: {
    merge: MergeResult;
    stillNeeded: StillNeededOpen[];
    council: CouncilPassStep[];
  };
}

/**
 * After an answer is recorded: what holds it, and for an escalation question the item's move back
 * out of Escalated to Didi (M3.5, src/core/escalations.ts). The guards decide that move, and the
 * kill switch and dry run hold it as for every move; the reconcile flow's escalation pass asks
 * again if this step is cut short. For a reversal's question to Didi (an `escalation` request on
 * a `decision-reversed:` topic), the follow-up Council question opens and its run starts
 * (D-234), in live mode only; the reconcile flow's follow-up pass opens it later otherwise. For a
 * held item's release request (D-269), the runner clears the hold flag on Didi's Approve
 * (src/core/hold-release.ts). For a plan-approval request (D-266), the idea moves into Plan
 * accepted on Approve, with `plan_accepted` recorded by the runner, and Triage starts; Reject or
 * Request changes sends an idea in Submitted back to Council planning (src/core/plans.ts), and
 * on a Council plan the Council pass starts its replan with Didi's words (D-316 (3)). For a
 * privileged-path request, Didi's Approve merges the item at once through the merge pass's own
 * path, then runs the merged-change check, when no switch holds the runner (N-82, D-334). Any
 * other gate kind asks for nothing of its own. Last, when no switch holds the runner, the request's item
 * gets its first run if the answer left it ready (D-329, ./ready-runs.ts): the check decides, so
 * an item still held, blocked, gated or running gets nothing. An escalation Didi's answer returned
 * to a building state starts the item's fix round instead, and an idea returned to Triage its
 * Triage run, as the Council's answer does at its run's end (`afterEscalationReturned`, O-104);
 * also only when no switch holds the runner, so the builder runs pass takes it on later.
 */
export async function afterAnswer(
  deps: FlowDeps,
  gate: GateRequest,
): Promise<AfterAnswer> {
  const escalation =
    gate.kind === "escalation" &&
    gate.nodeId &&
    gate.topicKey === escalationTopic(gate.nodeId)
      ? await createEscalations(deps).resolve(gate.nodeId)
      : undefined;
  let reversal: AfterAnswer["reversal"];
  if (
    gate.kind === "escalation" &&
    gate.owner === "didi" &&
    gate.topicKey.startsWith(REVERSAL_PREFIX)
  ) {
    const followUp = await followUpPass(deps, [gate.topicKey]);
    const opened = followUp.some((s) => s.step === "opened");
    reversal = {
      followUp,
      council: opened ? await councilPass(deps, [gate.topicKey]) : [],
    };
  }
  const holdRelease =
    gate.nodeId && gate.topicKey === `${HOLD_RELEASE_PREFIX}${gate.nodeId}`
      ? await createHoldReleases(deps).release(gate.nodeId)
      : undefined;
  const cancel =
    gate.nodeId && gate.topicKey === `${CANCEL_REQUEST_PREFIX}${gate.nodeId}`
      ? await createCancels(deps).step(gate.nodeId)
      : undefined;
  let plan: AfterAnswer["plan"];
  if (gate.nodeId && gate.topicKey === `${PLAN_APPROVAL_PREFIX}${gate.nodeId}`) {
    const step = await createPlanApprovals(deps).step(gate.nodeId);
    const accepted = step.step === "accepted" && step.move.outcome === "applied";
    plan = {
      step,
      triage: accepted ? await triagePass(deps, [gate.nodeId]) : [],
      council: accepted ? [] : await councilPass(deps, [councilPlanTopic(gate.nodeId)]),
    };
  }
  const held = await heldBy(deps.store);
  const returned =
    escalation?.step === "returned" && held === null
      ? await afterEscalationReturned(deps, escalation.nodeId)
      : undefined;
  const privilegedMerge =
    held === null ? await mergeOnPrivilegedApproval(deps, gate) : undefined;
  const firstRuns =
    gate.nodeId && held === null ? await startReadyRuns(deps, [gate.nodeId]) : [];
  return {
    heldBy: held,
    ...(escalation ? { escalation } : {}),
    ...(returned && returned.builderRuns.length > 0
      ? { builderRuns: returned.builderRuns }
      : {}),
    ...(returned?.triage ? { triage: returned.triage } : {}),
    ...(reversal ? { reversal } : {}),
    ...(holdRelease ? { holdRelease } : {}),
    ...(plan ? { plan } : {}),
    ...(cancel ? { cancel } : {}),
    ...(firstRuns.length > 0 ? { firstRuns } : {}),
    ...(privilegedMerge ? { privilegedMerge } : {}),
  };
}

/**
 * Didi's Approve of a privileged-path request merges the item at once (N-82, D-334), through the
 * merge pass's own path: `mergeOnPass` checks the same guards, and `privileged_paths_approved`
 * reads Didi's approval for this head, so an approval for an older head merges nothing. Any other
 * answer does nothing here, so a Reject never opens a fresh request at once; the merge pass reads
 * it as before. After a merge, the merged-change check runs as it does after the merge pass, and
 * the Council pass starts the run of any question it opened. Read again from the store: the
 * request passed in may be the one read before the answer was recorded.
 */
async function mergeOnPrivilegedApproval(
  deps: FlowDeps,
  gate: GateRequest,
): Promise<AfterAnswer["privilegedMerge"]> {
  const nodeId = gate.nodeId;
  if (gate.kind !== "privileged_path" || !nodeId) return undefined;
  if (gate.topicKey !== privilegedPathTopic(nodeId)) return undefined;
  const closed = await deps.store.getGateRequest(gate.id);
  if (closed?.status !== "answered" || !closed.decisionId) return undefined;
  const answer = await deps.store.getDecision(closed.decisionId);
  if (answer?.kind !== "approval" || answer.byActor !== "didi") return undefined;
  const merge = await createMerges(deps).mergeOnPass(nodeId, {
    kind: "event",
    ref: `privileged_path_approved:${gate.id}`,
  });
  const merged = merge.outcome === "applied";
  const stillNeeded = merged ? await createStillNeeded(deps).afterMerge(nodeId) : [];
  const asked = stillNeeded.filter((o) => o.opened);
  const council =
    asked.length > 0
      ? await councilPass(
          deps,
          asked.map((o) => `${STILL_NEEDED_PREFIX}${o.nodeId}`),
        )
      : [];
  return { merge, stillNeeded, council };
}
