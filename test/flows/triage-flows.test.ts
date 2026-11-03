// Seam: the flows around Triage (build plan M3.6, D-262, D-264, D-265) with a fake model (the fake
// agent runtime returns the structured answer the test gives), a fake repo map port, the memory
// store, and the real contracts of both machines and the real guards. The success test of D-265:
// a synthetic accepted plan run through Triage gives the expected items, links and tracks; the bad
// answers are rejected; the re-run gets the reason; a second bad answer goes to the Council, whose
// decision returns the idea to Triage. The answer rules themselves are in test/triage.test.ts.
import { describe, expect, it } from "vitest";

import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import { triagePass } from "../../flows/lib/triage-runs.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import { createLibrary } from "../../src/core/library.ts";
import {
  needsDidiTopic,
  rejectionRef,
  TRACK_DECIDER,
  TRACK_DECISION_POINT,
} from "../../src/core/triage.ts";
import type { DecisionPointRecord, Node, Store } from "../../src/core/store.ts";
import {
  BAD_ANSWERS,
  DIRECTION,
  goodAnswer,
  MAP_COMMIT,
  NEWER_COMMIT,
  PLAN,
  REPO_MAP,
} from "../triage-fixture.ts";
import { REPO, TRIAGE_SCHEMAS } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 2,
  costUsd: 0.05,
  minutes: 1,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

function ticking(t: FlowFixture) {
  const read = t.clock.now;
  t.clock.now = () => {
    t.advanceMinutes(1 / 60);
    return read();
  };
}

function finish(f: FlowFixture, runId: string, structured?: unknown) {
  f.runtime.status.set(runId, {
    state: "finished",
    result: { ...RESULT, ...(structured === undefined ? {} : { structured }) },
  });
  return recordRunEnd(f.deps, { runId });
}

/** Keeps every decision record a committed transaction wrote; the store has no read for them. */
function recordDecisionPoints(f: FlowFixture): DecisionPointRecord[] {
  const records: DecisionPointRecord[] = [];
  const base = f.deps.store;
  const store: Store = {
    ...base,
    transaction: async (work) => {
      const staged: DecisionPointRecord[] = [];
      const result = await base.transaction((tx) =>
        work({
          ...tx,
          insertDecisionPointRecord: async (record) => {
            await tx.insertDecisionPointRecord(record);
            staged.push(record);
          },
        }),
      );
      records.push(...staged);
      return result;
    },
  };
  f.deps.store = store;
  return records;
}

function lastTriageStart(f: FlowFixture) {
  const start = f.tasksFor.at(-1);
  if (start?.run.bot !== "triage") throw new Error("the last start is not Triage's");
  return start;
}

/** An idea whose plan the planning chat accepted (D-261), with its decisions on it, live. */
async function acceptedIdea(f: FlowFixture): Promise<Node> {
  ticking(f);
  await f.live();
  f.repoMaps.put(REPO, REPO_MAP);
  const idea = await f.node("plan_accepted", {
    type: "idea",
    track: null,
    ownerRole: "runner",
    title: "Settings page",
    body: { description: "A settings page for the rehearsal app." },
    agentReady: false,
  });
  const library = createLibrary(f.deps);
  await library.recordDecision({
    projectId: f.projectId,
    nodeId: idea.id,
    kind: "product_direction",
    scope: {},
    textVerbatim: DIRECTION,
    byActor: "council",
  });
  await library.recordDecision({
    projectId: f.projectId,
    nodeId: idea.id,
    kind: "council_decision",
    scope: { kind: "plan_accepted" },
    textVerbatim: PLAN,
    byActor: "council",
  });
  return idea;
}

async function startedTriage(f: FlowFixture) {
  const idea = await acceptedIdea(f);
  const pass = await reconcileFlow(f.deps);
  expect(pass.triage).toMatchObject([
    {
      ideaId: idea.id,
      toTriage: { outcome: "applied" },
      step: "start",
      result: { outcome: "started" },
    },
  ]);
  return { idea, start: lastTriageStart(f) };
}

