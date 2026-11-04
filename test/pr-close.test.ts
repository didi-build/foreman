// Seam: unit, over the memory store with the real contracts (D-318, O-98, src/core/pr-close.ts and
// the close rules in src/core/runs.ts). When a cancelled item's close is due, and why not; the
// close input and result read strictly; the outcome recorded once per run, `failed` for any end
// it cannot read; and admission: a close run's own limits, its pull request number, and never a
// second close run for the same pull request, whatever the first one's end. The flows are in
// test/flows/close-runs.test.ts. Synthetic data only.
import { describe, expect, it } from "vitest";

import { mapRunEnd } from "../src/adapters/agent-runtime/kubernetes/result.ts";
import {
  CLOSE_COMMENT,
  closeInputText,
  createPullRequestCloses,
  readCloseInput,
  readCloseResult,
} from "../src/core/pr-close.ts";
import { createRuns, limitsFor, REHEARSAL_RUN_LIMITS } from "../src/core/runs.ts";
import { createReconcileFixture, REPO } from "./reconcile-fixture.ts";

const CLOSE_LIMITS = { maxTurns: 1, maxMinutes: 5, maxUsd: 0.01 };
const TASK_LIMITS = { "developer:close": CLOSE_LIMITS, "designer:close": CLOSE_LIMITS };
const HASH = "a".repeat(64);

async function cancelledWithPullRequest(
  options: { repo?: string; role?: "developer" | "designer" | "qa" } = {},
) {
  const f = await createReconcileFixture();
  const item = await f.node("cancelled");
  const builder = await f.run(item.id, options.role ?? "developer", 10, {
    endedAt: f.clock.now(),
    outcome: "success",
  });
  await f.evidence(
    item.id,
    "dispatch_record",
    { repo: options.repo ?? REPO, branch: `foreman/${item.id}` },
    { runId: builder.id },
  );
  await f.evidence(
    item.id,
    "ci_run",
    { conclusion: "success", pr: 12, changedPaths: [] },
    { commitSha: "b".repeat(40) },
  );
  return { f, item, closes: createPullRequestCloses(f.deps) };
}

describe("when a cancelled item's close is due (unit: memory store, D-318)", () => {
  it("is due for a cancelled item with a recorded pull request, from its own bot's close task type", async () => {
    const { item, closes } = await cancelledWithPullRequest({ role: "designer" });
    expect(await closes.target(item.id)).toMatchObject({
      role: "designer",
      taskType: "designer:close",
      pullRequest: { repo: REPO, number: 12 },
      input: closeInputText(REPO, 12),
    });
    expect(await closes.pending()).toEqual([item.id]);
  });

  it("is not due for an item not cancelled, with no pull request, in another repository, with no builder's run, or once a close run started", async () => {
    const open = await cancelledWithPullRequest();
    const live = await open.f.node("in_development");
    expect(await open.closes.target(live.id)).toEqual({ why: "not_cancelled" });
    const bare = await open.f.node("cancelled");
    expect(await open.closes.target(bare.id)).toEqual({ why: "no_pull_request" });
    expect(await open.closes.target("50000000-0000-4000-8000-999999999999")).toEqual({
      why: "no_node",
    });

    const moved = await cancelledWithPullRequest({ repo: "didi-build/other" });
    expect(await moved.closes.target(moved.item.id)).toEqual({
      why: "other_repository",
    });
    const qa = await cancelledWithPullRequest({ role: "qa" });
    expect(await qa.closes.target(qa.item.id)).toEqual({ why: "no_builder" });

    const { f, item, closes } = open;
    await f.run(item.id, "developer", 0, {
      taskType: "developer:close",
      prNumber: 12,
      endedAt: f.clock.now(),
      outcome: "fail",
    });
    expect(await closes.target(item.id)).toEqual({ why: "close_already_run" });
    expect(await closes.pending()).toEqual([]);
  });
});

