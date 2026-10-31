// Seam: the dispatch and run-end flows (build plan M3.1 and M3.2, ADR 0106 sections 6 and 7,
// ADR 0107) with a fake agent runtime on the memory store. Admission itself is tested in
// src/core/runs.test.ts; this covers the flows around it: what is started, what is recorded,
// and that a duplicate trigger gives one run and one end.
import { describe, expect, it } from "vitest";

import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import { createFlowFixture, HEAD, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "token-like-text-that-is-never-stored",
  turns: 12,
  costUsd: 0.4,
  minutes: 6,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

async function readyItem(f: FlowFixture) {
  return f.node("ready_for_dev");
}

describe("dispatch flow (flow: fake adapters, build plan M3.1)", () => {
  it("admits one run and starts it with its role's limits", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const result = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    expect(result.outcome).toBe("started");
    const runs = await f.store.listRuns({ nodeId: node.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ bot: "developer", model: "claude-sonnet-5-5" });
    expect(f.tasksFor).toEqual([runs[0]?.id]);
    expect(f.runtime.started).toEqual([
      { task: { runId: runs[0]?.id }, limits: f.deps.limits.developer },
    ]);
    expect(result).toEqual({
      outcome: "started",
      runId: runs[0]?.id,
      handle: { runId: runs[0]?.id },
    });
  });

  it("refuses under the kill switch, writes nothing and starts nothing", async () => {
    const f = await createFlowFixture();
    await f.live();
    await f.killed();
    const node = await readyItem(f);
    const before = await f.footprint(node.id);
    expect(await dispatch(f.deps, { nodeId: node.id, role: "developer" })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.started).toEqual([]);
  });

  it("in dry run plans the run, inserts nothing and starts nothing", async () => {
    const f = await createFlowFixture();
    const node = await readyItem(f);
    const before = await f.footprint(node.id);
    const result = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    expect(result).toMatchObject({ outcome: "planned", run: { nodeId: node.id } });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.started).toEqual([]);
  });

  it("gives one run for a duplicate trigger, in turn or at once", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const input = { nodeId: node.id, role: "developer" as const };
    await dispatch(f.deps, input);
    expect(await dispatch(f.deps, input)).toEqual({
      outcome: "not_admitted",
      admitted: false,
      reason: "item_has_active_run",
    });
    const other = await readyItem(f);
    const both = await Promise.all([
      dispatch(f.deps, { ...input, nodeId: other.id }),
      dispatch(f.deps, { ...input, nodeId: other.id }),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["not_admitted", "started"]);
    expect(await f.store.listRuns({ nodeId: node.id })).toHaveLength(1);
    expect(await f.store.listRuns({ nodeId: other.id })).toHaveLength(1);
    expect(f.runtime.started).toHaveLength(2);
  });

  it("gives one QA run for a duplicate event on the same head", async () => {
    const f = await createFlowFixture();
    await f.live();
    const node = await f.node("in_qa_review");
    const input = { nodeId: node.id, role: "qa" as const, prNumber: 7, headSha: HEAD };
    expect((await dispatch(f.deps, input)).outcome).toBe("started");
    expect(await dispatch(f.deps, input)).toMatchObject({ reason: "qa_duplicate" });
    expect(f.runtime.started).toHaveLength(1);
  });
});

describe("run-end flow (flow: fake adapters, build plan M3.1)", () => {
  async function activeRun() {
    const f = await createFlowFixture();
    await f.live();
    const node = await readyItem(f);
    const started = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
    if (started.outcome !== "started") throw new Error("the dispatch was not started");
    const input = { runId: started.runId, handle: started.handle };
    return { f, node, input };
  }

  it("records the end once the run has finished, then cleans up", async () => {
    const { f, input } = await activeRun();
    expect(await recordRunEnd(f.deps, input)).toEqual({ outcome: "running" });
    expect((await f.store.getRun(input.runId))?.endedAt).toBeNull();

    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    expect(await recordRunEnd(f.deps, input)).toMatchObject({ outcome: "recorded" });
    const ended = await f.store.getRun(input.runId);
    expect(ended).toMatchObject({
      outcome: "success",
      turns: 12,
      minutes: 6,
      costUsd: 0.4,
    });
    expect(ended?.tokens).toEqual(RESULT.tokens);
    expect(JSON.stringify(ended)).not.toContain(RESULT.finalText);
    expect(f.runtime.cleaned).toEqual([input.handle]);
  });

  it("refuses under the kill switch without polling or writing", async () => {
    const { f, node, input } = await activeRun();
    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    await f.killed();
    const before = await f.footprint(node.id);
    expect(await recordRunEnd(f.deps, input)).toEqual({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.polled).toEqual([]);
    expect(f.runtime.cleaned).toEqual([]);
  });

  it("in dry run reports what it would record and writes nothing", async () => {
    const { f, node, input } = await activeRun();
    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    await f.setting("dry_run", true);
    const before = await f.footprint(node.id);
    expect(await recordRunEnd(f.deps, input)).toMatchObject({
      outcome: "would_record",
      report: { outcome: "success" },
    });
    expect(await f.footprint(node.id)).toBe(before);
    expect(f.runtime.cleaned).toEqual([]);
  });

  it("records one end for a duplicate trigger, in turn or at once", async () => {
    const { f, input } = await activeRun();
    f.runtime.status.set(input.runId, { state: "finished", result: RESULT });
    const both = await Promise.all([
      recordRunEnd(f.deps, input),
      recordRunEnd(f.deps, input),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["already_recorded", "recorded"]);
    const endedAt = (await f.store.getRun(input.runId))?.endedAt;
    f.advanceMinutes(5);
    expect(await recordRunEnd(f.deps, input)).toEqual({ outcome: "already_recorded" });
    expect((await f.store.getRun(input.runId))?.endedAt).toEqual(endedAt);
  });

  it("records a usage-exhausted end with its cause, which queues the dispatch", async () => {
    const { f, node, input } = await activeRun();
    f.runtime.status.set(input.runId, {
      state: "finished",
      result: {
        ...RESULT,
        outcome: "usage_exhausted",
        usageExhaustedCause: "rate_limit",
        retryAfterSeconds: 60,
      },
    });
    await recordRunEnd(f.deps, input);
    expect(await f.store.getRun(input.runId)).toMatchObject({
      outcome: "usage_exhausted",
      usageExhaustedCause: "rate_limit",
      retryAfterSeconds: 60,
    });
    expect(
      await dispatch(f.deps, { nodeId: node.id, role: "developer" }),
    ).toMatchObject({
      reason: "usage_exhausted_wait",
    });
  });
});
