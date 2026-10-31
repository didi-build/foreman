// Seam: unit, on the memory store with the real machine-2 contracts and guards. Escalation and
// stale marking (build plan M3.5, P-03 as confirmed by D-169, O-42 to O-46): a done report on a
// head QA already failed goes back to QA no more and counts as a failure; a refused done report
// and a repeated failed start count once each; three deliberate failures reach Escalated to
// Council; the Council's decision returns the item with both counters reset, and "cannot resolve"
// reaches Didi as a gate request whose answer returns it; a reversed decision marks its dependents
// stale and opens one Council question. The flows around these are in
// test/flows/escalation-flows.test.ts.
import { describe, expect, it } from "vitest";

import { approvalDecision } from "../src/core/approvals.ts";
import { createBuilderRuns } from "../src/core/builder-runs.ts";
import { createEscalations } from "../src/core/escalations.ts";
import { createFailures, failureCountKey } from "../src/core/failures.ts";
import { escalationTopic } from "../src/core/guards/escalation.ts";
import { createLibrary } from "../src/core/library.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import type { AgentRole, Json, Run } from "../src/core/store.ts";
import { createReconcileFixture, HEAD, REPO } from "./reconcile-fixture.ts";

const NEW_HEAD = "c".repeat(40);
const FINDING = { path: "src/a.ts", startLine: 1, endLine: 2, note: "wrong" };
const KEEPS = { changesProductDirection: false, passesGate: false };

async function setup() {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const reports = createRunReports(f.deps);
  const escalations = createEscalations(f.deps);
  const failures = createFailures(f.deps);
  const library = createLibrary(f.deps);

  /** A run that ended as given; a builder's start is recorded with its `dispatch_record`. */
  async function ended(
    nodeId: string,
    role: AgentRole,
    outcome: NonNullable<Run["outcome"]> = "success",
    options: { started?: boolean } = {},
  ): Promise<Run> {
    f.advanceMinutes(5);
    const run = await f.run(nodeId, role);
    if (options.started !== false) {
      await f.store.setRunHandle(run.id, { job: run.id });
      if (role === "developer" || role === "designer") {
        await f.evidence(
          nodeId,
          "dispatch_record",
          { repo: REPO, branch: `foreman/${nodeId}` },
          { runId: run.id },
        );
      }
    }
    f.advanceMinutes(5);
    await f.store.endRun(run.id, {
      endedAt: f.clock.now(),
      outcome,
      turns: 5,
      minutes: 10,
      costUsd: 0.2,
      tokens: null,
      transcriptRef: null,
      usageExhaustedCause: outcome === "usage_exhausted" ? "rate_limit" : null,
      retryAfterSeconds: null,
      serviceTierServed: null,
      capacityRetries: null,
      capacityWaitSeconds: null,
      firstTokenMs: null,
      reportedCostUsd: null,
    });
    f.advanceMinutes(1);
    return run;
  }

  /** CI and a docs note on a head, as ingestion and the Developer record them. */
  async function head(
    nodeId: string,
    sha: string,
    conclusion: "success" | "failure" | "pending" = "success",
  ) {
    const ciId = await f.evidence(
      nodeId,
      "ci_run",
      { conclusion, pr: 7, changedPaths: ["src/a.ts"] },
      { commitSha: sha },
    );
    await f.evidence(nodeId, "docs_note", { impact: "none" }, { commitSha: sha });
    return ciId;
  }

  /** QA's run on the head ended, with a failed verdict, and its report asked for. */
  async function qaFails(nodeId: string, sha: string) {
    const qa = await ended(nodeId, "qa");
    await f.evidence(
      nodeId,
      "qa_verdict",
      { verdict: "fail", findings: [FINDING], evidenceIds: [] },
      { commitSha: sha, runId: qa.id },
    );
    return reports.requestReportedMove(qa.id);
  }

  const state = async (nodeId: string) => (await f.store.getNode(nodeId))?.state;
  const counters = async (nodeId: string) => ({
    failure: await f.store.getCounter(nodeId, "failure"),
    qaRound: await f.store.getCounter(nodeId, "qa_round"),
  });
  const failureRows = (nodeId: string) =>
    f.store.listEvidence({ nodeId, kind: "failure_count" });

  /** A Council decision on the node, as the state API records it. */
  const councilDecides = (
    nodeId: string,
    scope: Json,
    text = "Retry with a smaller change.",
  ) => {
    f.advanceMinutes(1);
    return library.recordDecision({
      projectId: f.projectId,
      nodeId,
      kind: "council_decision",
      scope,
      textVerbatim: text,
      byActor: "council",
    });
  };

  /** An item escalated to the Council from In development, with both counters at their limit. */
  async function escalated() {
    const node = await f.node("in_development");
    await f.store.setCounter(node.id, "failure", 3, f.clock.now());
    await f.store.setCounter(node.id, "qa_round", 2, f.clock.now());
    f.advanceMinutes(1);
    const move = await escalations.escalate(
      node.id,
      { kind: "event", ref: "test:escalate" },
      "three failures",
    );
    expect(move).toMatchObject({ outcome: "applied", toState: "escalated_to_council" });
    return node;
  }

  return {
    ...f,
    reports,
    escalations,
    failures,
    library,
    ended,
    head,
    qaFails,
    state,
    counters,
    failureRows,
    councilDecides,
    escalated,
  };
}

