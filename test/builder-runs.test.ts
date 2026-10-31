// Seam: unit, on the memory store with the real machine-2 contracts and guards. Which items need a
// builder run with no move (src/core/builder-runs.ts, O-41): an item a failed QA round or staging
// check sent back to its building state, with no builder run started since, and one whose builder
// run ended usage_exhausted; and why it came back, from the evidence the fail move carried. The
// dispatch of those runs is covered through the flows in test/flows/builder-run-flows.test.ts.
import { describe, expect, it } from "vitest";

import { createBuilderRuns } from "../src/core/builder-runs.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import type { AgentRole, Run, Track } from "../src/core/store.ts";
import { createReconcileFixture, HEAD, REPO } from "./reconcile-fixture.ts";
import { setupStaging } from "./staging-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createReconcileFixture>>;

/** Ends a run as the runner records it. */
async function end(
  f: Pick<Fixture, "store" | "clock">,
  run: Run,
  outcome: NonNullable<Run["outcome"]> = "success",
) {
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
}

/** A builder run whose start was recorded: the run and its `dispatch_record`. */
async function startedBuilderRun(f: Fixture, nodeId: string, role: AgentRole) {
  const run = await f.run(nodeId, role);
  await f.evidence(
    nodeId,
    "dispatch_record",
    { repo: REPO, branch: `foreman/${nodeId}` },
    { runId: run.id },
  );
  return run;
}

/** An item QA failed with findings, moved back by QA's report as the run-end flow asks for it. */
async function qaFailed(track: Track = "code", findings = 2) {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const builder: AgentRole = track === "design" ? "designer" : "developer";
  const node = await f.node("in_qa_review", { ownerRole: "qa", track });
  await end(f, await startedBuilderRun(f, node.id, builder));
  f.advanceMinutes(5);
  const ciId = await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: ["src/a.ts"] },
    { commitSha: HEAD },
  );
  const qa = await f.run(node.id, "qa");
  await end(f, qa);
  const verdictId = await f.evidence(
    node.id,
    "qa_verdict",
    {
      verdict: "fail",
      findings: Array.from({ length: findings }, (_, i) => ({
        path: "src/a.ts",
        startLine: i + 1,
        endLine: i + 2,
        note: `finding ${i + 1}`,
      })),
      evidenceIds: [ciId],
    },
    { commitSha: HEAD, runId: qa.id },
  );
  f.advanceMinutes(1);
  const move = await createRunReports(f.deps).requestReportedMove(qa.id);
  const builderRuns = createBuilderRuns(f.deps);
  return { f, node, builder, qa, verdictId, move, builderRuns };
}

/** An item merged and then failed on staging, with its builder's run ended. */
async function stagingFailed(answer: "check" | "deploy" = "check") {
  const t = await setupStaging();
  for (const run of await t.store.listRuns({ nodeId: t.node.id })) {
    if (run.endedAt === null) await end(t, run);
  }
  t.advanceMinutes(5);
  if (answer === "check") {
    t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
  } else {
    t.deploy(t.mergeSha, "failure");
  }
  await t.staging().verifyCommit(REPO, t.mergeSha);
  return { t, builderRuns: createBuilderRuns(t.deps) };
}