describe("the M3.6 success test (flow: fake model, D-265)", () => {
  it("runs a synthetic accepted plan through Triage into the expected items, links and tracks", async () => {
    const f = await createFlowFixture();
    const records = recordDecisionPoints(f);
    const { idea, start } = await startedTriage(f);
    expect((await f.store.getNode(idea.id))?.state).toBe("triage");
    // The run: task type triage, on the idea, at the map's commit, with the plan and the brief.
    expect(start.run).toMatchObject({
      taskType: "triage",
      nodeId: idea.id,
      headSha: MAP_COMMIT,
    });
    expect(start.input).toContain("> Plan: a settings page for the rehearsal app.");
    expect(start.input).toContain(`at commit ${MAP_COMMIT}`);
    expect(start.input).toContain("> - src/settings/store.ts: imported by 1");
    // A second trigger starts no second run.
    expect(await triagePass(f.deps, [idea.id])).toMatchObject([{ step: "running" }]);

    // The default branch moves on meanwhile: the answer is still checked at the run's commit.
    f.repoMaps.put(REPO, { ...REPO_MAP, commitSha: NEWER_COMMIT, files: [] });
    const ended = await finish(f, start.run.id, goodAnswer());
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      triageAnswer: { recorded: true, ideaId: idea.id },
      triage: [{ step: "not_in_triage" }],
    });
    expect(f.repoMaps.reads.at(-1)).toBe(`${REPO}@${MAP_COMMIT}`);
    expect((await f.store.getNode(idea.id))?.state).toBe("handed_off");

    const items = (await f.store.listNodes({ projectId: f.projectId })).filter(
      (n) => n.type === "work_item",
    );
    const byKey = new Map(
      items.map((n) => [(n.body as { triageKey: string }).triageKey, n]),
    );
    expect(
      [...byKey.entries()].map(([key, n]) => [
        key,
        n.track,
        n.state,
        n.hold,
        n.agentReady,
      ]),
    ).toEqual([
      ["settings-design", "design", "ready_for_design_exploration", false, true],
      ["settings-wire", "code", "blocked", false, true],
      ["settings-docs", "docs", "blocked", false, true],
      ["settings-dns", "infra", "ready_for_dev", false, true],
      ["old-settings", "code", "blocked", true, true],
    ]);
    const id = (key: string) => byKey.get(key)?.id as string;
    // The Developer's input fields (D-213) are filled.
    expect(byKey.get("settings-wire")?.body).toMatchObject({
      acceptanceCriteria: ["settings-wire is done"],
      pathsInScope: ["src/app.ts", "src/settings/page.ts"],
      checks: ["npm run check", "npm run test"],
      ideaId: idea.id,
      triageRunId: start.run.id,
    });
    // The links: blocks in execution order, the design item to its counterpart, the idea's split.
    const edges = async (type: "blocks" | "design_for" | "split_into") =>
      (await Promise.all(items.map((n) => f.store.listEdges({ toNode: n.id, type }))))
        .flat()
        .map((e) => `${e.fromNode}>${e.toNode}`)
        .sort();
    expect(await edges("blocks")).toEqual(
      [
        `${id("settings-design")}>${id("settings-wire")}`,
        `${id("settings-wire")}>${id("settings-docs")}`,
        `${id("settings-wire")}>${id("old-settings")}`,
      ].sort(),
    );
    expect(await edges("design_for")).toEqual([
      `${id("settings-design")}>${id("settings-wire")}`,
    ]);
    expect(await edges("split_into")).toEqual(
      items.map((n) => `${idea.id}>${n.id}`).sort(),
    );
    // The needsDidi item has its gate request for Didi, and nothing else has one.
    const gates = await f.store.listOpenGateRequests(f.projectId);
    expect(gates).toMatchObject([
      {
        nodeId: id("settings-dns"),
        topicKey: needsDidiTopic(id("settings-dns")),
        kind: "dns",
        owner: "didi",
        blocking: true,
      },
    ]);
    // The plan and the product direction are on every item, so plan_attached passes.
    for (const item of items) {
      expect(
        (await f.store.listDecisionsForNode(item.id)).map((d) => d.kind).sort(),
      ).toEqual(["council_decision", "product_direction"]);
    }
    const design = await createLibrary(f.deps).checkTransition({
      nodeId: id("settings-design"),
      toState: "in_design_exploration",
      trigger: { kind: "reconcile", ref: null },
      actor: { kind: "runner", id: "test" },
    });
    expect(design.outcome).toBe("allowed");
    // The DNS item is ready but waits on Didi's gate.
    const dns = await createLibrary(f.deps).checkTransition({
      nodeId: id("settings-dns"),
      toState: "in_development",
      trigger: { kind: "reconcile", ref: null },
      actor: { kind: "runner", id: "test" },
    });
    expect(dns.guardReport.find((c) => !c.pass)?.name).toBe("no_pending_gate");
    // One track decision per item through the decision point (P-11).
    const tracks = records.filter((r) => r.decisionPoint === TRACK_DECISION_POINT);
    expect(tracks.map((r) => [r.deciderId, r.nodeId, r.confidence])).toEqual(
      items.map((n) => [TRACK_DECIDER, n.id, n.track === "design" ? 0.5 : 1]),
    );

    // A repeated run-end trigger writes nothing more.
    const before = await f.footprint(idea.id, ...items.map((n) => n.id));
    expect(await recordRunEnd(f.deps, { runId: start.run.id })).toMatchObject({
      outcome: "already_recorded",
    });
    expect(await f.footprint(idea.id, ...items.map((n) => n.id))).toBe(before);
  });
});

