// Seam: the run-end flow with a fake agent runtime on the memory store and the real machine-2
// contracts and guards, for the bugs a Developer, Designer or QA run reports outside its item
// (D-244, O-65): the runner creates one Machine 1 idea per finding, marked with the role, the item
// and the run, once per run, and the item's own move goes on unchanged. The Postgres path and two
// concurrent run ends are in test/db/finding-ideas.test.ts.
import { describe, expect, it } from "vitest";

import { run as dispatch } from "../../flows/dispatch.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { createFindingIdeas, FINDING_SOURCE } from "../../src/core/finding-ideas.ts";
import { HEAD } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 12,
  costUsd: 0.4,
  minutes: 6,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

const FOUND = [
  { title: "Login page answers 500", detail: "src/login.ts throws on an empty email." },
  { title: "Typo in the help page", detail: "docs/help.md says 'teh'." },
];

const withFindings = (findings: unknown, structured: object = {}): AgentRunResult => ({
  ...RESULT,
  structured: { ...structured, outOfScopeFindings: findings },
});

/** Makes the clock move one second at each read, as a real clock moves between steps. */
function ticking(t: FlowFixture) {
  const read = t.clock.now;
  t.clock.now = () => {
    t.advanceMinutes(1 / 60);
    return read();
  };
}

async function ideas(f: FlowFixture) {
  return (await f.store.listNodes({ projectId: f.projectId })).filter(
    (n) => n.type === "idea",
  );
}

/** A Developer run on an item, with the evidence its done report needs. */
async function developerDone(f: FlowFixture) {
  const node = await f.node("ready_for_dev");
  const started = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
  if (started.outcome !== "started") throw new Error("the Developer was not started");
  const ciId = await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: ["src/a.ts"] },
    { commitSha: HEAD },
  );
  await f.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });
  return { node, runId: started.runId, ciId };
}

describe("run-end flow with bugs found outside the item (flow: fake adapters, D-244, O-65)", () => {
  it("creates one Submitted idea per Developer finding, marked with who found it, and the item moves on as before", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const { node, runId } = await developerDone(f);
    f.runtime.status.set(runId, {
      state: "finished",
      result: withFindings(FOUND, { pullRequest: { number: 7 } }),
    });
    const ended = await recordRunEnd(f.deps, { runId });
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      move: { outcome: "applied", toState: "in_qa_review" },
      findingIdeas: { step: "created", ideas: 2 },
    });
    const made = await ideas(f);
    expect(made.map((n) => n.title)).toEqual(FOUND.map((x) => x.title));
    for (const [i, idea] of made.entries()) {
      expect(idea).toMatchObject({
        projectId: f.projectId,
        type: "idea",
        track: null,
        state: "submitted",
        ownerRole: "runner",
        hold: false,
        agentReady: false,
        body: {
          source: FINDING_SOURCE,
          description: FOUND[i]?.detail,
          foundBy: { role: "developer", nodeId: node.id, runId },
        },
      });
      // An idea is created, never moved: no transition is written for it.
      expect(await f.store.listTransitions(idea.id)).toEqual([]);
    }
    // The item itself is not escalated, and nothing is counted against it.
    expect((await f.store.getNode(node.id))?.state).toBe("in_qa_review");
    expect(await f.store.getCounter(node.id, "failure")).toBe(0);

    // A repeated run-end trigger creates nothing more.
    expect(await recordRunEnd(f.deps, { runId })).toMatchObject({
      outcome: "already_recorded",
    });
    expect(await ideas(f)).toHaveLength(2);
    // Nor does a second submit for the same run, as a flow cut short before the end would do.
    expect(
      await createFindingIdeas(f.deps).submit(runId, withFindings(FOUND).structured),
    ).toEqual({ step: "already_created", ideas: 2 });
    expect(await ideas(f)).toHaveLength(2);
  });

  it("creates ideas from QA's answer on a fail, and the fail move and fix round go on", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const { node, runId: devRun, ciId } = await developerDone(f);
    f.runtime.status.set(devRun, { state: "finished", result: RESULT });
    await recordRunEnd(f.deps, { runId: devRun });
    const qa = await dispatch(f.deps, {
      nodeId: node.id,
      role: "qa",
      prNumber: 7,
      headSha: HEAD,
    });
    if (qa.outcome !== "started") throw new Error("QA was not started");
    const verdict = {
      verdict: "fail",
      findings: [{ path: "src/a.ts", startLine: 1, endLine: 1, note: "wrong" }],
      evidenceIds: [ciId],
    };
    await f.evidence(node.id, "qa_verdict", verdict, {
      commitSha: HEAD,
      runId: qa.runId,
    });
    f.runtime.status.set(qa.runId, {
      state: "finished",
      result: withFindings([FOUND[0]], verdict),
    });
    expect(await recordRunEnd(f.deps, { runId: qa.runId })).toMatchObject({
      outcome: "recorded",
      move: { outcome: "applied", toState: "in_development" },
      builderRuns: [{ cause: "returned", result: { outcome: "started" } }],
      findingIdeas: { step: "created", ideas: 1 },
    });
    const [idea] = await ideas(f);
    expect(idea?.body).toMatchObject({
      foundBy: { role: "qa", nodeId: node.id, runId: qa.runId },
    });
  });

  it("creates nothing, and leaves the run and its move as they are, when the list has the wrong shape", async () => {
    for (const bad of [
      [...FOUND, ...FOUND],
      [{ title: "t".repeat(121), detail: "d" }],
      [{ title: "t" }],
      "a bug",
    ]) {
      const f = await createFlowFixture();
      ticking(f);
      await f.live();
      const { runId } = await developerDone(f);
      f.runtime.status.set(runId, { state: "finished", result: withFindings(bad) });
      expect(await recordRunEnd(f.deps, { runId })).toMatchObject({
        outcome: "recorded",
        report: { outcome: "success" },
        move: { outcome: "applied", toState: "in_qa_review" },
        findingIdeas: { step: "refused", reason: "bad_findings" },
      });
      expect(await ideas(f)).toEqual([]);
    }
  });

  it("creates nothing for a run with no findings, an empty list, or a failed run", async () => {
    for (const result of [
      RESULT,
      withFindings([]),
      { ...withFindings(FOUND), outcome: "fail" as const, detail: "job_failed" },
    ]) {
      const f = await createFlowFixture();
      ticking(f);
      await f.live();
      const { runId } = await developerDone(f);
      f.runtime.status.set(runId, { state: "finished", result });
      const ended = await recordRunEnd(f.deps, { runId });
      expect(ended.outcome).toBe("recorded");
      expect(await ideas(f)).toEqual([]);
    }
  });

  it("records nothing in dry run, as for every run end", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const { node, runId } = await developerDone(f);
    f.runtime.status.set(runId, { state: "finished", result: withFindings(FOUND) });
    await f.setting("dry_run", true);
    expect(await recordRunEnd(f.deps, { runId })).toMatchObject({
      outcome: "would_record",
    });
    // The core refuses on its own too, inside its transaction.
    expect(
      await createFindingIdeas(f.deps).submit(runId, withFindings(FOUND).structured),
    ).toEqual({ step: "refused", reason: "dry_run" });
    expect(await ideas(f)).toEqual([]);
    expect((await f.store.getNode(node.id))?.state).toBe("in_development");
  });

  it("creates nothing under the kill switch", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const { runId } = await developerDone(f);
    await f.killed();
    expect(
      await createFindingIdeas(f.deps).submit(runId, withFindings(FOUND).structured),
    ).toEqual({ step: "refused", reason: "kill_switch" });
    expect(await ideas(f)).toEqual([]);
  });
});
