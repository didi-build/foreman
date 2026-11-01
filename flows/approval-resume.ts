// The approval resume step (build plan M3.1, M0.4, D-170, D-200, D-201), after a Windmill
// `suspend` on a gate request's approval page. It records the page's answer (Approve, Reject or
// Changes requested, with Didi's words, verbatim, and the page link: `approvalDecision`) on the
// gate request through the library. A request closes once, so a repeated resume records one
// decision. The answer is recorded even under the kill switch or in dry run (D-201): Windmill
// closes the link after one answer, so refusing would lose it, and nothing acts on it until both
// are off; `heldBy` says so. A timeout records nothing; the request stays open (M4.1). An
// escalation answer then asks for the item's way back (./lib/approval.ts, M3.5).
import { approvalDecision } from "../src/core/approvals.ts";
import { createLibrary, LibraryError } from "../src/core/library.ts";
import {
  afterAnswer,
  readApprovalReply,
  type AfterAnswer,
  type ApprovalReply,
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