describe("a bad Triage answer (flow: fake model, D-262)", () => {
  it.each(BAD_ANSWERS)(
    "is rejected whole for $name, and the re-run gets the reason",
    async ({ answer, code }) => {
      const f = await createFlowFixture();
      const { idea, start } = await startedTriage(f);
      const ended = await finish(f, start.run.id, answer());
      expect(ended).toMatchObject({
        outcome: "recorded",
        report: { outcome: "fail" },
        triageAnswer: { recorded: false, reason: "rejected", rejection: { code } },
        triage: [{ step: "start", result: { outcome: "started" } }],
      });
      expect((await f.store.getNode(idea.id))?.state).toBe("triage");
      expect(
        (await f.store.listNodes({ projectId: f.projectId })).filter(
          (n) => n.type === "work_item",
        ),
      ).toEqual([]);
      const report = (
        await f.store.listEvidence({ nodeId: idea.id, kind: "agent_report" })
      )[0];
      expect(report).toMatchObject({
        ref: rejectionRef(start.run.id),
        recordedBy: "runner",
        payload: { code },
      });
      const rerun = lastTriageStart(f);
      expect(rerun.run.id).not.toBe(start.run.id);
      expect(rerun.input).toContain("## Why your last answer was rejected");
      expect(rerun.input).toContain(
        `> ${(report?.payload as { reason: string }).reason}`,
      );
    },
  );

  it("goes to the Council after the second bad answer, and the Council's decision returns it to Triage", async () => {
    const f = await createFlowFixture();
    const { idea, start } = await startedTriage(f);
    await finish(f, start.run.id, BAD_ANSWERS[1]?.answer());
    const rerun = lastTriageStart(f);
    // No structured answer at all is a bad answer too.
    const second = await finish(f, rerun.run.id);
    expect(second).toMatchObject({
      report: { outcome: "fail" },
      triage: [
        {
          step: "escalate",
          escalation: {
            escalated: true,
            move: { outcome: "applied", toState: "escalated_to_council" },
          },
          councilRuns: [{ step: "start", result: { outcome: "started" } }],
        },
      ],
    });
    const node = await f.store.getNode(idea.id);
    expect(node?.state).toBe("escalated_to_council");
    expect(node?.blockedReason).toMatch(/Triage gave no usable answer in 2 runs/);
    const council = f.tasksFor.at(-1);
    expect(council?.run).toMatchObject({
      bot: "council",
      questionTopic: escalationTopic(idea.id),
    });
    expect(council?.input).toMatch(/Triage gave no usable answer in 2 runs/);

    const answered = await finish(f, council?.run.id as string, {
      outcome: "resolve",
      note: "Name only scripts from package.json.",
      changesProductDirection: false,
      passesGate: false,
    });
    expect(answered).toMatchObject({
      council: {
        escalation: { step: "returned", move: { toState: "triage" } },
        triage: [{ step: "start", result: { outcome: "started" } }],
      },
    });
    const third = lastTriageStart(f);
    expect(third.input).toContain("> Name only scripts from package.json.");
    expect(third.input).not.toMatch(/Why your last answer was rejected/);
    // The third run's good answer hands the idea off.
    expect(await finish(f, third.run.id, goodAnswer())).toMatchObject({
      triageAnswer: { recorded: true },
    });
    expect((await f.store.getNode(idea.id))?.state).toBe("handed_off");
  });
});

describe("Triage's switches and refusals (flow: fake model, D-201)", () => {
  it("in dry run writes one dry-run row for the move to Triage and starts nothing", async () => {
    const f = await createFlowFixture();
    const idea = await acceptedIdea(f);
    await f.setting("dry_run", true);
    const steps = await triagePass(f.deps, [idea.id]);
    expect(steps).toMatchObject([
      { toTriage: { outcome: "planned" }, step: "not_in_triage" },
    ]);
    const after = await f.footprint(idea.id);
    expect(await triagePass(f.deps, [idea.id])).toMatchObject([
      { toTriage: { outcome: "noop", reason: "duplicate_trigger" } },
    ]);
    expect(await f.footprint(idea.id)).toBe(after);
    expect((await f.store.listTransitions(idea.id)).map((t) => t.mode)).toEqual([
      "dry_run",
    ]);
    expect((await f.store.getNode(idea.id))?.state).toBe("plan_accepted");
    expect(await f.store.listRuns({ nodeId: idea.id })).toEqual([]);
  });

  it("does not move an idea with no accepted plan", async () => {
    const f = await createFlowFixture();
    ticking(f);
    await f.live();
    const idea = await f.node("plan_accepted", {
      type: "idea",
      track: null,
      ownerRole: "runner",
    });
    expect(await triagePass(f.deps, [idea.id])).toMatchObject([
      {
        toTriage: { outcome: "rejected", reason: "guard_failed" },
        step: "not_in_triage",
      },
    ]);
  });

  it("starts no run when the repo map cannot be read", async () => {
    const f = await createFlowFixture();
    const idea = await acceptedIdea(f);
    const failing = {
      ...f.deps,
      repoMaps: { read: async () => Promise.reject(new Error("not built")) },
    };
    expect(await triagePass(failing, [idea.id])).toMatchObject([
      { step: "start", result: { outcome: "start_failed" } },
    ]);
    expect(await f.store.listRuns({ nodeId: idea.id })).toEqual([]);
  });

  it("the schema the run is given is Triage's answer schema", () => {
    expect(TRIAGE_SCHEMAS.answer).toBeDefined();
  });
});
