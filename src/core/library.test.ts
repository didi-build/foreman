import { describe, expect, it } from "vitest";

import type { Contracts, GuardRegistry } from "./contracts.ts";
import {
  createLibrary,
  LibraryError,
  type Clock,
  type IdSource,
  type TransitionRequest,
} from "./library.ts";
import { createMemoryStore } from "./memory-store.ts";
import type { Store } from "./store.ts";

/** A tiny test machine for the mechanics, until real contracts arrive in M2. */
const CONTRACTS: Contracts = {
  version: "a".repeat(40),
  contentHash: "test-machine",
  states: {
    triage: { initial: true },
    ready: {},
    in_progress: {},
    done: {},
    blocked: { requiresBlockedReason: true },
    escalated: { escalated: true, requiresBlockedReason: true },
  },
  transitions: [
    { from: "triage", to: "ready", guards: [] },
    { from: "ready", to: "in_progress", guards: ["agent_ready"] },
    { from: "in_progress", to: "done", guards: ["ci_green"] },
    { from: "in_progress", to: "blocked", guards: [] },
    { from: "in_progress", to: "escalated", guards: [] },
    { from: "blocked", to: "in_progress", guards: [] },
  ],
};

const GUARDS: GuardRegistry = {
  agent_ready: async ({ node }) => ({
    name: "agent_ready",
    pass: node.agentReady,
    evidenceIds: [],
  }),
  ci_green: async ({ node, store }) => {
    const runs = await store.listEvidence({ nodeId: node.id, kind: "ci_run" });
    const green = runs.filter((e) => (e.payload as { pass?: boolean }).pass === true);
    return {
      name: "ci_green",
      pass: green.length > 0,
      evidenceIds: green.map((e) => e.id),
    };
  },
};

const RUNNER = { kind: "runner" as const, id: "runner" };
const RECONCILE = { kind: "reconcile" as const, ref: null };
const PROJECT = "00000000-0000-4000-8000-000000000001";

function fixedClock(): Clock {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++)) };
}

