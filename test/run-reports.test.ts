// Seam: unit, on the memory store with the real machine-2 contracts and guards. The move a
// finished agent run asks for (src/core/run-reports.ts, ADR 0102, ADR 0107): which contract move a
// report triggers, that the guards decide from runner evidence and never from the agent's word,
// what a failed guard leaves, and that a repeated report moves once. Through the run-end flow in
// test/flows/run-flows.test.ts.
import { describe, expect, it } from "vitest";

import { createLibrary } from "../src/core/library.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import type { AgentRole, Run } from "../src/core/store.ts";
import { createReconcileFixture, HEAD } from "./reconcile-fixture.ts";

async function setup() {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const reports = createRunReports(f.deps);

  /** A run on the node that ended as given, as the runner records it. */
  async function ended(
    nodeId: string,
    role: AgentRole,
    outcome: Run["outcome"] = "success",
  ): Promise<Run> {
    const run = await f.run(nodeId, role, 10);
    await f.store.endRun(run.id, {
      endedAt: f.clock.now(),
      outcome: outcome ?? "success",
      turns: 5,
      minutes: 10,
      costUsd: 0.2,
      tokens: null,
      transcriptRef: null,
      usageExhaustedCause: outcome === "usage_exhausted" ? "capacity" : null,
      retryAfterSeconds: null,
      serviceTierServed: null,
      capacityRetries: null,
      capacityWaitSeconds: null,
      firstTokenMs: null,
      reportedCostUsd: null,
    });
    return run;
  }

  /** CI on the head commit, as GitHub ingestion records it. */
  const ci = (nodeId: string, conclusion: "success" | "pending") =>
    f.evidence(
      nodeId,
      "ci_run",
      { conclusion, pr: 7, changedPaths: ["src/a.ts"] },
      {
        commitSha: HEAD,
      },
    );

  const state = async (nodeId: string) => (await f.store.getNode(nodeId))?.state;

  return { ...f, reports, ended, ci, state };
}

