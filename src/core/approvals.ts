// How Didi's answer on an approval page becomes a decision on its gate request (D-170, D-200,
// D-201). The page offers three answers. Approve records an `approval` by Didi. Reject records an
// `answer` with the outcome `rejected`. Changes requested records an `answer` with the outcome
// `changes_requested`, which `changes_requested_recorded` reads (docs/guards.md), and the item
// goes back for revision. Didi's words are kept exactly as typed, with the page link and who the
// page says answered; the decision's `recordedAt` is the time.
//
// The answer is recorded even while the kill switch or dry run is on (D-201): recording a fact is
// not acting on it, and the transition flows refuse or write dry-run rows until both are off.
import type { Decision, GateRequest, Json } from "./store.ts";

export type ApprovalChoice = "approve" | "reject" | "changes_requested";

/** The labels the page shows, exactly as `flows/windmill.yaml` lists them, and what each means. */
export const APPROVAL_CHOICE_LABELS: Readonly<Record<string, ApprovalChoice>> = {
  Approve: "approve",
  Reject: "reject",
  "Changes requested": "changes_requested",
};

/** One answer from an approval page, as the page sent it. */
export interface ApprovalPageAnswer {
  choice: ApprovalChoice;
  /** Exactly as typed, never trimmed. Null when the page sent no words. */
  words: string | null;
  /** Who the page says answered; `anonymous` on Windmill's free plan (D-170). */
  approvers: string[];
}

const OUTCOME: Record<ApprovalChoice, string> = {
  approve: "approved",
  reject: "rejected",
  changes_requested: "changes_requested",
};

export type ApprovalDecision = Omit<Decision, "id" | "recordedAt" | "projectId">;

/** The decision an approval page answer records on its gate request. */
export function approvalDecision(
  gate: GateRequest,
  answer: ApprovalPageAnswer,
): ApprovalDecision {
  const scope: { [key: string]: Json } = {
    topicKey: gate.topicKey,
    gateRequestId: gate.id,
    gateKind: gate.kind,
    outcome: OUTCOME[answer.choice],
    via: "approval_page",
    pageUrl: gate.approvalUrl,
    approvers: [...answer.approvers],
  };
  return {
    nodeId: gate.nodeId,
    kind: answer.choice === "approve" ? "approval" : "answer",
    scope,
    textVerbatim: answer.words ?? "",
    byActor: "didi",
  };
}
