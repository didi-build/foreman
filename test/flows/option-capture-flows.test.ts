// Seam: option capture through the flows (O-88, D-274) with a fake agent runtime, a fake
// screenshot port and the memory store, on the real contracts and guards. The run-end flow of a
// Designer run captures at once when CI has already rendered the options, and the report's move
// then takes the item into Waiting for Didi. When CI has not, the report's move is refused without
// counting a failure or starting a fix round, and the option capture flow (the event path) or the
// reconcile flow's capture pass (the safety net) captures later and asks for the same report's
// move again, once. A refusal the Designer caused counts one failure once per head and starts the
// fix round with the refusal's fixed text in its input; a public repository opens nothing and
// counts nothing (O-89). Synthetic images only.
import { describe, expect, it } from "vitest";

import { run as optionCaptureFlow } from "../../flows/option-capture.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { visualApprovalTopic } from "../../src/core/guards/design.ts";
import { CAPTURE_REFUSAL_TEXT } from "../../src/core/option-capture.ts";
import { REPO } from "../reconcile-fixture.ts";
import { setupCapture } from "../option-capture-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 8,
  costUsd: 0.3,
  minutes: 5,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

/** A design item in exploration whose Designer run is still running, live. */
async function setup(bundle: boolean, names?: string[]) {
  const f = await createFlowFixture();
  await f.live();
  const c = await setupCapture(f, {
    screenshots: f.screenshots,
    visibility: f.repoVisibility,
    bundle,
    ...(names ? { names } : {}),
    designerRun: { endedAt: null, outcome: null },
  });
  await f.store.setRunHandle(c.designerRun.id, {
    runtime: "fake",
    runId: c.designerRun.id,
  });
  // The run's start as the dispatch records it, so a fix round can follow it.
  await f.evidence(
    c.nodeId,
    "dispatch_record",
    { repo: REPO, branch: `foreman/${c.nodeId}` },
    { runId: c.designerRun.id },
  );
  f.advanceMinutes(1);
  return { f, c };
}

const finish = (f: FlowFixture, runId: string) => {
  f.runtime.status.set(runId, { state: "finished", result: RESULT });
  return recordRunEnd(f.deps, { runId });
};

const failures = (f: FlowFixture, nodeId: string) =>
  f.store.getCounter(nodeId, "failure");