describe("a done report on a head QA already failed (unit, O-41's gap, O-42)", () => {
  async function failedOnce() {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    await t.head(node.id, HEAD);
    expect(await t.qaFails(node.id, HEAD)).toMatchObject({
      outcome: "applied",
      toState: "in_development",
    });
    expect(await t.counters(node.id)).toEqual({ failure: 1, qaRound: 1 });
    return { t, node };
  }

  it("does not go back to QA, counts once as a failure, and the fix round goes on", async () => {
    const { t, node } = await failedOnce();
    // The fix round reports done without pushing: CI is still green on the failed head.
    const dev = await t.ended(node.id, "developer");
    const move = await t.reports.requestReportedMove(dev.id);
    expect(move).toMatchObject({
      requested: true,
      outcome: "rejected",
      failedGuards: ["no_failed_qa_verdict_on_head"],
      failureCount: { counted: true, failures: 2 },
    });
    expect(await t.state(node.id)).toBe("in_development");
    expect(await t.counters(node.id)).toEqual({ failure: 2, qaRound: 1 });
    expect(await t.failureRows(node.id)).toMatchObject([
      {
        runId: dev.id,
        commitSha: HEAD,
        ref: failureCountKey("report_refused", dev.id),
        payload: {
          cause: "report_refused",
          failedGuards: ["no_failed_qa_verdict_on_head"],
        },
        recordedBy: "runner",
      },
    ]);
    // A repeated report counts once.
    expect(await t.reports.requestReportedMove(dev.id)).toMatchObject({
      failureCount: { counted: "already_counted", failures: 2 },
    });
    expect(await t.counters(node.id)).toEqual({ failure: 2, qaRound: 1 });
    expect(await t.failureRows(node.id)).toHaveLength(1);
    // The fix round goes on: another Developer run is due, told why.
    const builders = createBuilderRuns(t.deps);
    expect(await builders.check(node.id)).toEqual({
      due: true,
      nodeId: node.id,
      role: "developer",
      cause: "refused",
    });
    expect(await builders.returnReason(node.id)).toMatchObject({
      kind: "report_refused",
      failedGuards: ["no_failed_qa_verdict_on_head"],
      commitSha: HEAD,
      earlier: { kind: "qa_fail", commitSha: HEAD },
    });
  });

  it("goes back to QA on a new head", async () => {
    const { t, node } = await failedOnce();
    await t.head(node.id, NEW_HEAD);
    const dev = await t.ended(node.id, "developer");
    expect(await t.reports.requestReportedMove(dev.id)).toMatchObject({
      outcome: "applied",
      toState: "in_qa_review",
      failedGuards: [],
    });
    expect(await t.counters(node.id)).toEqual({ failure: 1, qaRound: 1 });
  });

  it("is refused on the design track too, in Building components", async () => {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa", track: "design" });
    await t.head(node.id, HEAD);
    expect(await t.qaFails(node.id, HEAD)).toMatchObject({
      outcome: "applied",
      toState: "building_components",
    });
    const designer = await t.ended(node.id, "designer");
    const move = await t.reports.requestReportedMove(designer.id);
    expect(move).toMatchObject({
      outcome: "rejected",
      failureCount: { counted: true },
    });
    expect(move.requested && move.failedGuards).toContain(
      "no_failed_qa_verdict_on_head",
    );
    expect(await t.state(node.id)).toBe("building_components");
  });
});