describe("a Developer's done report (in_development to in_qa_review)", () => {
  it("moves the item when CI is green on the head and the docs note is there, as a bot report", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.ci(node.id, "success");
    await t.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });
    const run = await t.ended(node.id, "developer");

    const move = await t.reports.requestReportedMove(run.id);
    expect(move).toMatchObject({
      requested: true,
      outcome: "applied",
      toState: "in_qa_review",
      failedGuards: [],
    });
    expect(await t.state(node.id)).toBe("in_qa_review");
    expect(await t.transitions(node.id)).toMatchObject([
      {
        fromState: "in_development",
        toState: "in_qa_review",
        triggerKind: "bot_report",
        triggerRef: `run:${run.id}`,
        actorKind: "runner",
        actorId: "run_end",
        mode: "applied",
      },
    ]);
  });

  it("leaves the item where it is and writes nothing when a guard fails, naming the guard", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.ci(node.id, "pending");
    const run = await t.ended(node.id, "developer");

    expect(await t.reports.requestReportedMove(run.id)).toMatchObject({
      requested: true,
      outcome: "rejected",
      reason: "guard_failed",
      failedGuards: ["ci_green_on_head", "docs_updated_or_none"],
    });
    expect(await t.state(node.id)).toBe("in_development");
    expect(await t.transitions(node.id)).toEqual([]);
    // The fallback's counter half is the P-03 rules (M3.5): nothing touches it here.
    expect(await t.store.getCounter(node.id, "failure")).toBe(0);
  });

  it("never takes the agent's own word: an agent report that says CI is green moves nothing", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.store.insertEvidence({
      id: "50000000-0000-4000-8000-0000000009a1",
      nodeId: node.id,
      runId: null,
      kind: "agent_report",
      ref: "report",
      commitSha: null,
      payload: { summary: "Done. CI is green on the head and the docs are updated." },
      recordedBy: "developer",
      recordedAt: t.clock.now(),
      supersedesId: null,
    });
    const run = await t.ended(node.id, "developer");
    expect(await t.reports.requestReportedMove(run.id)).toMatchObject({
      outcome: "rejected",
      failedGuards: ["ci_green_on_head", "docs_updated_or_none"],
    });
    expect(await t.state(node.id)).toBe("in_development");
  });

  it("moves once for a repeated report", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.ci(node.id, "success");
    await t.evidence(node.id, "docs_note", { impact: "updated" }, { commitSha: HEAD });
    const run = await t.ended(node.id, "developer");
    await t.reports.requestReportedMove(run.id);
    expect(await t.reports.requestReportedMove(run.id)).toMatchObject({
      outcome: "noop",
    });
    expect(await t.transitions(node.id)).toHaveLength(1);
  });

  it.each([
    "fail",
    "timeout",
    "budget_exceeded",
    "usage_exhausted",
    "cancelled",
  ] as const)(
    "asks for nothing after a %s end, which is not a done report",
    async (outcome) => {
      const t = await setup();
      const node = await t.node("in_development");
      await t.ci(node.id, "success");
      const run = await t.ended(node.id, "developer", outcome);
      expect(await t.reports.requestReportedMove(run.id)).toEqual({
        requested: false,
        reason: "not_success",
      });
      expect(await t.transitions(node.id)).toEqual([]);
    },
  );

  it("asks for nothing for a run still running, or a role that does not own the state", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    const running = await t.run(node.id, "developer");
    expect(await t.reports.requestReportedMove(running.id)).toEqual({
      requested: false,
      reason: "not_ended",
    });
    const qa = await t.ended(node.id, "qa");
    expect(await t.reports.requestReportedMove(qa.id)).toEqual({
      requested: false,
      reason: "not_owner",
    });
  });

  it("is refused under the kill switch, and written as dry run only while dry run is on", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.ci(node.id, "success");
    await t.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });
    const run = await t.ended(node.id, "developer");
    await t.setting("kill_switch", true);
    expect(await t.reports.requestReportedMove(run.id)).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    await t.setting("kill_switch", false);
    await t.setting("dry_run", true);
    expect(await t.reports.requestReportedMove(run.id)).toMatchObject({
      outcome: "planned",
    });
    expect(await t.state(node.id)).toBe("in_development");
    expect(await t.transitions(node.id)).toMatchObject([{ mode: "dry_run" }]);
  });
});

describe("QA's verdict report (in_qa_review)", () => {
  async function inReview(verdict: "pass" | "fail", findings: number) {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    const ciId = await t.ci(node.id, "success");
    const qa = await t.ended(node.id, "qa");
    // The verdict as the state API stores it: bound to the head the runner gave the QA run.
    await t.evidence(
      node.id,
      "qa_verdict",
      {
        verdict,
        findings: Array.from({ length: findings }, (_, i) => ({
          path: "src/a.ts",
          startLine: i + 1,
          endLine: i + 1,
          note: "wrong",
        })),
        evidenceIds: [ciId],
      },
      { commitSha: HEAD, runId: qa.id },
    );
    return { ...t, node, qa };
  }

  it("sends a failed round with findings back to In development", async () => {
    const t = await inReview("fail", 2);
    expect(await t.reports.requestReportedMove(t.qa.id)).toMatchObject({
      outcome: "applied",
      toState: "in_development",
    });
    expect(await t.state(t.node.id)).toBe("in_development");
  });

  it("leaves the item in review for a fail with no findings", async () => {
    const t = await inReview("fail", 0);
    expect(await t.reports.requestReportedMove(t.qa.id)).toMatchObject({
      outcome: "rejected",
      failedGuards: ["qa_failed_with_findings"],
    });
    expect(await t.state(t.node.id)).toBe("in_qa_review");
  });

  it("asks for the merge move first on a pass, which the merge guard decides (M3.3)", async () => {
    const t = await inReview("pass", 0);
    expect(t.reports.reportMoves(t.node, "qa").map((m) => m.to)).toEqual([
      "verifying_on_staging",
      "in_development",
    ]);
    // No dispatch record names the PR's repository here, so the merge stops before GitHub, the
    // fail move's guards refuse a pass, and nothing is merged or written. The merge itself is in
    // test/merge.test.ts.
    expect(await t.reports.requestReportedMove(t.qa.id)).toMatchObject({
      outcome: "rejected",
      toState: "in_development",
    });
    expect(t.github.merges).toEqual([]);
    expect(await t.state(t.node.id)).toBe("in_qa_review");
    expect(await t.transitions(t.node.id)).toEqual([]);
  });
});