describe("the close input and result (unit: read strictly, D-318)", () => {
  it("reads back exactly the input the runner writes", () => {
    expect(readCloseInput(closeInputText(REPO, 12), REPO)).toEqual({
      repository: REPO,
      pullRequest: 12,
      comment: CLOSE_COMMENT,
    });
    expect(CLOSE_COMMENT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("refuses anything else, naming the field only", () => {
    const text = (value: unknown) => JSON.stringify(value);
    expect(readCloseInput("not json", REPO)).toEqual({
      problem: "the close input is not JSON",
    });
    expect(readCloseInput(text([REPO, 12]), REPO)).toMatchObject({
      problem: expect.any(String) as unknown,
    });
    expect(readCloseInput(text({ repository: REPO, pullRequest: 12 }), REPO)).toEqual({
      problem: "the close input must have repository, pullRequest and comment only",
    });
    expect(
      readCloseInput(
        text({ repository: "x/y", pullRequest: 12, comment: CLOSE_COMMENT }),
        REPO,
      ),
    ).toEqual({ problem: "the close input's repository is not the run's repository" });
    for (const pullRequest of [0, -1, 1.5, "12", null]) {
      expect(
        readCloseInput(
          text({ repository: REPO, pullRequest, comment: CLOSE_COMMENT }),
          REPO,
        ),
      ).toEqual({
        problem: "the close input's pullRequest must be a whole number above 0",
      });
    }
    expect(
      readCloseInput(
        text({ repository: REPO, pullRequest: 12, comment: "Merge it." }),
        REPO,
      ),
    ).toEqual({ problem: "the close input's comment is not the fixed comment" });
  });

  it("reads a result of exactly {closeOutcome, pullRequest} with a known outcome", () => {
    for (const closeOutcome of [
      "closed",
      "already_closed",
      "already_merged",
      "not_found",
      "refused",
    ]) {
      expect(readCloseResult({ closeOutcome, pullRequest: 3 })).toEqual({
        closeOutcome,
        pullRequest: 3,
      });
    }
    for (const bad of [
      null,
      "closed",
      { closeOutcome: "deleted", pullRequest: 3 },
      { closeOutcome: "closed", pullRequest: 0 },
      { closeOutcome: "closed", pullRequest: 3, extra: true },
      { closeOutcome: "closed" },
    ]) {
      expect(readCloseResult(bad)).toBeNull();
    }
  });

  it("is passed through by the runtime as a success with its structured result", () => {
    const end = mapRunEnd(
      "complete",
      null,
      {
        status: "success",
        finalText: "",
        structured: { closeOutcome: "closed", pullRequest: 12 },
        turns: 0,
        costUsd: 0,
        tokens: null,
        errorText: "",
        providerError: null,
      },
      "claude-sonnet-5-5",
    );
    expect(end).toMatchObject({
      outcome: "success",
      detail: "success",
      structured: { closeOutcome: "closed", pullRequest: 12 },
    });
  });
});

describe("the close run's outcome (unit: recorded once per run, D-318)", () => {
  it("records the wrapper's outcome once, and failed for a run with no readable result", async () => {
    const { f, item, closes } = await cancelledWithPullRequest();
    const ended = { endedAt: f.clock.now(), outcome: "success" as const };
    const ok = await f.run(item.id, "developer", 0, {
      ...ended,
      taskType: "developer:close",
      prNumber: 12,
    });
    expect(
      await closes.recordOutcome(ok.id, { closeOutcome: "not_found", pullRequest: 12 }),
    ).toBe("not_found");
    // Once: a second call returns the first outcome and writes nothing.
    expect(
      await closes.recordOutcome(ok.id, { closeOutcome: "closed", pullRequest: 12 }),
    ).toBe("not_found");
    for (const result of [
      null,
      { closeOutcome: "closed", pullRequest: 99 },
      "closed",
    ]) {
      const run = await f.run(item.id, "developer", 0, {
        ...ended,
        taskType: "developer:close",
        prNumber: 12,
      });
      expect(await closes.recordOutcome(run.id, result)).toBe("failed");
    }
    expect(
      await f.store.listEvidence({ nodeId: item.id, kind: "agent_report" }),
    ).toHaveLength(4);
    expect(await closes.closeOf(item.id, 12)).toMatchObject({
      status: "ended",
      outcome: "failed",
    });
    // A builder's own run is not a close run: nothing is recorded for it.
    const builder = await f.run(item.id, "developer");
    expect(await closes.recordOutcome(builder.id, null)).toBeNull();
  });
});

describe("a close run's admission (unit: memory store, D-318)", () => {
  async function admission() {
    const { f, item } = await cancelledWithPullRequest();
    await f.setting("dry_run", false);
    const runs = createRuns({ ...f.deps, taskLimits: TASK_LIMITS });
    const request = {
      nodeId: item.id,
      role: "developer" as const,
      runtime: "opencode",
      botVersion: "v1",
      taskType: "developer:close",
      prNumber: 12,
    };
    return { f, item, runs, request };
  }

  it("records the close task type's own limits and the pull request on the run", async () => {
    const { runs, request } = await admission();
    const admitted = await runs.dispatch(request, { tokenHash: HASH });
    expect(admitted).toMatchObject({
      admitted: true,
      run: { taskType: "developer:close", prNumber: 12, budget: CLOSE_LIMITS },
    });
    expect(
      limitsFor({ limits: REHEARSAL_RUN_LIMITS }, "developer", "developer:code"),
    ).toEqual(REHEARSAL_RUN_LIMITS.developer);
    expect(() =>
      limitsFor({ limits: REHEARSAL_RUN_LIMITS }, "developer", "developer:close"),
    ).toThrow("A close run needs the limits of its task type");
  });

  it("never admits a second close run for the same pull request, whatever the first one's end", async () => {
    const { f, runs, request } = await admission();
    const first = await runs.dispatch(request, { tokenHash: HASH });
    if (!first.admitted) throw new Error("not admitted");
    expect(await runs.dispatch(request, { tokenHash: "b".repeat(64) })).toEqual({
      admitted: false,
      reason: "close_already_run",
    });
    await runs.recordRunnerEnd(first.run.id, "fail");
    expect(await runs.dispatch(request, { tokenHash: "c".repeat(64) })).toEqual({
      admitted: false,
      reason: "close_already_run",
    });
    expect(await runs.planDispatch(request)).toEqual({
      admitted: false,
      reason: "close_already_run",
    });
    // Another pull request on the same item may still be closed.
    expect(
      await runs.dispatch({ ...request, prNumber: 14 }, { tokenHash: "d".repeat(64) }),
    ).toMatchObject({ admitted: true });
    await f.setting("kill_switch", true);
    expect(
      await runs.dispatch({ ...request, prNumber: 15 }, { tokenHash: "e".repeat(64) }),
    ).toEqual({ admitted: false, reason: "kill_switch" });
  });

  it("needs a pull request number and a builder role", async () => {
    const { runs, request } = await admission();
    await expect(
      runs.dispatch({ ...request, prNumber: null }, { tokenHash: HASH }),
    ).rejects.toThrow("A close run needs its pull request number");
    await expect(
      runs.dispatch(
        { ...request, role: "qa", taskType: "developer:close" },
        { tokenHash: HASH },
      ),
    ).rejects.toThrow("Only a Developer or Designer run closes a pull request");
    await expect(
      runs.dispatch({ ...request, taskType: "designer:close" }, { tokenHash: HASH }),
    ).rejects.toThrow("does not allow the requested task type");
  });
});