describe("a failed guard after a done report (unit, P-03, O-43)", () => {
  it("counts once per report, and three deliberate failures reach Escalated to Council", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    for (const [i, sha] of ["1", "2", "3"].map((c) => c.repeat(40)).entries()) {
      // Each run reports done on a head whose CI failed.
      await t.head(node.id, sha, "failure");
      const dev = await t.ended(node.id, "developer");
      const move = await t.reports.requestReportedMove(dev.id);
      expect(move).toMatchObject({
        outcome: "rejected",
        failedGuards: ["ci_green_on_head"],
        failureCount: { counted: true, failures: i + 1 },
      });
      if (i < 2) {
        expect(move.requested && move.failureCount).not.toHaveProperty("escalation");
        expect(await t.state(node.id)).toBe("in_development");
      } else {
        expect(move.requested && move.failureCount).toMatchObject({
          escalation: { outcome: "applied", toState: "escalated_to_council" },
        });
      }
    }
    expect(await t.state(node.id)).toBe("escalated_to_council");
    expect(await t.counters(node.id)).toEqual({ failure: 3, qaRound: 0 });
    expect((await t.store.getNode(node.id))?.blockedReason).toMatch(/failure counter/);
    // The item belongs to the Council: no builder run is due.
    expect(await createBuilderRuns(t.deps).check(node.id)).toMatchObject({
      due: false,
    });
  });

  it("does not count while CI is still pending on the head, and counts once it is red", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.head(node.id, HEAD, "pending");
    const dev = await t.ended(node.id, "developer");
    const move = await t.reports.requestReportedMove(dev.id);
    expect(move).toMatchObject({
      outcome: "rejected",
      failedGuards: ["ci_green_on_head"],
    });
    expect(move.requested && move.failureCount).toBeUndefined();
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
    // The same report asked again once CI is red counts.
    await t.head(node.id, HEAD, "failure");
    expect(await t.reports.requestReportedMove(dev.id)).toMatchObject({
      failureCount: { counted: true, failures: 1 },
    });
  });

  it("never counts a QA run's report: a merge waiting on a condition is not a failure", async () => {
    const t = await setup();
    const node = await t.node("in_qa_review", { ownerRole: "qa" });
    await t.head(node.id, HEAD);
    const qa = await t.ended(node.id, "qa");
    const move = await t.reports.requestReportedMove(qa.id);
    expect(move).toMatchObject({ outcome: "rejected" });
    expect(move.requested && move.failureCount).toBeUndefined();
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
  });

  it("does not count a scope change alone, which goes to the Council instead", async () => {
    const t = await setup();
    const node = await t.node("writing_spec", {
      ownerRole: "designer",
      track: "design",
    });
    await t.setting("designer_identity", "designer[bot]");
    await t.evidence(node.id, "spec_paths", {
      paths: ["design/a/b/spec.md"],
      components: [],
      commits: [{ sha: HEAD, author: "designer[bot]" }],
      newFeatures: ["export to PDF"],
      newFlows: [],
    });
    const designer = await t.ended(node.id, "designer");
    const move = await t.reports.requestReportedMove(designer.id);
    expect(move).toMatchObject({
      outcome: "rejected",
      failedGuards: ["scope_matches_plan"],
    });
    expect(move.requested && move.failureCount).toBeUndefined();
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
  });

  it("counts nothing in dry run or under the kill switch", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    await t.head(node.id, HEAD, "failure");
    const dev = await t.ended(node.id, "developer");
    await t.setting("dry_run", true);
    expect(await t.reports.requestReportedMove(dev.id)).toMatchObject({
      outcome: "rejected",
      failureCount: { counted: false, reason: "dry_run" },
    });
    await t.setting("dry_run", false);
    await t.setting("kill_switch", true);
    expect(await t.reports.requestReportedMove(dev.id)).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
    expect(await t.failureRows(node.id)).toEqual([]);
  });
});