describe("which moves a report triggers (from the contracts)", () => {
  it("takes the Designer's report moves and QA's merge, and leaves out dispatch, fallback and escalation moves", async () => {
    const t = await setup();
    const moves = async (state: string, role: string, track: "code" | "design") =>
      t.reports
        .reportMoves(await t.node(state, { track }), role)
        .map((m) => `${m.from}>${m.to}`);
    expect(await moves("in_design_exploration", "designer", "design")).toEqual([
      "in_design_exploration>waiting_for_didi",
    ]);
    expect(await moves("writing_spec", "designer", "design")).toEqual([
      "writing_spec>building_components",
    ]);
    expect(await moves("building_components", "designer", "design")).toEqual([
      "building_components>in_qa_review",
    ]);
    expect(await moves("in_qa_review", "qa", "design")).toEqual([
      "in_qa_review>verifying_on_staging",
      "in_qa_review>building_components",
    ]);
    // The dispatch move is the runner's, not a report's.
    expect(await moves("ready_for_dev", "developer", "code")).toEqual([]);
  });

  it("asks for nothing when the node moved since the run started, so a stale report moves nothing", async () => {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    const qa = await t.ended(node.id, "qa");
    // Moved on meanwhile by something else, for example a newer head and its own QA run.
    await t.store.insertTransition({
      id: "50000000-0000-4000-8000-0000000009b1",
      nodeId: node.id,
      fromState: "in_qa_review",
      toState: "in_qa_review",
      fromSubstate: null,
      toSubstate: null,
      triggerKind: "event",
      triggerRef: "github:other",
      actorKind: "runner",
      actorId: "test",
      guardResult: [],
      evidenceIds: [],
      specVersion: t.contracts.version,
      mode: "applied",
      reason: null,
      at: t.clock.now(),
    });
    expect(await t.reports.requestReportedMove(qa.id)).toEqual({
      requested: false,
      reason: "state_changed",
    });
  });
});

