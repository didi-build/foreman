// The reply an approval page sends back when a suspended flow resumes (M0.4, D-170, D-200).
// Windmill hands the step after a `suspend` two values: `resume`, the form's fields, or an error
// object when the request timed out or was cancelled; and `approvers`, which is `["anonymous"]`
// on the free plan. The form (flows/windmill.yaml) has two fields: `answer`, one of the page's
// three labels, and `reply`, Didi's words. This reads that shape and nothing more; what an answer
// records is `approvalDecision` in the core.
import {
  APPROVAL_CHOICE_LABELS,
  type ApprovalPageAnswer,
} from "../../src/core/approvals.ts";
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import type { GateRequest } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import { heldBy } from "./switches.ts";

/**
 * An answer, or why there is none: Windmill's error name for a timeout or a cancel, or
 * `no_choice` when the form came back without one of the three labels. `replyVerbatim` keeps any
 * words that came back without an answer, so the flow's result holds them.
 */
export type ApprovalReply =
  | ({ answered: true } & ApprovalPageAnswer)
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
  const words = typeof fields.reply === "string" ? fields.reply : null;
  const label = fields.answer;
  const choice =
    typeof label === "string" && Object.hasOwn(APPROVAL_CHOICE_LABELS, label)
      ? APPROVAL_CHOICE_LABELS[label]
      : undefined;
  if (!choice) {
    return {
      answered: false,
      reason: "no_choice",
      replyVerbatim: words,
      approvers: names,
    };
  }
  return { answered: true, choice, words, approvers: names };
}

/** What the step reports after an answer is recorded. */
export interface AfterAnswer {
  /** Why nothing acts on the answer yet, if anything holds it (D-201). */
  heldBy: "kill_switch" | "dry_run" | null;
  /** For an escalation question: what the move out of Escalated to Didi did. */
  escalation?: EscalationStep;
}

/**
 * After an answer is recorded: what holds it, and for an escalation question the item's move back
 * out of Escalated to Didi (M3.5, src/core/escalations.ts). The guards decide that move, and the
 * kill switch and dry run hold it as for every move; the reconcile flow's escalation pass asks
 * again if this step is cut short. Any other gate kind asks for nothing.
 */
export async function afterAnswer(
  deps: FlowDeps,
  gate: GateRequest,
): Promise<AfterAnswer> {
  const escalation =
    gate.kind === "escalation" && gate.nodeId
      ? await createEscalations(deps).resolve(gate.nodeId)
      : undefined;
  return { heldBy: await heldBy(deps.store), ...(escalation ? { escalation } : {}) };
}