describe("repeated dispatch failure (unit, P-03, O-44)", () => {
  it("counts each failed start after the first in a row, once per run, and escalates at the threshold", async () => {
    const t = await setup();
    const node = await t.node("ready_for_dev");
    const fails: Run[] = [];
    const fail = async () => {
      const run = await t.ended(node.id, "developer", "fail", { started: false });
      fails.push(run);
      return t.failures.dispatchFailed(run.id);
    };
    expect(await fail()).toEqual({ counted: false, reason: "first_failed_start" });
    expect(await fail()).toMatchObject({ counted: true, failures: 1 });
    expect(await t.failures.dispatchFailed(fails[1]!.id)).toMatchObject({
      counted: "already_counted",
      failures: 1,
    });
    expect(await fail()).toMatchObject({ counted: true, failures: 2 });
    expect(await fail()).toMatchObject({
      counted: true,
      failures: 3,
      escalation: { outcome: "applied", toState: "escalated_to_council" },
    });
    expect(await t.state(node.id)).toBe("escalated_to_council");
    expect((await t.failureRows(node.id)).map((e) => e.payload)).toEqual([
      { cause: "dispatch_failed", failedStartsInRow: 2 },
      { cause: "dispatch_failed", failedStartsInRow: 3 },
      { cause: "dispatch_failed", failedStartsInRow: 4 },
    ]);
  });

  it("does not count a run that started, a cancelled run, or a first failure after a started run", async () => {
    const t = await setup();
    const node = await t.node("in_development");
    const first = await t.ended(node.id, "developer", "fail", { started: false });
    expect(await t.failures.dispatchFailed(first.id)).toMatchObject({ counted: false });
    // An agent run that started and failed is not a failed start, and breaks the row.
    const agentFail = await t.ended(node.id, "developer", "fail");
    expect(await t.failures.dispatchFailed(agentFail.id)).toEqual({
      counted: false,
      reason: "not_a_failed_start",
    });
    const afterStart = await t.ended(node.id, "developer", "fail", { started: false });
    expect(await t.failures.dispatchFailed(afterStart.id)).toEqual({
      counted: false,
      reason: "first_failed_start",
    });
    const cancelled = await t.ended(node.id, "developer", "cancelled", {
      started: false,
    });
    expect(await t.failures.dispatchFailed(cancelled.id)).toEqual({
      counted: false,
      reason: "not_a_failed_start",
    });
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
  });

  it("counts nothing in dry run or under the kill switch", async () => {
    const t = await setup();
    const node = await t.node("ready_for_dev");
    await t.ended(node.id, "developer", "fail", { started: false });
    const second = await t.ended(node.id, "developer", "fail", { started: false });
    await t.setting("dry_run", true);
    expect(await t.failures.dispatchFailed(second.id)).toEqual({
      counted: false,
      reason: "dry_run",
    });
    await t.setting("dry_run", false);
    await t.setting("kill_switch", true);
    expect(await t.failures.dispatchFailed(second.id)).toEqual({
      counted: false,
      reason: "kill_switch",
    });
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
  });
});