describe("a builder run due after QA's fail (unit, O-41)", () => {
  it("is due for the Developer once QA's fail sends the item back, and says why", async () => {
    const t = await qaFailed();
    expect(t.move).toMatchObject({ outcome: "applied", toState: "in_development" });
    expect(await t.builderRuns.check(t.node.id)).toEqual({
      due: true,
      nodeId: t.node.id,
      role: "developer",
      cause: "returned",
    });
    expect(await t.builderRuns.returnReason(t.node.id)).toEqual({
      kind: "qa_fail",
      commitSha: HEAD,
      findings: [
        { path: "src/a.ts", startLine: 1, endLine: 2, note: "finding 1" },
        { path: "src/a.ts", startLine: 2, endLine: 3, note: "finding 2" },
      ],
    });
    expect(await t.builderRuns.listDue()).toMatchObject([{ nodeId: t.node.id }]);
  });

  it("is due for the Designer on the design track, back in Building components", async () => {
    const t = await qaFailed("design");
    expect(t.move).toMatchObject({
      outcome: "applied",
      toState: "building_components",
    });
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({
      due: true,
      role: "designer",
    });
  });

  it("is not due once a builder run started since, and is due again when that run never started", async () => {
    const t = await qaFailed();
    // A run whose task or start failed has no dispatch record: it never started.
    const failedStart = await t.f.run(t.node.id, "developer");
    await end(t.f, failedStart, "fail");
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({ due: true });

    t.f.advanceMinutes(1);
    const started = await startedBuilderRun(t.f, t.node.id, "developer");
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({
      due: false,
      reason: "active_run",
    });
    await end(t.f, started);
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({
      due: false,
      reason: "not_due",
    });
    expect(await t.builderRuns.listDue()).toEqual([]);
  });

  it("is not due while the item is on hold, not agent-ready, or has an active run of any role", async () => {
    for (const change of [{ hold: true }, { agentReady: false }]) {
      const t = await qaFailed();
      await t.f.store.setNodeFlags(t.node.id, change, t.f.clock.now());
      expect(await t.builderRuns.check(t.node.id)).toMatchObject({
        due: false,
        reason: "not_dispatchable",
      });
    }
    const t = await qaFailed();
    await t.f.run(t.node.id, "qa");
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({
      due: false,
      reason: "active_run",
    });
  });

  it("is not due for an item still in review, or one that never came back", async () => {
    const t = await qaFailed("code", 0);
    expect(t.move).toMatchObject({ outcome: "rejected" });
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({
      due: false,
      reason: "not_building",
    });
    const first = await t.f.node("in_development");
    expect(await t.builderRuns.check(first.id)).toMatchObject({
      due: false,
      reason: "not_due",
    });
    expect(await t.builderRuns.returnReason(first.id)).toBeNull();
    const ready = await t.f.node("ready_for_dev");
    expect(await t.builderRuns.check(ready.id)).toMatchObject({
      due: false,
      reason: "not_building",
    });
  });

  it("is not due once the guards allow the escalation: the item belongs to the Council", async () => {
    const t = await qaFailed();
    await t.f.store.setCounter(t.node.id, "failure", 3, t.f.clock.now());
    expect(await t.builderRuns.check(t.node.id)).toMatchObject({
      due: false,
      reason: "escalation_due",
    });
  });

  it("at the third failed round QA's fail move is refused, so the item stays in review and gets no run", async () => {
    const f = await createReconcileFixture();
    await f.setting("dry_run", false);
    const node = await f.node("in_qa_review", { ownerRole: "qa" });
    await f.store.setCounter(node.id, "qa_round", 2, f.clock.now());
    const ciId = await f.evidence(
      node.id,
      "ci_run",
      { conclusion: "success", pr: 7 },
      { commitSha: HEAD },
    );
    const qa = await f.run(node.id, "qa");
    await end(f, qa);
    await f.evidence(
      node.id,
      "qa_verdict",
      {
        verdict: "fail",
        findings: [{ path: "a", startLine: 1, endLine: 1, note: "n" }],
        evidenceIds: [ciId],
      },
      { commitSha: HEAD, runId: qa.id },
    );
    expect(await createRunReports(f.deps).requestReportedMove(qa.id)).toMatchObject({
      outcome: "rejected",
      failedGuards: ["not_third_failed_round"],
    });
    expect(await createBuilderRuns(f.deps).check(node.id)).toMatchObject({
      due: false,
      reason: "not_building",
    });
  });
});

describe("a builder run due after a staging fail (unit, O-41)", () => {
  it("is due for the Developer after a failed check, and says what failed on which commit", async () => {
    const { t, builderRuns } = await stagingFailed();
    expect(await t.state()).toBe("in_development");
    expect(await t.counter("failure")).toBe(1);
    expect(await builderRuns.check(t.node.id)).toMatchObject({
      due: true,
      role: "developer",
      cause: "returned",
    });
    expect(await builderRuns.returnReason(t.node.id)).toEqual({
      kind: "staging_check_failed",
      mergeCommitSha: t.mergeSha,
      servedCommitSha: t.mergeSha,
    });
  });

  it("is due after a failed staging deploy, naming the deploy", async () => {
    const { t, builderRuns } = await stagingFailed("deploy");
    expect(await t.state()).toBe("in_development");
    expect(await builderRuns.check(t.node.id)).toMatchObject({ due: true });
    expect(await builderRuns.returnReason(t.node.id)).toEqual({
      kind: "staging_deploy_failed",
      mergeCommitSha: t.mergeSha,
      deployedSha: t.mergeSha,
      deployState: "failure",
    });
  });

  it("at the failure threshold the item escalates from the fail move, and gets no run", async () => {
    const t = await setupStaging();
    for (const run of await t.store.listRuns({ nodeId: t.node.id })) {
      if (run.endedAt === null) await end(t, run);
    }
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
    await t.staging().verifyCommit(REPO, t.mergeSha);
    expect(await t.counter("failure")).toBe(3);
    expect(await t.state()).toBe("escalated_to_council");
    expect(await createBuilderRuns(t.deps).check(t.node.id)).toMatchObject({
      due: false,
      reason: "not_building",
    });
  });
});

describe("a builder run resumed after usage_exhausted (unit, O-41)", () => {
  it("is due when the item's latest started run is the builder's and ended usage_exhausted", async () => {
    const f = await createReconcileFixture();
    const node = await f.node("in_development");
    const run = await startedBuilderRun(f, node.id, "developer");
    await end(f, run, "usage_exhausted");
    expect(await createBuilderRuns(f.deps).check(node.id)).toMatchObject({
      due: true,
      role: "developer",
      cause: "resumed",
    });
    // Its input says nothing about a return: it was never sent back.
    expect(await createBuilderRuns(f.deps).returnReason(node.id)).toBeNull();
  });
});