describe("option capture through the flows (flow: fake adapters, O-88)", () => {
  it("captures at the Designer run's end when CI has rendered the options, and the report's move takes the item to Waiting for Didi", async () => {
    const { f, c } = await setup(true);
    const ended = await finish(f, c.designerRun.id);
    expect(ended).toMatchObject({
      outcome: "recorded",
      optionCapture: { step: "opened", options: ["a", "b"] },
      move: { requested: true, outcome: "applied", toState: "waiting_for_didi" },
      builderRuns: [],
    });
    expect((await f.store.getNode(c.nodeId))?.state).toBe("waiting_for_didi");
    expect(
      await f.store.findOpenGateRequest(f.projectId, visualApprovalTopic(c.nodeId)),
    ).toMatchObject({ kind: "visual_approval", owner: "didi" });
    // A repeated run-end trigger records nothing more.
    expect(await recordRunEnd(f.deps, { runId: c.designerRun.id })).toMatchObject({
      outcome: "already_recorded",
      optionCapture: { step: "not_exploring" },
    });
    expect(f.runtime.started).toEqual([]);
  });

  it("before CI has rendered them: the report's move is refused with no failure and no fix round, and the option capture flow then moves the item once", async () => {
    const { f, c } = await setup(false);
    const ended = await finish(f, c.designerRun.id);
    expect(ended).toMatchObject({
      optionCapture: { step: "bundle_missing" },
      move: {
        requested: true,
        outcome: "rejected",
        failedGuards: ["options_attached"],
      },
      builderRuns: [],
    });
    expect(ended).not.toHaveProperty("move.failureCount");
    expect(await failures(f, c.nodeId)).toBe(0);
    expect(f.runtime.started).toEqual([]);
    expect((await f.store.getNode(c.nodeId))?.state).toBe("in_design_exploration");

    // CI finishes on the head: the event path captures and asks for the report's move again.
    c.putOptions(["a", "b"]);
    const [step] = await optionCaptureFlow(f.deps, { nodeId: c.nodeId });
    expect(step).toMatchObject({
      capture: { step: "opened", designerRunId: c.designerRun.id },
      move: {
        move: { requested: true, outcome: "applied", toState: "waiting_for_didi" },
        builderRuns: [],
      },
    });
    expect((await f.store.getNode(c.nodeId))?.state).toBe("waiting_for_didi");
    const moves = (await f.transitions(c.nodeId)).filter((t) => t.mode === "applied");
    expect(moves.map((t) => [t.toState, t.triggerRef])).toEqual([
      ["waiting_for_didi", `run:${c.designerRun.id}`],
    ]);
    // Again: the item has moved on, so nothing more.
    expect(await optionCaptureFlow(f.deps, { nodeId: c.nodeId })).toEqual([
      { capture: { nodeId: c.nodeId, step: "not_exploring" } },
    ]);
    expect(await failures(f, c.nodeId)).toBe(0);
  });

  it("the reconcile flow's capture pass is the safety net for a capture the event missed", async () => {
    const { f, c } = await setup(false);
    await finish(f, c.designerRun.id);
    expect((await reconcileFlow(f.deps)).optionCaptures).toEqual([
      { capture: { nodeId: c.nodeId, step: "bundle_missing" } },
    ]);
    c.putOptions(["a", "b"]);
    const pass = await reconcileFlow(f.deps);
    expect(pass.optionCaptures).toMatchObject([
      {
        capture: { step: "opened" },
        move: { move: { outcome: "applied", toState: "waiting_for_didi" } },
      },
    ]);
    expect((await f.store.getNode(c.nodeId))?.state).toBe("waiting_for_didi");
    expect((await reconcileFlow(f.deps)).optionCaptures).toEqual([]);
  });

  it("a refusal the Designer caused counts one failure and starts the fix round with the refusal's text; a pass repeat counts nothing more, an empty fix round counts once more (O-89, D-293)", async () => {
    const { f, c } = await setup(true, ["a"]);
    const ended = await finish(f, c.designerRun.id);
    expect(ended).toMatchObject({
      optionCapture: {
        step: "refused",
        reason: "too_few_options",
        failureCount: { counted: true, failures: 1 },
      },
      move: {
        requested: true,
        outcome: "rejected",
        failedGuards: ["options_attached"],
      },
      builderRuns: [{ nodeId: c.nodeId, role: "designer", cause: "refused" }],
    });
    // The report's own refusal by `options_attached` alone still counts nothing (O-88).
    expect(ended).not.toHaveProperty("move.failureCount");
    expect(await failures(f, c.nodeId)).toBe(1);
    expect(f.runtime.started).toHaveLength(1);
    // The fix round's input says why it came back, with the refusal's fixed text.
    const [fixRound] = f.tasksFor;
    expect(fixRound?.input).toContain(CAPTURE_REFUSAL_TEXT.too_few_options);
    expect(fixRound?.input).not.toMatch(/https?:/);

    // While the fix round runs, a capture pass waits and counts nothing.
    expect(await optionCaptureFlow(f.deps, { nodeId: c.nodeId })).toMatchObject([
      { capture: { step: "designer_running" } },
    ]);
    expect(await failures(f, c.nodeId)).toBe(1);
    // The fix round's run ends without a new head: it counts once more (D-293) and the next
    // fix round starts, so repeated empty rounds reach the Council.
    const fixRunId = fixRound!.run.id;
    f.advanceMinutes(5);
    const ended2 = await finish(f, fixRunId);
    expect(ended2).toMatchObject({
      optionCapture: {
        step: "refused",
        failureCount: { counted: true, failures: 2 },
      },
    });
    expect(await failures(f, c.nodeId)).toBe(2);
    expect(f.runtime.started).toHaveLength(2);
    // A capture pass asking again for the same run and head counts nothing more.
    const pass = await optionCaptureFlow(f.deps, { nodeId: c.nodeId });
    expect(JSON.stringify(pass)).not.toContain('"counted":true');
    expect(await failures(f, c.nodeId)).toBe(2);
  });

  it("a public repository opens nothing, counts nothing and starts nothing (O-89)", async () => {
    const { f, c } = await setup(true);
    f.repoVisibility.set(REPO, "public");
    const ended = await finish(f, c.designerRun.id);
    expect(ended).toMatchObject({
      optionCapture: { step: "refused", reason: "no_private_link" },
      builderRuns: [],
    });
    expect(ended).not.toHaveProperty("optionCapture.failureCount");
    expect(await failures(f, c.nodeId)).toBe(0);
    expect(
      await f.store.findOpenGateRequest(f.projectId, visualApprovalTopic(c.nodeId)),
    ).toBe(null);
    expect((await f.store.getNode(c.nodeId))?.state).toBe("in_design_exploration");
    expect(f.runtime.started).toEqual([]);
  });

  it("does nothing under the kill switch or in dry run", async () => {
    const { f, c } = await setup(true);
    await f.setting("dry_run", true);
    const before = await f.footprint(c.nodeId);
    expect(await optionCaptureFlow(f.deps, { nodeId: c.nodeId })).toEqual([
      { capture: { nodeId: c.nodeId, step: "dry_run" } },
    ]);
    await f.setting("dry_run", false);
    await f.killed();
    expect(await optionCaptureFlow(f.deps, { nodeId: c.nodeId })).toEqual([
      { capture: { nodeId: c.nodeId, step: "kill_switch" } },
    ]);
    expect(await f.footprint(c.nodeId)).toBe(before);
    expect(f.screenshots.reads).toEqual([]);
  });
});