function sequentialIds(): IdSource {
  let n = 1;
  return { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
}

/** `null` leaves a setting out entirely. */
async function setup(settings: Record<string, boolean | null> = {}) {
  const store = createMemoryStore();
  const clock = fixedClock();
  await store.insertProject({
    id: PROJECT,
    slug: "rehearsal",
    name: "Rehearsal",
    repo: "didi-build/rehearsal",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: clock.now(),
  });
  for (const [key, value] of Object.entries({
    kill_switch: false,
    dry_run: false,
    ...settings,
  })) {
    if (value === null) continue;
    await store.setSetting({ key, value, updatedBy: "test", updatedAt: clock.now() });
  }
  await store.setSetting({
    key: "failure_threshold",
    value: 3,
    updatedBy: "test",
    updatedAt: clock.now(),
  });
  const library = createLibrary({
    store,
    contracts: CONTRACTS,
    guards: GUARDS,
    clock,
    ids: sequentialIds(),
  });
  const item = (agentReady = true) =>
    library.createNode({
      projectId: PROJECT,
      type: "work_item",
      track: "code",
      state: "triage",
      ownerRole: "triage",
      title: "An item",
      agentReady,
    });
  return { store, library, item };
}

const move = (
  nodeId: string,
  toState: string,
  extra: Partial<TransitionRequest> = {},
): TransitionRequest => ({
  nodeId,
  toState,
  trigger: RECONCILE,
  actor: RUNNER,
  ...extra,
});

async function stateOf(store: Store, id: string): Promise<string | undefined> {
  return (await store.getNode(id))?.state;
}

describe("state library (unit, build plan M1.3, schema invariants)", () => {
  it("moves a node, writing one transition and bumping the version (invariant 1)", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    const result = await library.requestTransition(move(node.id, "ready"));
    expect(result.outcome).toBe("applied");
    const after = await store.getNode(node.id);
    expect(after?.state).toBe("ready");
    expect(after?.version).toBe(1);
    const transitions = await store.listTransitions(node.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromState: "triage",
      toState: "ready",
      mode: "applied",
      specVersion: CONTRACTS.version,
    });
    expect(await store.getSpecVersion(CONTRACTS.version)).not.toBeNull();
  });

  it("allows only the legal moves in the contracts (invariant 3)", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    const result = await library.requestTransition(move(node.id, "done"));
    expect(result).toMatchObject({ outcome: "rejected", reason: "illegal_move" });
    expect(await store.listTransitions(node.id)).toEqual([]);
    expect(await stateOf(store, node.id)).toBe("triage");
  });

  it("writes nothing when a guard fails, and reports which one (invariant 3)", async () => {
    const { store, library, item } = await setup();
    const node = await item(false);
    await library.requestTransition(move(node.id, "ready"));
    const result = await library.requestTransition(move(node.id, "in_progress"));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("guard_failed");
    expect(result.guardReport).toEqual([
      { name: "agent_ready", pass: false, evidenceIds: [] },
    ]);
    expect(await store.listTransitions(node.id)).toHaveLength(1);
    expect(await stateOf(store, node.id)).toBe("ready");
  });

  it("records the evidence a passing guard relied on", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    await library.requestTransition(move(node.id, "ready"));
    await library.requestTransition(move(node.id, "in_progress"));
    const ci = await library.recordEvidence({
      nodeId: node.id,
      runId: null,
      kind: "ci_run",
      ref: "run/1",
      commitSha: "b".repeat(40),
      payload: { pass: true },
      recordedBy: "runner",
    });
    const result = await library.requestTransition(move(node.id, "done"));
    expect(result.outcome).toBe("applied");
    const last = (await store.listTransitions(node.id)).at(-1);
    expect(last?.evidenceIds).toEqual([ci.id]);
  });

  it("treats an unregistered guard as a failure", async () => {
    const { store } = await setup();
    const clock = fixedClock();
    const library = createLibrary({
      store,
      contracts: {
        ...CONTRACTS,
        transitions: [{ from: "triage", to: "ready", guards: ["missing"] }],
      },
      guards: GUARDS,
      clock,
      ids: sequentialIds(),
    });
    const node = await library.createNode({
      projectId: PROJECT,
      type: "idea",
      track: null,
      state: "triage",
      ownerRole: "council",
      title: "Idea",
    });
    const result = await library.requestTransition(move(node.id, "ready"));
    expect(result.guardReport).toEqual([
      {
        name: "missing",
        pass: false,
        evidenceIds: [],
        detail: "guard is not registered",
      },
    ]);
  });

  it("requires a blocked reason for Blocked and escalated states (invariant 4)", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    await library.requestTransition(move(node.id, "ready"));
    await library.requestTransition(move(node.id, "in_progress"));
    expect(await library.requestTransition(move(node.id, "blocked"))).toMatchObject({
      outcome: "rejected",
      reason: "blocked_reason_required",
    });
    const blocked = await library.requestTransition(
      move(node.id, "blocked", { blockedReason: "Waiting on DNS" }),
    );
    expect(blocked.outcome).toBe("applied");
    expect((await store.getNode(node.id))?.blockedReason).toBe("Waiting on DNS");
    await library.requestTransition(move(node.id, "in_progress"));
    expect((await store.getNode(node.id))?.blockedReason).toBeNull();
  });

  it("never dispatches an item in an escalated state, on hold, or not agent-ready (invariant 6)", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    expect(library.canDispatch(node)).toBe(true);
    expect(library.canDispatch({ ...node, hold: true })).toBe(false);
    expect(library.canDispatch({ ...node, agentReady: false })).toBe(false);
    await library.requestTransition(move(node.id, "ready"));
    await library.requestTransition(move(node.id, "in_progress"));
    await library.requestTransition(
      move(node.id, "escalated", { blockedReason: "Third failure" }),
    );
    const escalated = await store.getNode(node.id);
    expect(escalated?.state).toBe("escalated");
    expect(library.canDispatch(escalated!)).toBe(false);
  });

  it("refuses a node without a project, and one that cannot start in its state (invariant 7)", async () => {
    const { library } = await setup();
    await expect(
      library.createNode({
        projectId: "00000000-0000-4000-8000-0000000000ff",
        type: "idea",
        track: null,
        state: "triage",
        ownerRole: "council",
        title: "x",
      }),
    ).rejects.toBeInstanceOf(LibraryError);
    await expect(
      library.createNode({
        projectId: PROJECT,
        type: "idea",
        track: null,
        state: "done",
        ownerRole: "council",
        title: "x",
      }),
    ).rejects.toThrow(/not a state a node can start in/);
  });

  it("keeps one open gate request per topic by superseding the older one (invariant 5)", async () => {
    const { store, library } = await setup();
    const ask = {
      projectId: PROJECT,
      topicKey: "spend:windmill",
      kind: "spend" as const,
      owner: "didi" as const,
      blocking: true,
    };
    const first = await library.openGateRequest(ask);
    const second = await library.openGateRequest({ ...ask, payload: { amount: 10 } });
    expect(await store.getGateRequest(first.id)).toMatchObject({
      status: "superseded",
      supersededBy: second.id,
    });
    expect((await store.findOpenGateRequest(PROJECT, "spend:windmill"))?.id).toBe(
      second.id,
    );
  });

  it("answers a gate request once, recording the answer as a decision", async () => {
    const { store, library } = await setup();
    const request = await library.openGateRequest({
      projectId: PROJECT,
      topicKey: "dns:x",
      kind: "dns",
      owner: "didi",
      blocking: true,
    });
    const answer = {
      nodeId: null,
      kind: "approval" as const,
      scope: {},
      textVerbatim: "yes",
      byActor: "didi",
    };
    const decision = await library.answerGateRequest(request.id, answer);
    expect(await store.getGateRequest(request.id)).toMatchObject({
      status: "answered",
      decisionId: decision.id,
    });
    await expect(library.answerGateRequest(request.id, answer)).rejects.toThrow(
      /no longer open/,
    );
    expect(await store.getDecision(decision.id)).not.toBeNull();
  });

  it("rejects self edges and blocks edges that would close a cycle (test plan item 3)", async () => {
    const { library, item } = await setup();
    const [a, b, c] = [await item(), await item(), await item()];
    await expect(library.addEdge(a.id, a.id, "blocks")).rejects.toThrow(/itself/);
    await library.addEdge(a.id, b.id, "blocks");
    await library.addEdge(b.id, c.id, "blocks");
    await expect(library.addEdge(c.id, a.id, "blocks")).rejects.toThrow(/cycle/);
    // A different edge type is not part of the blocks graph.
    await expect(library.addEdge(c.id, a.id, "design_for")).resolves.toMatchObject({
      type: "design_for",
    });
  });

  it("reverses a decision without editing it: dependents go stale and the Council is asked (test plan item 5)", async () => {
    const { store, library, item } = await setup();
    const [a, b, unrelated] = [await item(), await item(), await item()];
    const decision = await library.recordDecision(
      {
        projectId: PROJECT,
        nodeId: null,
        kind: "product_direction",
        scope: {},
        textVerbatim: "Ship the gallery",
        byActor: "didi",
      },
      [a.id, b.id],
    );
    const question = await library.reverseDecision(
      decision.id,
      "didi",
      "Changed direction",
    );
    const current = await store.getDecision(decision.id);
    expect(current).toMatchObject({
      status: "reversed",
      textVerbatim: "Ship the gallery",
    });
    expect((await store.getNode(a.id))?.stale).toBe(true);
    expect((await store.getNode(b.id))?.stale).toBe(true);
    expect((await store.getNode(unrelated.id))?.stale).toBe(false);
    expect(question).toMatchObject({
      kind: "council_question",
      owner: "council",
      status: "open",
    });
    await expect(
      library.reverseDecision(decision.id, "didi", "again"),
    ).rejects.toThrow();
  });

  it("counts up from 0, resets both counters, and reads the limit from settings", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    expect(await library.incrementCounter(node.id, "failure")).toBe(1);
    expect(await library.incrementCounter(node.id, "failure")).toBe(2);
    expect(await library.incrementCounter(node.id, "qa_round")).toBe(1);
    expect(await library.counterLimit("failure")).toBe(3);
    expect(await library.counterLimit("qa_round")).toBeNull();
    await library.resetCounters(node.id);
    expect(await store.getCounter(node.id, "failure")).toBe(0);
    expect(await store.getCounter(node.id, "qa_round")).toBe(0);
  });

  it("refuses every move while the kill switch is on, and writes nothing", async () => {
    const { store, library, item } = await setup({ kill_switch: true });
    const node = await item();
    expect(await library.requestTransition(move(node.id, "ready"))).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(await store.listTransitions(node.id)).toEqual([]);
  });

  it("in dry run, records the planned transition and leaves the node where it is", async () => {
    const { store, library, item } = await setup({ dry_run: true });
    const node = await item();
    const result = await library.requestTransition(move(node.id, "ready"));
    expect(result.outcome).toBe("planned");
    expect((await store.listTransitions(node.id))[0]?.mode).toBe("dry_run");
    expect(await store.getNode(node.id)).toMatchObject({ state: "triage", version: 0 });
  });

  it("treats a missing dry_run setting as dry run, so nothing acts for real by default", async () => {
    const { store, library, item } = await setup({ dry_run: null });
    const node = await item();
    expect((await library.requestTransition(move(node.id, "ready"))).outcome).toBe(
      "planned",
    );
    expect(await store.getNode(node.id)).toMatchObject({ state: "triage", version: 0 });
  });

  it("gives guards read calls only, so a guard cannot write even by casting", async () => {
    const seen: string[] = [];
    const store = createMemoryStore();
    const library = createLibrary({
      store,
      contracts: {
        ...CONTRACTS,
        transitions: [{ from: "triage", to: "ready", guards: ["peek"] }],
      },
      guards: {
        peek: async (ctx) => {
          seen.push(...Object.keys(ctx.store));
          return { name: "peek", pass: true, evidenceIds: [] };
        },
      },
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    await store.insertProject({
      id: PROJECT,
      slug: "rehearsal",
      name: "Rehearsal",
      repo: "didi-build/rehearsal",
      linearProjectId: null,
      galleryPathOverride: null,
      privilegedPathsExtra: [],
      prodRequiresApproval: false,
      stagingUrl: null,
      createdAt: fixedClock().now(),
    });
    const node = await library.createNode({
      projectId: PROJECT,
      type: "work_item",
      track: "code",
      state: "triage",
      ownerRole: "triage",
      title: "An item",
    });
    await library.requestTransition(move(node.id, "ready"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((name) => !/^(get|list|find)/.test(name))).toEqual([]);
  });

  it("does nothing when the node is already in the requested state", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    await library.requestTransition(move(node.id, "ready"));
    expect((await library.requestTransition(move(node.id, "ready"))).outcome).toBe(
      "noop",
    );
    expect(await store.listTransitions(node.id)).toHaveLength(1);
  });

  it("lets one of two parallel requests win and the other retry cleanly, every time (test plan item 2)", async () => {
    for (let round = 0; round < 50; round++) {
      const { store, library, item } = await setup();
      const node = await item();
      const results = await Promise.all([
        library.requestTransition(move(node.id, "ready")),
        library.requestTransition(move(node.id, "ready")),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "noop"]);
      expect(await store.listTransitions(node.id)).toHaveLength(1);
      expect((await store.getNode(node.id))?.version).toBe(1);
    }
  });

  it("rolls back the transition row when the node changed underneath it, and gives up after 3 tries", async () => {
    const { store, item } = await setup();
    const node = await item();
    // Another writer changes the node (same state, new version) between every read and write.
    const racing: Store = {
      ...store,
      getNode: async (id) => {
        const read = await store.getNode(id);
        await store.changeNodeState(id, read!.version, {
          state: read!.state,
          substate: null,
          ownerRole: "triage",
          blockedReason: null,
          stateSince: read!.stateSince,
          updatedAt: read!.updatedAt,
        });
        return read;
      },
    };
    const raced = createLibrary({
      store: racing,
      contracts: CONTRACTS,
      guards: GUARDS,
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    const result = await raced.requestTransition(move(node.id, "ready"));
    expect(result).toMatchObject({ outcome: "refused", reason: "too_much_contention" });
    expect(await store.listTransitions(node.id)).toEqual([]);
    expect((await store.getNode(node.id))?.version).toBe(3);
  });
});

describe("checking a transition without writing (unit, build plan M2.4)", () => {
  it("answers as requestTransition would, with the evidence ids, and writes nothing", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    await library.requestTransition(move(node.id, "ready"));
    await library.requestTransition(move(node.id, "in_progress"));
    expect(await library.checkTransition(move(node.id, "done"))).toMatchObject({
      outcome: "rejected",
      reason: "guard_failed",
    });
    const green = await library.recordEvidence({
      nodeId: node.id,
      runId: null,
      kind: "ci_run",
      ref: "ci/1",
      commitSha: null,
      payload: { pass: true },
      recordedBy: "test",
    });
    expect(await library.checkTransition(move(node.id, "done"))).toEqual({
      outcome: "allowed",
      guardReport: [{ name: "ci_green", pass: true, evidenceIds: [green.id] }],
      evidenceIds: [green.id],
    });
    expect(await library.checkTransition(move(node.id, "in_progress"))).toMatchObject({
      outcome: "noop",
    });
    expect(await library.checkTransition(move(node.id, "triage"))).toMatchObject({
      outcome: "rejected",
      reason: "illegal_move",
    });
    expect(await store.listTransitions(node.id)).toHaveLength(2);
    expect(await stateOf(store, node.id)).toBe("in_progress");
  });
});

describe("escalation keywords never match as states (unit, ADR 0105)", () => {
  /** Hand-built, unvalidated contracts: the library must stay safe without the validator. */
  async function keywordLibrary(contracts: Contracts) {
    const { store } = await setup();
    const library = createLibrary({
      store,
      contracts,
      guards: {},
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    const node = await library.createNode({
      projectId: PROJECT,
      type: "work_item",
      track: null,
      state: "triage",
      ownerRole: "triage",
      title: "An item",
    });
    return { store, library, node };
  }

  it("rejects a request for a target that is not a state, even if a move names it", async () => {
    const { store, library, node } = await keywordLibrary({
      ...CONTRACTS,
      states: { triage: { initial: true }, ready: {} },
      transitions: [
        { from: "triage", to: "ready", guards: [] },
        { from: "triage", to: "any", guards: [] },
      ],
    });
    expect(await library.requestTransition(move(node.id, "any"))).toMatchObject({
      outcome: "rejected",
      reason: "illegal_move",
    });
    expect(await stateOf(store, node.id)).toBe("triage");
  });

  it("never takes a `to: return` move literally, even when a state is named return", async () => {
    const { store, library, node } = await keywordLibrary({
      ...CONTRACTS,
      states: { triage: { initial: true }, return: {} },
      transitions: [{ from: "triage", to: "return", guards: [], escalation: true }],
    });
    expect(await library.requestTransition(move(node.id, "return"))).toMatchObject({
      outcome: "rejected",
      reason: "illegal_move",
    });
    expect(await stateOf(store, node.id)).toBe("triage");
  });
});

describe("a trigger with its own id is taken once (unit, build plan M3.1)", () => {
  const event = (ref: string) => ({ trigger: { kind: "event" as const, ref } });

  it("writes one applied row for a repeated trigger, and a new trigger is judged afresh", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    const first = await library.requestTransitionOnce(
      move(node.id, "ready", event("e1")),
    );
    expect(first.outcome).toBe("applied");
    expect(
      await library.requestTransitionOnce(move(node.id, "ready", event("e1"))),
    ).toEqual({
      outcome: "noop",
      reason: "duplicate_trigger",
      guardReport: [],
      transitionId: first.transitionId,
    });
    expect(await store.listTransitions(node.id)).toHaveLength(1);
    // Another trigger kind with the same id is another trigger.
    expect(
      (
        await library.requestTransitionOnce(
          move(node.id, "in_progress", { trigger: { kind: "bot_report", ref: "e1" } }),
        )
      ).outcome,
    ).toBe("applied");
  });

  it("writes one dry-run row for a repeated trigger, where the node never moves", async () => {
    const { store, library, item } = await setup({ dry_run: true });
    const node = await item();
    expect(
      (await library.requestTransitionOnce(move(node.id, "ready", event("e1"))))
        .outcome,
    ).toBe("planned");
    expect(
      (await library.requestTransitionOnce(move(node.id, "ready", event("e1")))).reason,
    ).toBe("duplicate_trigger");
    expect(await store.listTransitions(node.id)).toHaveLength(1);
    expect(
      (await library.requestTransitionOnce(move(node.id, "ready", event("e2"))))
        .outcome,
    ).toBe("planned");
  });

  it("lets a rejected trigger be retried, since a rejection writes nothing", async () => {
    const { store, library, item } = await setup();
    const node = await item(false);
    await library.requestTransition(move(node.id, "ready"));
    const again = () =>
      library.requestTransitionOnce(move(node.id, "in_progress", event("e1")));
    expect((await again()).reason).toBe("guard_failed");
    await store.setNodeFlags(node.id, { agentReady: true }, new Date(0));
    expect((await again()).outcome).toBe("applied");
  });

  it("refuses under the kill switch and needs the trigger's id", async () => {
    const { store, library, item } = await setup({ kill_switch: true });
    const node = await item();
    expect(
      await library.requestTransitionOnce(move(node.id, "ready", event("e1"))),
    ).toMatchObject({ outcome: "refused", reason: "kill_switch" });
    await expect(library.requestTransitionOnce(move(node.id, "ready"))).rejects.toThrow(
      LibraryError,
    );
    expect(await store.listTransitions(node.id)).toHaveLength(0);
  });
});

describe("a move with writes that go with it (unit, build plan M3.2)", () => {
  const counted = (store: Store, nodeId: string) => async () =>
    (await store.listEvidence({ nodeId })).length;

  /** Writes one evidence row in the move's transaction, then refuses if told to. */
  const evidenceWrite =
    (nodeId: string, refuse: string | null = null) =>
    async (tx: Parameters<Parameters<Store["transaction"]>[0]>[0]) => {
      await tx.insertEvidence({
        id: "00000000-0000-4000-8000-0000000000e1",
        nodeId,
        runId: null,
        kind: "dispatch_record",
        ref: "dispatch:test",
        commitSha: null,
        payload: { repo: "didi-build/rehearsal", branch: "foreman/test" },
        recordedBy: "runner",
        recordedAt: new Date(Date.UTC(2026, 9, 31)),
        supersedesId: null,
      });
      return refuse;
    };

  it("commits the move and the writes together", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    const result = await library.requestTransitionWith(
      move(node.id, "ready"),
      evidenceWrite(node.id),
    );
    expect(result.outcome).toBe("applied");
    expect(await stateOf(store, node.id)).toBe("ready");
    expect(await counted(store, node.id)()).toBe(1);
  });

  it("rolls back the move with the writes when the writes refuse", async () => {
    const { store, library, item } = await setup();
    const node = await item();
    expect(
      await library.requestTransitionWith(
        move(node.id, "ready"),
        evidenceWrite(node.id, "run_ended"),
      ),
    ).toMatchObject({ outcome: "refused", reason: "run_ended" });
    expect(await stateOf(store, node.id)).toBe("triage");
    expect(await store.listTransitions(node.id)).toEqual([]);
    expect(await counted(store, node.id)()).toBe(0);
  });

  it("writes nothing when a guard fails, in dry run, or under the kill switch", async () => {
    for (const [settings, agentReady, reason] of [
      [{}, false, "guard_failed"],
      [{ dry_run: true }, true, "dry_run"],
      [{ kill_switch: true }, true, "kill_switch"],
    ] as const) {
      const { store, library, item } = await setup(settings);
      const node = await item(agentReady);
      // triage to ready has no guard; ready to in_progress needs the node agent-ready.
      if (reason === "guard_failed")
        await library.requestTransition(move(node.id, "ready"));
      const to = reason === "guard_failed" ? "in_progress" : "ready";
      const result = await library.requestTransitionWith(
        move(node.id, to),
        evidenceWrite(node.id),
      );
      expect(result.reason).toBe(reason);
      expect(await counted(store, node.id)()).toBe(0);
      expect(
        (await store.listTransitions(node.id)).filter((t) => t.toState === to),
      ).toEqual([]);
    }
  });
});