describe("out of Escalated to Council (unit, D-169, D-177, O-46)", () => {
  it("waits for a Council decision, then returns the item with both counters reset, once", async () => {
    const t = await setup();
    const node = await t.escalated();
    expect(await t.escalations.resolve(node.id)).toEqual({
      nodeId: node.id,
      step: "waiting",
      on: "council",
    });
    const decision = await t.councilDecides(node.id, KEEPS);
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "returned",
      move: { outcome: "applied", toState: "in_development" },
    });
    expect(await t.state(node.id)).toBe("in_development");
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
    expect((await t.transitions(node.id)).at(-1)).toMatchObject({
      fromState: "escalated_to_council",
      toState: "in_development",
      triggerKind: "event",
      triggerRef: `council_decision:${decision.id}`,
      actorKind: "runner",
      actorId: "escalation",
    });
    // A repeat is not escalated any more and writes nothing.
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "not_escalated",
    });
    // The Developer's work goes on, told what the Council said.
    const builders = createBuilderRuns(t.deps);
    expect(await builders.check(node.id)).toMatchObject({
      due: true,
      cause: "returned",
    });
    expect(await builders.returnReason(node.id)).toEqual({
      kind: "escalation_resolved",
      by: "council",
      note: "Retry with a smaller change.",
    });
  });

  it("a Council 'cannot resolve' reaches Didi as a gate request, once, and Didi's answer returns the item", async () => {
    const t = await setup();
    const node = await t.escalated();
    const decision = await t.councilDecides(
      node.id,
      { ...KEEPS, outcome: "cannot_resolve" },
      "We cannot tell which behaviour is wanted.",
    );
    const step = await t.escalations.resolve(node.id);
    expect(step).toMatchObject({
      step: "to_didi",
      move: { outcome: "applied", toState: "escalated_to_didi" },
    });
    const gate = await t.store.findOpenGateRequest(
      t.projectId,
      escalationTopic(node.id),
    );
    expect(gate).toMatchObject({
      id: step.step === "to_didi" ? step.gateRequestId : "",
      nodeId: node.id,
      kind: "escalation",
      owner: "didi",
      blocking: true,
      payload: {
        councilDecisionId: decision.id,
        councilNote: "We cannot tell which behaviour is wanted.",
        returnState: "in_development",
      },
    });
    const escalatedNode = await t.store.getNode(node.id);
    expect(escalatedNode?.blockedReason).toMatch(/Didi/);
    // The counters stay until the escalation is resolved.
    expect(await t.counters(node.id)).toEqual({ failure: 3, qaRound: 2 });
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "waiting",
      on: "didi",
    });
    expect(await t.store.listOpenGateRequests(t.projectId)).toHaveLength(1);

    // Didi answers on the approval page (src/core/approvals.ts).
    t.advanceMinutes(10);
    const answer = await t.library.answerGateRequest(
      gate!.id,
      approvalDecision(gate!, {
        choice: "approve",
        words: "Keep the old behaviour.",
        approvers: ["anonymous"],
      }),
    );
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "returned",
      move: { outcome: "applied", toState: "in_development" },
    });
    expect((await t.transitions(node.id)).at(-1)).toMatchObject({
      fromState: "escalated_to_didi",
      toState: "in_development",
      triggerRef: `didi_answer:${answer.id}`,
    });
    expect(await t.counters(node.id)).toEqual({ failure: 0, qaRound: 0 });
    expect(await createBuilderRuns(t.deps).returnReason(node.id)).toEqual({
      kind: "escalation_resolved",
      by: "didi",
      note: "Keep the old behaviour.",
    });
  });

  it("sends a decision that changes product direction or passes a gate to Didi", async () => {
    for (const scope of [
      { ...KEEPS, changesProductDirection: true },
      { ...KEEPS, passesGate: true },
    ]) {
      const t = await setup();
      const node = await t.escalated();
      await t.councilDecides(node.id, scope);
      expect(await t.escalations.resolve(node.id)).toMatchObject({
        step: "to_didi",
        move: { outcome: "applied" },
      });
      expect(await t.state(node.id)).toBe("escalated_to_didi");
    }
  });

  it("an answer without words keeps the item with Didi", async () => {
    const t = await setup();
    const node = await t.escalated();
    await t.councilDecides(node.id, { ...KEEPS, outcome: "cannot_resolve" });
    await t.escalations.resolve(node.id);
    const gate = await t.store.findOpenGateRequest(
      t.projectId,
      escalationTopic(node.id),
    );
    t.advanceMinutes(1);
    await t.library.answerGateRequest(
      gate!.id,
      approvalDecision(gate!, { choice: "approve", words: null, approvers: [] }),
    );
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "waiting",
      on: "didi",
    });
    expect(await t.state(node.id)).toBe("escalated_to_didi");
  });

  it("in dry run writes dry-run rows, resets nothing and opens no gate request", async () => {
    const t = await setup();
    const node = await t.escalated();
    const other = await t.escalated();
    await t.setting("dry_run", true);
    await t.councilDecides(node.id, KEEPS);
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "returned",
      move: { outcome: "planned" },
    });
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      move: { outcome: "noop", reason: "duplicate_trigger" },
    });
    expect((await t.transitions(node.id)).map((m) => m.mode)).toEqual([
      "applied",
      "dry_run",
    ]);
    expect(await t.state(node.id)).toBe("escalated_to_council");
    expect(await t.counters(node.id)).toEqual({ failure: 3, qaRound: 2 });

    await t.councilDecides(other.id, { ...KEEPS, outcome: "cannot_resolve" });
    expect(await t.escalations.resolve(other.id)).toMatchObject({
      step: "to_didi",
      gateRequestId: null,
      move: { outcome: "rejected", failedGuards: ["didi_question_open"] },
    });
    expect(await t.store.listOpenGateRequests(t.projectId)).toEqual([]);
  });

  it("refuses every move under the kill switch", async () => {
    const t = await setup();
    const node = await t.escalated();
    await t.councilDecides(node.id, KEEPS);
    await t.setting("kill_switch", true);
    expect(await t.escalations.resolve(node.id)).toMatchObject({
      step: "returned",
      move: { outcome: "refused", reason: "kill_switch" },
    });
    expect(await t.state(node.id)).toBe("escalated_to_council");
    expect(await t.counters(node.id)).toEqual({ failure: 3, qaRound: 2 });
  });

  it("takes on every escalated item in one pass", async () => {
    const t = await setup();
    const back = await t.escalated();
    const waiting = await t.escalated();
    await t.councilDecides(back.id, KEEPS);
    expect(await t.escalations.resolveAll()).toMatchObject([
      { nodeId: back.id, step: "returned" },
      { nodeId: waiting.id, step: "waiting", on: "council" },
    ]);
  });
});

