// Seam: the dispatch and run-end flows with a fake agent runtime, a fake screenshot port and the
// memory store, for QA's visual comparison (D-242, D-250): the dispatch builds the run's images
// and input from the runner's own records and CI's bundles, the run end checks the answer and
// records `visual_comparison`, and the merge guard then decides. Synthetic images only.
import { describe, expect, it } from "vitest";

import { run as dispatch } from "../../flows/dispatch.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { ROUTING_SETTINGS } from "../../src/core/routing.ts";
import {
  FIRST_OUTPUT_TOKEN_NEEDS,
  FIRST_ROUTING_POLICY,
} from "../../src/core/routing-testing.ts";
import { HEAD } from "../reconcile-fixture.ts";
import { answer, setupVisual } from "../visual-fixture.ts";
import { createFlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 1,
  costUsd: 0.01,
  minutes: 1,
  tokens: { uncachedInput: 3000, cachedInput: 0, output: 200 },
  model: "claude-opus-5-5",
};

/** A routing policy with a `qa:visual` entry: the test's own, not a model choice (D-249). */
async function routeVisual(f: Awaited<ReturnType<typeof createFlowFixture>>) {
  const policy = structuredClone(FIRST_ROUTING_POLICY) as {
    taskTypes: Record<string, unknown>;
  };
  policy.taskTypes["qa:visual"] = policy.taskTypes["qa:review"];
  await f.setting(ROUTING_SETTINGS.policy, policy as never);
  await f.setting(ROUTING_SETTINGS.outputNeeds, {
    ...FIRST_OUTPUT_TOKEN_NEEDS,
    "qa:visual": 16000,
  });
}

async function started() {
  const f = await createFlowFixture();
  await f.live();
  await routeVisual(f);
  const v = await setupVisual(f, f.screenshots);
  const result = await dispatch(f.deps, {
    nodeId: v.nodeId,
    role: "qa",
    prNumber: 7,
    headSha: HEAD,
    taskType: "qa:visual",
  });
  return { f, v, result };
}

describe("QA's visual comparison through the flows (flow: fake adapters, D-242, D-250)", () => {
  it("starts a qa:visual run with the image pairs, the answer schema and no evidence ids", async () => {
    const { f, result } = await started();
    expect(result.outcome).toBe("started");
    const start = f.tasksFor[0];
    expect(start?.run.taskType).toBe("qa:visual");
    expect(start?.evidenceIds).toEqual([]);
    expect(start?.images?.map((i) => i.label)).toEqual([
      "Image 1: the approved option, component example-button, variant Primary",
      "Image 2: the built component at the head commit, component example-button, variant Primary",
    ]);
    expect(start?.outputSchema).toHaveProperty("properties.components");
    expect(start?.input).toContain("# Visual comparison");
  });

  it("refuses to start when the comparison cannot be built, writing no run", async () => {
    const f = await createFlowFixture();
    await f.live();
    await routeVisual(f);
    const v = await setupVisual(f, f.screenshots);
    const result = await dispatch(f.deps, {
      nodeId: v.nodeId,
      role: "qa",
      prNumber: 7,
      headSha: "e".repeat(40),
      taskType: "qa:visual",
    });
    expect(result).toEqual({
      outcome: "not_started",
      reason: "gallery_bundle_missing",
      failedGuards: [],
    });
    const runs = await f.store.listRuns({ nodeId: v.nodeId });
    expect(runs.filter((r) => r.bot === "qa")).toEqual([]);
  });

  it("finds no route while the routing policy names no model for qa:visual (D-249)", async () => {
    const f = await createFlowFixture();
    await f.live();
    const v = await setupVisual(f, f.screenshots);
    expect(
      await dispatch(f.deps, {
        nodeId: v.nodeId,
        role: "qa",
        prNumber: 7,
        headSha: HEAD,
        taskType: "qa:visual",
      }),
    ).toMatchObject({ outcome: "not_admitted", reason: "no_route" });
  });

  it("records the answer at the run's end, and a not-passing one keeps the item in QA review", async () => {
    const { f, v, result } = await started();
    if (result.outcome !== "started") throw new Error("not started");
    f.runtime.status.set(result.runId, {
      state: "finished",
      result: { ...RESULT, structured: answer("differs") },
    });
    const ended = await recordRunEnd(f.deps, { runId: result.runId });
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      visual: { recorded: true, pass: false, outcome: "differs" },
    });
    const rows = await f.store.listEvidence({
      nodeId: v.nodeId,
      kind: "visual_comparison",
    });
    expect(rows).toHaveLength(1);
    expect((await f.store.getNode(v.nodeId))?.state).toBe("in_qa_review");
  });

  it("ends the run fail on an answer it cannot record, and records nothing", async () => {
    const { f, v, result } = await started();
    if (result.outcome !== "started") throw new Error("not started");
    f.runtime.status.set(result.runId, {
      state: "finished",
      result: { ...RESULT, structured: { components: [] } },
    });
    expect(await recordRunEnd(f.deps, { runId: result.runId })).toMatchObject({
      outcome: "recorded",
      report: { outcome: "fail" },
      visual: { recorded: false, reason: "invalid" },
    });
    expect(
      await f.store.listEvidence({ nodeId: v.nodeId, kind: "visual_comparison" }),
    ).toEqual([]);
  });
});
