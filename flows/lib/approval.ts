// The reply an approval page sends back when a suspended flow resumes (M0.4, D-170). Windmill
// hands the step after a `suspend` two values: `resume`, the form's fields (the M0.4 form has one,
// `reply`), or an error object when the request was disapproved or timed out; and `approvers`,
// which is `["anonymous"]` on the free plan. This reads that shape and nothing more. How a reply
// becomes a decision is not decided yet (see `ApprovalAnswers` in ./compose.ts).

export interface ApprovalReply {
  /** `approved`, or the name Windmill gives a disapproval or a timeout. */
  outcome: string;
  approved: boolean;
  /** Exactly as typed, never trimmed. Null when the form sent no reply. */
  replyVerbatim: string | null;
  approvers: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readApprovalReply(resume: unknown, approvers: unknown): ApprovalReply {
  const names = Array.isArray(approvers)
    ? approvers.filter((a): a is string => typeof a === "string")
    : [];
  if (isObject(resume) && isObject(resume.error)) {
    const name = resume.error.name;
    return {
      outcome: typeof name === "string" && name !== "" ? name : "disapproved",
      approved: false,
      replyVerbatim: null,
      approvers: names,
    };
  }
  const reply = isObject(resume) ? resume.reply : undefined;
  return {
    outcome: "approved",
    approved: true,
    replyVerbatim: typeof reply === "string" ? reply : null,
    approvers: names,
  };
}
