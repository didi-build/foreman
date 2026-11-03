// The approval resume step (build plan M3.1, M0.4, D-170, D-200, D-201, D-254), after a Windmill
// `suspend` on a gate request's approval page. It records the page's answer (Approve, Request
// changes or Reject, with its options and Didi's words verbatim: `approvalDecision`) through the
// library, once. An answer that breaks the form's rules records nothing and opens a fresh request
// with a note saying why. Answers are recorded even under the kill switch or in dry run (D-201):
// the link closes after one answer, and nothing acts on it until both are off. A timeout records
// nothing (M4.1). Then the escalation and reversal steps follow (./lib/approval.ts, D-234).
import { approvalDecision } from "../src/core/approvals.ts";
import { createLibrary, LibraryError } from "../src/core/library.ts";
import {
  afterAnswer,
  readApprovalReply,
  reopenIfAnswerBreaksRules,
  type AfterAnswer,
  type ApprovalReply,
  type ReopenedRequest,
} from "./lib/approval.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface ApprovalResumeInput {
  gateRequestId: string;
  /** Windmill's `resume` value. */
  resume: unknown;
  /** Windmill's `approvers` value. */
  approvers: unknown;
}

export type ApprovalResumeResult =
  | { outcome: "no_gate_request" | "already_closed" }
  | { outcome: "not_answered"; reply: ApprovalReply }
  | ({ outcome: "reopened" } & ReopenedRequest)
  | ({ outcome: "recorded"; decisionId: string } & AfterAnswer);

export async function run(
  deps: FlowDeps,
  input: ApprovalResumeInput,
): Promise<ApprovalResumeResult> {
  const reply = readApprovalReply(input.resume, input.approvers);
  const gate = await deps.store.getGateRequest(input.gateRequestId);
  if (!gate) return { outcome: "no_gate_request" };
  if (gate.status !== "open") return { outcome: "already_closed" };
  if (!reply.answered) return { outcome: "not_answered", reply };
  const reopened = await reopenIfAnswerBreaksRules(deps, gate, reply);
  if (reopened) return { outcome: "reopened", ...reopened };
  let decisionId: string;
  try {
    const answer = approvalDecision(gate, reply);
    decisionId = (await createLibrary(deps).answerGateRequest(gate.id, answer)).id;
  } catch (error) {
    // Another resume closed it between the read and the write; the store kept one answer.
    if (error instanceof LibraryError) return { outcome: "already_closed" };
    throw error;
  }
  return { outcome: "recorded", decisionId, ...(await afterAnswer(deps, gate)) };
}

export const main = (input: ApprovalResumeInput): Promise<ApprovalResumeResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