describe("QA's failed rounds and the counters (P-03, D-169, O-41)", () => {
  /** An item in review with CI on `sha`, and QA's run ended with a verdict on it. */
  async function verdictOn(
    t: Awaited<ReturnType<typeof setup>>,
    nodeId: string,
    sha: string,
    verdict: "pass" | "fail" = "fail",
  ) {
    const ciId = await t.evidence(
      nodeId,
      "ci_run",
      { conclusion: "success", pr: 7, changedPaths: ["src/a.ts"] },
      { commitSha: sha },
    );
    await t.evidence(nodeId, "docs_note", { impact: "none" }, { commitSha: sha });
    const qa = await t.ended(nodeId, "qa");
    await t.evidence(
      nodeId,
      "qa_verdict",
      {
        verdict,
        findings:
          verdict === "fail"
            ? [{ path: "src/a.ts", startLine: 1, endLine: 1, note: "n" }]
            : [],
        evidenceIds: [ciId],
      },
      { commitSha: sha, runId: qa.id },
    );
    // Later steps start after this one, as a real clock moves on.
    t.advanceMinutes(20);
    return qa;
  }

  const counters = async (t: Awaited<ReturnType<typeof setup>>, nodeId: string) => ({
    qaRound: await t.store.getCounter(nodeId, "qa_round"),
    failure: await t.store.getCounter(nodeId, "failure"),
  });

  it("a failed round adds one to qa_round and to failure with its move, once for a repeated report", async () => {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    const qa = await verdictOn(t, node.id, HEAD);
    expect(await t.reports.requestReportedMove(qa.id)).toMatchObject({
      outcome: "applied",
      toState: "in_development",
    });
    expect(await counters(t, node.id)).toEqual({ qaRound: 1, failure: 1 });
    expect(await t.reports.requestReportedMove(qa.id)).toMatchObject({
      outcome: "noop",
      reason: "duplicate_trigger",
    });
    expect(await counters(t, node.id)).toEqual({ qaRound: 1, failure: 1 });
    expect(await t.state(node.id)).toBe("in_development");
  });

  it("writes a dry-run row and no counter in dry run", async () => {
    const t = await setup();
    await t.setting("dry_run", true);
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    const qa = await verdictOn(t, node.id, HEAD);
    await t.reports.requestReportedMove(qa.id);
    expect((await t.transitions(node.id)).map((m) => [m.toState, m.mode])).toEqual([
      ["in_development", "dry_run"],
    ]);
    expect(await counters(t, node.id)).toEqual({ qaRound: 0, failure: 0 });
  });

  it("escalates from the building state once failure reaches failure_threshold", async () => {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    // Two failures counted earlier, for example two failed staging checks.
    await t.store.setCounter(node.id, "failure", 2, t.clock.now());
    const qa = await verdictOn(t, node.id, HEAD);
    expect(await t.reports.requestReportedMove(qa.id)).toMatchObject({
      outcome: "applied",
      toState: "in_development",
      escalation: { outcome: "applied", toState: "escalated_to_council" },
    });
    expect(await counters(t, node.id)).toEqual({ qaRound: 1, failure: 3 });
    expect((await t.transitions(node.id)).map((m) => [m.fromState, m.toState])).toEqual(
      [
        ["in_qa_review", "in_development"],
        ["in_development", "escalated_to_council"],
      ],
    );
  });

  it("sends the third failed verdict to the Council, counted once, while the merge guard still reads the count", async () => {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    const heads = ["1", "2", "3"].map((c) => c.repeat(40));
    for (const [i, sha] of heads.slice(0, 2).entries()) {
      const qa = await verdictOn(t, node.id, sha);
      expect(await t.reports.requestReportedMove(qa.id)).toMatchObject({
        outcome: "applied",
        toState: "in_development",
      });
      expect(await counters(t, node.id)).toEqual({ qaRound: i + 1, failure: i + 1 });
      // The fix round, started after the fail move, reports done on the same head, and the
      // item goes back to review.
      t.advanceMinutes(20);
      const dev = await t.ended(node.id, "developer");
      expect(await t.reports.requestReportedMove(dev.id)).toMatchObject({
        outcome: "applied",
        toState: "in_qa_review",
      });
      t.advanceMinutes(20);
    }
    // After two failed rounds the merge guard still lets a pass through (O-30).
    expect(
      (await t.reports.reportMoves((await t.store.getNode(node.id))!, "qa")).length,
    ).toBe(2);
    const capCheck = await createLibrary(t.deps).checkTransition({
      nodeId: node.id,
      toState: "verifying_on_staging",
      trigger: { kind: "reconcile", ref: null },
      actor: { kind: "runner", id: "test" },
    });
    expect(
      capCheck.guardReport.find((c) => c.name === "qa_rounds_below_cap")?.pass,
    ).toBe(true);

    const third = await verdictOn(t, node.id, heads[2] ?? "");
    expect(await t.reports.requestReportedMove(third.id)).toMatchObject({
      outcome: "rejected",
      failedGuards: ["not_third_failed_round"],
      escalation: { outcome: "applied", toState: "escalated_to_council" },
    });
    expect(await t.state(node.id)).toBe("escalated_to_council");
    expect(await counters(t, node.id)).toEqual({ qaRound: 3, failure: 3 });
    expect(await t.reports.requestReportedMove(third.id)).toMatchObject({
      outcome: "noop",
      reason: "duplicate_trigger",
    });
    expect(await counters(t, node.id)).toEqual({ qaRound: 3, failure: 3 });
  });
});
