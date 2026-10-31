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

  describe("a privileged-path request (M3.3)", () => {
    const HEAD = "b".repeat(40);
    const privileged = (payload: GateRequest["payload"]): GateRequest => ({
      ...GATE,
      topicKey: `privileged-path:${GATE.nodeId}`,
      kind: "privileged_path",
      payload,
    });

    it("records an approval with the scope privileged_paths_approved reads: the kind and the request's head", () => {
      const decision = approvalDecision(
        privileged({ commitSha: HEAD, pr: 7, paths: ["db/migrations/0010_x.sql"] }),
        { choice: "approve", words: "ok to merge", approvers: ["anonymous"] },
      );
      expect(decision).toMatchObject({
        kind: "approval",
        byActor: "didi",
        nodeId: GATE.nodeId,
        scope: {
          kind: "privileged_path",
          commitSha: HEAD,
          gateKind: "privileged_path",
          outcome: "approved",
        },
      });
    });

    it("leaves out a commit that is not a full sha, so the approval matches no head", () => {
      const scope = approvalDecision(privileged({ commitSha: "main" }), {
        choice: "approve",
        words: "ok",
        approvers: [],
      }).scope as Record<string, unknown>;
      expect(scope.kind).toBe("privileged_path");
      expect(scope).not.toHaveProperty("commitSha");
    });

    it("records a reject as an answer, which the guard never counts", () => {
      expect(
        approvalDecision(privileged({ commitSha: HEAD }), {
          choice: "reject",
          words: "no",
          approvers: [],
        }),
      ).toMatchObject({
        kind: "answer",
        scope: { outcome: "rejected", commitSha: HEAD },
      });
    });
  });

  it("names the three labels the page shows", () => {
    expect(Object.keys(APPROVAL_CHOICE_LABELS)).toEqual([
      "Approve",
      "Reject",
      "Changes requested",
    ]);
  });
});
