// Seam: the flows around Triage (build plan M3.6, D-262, D-264, D-265) with a fake model (the fake
// agent runtime returns the structured answer the test gives), a fake repo map port, the memory
// store, and the real contracts of both machines and the real guards. The success test of D-265:
// a synthetic accepted plan run through Triage gives the expected items, links and tracks; the bad
// answers are rejected; the re-run gets the reason; a second bad answer goes to the Council, whose
// decision returns the idea to Triage. The answer rules themselves are in test/triage.test.ts.
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import { triagePass } from "../../flows/lib/triage-runs.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { createGitHubRepoMaps } from "../../src/adapters/repo-map/github.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import {
  createHoldReleases,
  HOLD_RELEASE_QUESTION,
  holdReleaseTopic,
} from "../../src/core/hold-release.ts";
import { createLibrary } from "../../src/core/library.ts";
import {
  needsDidiTopic,
  rejectionRef,
  TRACK_DECIDER,
  TRACK_DECISION_POINT,
} from "../../src/core/triage.ts";
import type { DecisionPointRecord, Node, Store } from "../../src/core/store.ts";
import {
  answerWith,
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
    // The needsDidi item has its gate request for Didi, the held item its release request
    // (D-269), and nothing else has one.
    const gates = await f.store.listOpenGateRequests(f.projectId);
    expect(gates).toMatchObject([
      {
        nodeId: id("settings-dns"),
        topicKey: needsDidiTopic(id("settings-dns")),
        kind: "dns",
        owner: "didi",
        blocking: true,
      },
      {
        nodeId: id("old-settings"),
        topicKey: holdReleaseTopic(id("old-settings")),
        kind: "scope",
        owner: "didi",
        blocking: false,
        payload: {
          question: HOLD_RELEASE_QUESTION,
          title: "Item old-settings",
          description: "The old-settings work.",
          ideaId: idea.id,
          note: goodAnswer().note,
        },
      },
    ]);
    // The release request uses the approval form with no options (D-254).
    expect((gates[1]?.payload as { options?: unknown }).options).toBeUndefined();
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

describe("a design item Triage marks as blocked (flow: fake model, D-268)", () => {
  it("waits for its blocker, and starts once the blocker is Done", async () => {
    const f = await createFlowFixture();
    const { start } = await startedTriage(f);
    // The design item now waits on the DNS item too.
    const answer = answerWith((a) => {
      const design = a.items.find((i) => i.key === "settings-design");
      design?.blockedBy.push("settings-dns");
    });
    expect(await finish(f, start.run.id, answer)).toMatchObject({
      triageAnswer: { recorded: true },
    });
    const items = (await f.store.listNodes({ projectId: f.projectId })).filter(
      (n) => n.type === "work_item",
    );
    const byKey = (key: string) =>
      items.find((n) => (n.body as { triageKey: string }).triageKey === key) as Node;
    const design = byKey("settings-design");
    const dns = byKey("settings-dns");
    // The design track's only start state is Ready for design exploration, blocked or not.
    expect(design.state).toBe("ready_for_design_exploration");

    const waiting = await dispatch(f.deps, { nodeId: design.id, role: "designer" });
    expect(waiting).toMatchObject({
      outcome: "not_started",
      failedGuards: ["blockers_done"],
    });
    expect(await f.store.listRuns({ nodeId: design.id })).toEqual([]);

    // The blocker reaches Done (written directly: its own track is not under test here).
    const blocker = (await f.store.getNode(dns.id)) as Node;
    const at = f.clock.now();
    await f.store.changeNodeState(dns.id, blocker.version, {
      state: "done",
      substate: null,
      ownerRole: "runner",
      blockedReason: null,
      stateSince: at,
      updatedAt: at,
    });
    const started = await dispatch(f.deps, { nodeId: design.id, role: "designer" });
    expect(started).toMatchObject({ outcome: "started" });
    expect((await f.store.getNode(design.id))?.state).toBe("in_design_exploration");
  });
});

/** A handoff whose held item waits on nothing else, with its release request (D-269). */
async function heldItem(f: FlowFixture) {
  const { start } = await startedTriage(f);
  const answer = answerWith((a) => {
    const old = a.items.find((i) => i.key === "old-settings");
    if (old) old.blockedBy = [];
  });
  expect(await finish(f, start.run.id, answer)).toMatchObject({
    triageAnswer: { recorded: true },
  });
  const held = (await f.store.listNodes({ projectId: f.projectId })).find(
    (n) => (n.body as { triageKey?: string }).triageKey === "old-settings",
  ) as Node;
  expect(held).toMatchObject({ state: "ready_for_dev", hold: true });
  const request = await f.store.findOpenGateRequest(
    f.projectId,
    holdReleaseTopic(held.id),
  );
  if (!request) throw new Error("no release request");
  return { held, request };
}

const answerPage = (
  f: FlowFixture,
  gateRequestId: string,
  decision: string,
  feedback = "",
) =>
  resume(f.deps, {
    gateRequestId,
    resume: { decision, options: [], feedback },
    approvers: ["anonymous"],
  });

describe("a held item's release request (flow: fake model, D-269)", () => {
  it("keeps the held item from starting; Didi's Approve releases it once and it starts", async () => {
    const f = await createFlowFixture();
    const { held, request } = await heldItem(f);
    const waiting = await dispatch(f.deps, { nodeId: held.id, role: "developer" });
    expect(waiting).toMatchObject({ outcome: "not_started" });
    expect((waiting as { failedGuards: string[] }).failedGuards).toContain(
      "agent_ready_not_on_hold",
    );
    expect(await f.store.listRuns({ nodeId: held.id })).toEqual([]);

    // Approve needs no feedback here: a release request is not a question (D-254, D-257).
    const approved = await answerPage(f, request.id, "Approve");
    expect(approved).toMatchObject({
      outcome: "recorded",
      heldBy: null,
      holdRelease: { nodeId: held.id, step: "released" },
    });
    expect((await f.store.getNode(held.id))?.hold).toBe(false);
    const decisions = (await f.store.listDecisionsForNode(held.id)).filter(
      (d) => d.kind === "approval",
    );
    expect(decisions).toMatchObject([
      {
        byActor: "didi",
        scope: { topicKey: holdReleaseTopic(held.id), gateKind: "scope" },
      },
    ]);

    // A repeated answer records nothing more, and the release is not taken again.
    const before = await f.footprint(held.id);
    expect(await answerPage(f, request.id, "Approve")).toEqual({
      outcome: "already_closed",
    });
    expect(await createHoldReleases(f.deps).release(held.id)).toEqual({
      nodeId: held.id,
      step: "not_held",
    });
    expect((await reconcileFlow(f.deps)).holdReleases).toEqual([]);
    expect(await f.footprint(held.id)).toBe(before);

    const started = await dispatch(f.deps, { nodeId: held.id, role: "developer" });
    expect(started).toMatchObject({ outcome: "started" });
  });

  it("keeps the item held on Reject, with Didi's words recorded", async () => {
    const f = await createFlowFixture();
    const { held, request } = await heldItem(f);
    const words = "Not yet.\nWait until the new page has run for a week.";
    expect(await answerPage(f, request.id, "Reject", words)).toMatchObject({
      outcome: "recorded",
      holdRelease: { nodeId: held.id, step: "kept_held" },
    });
    expect((await f.store.getNode(held.id))?.hold).toBe(true);
    expect(await f.store.listDecisionsForNode(held.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "answer",
          textVerbatim: words,
          scope: expect.objectContaining({ outcome: "rejected" }),
        }),
      ]),
    );
    expect((await reconcileFlow(f.deps)).holdReleases).toEqual([]);
    expect(
      await dispatch(f.deps, { nodeId: held.id, role: "developer" }),
    ).toMatchObject({
      outcome: "not_started",
    });
    expect((await f.store.getNode(held.id))?.hold).toBe(true);
  });

  it("keeps it held on Request changes, and a Reject with no feedback records nothing", async () => {
    const f = await createFlowFixture();
    const { held, request } = await heldItem(f);
    const reopened = await answerPage(f, request.id, "Reject");
    expect(reopened).toMatchObject({
      outcome: "reopened",
      note: "Reject needs feedback: say why.",
    });
    expect((await f.store.getNode(held.id))?.hold).toBe(true);
    const fresh = (reopened as { gateRequestId: string }).gateRequestId;
    expect(
      await answerPage(f, fresh, "Request changes", "Split it first."),
    ).toMatchObject({ outcome: "recorded", holdRelease: { step: "kept_held" } });
    expect((await f.store.getNode(held.id))?.hold).toBe(true);
  });

  it("records Didi's Approve under dry run and releases the item once the runner is live", async () => {
    const f = await createFlowFixture();
    const { held, request } = await heldItem(f);
    await f.setting("dry_run", true);
    expect(await answerPage(f, request.id, "Approve")).toMatchObject({
      outcome: "recorded",
      heldBy: "dry_run",
      holdRelease: { step: "dry_run" },
    });
    expect((await f.store.getNode(held.id))?.hold).toBe(true);
    await f.live();
    expect((await reconcileFlow(f.deps)).holdReleases).toEqual([
      { nodeId: held.id, step: "released" },
    ]);
    expect((await f.store.getNode(held.id))?.hold).toBe(false);
    expect((await reconcileFlow(f.deps)).holdReleases).toEqual([]);
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

  it("builds the brief from GitHub's archive at the default branch's head through the runner App's read token (D-267)", async () => {
    const f = await createFlowFixture();
    const idea = await acceptedIdea(f);
    const minted: unknown[] = [];
    const top = `rehearsal-${MAP_COMMIT.slice(0, 7)}`;
    const tar = (path: string, text: string) => {
      const header = Buffer.alloc(512);
      header.write(`${top}/${path}`, 0);
      header.write(`${text.length.toString(8).padStart(11, "0")}\0`, 124);
      header.write("0", 156);
      header.write("ustar\0", 257);
      const body = Buffer.alloc(Math.ceil(text.length / 512) * 512);
      body.write(text);
      return Buffer.concat([header, body]);
    };
    const archive = gzipSync(
      Buffer.concat([
        tar("package.json", '{"scripts":{"check":"vitest run"}}'),
        tar("src/settings/store.ts", "export function readSettings() {}"),
        Buffer.alloc(1024),
      ]),
    );
    const repoMaps = createGitHubRepoMaps({
      tokens: {
        async mint(request) {
          minted.push(request);
          return "fake-token-for-tests";
        },
      },
      http: {
        async get({ path }) {
          if (path === `/repos/${REPO}`)
            return { status: 200, body: Buffer.from('{"default_branch":"main"}') };
          if (path === `/repos/${REPO}/commits/main`)
            return { status: 200, body: Buffer.from(MAP_COMMIT) };
          if (path === `/repos/${REPO}/tarball/${MAP_COMMIT}`)
            return { status: 200, body: archive };
          return { status: 404, body: new Uint8Array() };
        },
      },
    });
    const steps = await triagePass({ ...f.deps, repoMaps }, [idea.id]);
    expect(steps).toMatchObject([{ step: "start", result: { outcome: "started" } }]);
    expect(minted).toEqual([{ repository: REPO, permission: "contents" }]);
    const start = lastTriageStart(f);
    expect(start.run.headSha).toBe(MAP_COMMIT);
    expect(start.input).toContain(`at commit ${MAP_COMMIT}`);
    expect(start.input).toContain("src/settings/store.ts");
    expect(start.input).toContain("- check: vitest run");
  });

  it("the schema the run is given is Triage's answer schema", () => {
    expect(TRIAGE_SCHEMAS.answer).toBeDefined();
  });
});
