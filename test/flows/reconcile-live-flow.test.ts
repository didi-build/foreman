// Seam: the reconcile flow in live mode and the flows whose move makes an item ready (D-329
// slice 3, O-103), with fake adapters on the memory store and the real contracts and guards. The
// pass's plan itself is in test/reconcile-live.test.ts; this covers what the flows do with it:
// release, then the released item's first run in the same pass; the first run of a ready item;
// the advance into QA review and QA's run on the head; nothing more on a second pass or two passes
// at once; nothing under the kill switch or in dry run; refusals reported, never thrown. Then each
// flow whose move makes an item ready starts its first run once. Fake data only.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import { run as requestTransition } from "../../flows/request-transition.ts";
import { run as verifyStaging } from "../../flows/verify-staging.ts";
import { startReadyRuns } from "../../flows/lib/ready-runs.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import { createLibrary } from "../../src/core/library.ts";
import { FIRST_ROUTING_POLICY } from "../../src/core/routing-testing.ts";
import type { Node } from "../../src/core/store.ts";
import { HEAD, REPO } from "../reconcile-fixture.ts";
import { setupStaging } from "../staging-fixture.ts";
import { createFlowFixture, flowDepsFor, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 3,
  costUsd: 0.1,
  minutes: 2,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

/** Makes the clock move one second at each read, as a real clock moves between steps. */
function ticking(t: FlowFixture) {
  const read = t.clock.now;
  t.clock.now = () => {
    t.advanceMinutes(1 / 60);
    return read();
  };
}

/** Live, with one Blocked item whose blocker is Done and one item ready for the Developer. */
async function releaseAndReady() {
  const f = await createFlowFixture();
  ticking(f);
  await f.live();
  const blocker = await f.node("done");
  const blocked = await f.node("blocked");
  await f.blocks(blocker.id, blocked.id);
  const ready = await f.node("ready_for_dev");
  return { f, blocked, ready };
}

const statesOf = async (f: FlowFixture, ...nodes: Node[]) =>
  Promise.all(nodes.map(async (n) => (await f.store.getNode(n.id))?.state));

const developerRuns = async (f: FlowFixture, node: Node) =>
  (await f.store.listRuns({ nodeId: node.id })).filter((r) => r.bot === "developer");

describe("the reconcile flow in live mode (flow: fake adapters, D-329 slice 3)", () => {
  it("releases a Blocked item, starts its first run in the same pass, and starts a ready item's first run, once each", async () => {
    const { f, blocked, ready } = await releaseAndReady();

    const result = await reconcileFlow(f.deps);

    expect(result).toMatchObject({ mode: "live", stopped: null, problems: [] });
    expect(result.released).toMatchObject([
      {
        nodeId: blocked.id,
        toState: "ready_for_dev",
        move: { outcome: "applied" },
        firstRuns: [
          { nodeId: blocked.id, role: "developer", result: { outcome: "started" } },
        ],
      },
    ]);
    expect(result.dispatched).toMatchObject([
      {
        nodeId: ready.id,
        role: "developer",
        plan: "planned",
        result: { outcome: "started" },
      },
    ]);
    expect(await statesOf(f, blocked, ready)).toEqual([
      "in_development",
      "in_development",
    ]);
    // The release is the pass's own move, with its trigger; each start took the dispatch move.
    const rows = await f.transitions(blocked.id);
    expect(rows.map((t) => [t.mode, t.toState, t.triggerKind, t.actorId])).toEqual([
      ["applied", "ready_for_dev", "reconcile", "reconcile"],
      ["applied", "in_development", "event", "dispatch"],
    ]);
    expect(f.runtime.started).toHaveLength(2);
    expect(f.tasksFor.map((t) => [t.run.nodeId, t.branch])).toEqual([
      [blocked.id, `foreman/${blocked.id}`],
      [ready.id, `foreman/${ready.id}`],
    ]);
  });

  it("starts nothing more on a second pass, in turn or two at once", async () => {
    const { f, blocked, ready } = await releaseAndReady();
    const [first, second] = await Promise.all([
      reconcileFlow(f.deps),
      reconcileFlow(f.deps),
    ]);
    // Between them, one release and one first run each.
    const applied = [...(first.released ?? []), ...(second.released ?? [])].filter(
      (r) => r.move.outcome === "applied",
    );
    expect(applied).toHaveLength(1);
    expect(await developerRuns(f, blocked)).toHaveLength(1);
    expect(await developerRuns(f, ready)).toHaveLength(1);
    expect(f.runtime.started).toHaveLength(2);

    const before = await f.footprint(blocked.id, ready.id);
    const third = await reconcileFlow(f.deps);
    expect(third).toMatchObject({ released: [], dispatched: [], advanced: [] });
    expect(await f.footprint(blocked.id, ready.id)).toBe(before);
    expect(f.runtime.started).toHaveLength(2);
  });

  it("acts on nothing under the kill switch, and in dry run writes only dry-run rows", async () => {
    const { f, blocked, ready } = await releaseAndReady();
    await f.killed();
    const before = await f.footprint(blocked.id, ready.id);
    const killed = await reconcileFlow(f.deps);
    expect(killed).toMatchObject({
      stopped: "kill_switch",
      released: null,
      dispatched: null,
      advanced: null,
    });
    expect(await f.footprint(blocked.id, ready.id)).toBe(before);

    await f.setting("kill_switch", false);
    await f.setting("dry_run", true);
    const dry = await reconcileFlow(f.deps);
    expect(dry).toMatchObject({
      mode: "dry_run",
      stopped: null,
      planned: { releases: 1, dispatches: 1 },
      released: null,
      dispatched: null,
    });
    expect((await f.transitions(blocked.id, ready.id)).map((t) => t.mode)).toEqual([
      "dry_run",
      "dry_run",
    ]);
    expect(await statesOf(f, blocked, ready)).toEqual(["blocked", "ready_for_dev"]);
    expect(await f.store.listActiveRuns()).toEqual([]);
    expect(f.runtime.started).toEqual([]);
  });

  it("reports the cluster limit and a missing route, and throws nothing", async () => {
    // One cluster slot: the released item's first run takes it, so the ready item the plan admitted
    // is refused at its start, and a second ready item is refused by the plan itself.
    const { f, blocked, ready } = await releaseAndReady();
    await f.setting("agent_cluster_max_active_runs", 1);
    const other = await f.node("ready_for_dev");
    const result = await reconcileFlow(f.deps);
    expect(result.released).toMatchObject([
      { nodeId: blocked.id, firstRuns: [{ result: { outcome: "started" } }] },
    ]);
    expect(result.dispatched).toMatchObject([
      {
        nodeId: ready.id,
        plan: "planned",
        result: { outcome: "not_admitted", reason: "cluster_full" },
      },
      { nodeId: other.id, plan: "refused", reason: "cluster_full" },
    ]);
    expect(await statesOf(f, ready, other)).toEqual(["ready_for_dev", "ready_for_dev"]);

    // No route for the Developer: refused by the plan, and nothing starts.
    const g = await createFlowFixture();
    await g.live();
    await g.setting("model_routing_policy", {
      ...FIRST_ROUTING_POLICY,
      taskTypes: { designer: FIRST_ROUTING_POLICY.taskTypes.designer },
    });
    const lonely = await g.node("ready_for_dev");
    const noRoute = await reconcileFlow(g.deps);
    expect(noRoute.dispatched).toEqual([
      { nodeId: lonely.id, role: "developer", plan: "refused", reason: "no_route" },
    ]);
    expect(g.runtime.started).toEqual([]);
  });

  it("reports a start that failed, and the item waits ready for the next pass", async () => {
    const { f, blocked, ready } = await releaseAndReady();
    f.runtime.failNext.add("start");
    const result = await reconcileFlow(f.deps);
    // The release's first run took the failed start.
    expect(result.released?.[0]?.firstRuns).toMatchObject([
      { result: { outcome: "start_failed" } },
    ]);
    expect(result.dispatched).toMatchObject([
      { nodeId: ready.id, result: { outcome: "started" } },
    ]);
    // Its run ended `fail` before it started; the item is still ready, and the next pass starts it.
    expect((await f.store.getNode(blocked.id))?.state).toBe("ready_for_dev");
    expect(
      (await f.store.listRuns({ nodeId: blocked.id })).map((r) => r.outcome),
    ).toEqual(["fail"]);
    const again = await reconcileFlow(f.deps);
    expect(again.dispatched).toMatchObject([
      { nodeId: blocked.id, plan: "planned", result: { outcome: "started" } },
    ]);
    expect((await f.store.getNode(blocked.id))?.state).toBe("in_development");
  });

  it("advances an item whose CI is green on its head into QA review, and starts QA on that head once", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const item = await f.node("in_development");
    await f.evidence(
      item.id,
      "ci_run",
      { conclusion: "success", pr: 7, changedPaths: ["src/a.ts"] },
      { commitSha: HEAD },
    );
    await f.evidence(item.id, "docs_note", { impact: "none" }, { commitSha: HEAD });

    const result = await reconcileFlow(f.deps);

    expect(result.advanced).toMatchObject([
      {
        nodeId: item.id,
        toState: "in_qa_review",
        move: { outcome: "applied" },
        qa: { role: "qa", plan: "planned", result: { outcome: "started" } },
      },
    ]);
    expect((await f.store.getNode(item.id))?.state).toBe("in_qa_review");
    const qa = (await f.store.listRuns({ nodeId: item.id })).filter(
      (r) => r.bot === "qa",
    );
    expect(qa).toMatchObject([{ headSha: HEAD, prNumber: 7, endedAt: null }]);
    expect(f.tasksFor.at(-1)?.run.bot).toBe("qa");

    const again = await reconcileFlow(f.deps);
    expect(again.advanced).toEqual([]);
    expect(
      (await f.store.listRuns({ nodeId: item.id })).filter((r) => r.bot === "qa"),
    ).toHaveLength(1);
  });
});

