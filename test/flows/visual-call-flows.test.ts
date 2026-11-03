// Seam: the Council pass, dispatch and run-end flows with a fake agent runtime, a fake screenshot
// port and the memory store, for the Council's call on a visual approval (D-263, D-270): with no
// route for `council:visual` the dispatch is refused with `no_route` and nothing changes; with
// one, the run starts with the option screenshots, its answer is recorded at the run's end on the
// call's own topic, an unusable answer gets one re-run and is then dropped, and the request, the
// item and what reaches Didi never change. Synthetic images only.
import { describe, expect, it } from "vitest";

import { councilPass } from "../../flows/lib/council-runs.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { ROUTING_SETTINGS } from "../../src/core/routing.ts";
import {
  FIRST_OUTPUT_TOKEN_NEEDS,
  FIRST_ROUTING_POLICY,
} from "../../src/core/routing-testing.ts";
import { visualCallTopic } from "../../src/core/visual-call.ts";
import { CALL, CALL_OPTION_COMMIT, setupVisualCall } from "../visual-call-fixture.ts";
import { createFlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 1,
  costUsd: 0.01,
  minutes: 1,
  tokens: { uncachedInput: 3000, cachedInput: 0, output: 200 },
  model: "claude-sonnet-5-5",
};

/** A routing policy with a `council:visual` entry: the test's own, not a model choice (D-249). */
async function routeVisualCall(f: Awaited<ReturnType<typeof createFlowFixture>>) {
  const policy = structuredClone(FIRST_ROUTING_POLICY) as {
    taskTypes: Record<string, unknown>;
  };
  policy.taskTypes["council:visual"] = policy.taskTypes.council;
  await f.setting(ROUTING_SETTINGS.policy, policy as never);
  await f.setting(ROUTING_SETTINGS.outputNeeds, {
    ...FIRST_OUTPUT_TOKEN_NEEDS,
    "council:visual": 16000,
  });
}

async function setup(routed = true) {
  const f = await createFlowFixture();
  await f.live();
  if (routed) await routeVisualCall(f);
  const v = await setupVisualCall(f, ["a", "b"], f.screenshots);
  const topic = visualCallTopic(v.nodeId);
  const callSteps = async () =>
    (await councilPass(f.deps)).filter((s) => s.kind === "visual_call");
  const finish = async (runId: string, structured: unknown) => {
    f.runtime.status.set(runId, {
      state: "finished",
      result: { ...RESULT, structured },
    });
    f.advanceMinutes(1);
    return recordRunEnd(f.deps, { runId });
  };
  return { f, v, topic, callSteps, finish };
}

describe("the Council's visual call through the flows (flow: fake adapters, D-270)", () => {
  it("is refused with no_route while the routing policy names no model for council:visual, and nothing changes", async () => {
    const { f, v, callSteps } = await setup(false);
    const before = await f.footprint(v.nodeId);
    expect(await callSteps()).toMatchObject([
      {
        kind: "visual_call",
        step: "start",
        result: { outcome: "not_admitted", reason: "no_route" },
      },
    ]);
    expect(await f.footprint(v.nodeId)).toBe(before);
    expect(f.runtime.started).toEqual([]);
    // Didi's approval is unaffected: the request stays open as it was.
    expect(await f.store.getGateRequest(v.gate.id)).toEqual(v.gate);
  });

  it("is refused on options from a PR that changes the screenshot pipeline, and nothing changes (D-279)", async () => {
    const { f, v, callSteps } = await setup();
    await f.evidence(
      v.nodeId,
      "ci_run",
      {
        conclusion: "success",
        pr: 7,
        changedPaths: [
          "design/gallery/example-button/options/a/index.html",
          "gallery/App.tsx",
        ],
      },
      { commitSha: CALL_OPTION_COMMIT },
    );
    const before = await f.footprint(v.nodeId);
    expect(await callSteps()).toMatchObject([
      {
        kind: "visual_call",
        step: "start",
        result: { outcome: "not_started", reason: "screenshot_pipeline_changed" },
      },
    ]);
    expect(await f.footprint(v.nodeId)).toBe(before);
    expect(f.runtime.started).toEqual([]);
    expect(await f.store.getGateRequest(v.gate.id)).toEqual(v.gate);
  });

  it("starts one run per request with the option screenshots, and records the call at its end", async () => {
    const { f, v, topic, callSteps, finish } = await setup();
    const [step] = await callSteps();
    expect(step).toMatchObject({ step: "start", result: { outcome: "started" } });
    // A second pass while the run is active starts nothing.
    expect(await callSteps()).toMatchObject([{ step: "running" }]);
    expect(f.tasksFor).toHaveLength(1);
    const start = f.tasksFor[0];
    expect(start?.run).toMatchObject({
      bot: "council",
      taskType: "council:visual",
      questionTopic: topic,
    });
    expect(start?.images?.map((i) => i.label)).toEqual([
      "Image 1: option a",
      "Image 2: option b",
    ]);
    expect(start?.outputSchema).toHaveProperty("properties.call");
    expect(start?.input).toContain("does it need Didi?");

    const node = await f.store.getNode(v.nodeId);
    const runId = (step?.result as { runId: string }).runId;
    const ended = await finish(runId, CALL);
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      council: { answer: { recorded: true, kind: "visual_call" }, council: [] },
    });
    const calls = (await f.store.listDecisionsForNode(v.nodeId)).filter(
      (d) => d.kind === "council_decision",
    );
    expect(calls).toMatchObject([
      { scope: { topicKey: topic, gateRequestId: v.gate.id, call: CALL.call, runId } },
    ]);
    // The request, the item and what is open for Didi are unchanged.
    expect(await f.store.getGateRequest(v.gate.id)).toEqual(v.gate);
    expect(await f.store.getNode(v.nodeId)).toEqual(node);
    expect(await f.store.listOpenGateRequests(f.projectId)).toEqual([v.gate]);
    expect(await callSteps()).toEqual([]);
  });

  it("re-runs once after an unusable answer, then drops the call with nothing for Didi", async () => {
    const { f, v, topic, callSteps, finish } = await setup();
    const [first] = await callSteps();
    const firstId = (first?.result as { runId: string }).runId;
    const ended = await finish(firstId, { call: "maybe", reason: "x" });
    expect(ended).toMatchObject({
      report: { outcome: "fail" },
      council: {
        answer: { recorded: false, reason: "invalid" },
        council: [{ step: "start", result: { outcome: "started" } }],
      },
    });
    const secondId = f.tasksFor[1]?.run.id ?? "";
    expect(f.tasksFor[1]?.run.taskType).toBe("council:visual");
    const last = await finish(secondId, { call: "needs_didi" });
    expect(last).toMatchObject({
      report: { outcome: "fail" },
      council: {
        council: [{ step: "drop", dropped: { recorded: true } }],
      },
    });
    expect(
      (await f.store.listDecisionsForNode(v.nodeId)).filter(
        (d) => d.kind === "council_decision",
      ),
    ).toMatchObject([
      {
        scope: {
          topicKey: topic,
          gateRequestId: v.gate.id,
          call: "dropped",
          runId: secondId,
        },
      },
    ]);
    expect(await f.store.listOpenGateRequests(f.projectId)).toEqual([v.gate]);
    expect(f.tasksFor).toHaveLength(2);
    expect(await callSteps()).toEqual([]);
  });
});
