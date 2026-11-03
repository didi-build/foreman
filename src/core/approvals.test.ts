// Seam: unit. What each of the approval page's three answers records (D-170, D-200, D-254), as
// docs/guards.md's decision conventions read it. The flow around it is in
// test/flows/transition-flows.test.ts.
import { describe, expect, it } from "vitest";

import {
  ANSWER_PROBLEMS,
  APPROVAL_CHOICE_LABELS,
  OLDER_FORM_CHOICE_LABELS,
  approvalAnswerProblem,
  approvalDecision,
  approvalFormEnums,
} from "./approvals.ts";
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

  it("records the approved option only when the visual-approval request lists it (D-242, D-254)", () => {
    const listing = { ...GATE, payload: { options: ["a", "b"] } };
    const scope = (
      gate: GateRequest,
      options: string[],
      choice: "approve" | "reject" | "changes_requested" = "approve",
    ) =>
      approvalDecision(gate, {
        choice,
        words: "Option a.",
        approvers: ["anonymous"],
        options,
      }).scope;
    expect(scope(listing, ["a"])).toMatchObject({ option: "a" });
    expect(scope(listing, ["a"])).not.toHaveProperty("options");
    expect(scope(listing, ["c"])).not.toHaveProperty("option");
    expect(scope(listing, [])).not.toHaveProperty("option");
    expect(scope(GATE, ["a"])).not.toHaveProperty("option");
    expect(scope({ ...listing, kind: "new_credentials" }, ["a"])).not.toHaveProperty(
      "option",
    );
    // Request changes and Reject keep the options they name, for the Designer's input.
    expect(scope(listing, ["a", "b"], "changes_requested")).toMatchObject({
      outcome: "changes_requested",
      options: ["a", "b"],
    });
    expect(scope(listing, ["a"], "reject")).toMatchObject({ options: ["a"] });
    expect(scope(listing, ["a"], "reject")).not.toHaveProperty("option");
    expect(scope(listing, [], "changes_requested")).not.toHaveProperty("options");
  });

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

  it("names the Decision field's three labels, and reads the older form's (D-254, D-200)", () => {
    expect(APPROVAL_CHOICE_LABELS).toEqual({
      Approve: "approve",
      "Request changes": "changes_requested",
      Reject: "reject",
    });
    expect(OLDER_FORM_CHOICE_LABELS).toEqual({
      Approve: "approve",
      Reject: "reject",
      "Changes requested": "changes_requested",
    });
  });
});

describe("the approval form's rules (unit, D-254)", () => {
  const listing: GateRequest = { ...GATE, payload: { options: ["a", "b", "c"] } };
  const problem = (
    gate: GateRequest,
    choice: "approve" | "reject" | "changes_requested",
    options: string[],
    words: string | null = "Feedback.",
  ) => approvalAnswerProblem(gate, { choice, words, approvers: [], options });

  it("fills the Options field per request with the request's own options", () => {
    expect(approvalFormEnums(listing)).toEqual({ options: ["a", "b", "c"] });
    expect(approvalFormEnums(GATE)).toEqual({ options: [] });
    expect(
      approvalFormEnums({ ...GATE, payload: { options: ["a", 3, null] } }),
    ).toEqual({ options: ["a"] });
  });

  it("Approve needs exactly one listed option, and no feedback", () => {
    expect(problem(listing, "approve", ["b"], null)).toBeNull();
    expect(problem(listing, "approve", ["b"], "")).toBeNull();
    expect(problem(listing, "approve", [])).toBe(ANSWER_PROBLEMS.approveNeedsOneOption);
    expect(problem(listing, "approve", ["a", "b"])).toBe(
      ANSWER_PROBLEMS.approveNeedsOneOption,
    );
  });

  it("Request changes may name any number of options, and needs feedback", () => {
    expect(problem(listing, "changes_requested", [])).toBeNull();
    expect(problem(listing, "changes_requested", ["a", "c"])).toBeNull();
    expect(problem(listing, "changes_requested", ["a"], "  ")).toBe(
      ANSWER_PROBLEMS.changesNeedFeedback,
    );
    expect(problem(listing, "changes_requested", [], null)).toBe(
      ANSWER_PROBLEMS.changesNeedFeedback,
    );
  });

  it("Reject needs feedback", () => {
    expect(problem(listing, "reject", [])).toBeNull();
    expect(problem(listing, "reject", [], "")).toBe(
      ANSWER_PROBLEMS.rejectNeedsFeedback,
    );
  });

  it("refuses an option the request does not show, or one named twice", () => {
    expect(problem(listing, "approve", ["z"])).toBe(ANSWER_PROBLEMS.unknownOption);
    expect(problem(listing, "changes_requested", ["a", "a"])).toBe(
      ANSWER_PROBLEMS.repeatedOption,
    );
    // A request that lists no options: Approve needs none, and any named is unknown.
    expect(problem(GATE, "approve", [], null)).toBeNull();
    expect(problem(GATE, "approve", ["a"])).toBe(ANSWER_PROBLEMS.unknownOption);
  });

  it("says why in one line of fixed text", () => {
    for (const note of Object.values(ANSWER_PROBLEMS)) {
      expect(note).not.toContain("\n");
      expect(note.length).toBeLessThanOrEqual(120);
    }
  });
});
