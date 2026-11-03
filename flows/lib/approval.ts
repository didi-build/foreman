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
import { REVERSAL_PREFIX, type FollowUpStep } from "../../src/core/council.ts";
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import {
  createHoldReleases,
  HOLD_RELEASE_PREFIX,
  type HoldReleaseStep,
} from "../../src/core/hold-release.ts";
import { createLibrary } from "../../src/core/library.ts";
import type { GateRequest, Json } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import { councilPass, followUpPass, type CouncilPassStep } from "./council-runs.ts";
import { heldBy } from "./switches.ts";

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
  return { answered: true, choice, words, approvers: names, options };
}

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
}

/**
 * After an answer is recorded: what holds it, and for an escalation question the item's move back
 * out of Escalated to Didi (M3.5, src/core/escalations.ts). The guards decide that move, and the
 * kill switch and dry run hold it as for every move; the reconcile flow's escalation pass asks
 * again if this step is cut short. For a reversal's question to Didi (an `escalation` request on
 * a `decision-reversed:` topic), the follow-up Council question opens and its run starts
 * (D-234), in live mode only; the reconcile flow's follow-up pass opens it later otherwise. For a
 * held item's release request (D-269), the runner clears the hold flag on Didi's Approve
 * (src/core/hold-release.ts). Any other gate kind asks for nothing.
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
  return {
    heldBy: await heldBy(deps.store),
    ...(escalation ? { escalation } : {}),
    ...(reversal ? { reversal } : {}),
    ...(holdRelease ? { holdRelease } : {}),
  };
}
