// Seam: the flows around a cancelled item's pull request (D-318, O-98) with a fake agent runtime
// on the memory store and the real contracts, guards and bot files' limits. Through the called
// flow `f/foreman/cancel_item`: Didi's cancel moves the item to Cancelled and starts its own bot's
// close run at once, with the close input and the close task type's small limits; the run-end
// flow records its outcome on the item and starts nothing more; the reconcile flow's live passes
// never start a second close run for the same pull request, whatever the first one's end. The
// switches and admission: dry run plans and writes nothing, the kill switch and a full cluster
// refuse and the next pass starts it, and a policy without a route for the close task type (as
// before migration 0019, D-324) refuses with `no_route`. The wrapper itself is tested in src/agent-images/opencode/; the rules
// in test/pr-close.test.ts. Synthetic data only.
import { describe, expect, it } from "vitest";

import { run as cancelItem } from "../../flows/cancel-item.ts";
import { closePass } from "../../flows/lib/close-runs.ts";
import { cancelPass } from "../../flows/lib/council-runs.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import {
  readBotFiles,
  taskTypeLimits,
} from "../../src/adapters/contracts-file/bot-files.ts";
import {
  CLOSE_COMMENT,
  CLOSE_REPORT_KIND,
  closeReportRef,
} from "../../src/core/pr-close.ts";
import { FIRST_ROUTING_POLICY } from "../../src/core/routing-testing.ts";
import { REPO } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const LIMITS = taskTypeLimits(readBotFiles());

const CLOSED: AgentRunResult = {
  outcome: "success",
  detail: "success",
  finalText: "",
  structured: { closeOutcome: "closed", pullRequest: 12 },
  turns: 0,
  costUsd: 0,
  minutes: 1,
  tokens: null,
  model: "claude-sonnet-5-5",
};

/** A live fixture with the close limits and routes, and an item whose PR #12 is open. */
async function withPullRequest(role: "developer" | "designer" = "developer") {
  const f = await createFlowFixture();
  f.deps.taskLimits = LIMITS;
  await f.live();
  const item = await f.node(
    role === "designer" ? "building_components" : "in_development",
    {
      title: "Fix the link",
      ...(role === "designer" ? { track: "design", ownerRole: "designer" } : {}),
    },
  );
  const builder = await f.run(item.id, role, 10, {
    endedAt: f.clock.now(),
    outcome: "success",
  });
  await f.evidence(
    item.id,
    "dispatch_record",
    { repo: REPO, branch: `foreman/${item.id}` },
    { runId: builder.id },
  );
  await f.evidence(
    item.id,
    "ci_run",
    { conclusion: "success", pr: 12, changedPaths: [] },
    { commitSha: "b".repeat(40) },
  );
  return { f, item };
}

const closeRunsOf = async (f: FlowFixture, nodeId: string) =>
  (await f.store.listRuns({ nodeId })).filter((r) => r.taskType.endsWith(":close"));

