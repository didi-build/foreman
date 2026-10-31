// Seam: unit. What each of the approval page's three answers records (D-170, D-200), as
// docs/guards.md's decision conventions read it. The flow around it is in
// test/flows/transition-flows.test.ts.
import { describe, expect, it } from "vitest";

import { APPROVAL_CHOICE_LABELS, approvalDecision } from "./approvals.ts";
import type { GateRequest } from "./store.ts";

const GATE: GateRequest = {
  id: "80000000-0000-4000-8000-000000000001",
  projectId: "80000000-0000-4000-8000-000000000002",
  nodeId: "80000000-0000-4000-8000-000000000003",
  topicKey: "visual-approval:80000000-0000-4000-8000-000000000003",
  kind: "visual_approval",
  owner: "didi",
  blocking: true,
  payload: {},
  approvalUrl: "https://approvals.example.test/page/not-a-real-link",
  status: "open",
  decisionId: null,
  supersededBy: null,
  createdAt: new Date(Date.UTC(2026, 9, 31)),
  answeredAt: null,
  lastNotifiedAt: null,
};

describe("an approval page answer (unit, D-200)", () => {
  it.each([
    ["approve", "approval", "approved"],
    ["reject", "answer", "rejected"],
    ["changes_requested", "answer", "changes_requested"],
  ] as const)(
    "records %s as an %s by Didi with outcome %s",
    (choice, kind, outcome) => {
      expect(
        approvalDecision(GATE, {
          choice,
          words: " Exactly this. ",
          approvers: ["anonymous"],
        }),
      ).toEqual({
        nodeId: GATE.nodeId,
        kind,
        byActor: "didi",
        textVerbatim: " Exactly this. ",
        scope: {
          topicKey: GATE.topicKey,
          gateRequestId: GATE.id,
          gateKind: "visual_approval",
          outcome,
          via: "approval_page",
          pageUrl: GATE.approvalUrl,
          approvers: ["anonymous"],
        },
      });
    },
  );

  it("records no words as empty text, which approval_recorded never accepts", () => {
    expect(
      approvalDecision(GATE, { choice: "approve", words: null, approvers: [] })
        .textVerbatim,
    ).toBe("");
  });

  it("names the three labels the page shows", () => {
    expect(Object.keys(APPROVAL_CHOICE_LABELS)).toEqual([
      "Approve",
      "Reject",
      "Changes requested",
    ]);
  });
});