describe("a reversed decision (unit, ADR 0104, O-45)", () => {
  it("marks every dependent stale and opens one Council question, once", async () => {
    const t = await setup();
    const [a, b, other] = [
      await t.node("ready_for_dev"),
      await t.node("in_development"),
      await t.node("ready_for_dev"),
    ];
    const decision = await t.library.recordDecision(
      {
        projectId: t.projectId,
        nodeId: null,
        kind: "approval",
        scope: { option: "a" },
        textVerbatim: "Option A",
        byActor: "didi",
      },
      [a.id, b.id],
    );
    const question = await t.library.reverseDecision(
      decision.id,
      "didi",
      "Option B now",
    );
    expect(question).toMatchObject({
      kind: "council_question",
      owner: "council",
      topicKey: `decision-reversed:${decision.id}`,
      payload: { decisionId: decision.id, staleNodeIds: [a.id, b.id] },
    });
    expect((await t.store.getNode(a.id))?.stale).toBe(true);
    expect((await t.store.getNode(b.id))?.stale).toBe(true);
    expect((await t.store.getNode(other.id))?.stale).toBe(false);
    expect((await t.store.getDecision(decision.id))?.status).toBe("reversed");
    // A repeat writes nothing again.
    expect((await t.library.reverseDecision(decision.id, "didi", "again"))?.id).toBe(
      question?.id,
    );
    expect(await t.store.listOpenGateRequests(t.projectId)).toHaveLength(1);
  });

  it("starts no work on a stale item: the dispatch move is refused and no builder run is due", async () => {
    const t = await setup();
    const ready = await t.node("ready_for_dev", { stale: true });
    const check = await t.library.checkTransition({
      nodeId: ready.id,
      toState: "in_development",
      trigger: { kind: "reconcile", ref: null },
      actor: { kind: "runner", id: "test" },
    });
    expect(check.outcome).toBe("rejected");
    expect(
      check.guardReport.find((c) => c.name === "agent_ready_not_on_hold"),
    ).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/stale/),
    });
    const back = await t.node("in_qa_review", { ownerRole: "qa" });
    await t.head(back.id, HEAD);
    await t.qaFails(back.id, HEAD);
    await t.store.setNodeFlags(back.id, { stale: true }, t.clock.now());
    expect(await createBuilderRuns(t.deps).check(back.id)).toMatchObject({
      due: false,
      reason: "not_dispatchable",
    });
  });
});
