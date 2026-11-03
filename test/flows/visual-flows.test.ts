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
import { visualRerun } from "../../flows/lib/council-runs.ts";
import { VISUAL_CANNOT_TELL_REASON } from "../../src/core/run-reports.ts";
import { HEAD } from "../reconcile-fixture.ts";
import {
  answer,
  HEAD_CHANGED_PATHS,
  OPTION_PATH,
  setupVisual,
} from "../visual-fixture.ts";
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
    await f.evidence(
      v.nodeId,
      "ci_run",
      { conclusion: "success", pr: 7, changedPaths: HEAD_CHANGED_PATHS },
      { commitSha: "e".repeat(40) },
    );
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

  it("refuses to start on a PR that changes the screenshot pipeline, writing no run and nothing passing (D-279)", async () => {
    const f = await createFlowFixture();
    await f.live();
    await routeVisual(f);
    const v = await setupVisual(f, f.screenshots);
    await f.evidence(
      v.nodeId,
      "ci_run",
      {
        conclusion: "success",
        pr: 7,
        changedPaths: [...HEAD_CHANGED_PATHS, "scripts/lib/screenshot-bundle.ts"],
      },
      { commitSha: HEAD },
    );
    const result = await dispatch(f.deps, {
      nodeId: v.nodeId,
      role: "qa",
      prNumber: 7,
      headSha: HEAD,
      taskType: "qa:visual",
    });
    expect(result).toEqual({
      outcome: "not_started",
      reason: "screenshot_pipeline_changed",
      failedGuards: [],
    });
    const runs = await f.store.listRuns({ nodeId: v.nodeId });
    expect(runs.filter((r) => r.bot === "qa")).toEqual([]);
    expect(
      await f.store.listEvidence({ nodeId: v.nodeId, kind: "visual_comparison" }),
    ).toEqual([]);
    expect((await f.store.getNode(v.nodeId))?.state).toBe("in_qa_review");
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

  it("records the answer at the run's end; a match with no QA verdict moves nothing", async () => {
    const { f, v, result } = await started();
    if (result.outcome !== "started") throw new Error("not started");
    f.runtime.status.set(result.runId, {
      state: "finished",
      result: { ...RESULT, structured: answer("match") },
    });
    const ended = await recordRunEnd(f.deps, { runId: result.runId });
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      visual: { recorded: true, pass: true, outcome: "match" },
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

  describe("a comparison that does not pass (D-252)", () => {
    /** The visual run started on the head, with CI's run on record so the guards see the head. */
    async function onHead() {
      const setup = await started();
      await setup.f.evidence(
        setup.v.nodeId,
        "ci_run",
        { conclusion: "success", pr: 7, changedPaths: HEAD_CHANGED_PATHS },
        { commitSha: HEAD },
      );
      return setup;
    }
    const finish = async (
      f: Awaited<ReturnType<typeof createFlowFixture>>,
      runId: string,
      result: "match" | "differs" | "cannot_tell",
    ) => {
      f.runtime.status.set(runId, {
        state: "finished",
        result: { ...RESULT, structured: answer(result) },
      });
      return recordRunEnd(f.deps, { runId });
    };

    it("differs: QA's fail move sends the item back to Building components, counted, and the Designer's input quotes the findings", async () => {
      const { f, v, result } = await onHead();
      if (result.outcome !== "started") throw new Error("not started");
      const ended = await finish(f, result.runId, "differs");
      expect(ended).toMatchObject({
        visual: { recorded: true, outcome: "differs" },
        move: { requested: true, outcome: "applied", toState: "building_components" },
      });
      expect((await f.store.getNode(v.nodeId))?.state).toBe("building_components");
      expect(await f.store.getCounter(v.nodeId, "qa_round")).toBe(1);
      expect(await f.store.getCounter(v.nodeId, "failure")).toBe(1);
      // The fix round starts, and the Designer's input says why, quoting QA's words as data.
      const designer = f.tasksFor.find((t) => t.run.bot === "designer");
      expect(designer?.input).toContain("## Why the item came back");
      expect(designer?.input).toContain(
        "QA's visual comparison found that the built components differ from option a",
      );
      expect(designer?.input).toContain("> The button is red, not blue.");
      expect(designer?.input).toContain(
        "> - The primary button is blue with a dark label.",
      );
    });

    it("a PR that keeps an unpicked option folder: QA's fail move, counted, and the Designer's input names the folders (D-259)", async () => {
      const { f, v, result } = await started();
      if (result.outcome !== "started") throw new Error("not started");
      const unpicked = "design/gallery/example-button/options/b";
      await f.evidence(
        v.nodeId,
        "ci_run",
        {
          conclusion: "success",
          pr: 7,
          changedPaths: [`${OPTION_PATH}/index.html`, `${unpicked}/index.html`],
        },
        { commitSha: HEAD },
      );
      const ended = await finish(f, result.runId, "match");
      expect(ended).toMatchObject({
        visual: { recorded: true, outcome: "match" },
        move: { requested: true, outcome: "applied", toState: "building_components" },
      });
      expect(await f.store.getCounter(v.nodeId, "qa_round")).toBe(1);
      expect(await f.store.getCounter(v.nodeId, "failure")).toBe(1);
      const designer = f.tasksFor.find((t) => t.run.bot === "designer");
      expect(designer?.input).toContain("## Why the item came back");
      expect(designer?.input).toContain(
        "the pull request still carries the folders of exploration options Didi did not approve",
      );
      expect(designer?.input).toContain(`> ${unpicked}\n`);
      expect(designer?.input).not.toContain(`> ${OPTION_PATH}\n`);
    });

    it("cannot_tell: one more run on the same head, then the second cannot_tell escalates to the Council", async () => {
      const { f, v, result } = await onHead();
      if (result.outcome !== "started") throw new Error("not started");
      const first = await finish(f, result.runId, "cannot_tell");
      expect(first).toMatchObject({
        visual: { recorded: true, outcome: "cannot_tell" },
        visualRerun: { nodeId: v.nodeId, result: { outcome: "started" } },
      });
      expect(first).not.toHaveProperty("move.escalation");
      expect((await f.store.getNode(v.nodeId))?.state).toBe("in_qa_review");
      expect(await f.store.getCounter(v.nodeId, "qa_round")).toBe(0);
      const again =
        first.outcome === "recorded" ? first.visualRerun?.result : undefined;
      if (again?.outcome !== "started") throw new Error("no second run");
      const rerun = await f.store.getRun(again.runId);
      expect(rerun).toMatchObject({ bot: "qa", taskType: "qa:visual", headSha: HEAD });

      const second = await finish(f, again.runId, "cannot_tell");
      expect(second).toMatchObject({
        visual: { recorded: true, outcome: "cannot_tell" },
        move: { escalation: { outcome: "applied", toState: "escalated_to_council" } },
      });
      expect(second).not.toHaveProperty("visualRerun");
      const node = await f.store.getNode(v.nodeId);
      expect(node?.state).toBe("escalated_to_council");
      expect(node?.blockedReason).toBe(VISUAL_CANNOT_TELL_REASON);
      // Not a failed QA round.
      expect(await f.store.getCounter(v.nodeId, "qa_round")).toBe(0);
    });

    it("cannot_tell while the review run is active: the one more run waits for that run's end", async () => {
      const { f, v, result } = await onHead();
      if (result.outcome !== "started") throw new Error("not started");
      const review = await f.run(v.nodeId, "qa", 0, { headSha: HEAD, prNumber: 7 });
      const first = await finish(f, result.runId, "cannot_tell");
      expect(first).not.toHaveProperty("visualRerun");
      await f.store.endRun(review.id, {
        endedAt: f.clock.now(),
        outcome: "fail",
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        transcriptRef: null,
        usageExhaustedCause: null,
        retryAfterSeconds: null,
        serviceTierServed: null,
        capacityRetries: null,
        capacityWaitSeconds: null,
        firstTokenMs: null,
        reportedCostUsd: null,
      });
      expect(await visualRerun(f.deps, v.nodeId)).toMatchObject({
        result: { outcome: "started" },
      });
    });
  });
});