describe("a cancelled item's pull request closed by its own bot (flow: fake adapters, D-318)", () => {
  it("Didi's cancel starts the item's bot's close run at once, with the close input and its small limits", async () => {
    const { f, item } = await withPullRequest();
    const result = await cancelItem(f.deps, { nodeId: item.id, reason: "Not needed." });
    expect(result).toMatchObject({
      mode: "cancel",
      cancel: {
        recorded: true,
        step: { items: [{ nodeId: item.id, result: "cancelled" }] },
      },
      closeRuns: [{ nodeId: item.id, pullRequest: 12, outcome: "started" }],
    });
    const [close] = await closeRunsOf(f, item.id);
    expect(close).toMatchObject({
      bot: "developer",
      taskType: "developer:close",
      prNumber: 12,
      budget: { maxTurns: 1, maxMinutes: 5, maxUsd: 0.01 },
    });
    expect(f.runtime.started.at(-1)?.limits).toEqual(LIMITS["developer:close"]);
    const start = f.tasksFor.at(-1);
    expect(start?.branch).toBe(`foreman/${item.id}`);
    expect(JSON.parse(start?.input ?? "")).toEqual({
      repository: REPO,
      pullRequest: 12,
      comment: CLOSE_COMMENT,
    });
    // A close run pushes nothing: the item's latest dispatch record is still the builder's.
    const records = await f.store.listEvidence({
      nodeId: item.id,
      kind: "dispatch_record",
    });
    expect(records).toHaveLength(1);
  });

  it("the cancel pass starts the close run of each item it cancels, in the step's result", async () => {
    const { f, item } = await withPullRequest();
    // A cancel standing on the item that the pass has not acted on yet.
    await f.store.insertDecision({
      id: f.deps.ids.next(),
      projectId: f.projectId,
      nodeId: item.id,
      kind: "answer",
      scope: { kind: "cancel", via: "cancel_item" },
      textVerbatim: "Not needed.",
      byActor: "didi",
      recordedAt: f.clock.now(),
    });
    expect(await cancelPass(f.deps)).toMatchObject([
      {
        nodeId: item.id,
        step: "acted",
        items: [{ nodeId: item.id, result: "cancelled", pullRequest: { number: 12 } }],
        closeRuns: [{ nodeId: item.id, pullRequest: 12, outcome: "started" }],
      },
    ]);
    expect(await closeRunsOf(f, item.id)).toHaveLength(1);
  });

  it("the run's end records the outcome on the item, and no pass starts a second close run", async () => {
    const { f, item } = await withPullRequest("designer");
    await cancelItem(f.deps, { nodeId: item.id, reason: "Not needed." });
    const [close] = await closeRunsOf(f, item.id);
    if (!close) throw new Error("no close run");
    expect(close).toMatchObject({ bot: "designer", taskType: "designer:close" });
    f.runtime.status.set(close.id, { state: "finished", result: CLOSED });
    const ended = await recordRunEnd(f.deps, { runId: close.id });
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      move: { requested: false },
      builderRuns: [],
      closeRun: { nodeId: item.id, close: { status: "ended", outcome: "closed" } },
    });
    const reports = await f.store.listEvidence({
      nodeId: item.id,
      kind: "agent_report",
    });
    expect(reports).toMatchObject([
      {
        ref: closeReportRef(close.id),
        runId: close.id,
        recordedBy: "runner",
        payload: { kind: CLOSE_REPORT_KIND, outcome: "closed", pullRequest: 12 },
      },
    ]);
    // A repeated end records nothing more; the item stays Cancelled with no new move.
    await recordRunEnd(f.deps, { runId: close.id });
    expect(
      await f.store.listEvidence({ nodeId: item.id, kind: "agent_report" }),
    ).toHaveLength(1);
    expect((await f.store.getNode(item.id))?.state).toBe("cancelled");

    f.advanceMinutes(10);
    const passed = await reconcileFlow(f.deps);
    expect(passed).toMatchObject({ closes: [] });
    expect(await closePass(f.deps, [item.id])).toEqual([]);
    expect(await closeRunsOf(f, item.id)).toHaveLength(1);
  });

  it("a close run that fails is recorded as failed, and none is started again", async () => {
    const { f, item } = await withPullRequest();
    await cancelItem(f.deps, { nodeId: item.id, reason: "Not needed." });
    const [close] = await closeRunsOf(f, item.id);
    if (!close) throw new Error("no close run");
    f.runtime.status.set(close.id, {
      state: "finished",
      result: {
        ...CLOSED,
        outcome: "fail",
        detail: "agent_error",
        structured: undefined,
      },
    });
    expect(await recordRunEnd(f.deps, { runId: close.id })).toMatchObject({
      closeRun: { close: { status: "ended", outcome: "failed" } },
    });
    // A success whose result cannot be read ends `fail` too (checked in test/pr-close.test.ts).
    f.advanceMinutes(10);
    await reconcileFlow(f.deps);
    expect(await closeRunsOf(f, item.id)).toHaveLength(1);
  });

  it("a success with an unreadable result ends the run fail, recorded as failed", async () => {
    const { f, item } = await withPullRequest();
    await cancelItem(f.deps, { nodeId: item.id, reason: "Not needed." });
    const [close] = await closeRunsOf(f, item.id);
    if (!close) throw new Error("no close run");
    f.runtime.status.set(close.id, {
      state: "finished",
      result: { ...CLOSED, structured: { closeOutcome: "closed", pullRequest: 13 } },
    });
    expect(await recordRunEnd(f.deps, { runId: close.id })).toMatchObject({
      report: { outcome: "fail" },
      closeRun: { close: { status: "ended", outcome: "failed" } },
    });
  });

  it("respects admission: the kill switch and a full cluster refuse, writing nothing, and the next pass starts it", async () => {
    const { f, item } = await withPullRequest();
    await f.setting("agent_cluster_max_active_runs", 1);
    const other = await f.node("in_development");
    await f.run(other.id, "developer");
    expect(await cancelItem(f.deps, { nodeId: item.id, reason: "x" })).toMatchObject({
      closeRuns: [{ outcome: "not_admitted", reason: "cluster_full" }],
    });
    expect(await closeRunsOf(f, item.id)).toEqual([]);

    await f.setting("agent_cluster_max_active_runs", 10);
    await f.setting("kill_switch", true);
    expect(await closePass(f.deps)).toMatchObject([
      { nodeId: item.id, outcome: "not_admitted", reason: "kill_switch" },
    ]);
    expect(await closeRunsOf(f, item.id)).toEqual([]);

    await f.setting("kill_switch", false);
    f.advanceMinutes(10);
    const passed = await reconcileFlow(f.deps);
    expect(passed).toMatchObject({
      closes: [{ nodeId: item.id, pullRequest: 12, outcome: "started" }],
    });
    expect(await closeRunsOf(f, item.id)).toHaveLength(1);
  });

  it("a start that throws is start_failed with its error's kind (D-384)", async () => {
    const { f, item } = await withPullRequest();
    f.runtime.failNext.add("start");
    expect(await cancelItem(f.deps, { nodeId: item.id, reason: "x" })).toMatchObject({
      closeRuns: [
        // The fake's plain Error: only its kind is kept, never its message.
        { nodeId: item.id, outcome: "start_failed", error: { type: "Error" } },
      ],
    });
  });

  it("in dry run plans the close run and writes nothing", async () => {
    const { f, item } = await withPullRequest();
    await cancelItem(f.deps, { nodeId: item.id, reason: "x" });
    const [close] = await closeRunsOf(f, item.id);
    if (!close) throw new Error("no close run");
    // A second pull request on the item, its close not run yet.
    await f.evidence(
      item.id,
      "ci_run",
      { conclusion: "success", pr: 14, changedPaths: [] },
      { commitSha: "c".repeat(40) },
    );
    f.runtime.status.set(close.id, { state: "finished", result: CLOSED });
    await recordRunEnd(f.deps, { runId: close.id });
    await f.setting("dry_run", true);
    const before = await f.footprint(item.id);
    expect(await closePass(f.deps, [item.id])).toMatchObject([
      { nodeId: item.id, pullRequest: 14, outcome: "planned" },
    ]);
    expect(await f.footprint(item.id)).toBe(before);
  });

  it("refuses with no_route when the routing policy has no entry for the close task type", async () => {
    const f = await createFlowFixture();
    f.deps.taskLimits = LIMITS;
    await f.live();
    // The first policy, before migration 0019 gave the close task types their route (D-324).
    await f.setting("model_routing_policy", FIRST_ROUTING_POLICY);
    const item = await f.node("in_development");
    const builder = await f.run(item.id, "developer", 10, {
      endedAt: f.clock.now(),
      outcome: "success",
    });
    await f.evidence(item.id, "dispatch_record", { repo: REPO }, { runId: builder.id });
    await f.evidence(
      item.id,
      "ci_run",
      { conclusion: "success", pr: 12, changedPaths: [] },
      { commitSha: "b".repeat(40) },
    );
    expect(await cancelItem(f.deps, { nodeId: item.id, reason: "x" })).toMatchObject({
      closeRuns: [{ outcome: "not_admitted", reason: "no_route" }],
    });
    expect(await closeRunsOf(f, item.id)).toEqual([]);
  });
});
