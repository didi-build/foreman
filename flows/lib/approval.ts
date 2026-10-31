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