describe("a move that makes an item ready starts its first run in the same flow (flow: D-329)", () => {
  it("starts and plans nothing while the kill switch or dry run holds the runner, and once when live", async () => {
    const f = await createFlowFixture();
    const ready = await f.node("ready_for_dev");
    const before = await f.footprint(ready.id);
    // Dry run is the fixture's default.
    expect(await startReadyRuns(f.deps, [ready.id])).toEqual([]);
    await f.live();
    await f.killed();
    expect(await startReadyRuns(f.deps, [ready.id])).toEqual([]);
    expect(await f.footprint(ready.id)).toBe(before);
    expect(f.runtime.started).toEqual([]);
    expect(f.tokens).toEqual([]);

    await f.setting("kill_switch", false);
    // The same node twice in one call, then again: one start.
    expect(await startReadyRuns(f.deps, [ready.id, ready.id])).toMatchObject([
      { nodeId: ready.id, role: "developer", result: { outcome: "started" } },
    ]);
    expect(await startReadyRuns(f.deps, [ready.id])).toEqual([]);
    expect(f.runtime.started).toHaveLength(1);
  });

  it("the staging flow's Done frees a Blocked item and a design item waiting on it, once each", async () => {
    const t = await setupStaging();
    const { deps, runtime } = flowDepsFor(t.deps, t.checker);
    const code = await t.addNode("blocked");
    await t.blocks(t.node.id, code.id);
    // A design item waits in Ready for design exploration on its blocker (D-268), plan attached.
    const design = await t.addNode("ready_for_design_exploration", {
      track: "design",
      ownerRole: "designer",
    });
    await t.blocks(t.node.id, design.id);
    const library = createLibrary(t.deps);
    for (const kind of ["product_direction", "council_decision"] as const) {
      await library.recordDecision(
        {
          projectId: t.projectId,
          nodeId: design.id,
          kind,
          scope: kind === "council_decision" ? { kind: "plan_accepted" } : {},
          textVerbatim: "The plan.",
          byActor: "council",
        },
        [design.id],
      );
    }
    t.deploy();

    const verified = await verifyStaging(deps, { repo: REPO, sha: t.mergeSha });

    expect(verified).toMatchObject({
      outcome: "verified",
      results: [{ move: { toState: "done", outcome: "applied" } }],
      firstRuns: [
        { nodeId: code.id, role: "developer", result: { outcome: "started" } },
        { nodeId: design.id, role: "designer", result: { outcome: "started" } },
      ],
    });
    expect(await t.state()).toBe("done");
    expect((await t.store.getNode(code.id))?.state).toBe("in_development");
    expect((await t.store.getNode(design.id))?.state).toBe("in_design_exploration");
    expect(runtime.started).toHaveLength(2);

    // The same event again starts nothing more.
    expect(await verifyStaging(deps, { repo: REPO, sha: t.mergeSha })).toMatchObject({
      firstRuns: [],
    });
    expect(runtime.started).toHaveLength(2);
  });

  it("a release asked of the transition flow starts the item's first run once", async () => {
    const { f, blocked } = await releaseAndReady();
    const input = {
      nodeId: blocked.id,
      toState: "ready_for_dev",
      trigger: { kind: "event" as const, ref: "test:blocker-done" },
      actor: { kind: "runner" as const, id: "test" },
    };
    expect(await requestTransition(f.deps, input)).toMatchObject({
      outcome: "applied",
      firstRuns: [{ nodeId: blocked.id, result: { outcome: "started" } }],
    });
    expect((await f.store.getNode(blocked.id))?.state).toBe("in_development");
    const repeated = await requestTransition(f.deps, input);
    expect(repeated).toMatchObject({ outcome: "noop", reason: "duplicate_trigger" });
    expect(repeated).not.toHaveProperty("firstRuns");
    expect(await developerRuns(f, blocked)).toHaveLength(1);
  });

  it("an escalation the Council resolves back to Ready for dev starts the item's first run once", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await f.node("ready_for_dev");
    await f.store.setCounter(node.id, "failure", 3, f.clock.now());
    await createEscalations(f.deps).escalate(
      node.id,
      { kind: "event", ref: "test:escalate" },
      "three failed starts",
    );
    expect((await reconcileFlow(f.deps)).councilRuns).toMatchObject([
      { topicKey: escalationTopic(node.id), result: { outcome: "started" } },
    ]);
    const council = f.tasksFor.at(-1)?.run;
    if (council?.bot !== "council") throw new Error("no Council run");
    f.runtime.status.set(council.id, {
      state: "finished",
      result: {
        ...RESULT,
        structured: {
          outcome: "resolve",
          note: "Start it again.",
          changesProductDirection: false,
          passesGate: false,
        },
      },
    });
    const ended = await recordRunEnd(f.deps, { runId: council.id });
    expect(ended).toMatchObject({
      outcome: "recorded",
      council: {
        escalation: { step: "returned", move: { toState: "ready_for_dev" } },
        firstRuns: [
          { nodeId: node.id, role: "developer", result: { outcome: "started" } },
        ],
      },
    });
    expect((await f.store.getNode(node.id))?.state).toBe("in_development");
    const repeated = await recordRunEnd(f.deps, { runId: council.id });
    expect(repeated).toMatchObject({ outcome: "already_recorded" });
    expect(await developerRuns(f, node)).toHaveLength(1);
  });

  it("Didi's answer to the only request holding a ready item starts its first run once, and never under a switch", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const node = await f.node("ready_for_dev");
    const gate = await createLibrary(f.deps).openGateRequest({
      projectId: f.projectId,
      nodeId: node.id,
      topicKey: `needs-didi:${node.id}`,
      kind: "dns",
      owner: "didi",
      blocking: true,
      payload: { question: "May the runner add the DNS record?" },
    });
    // Answered under dry run: recorded, and nothing starts (D-201).
    await f.setting("dry_run", true);
    const held = await resume(f.deps, {
      gateRequestId: gate.id,
      resume: { decision: "Approve", options: [], feedback: "" },
      approvers: ["anonymous"],
    });
    expect(held).toMatchObject({ outcome: "recorded", heldBy: "dry_run" });
    expect(held).not.toHaveProperty("firstRuns");
    expect(f.runtime.started).toEqual([]);

    // The same answer once live: the next request on the topic, answered.
    await f.live();
    const again = await createLibrary(f.deps).openGateRequest({
      projectId: f.projectId,
      nodeId: node.id,
      topicKey: `needs-didi:${node.id}`,
      kind: "dns",
      owner: "didi",
      blocking: true,
      payload: { question: "May the runner add the DNS record?" },
    });
    expect(
      await resume(f.deps, {
        gateRequestId: again.id,
        resume: { decision: "Approve", options: [], feedback: "" },
        approvers: ["anonymous"],
      }),
    ).toMatchObject({
      outcome: "recorded",
      heldBy: null,
      firstRuns: [{ nodeId: node.id, result: { outcome: "started" } }],
    });
    expect((await f.store.getNode(node.id))?.state).toBe("in_development");
    expect(await developerRuns(f, node)).toHaveLength(1);
  });

  it("a reversal answer that clears a ready item's stale flag starts its first run once", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const library = createLibrary(f.deps);
    const owner = await f.node("in_development");
    const item = await f.node("ready_for_dev");
    const decision = await library.recordDecision(
      {
        projectId: f.projectId,
        nodeId: owner.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Use the blue layout.",
        byActor: "didi",
      },
      [item.id],
    );
    await library.reverseDecision(decision.id, "didi", "It tested badly.");
    expect((await f.store.getNode(item.id))?.stale).toBe(true);
    const pass = await reconcileFlow(f.deps);
    // Stale: not started by the pass.
    expect(pass.dispatched).toEqual([]);
    const council = f.tasksFor.at(-1)?.run;
    if (council?.bot !== "council") throw new Error("no Council run");
    f.runtime.status.set(council.id, {
      state: "finished",
      result: {
        ...RESULT,
        structured: {
          verdicts: [{ nodeId: item.id, verdict: "still_valid", note: "Unaffected." }],
          note: "The item does not rely on the layout.",
        },
      },
    });
    expect(await recordRunEnd(f.deps, { runId: council.id })).toMatchObject({
      council: {
        answer: { recorded: true, verdicts: [{ nodeId: item.id, result: "cleared" }] },
        firstRuns: [{ nodeId: item.id, result: { outcome: "started" } }],
      },
    });
    expect(await f.store.getNode(item.id)).toMatchObject({
      state: "in_development",
      stale: false,
    });
    await recordRunEnd(f.deps, { runId: council.id });
    expect(await developerRuns(f, item)).toHaveLength(1);
  });
});
