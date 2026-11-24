// Seam: unit, synthetic data on the memory store. The pure parts of the state API's three context
// routes (ADR 0119 slice 3b): the query checks, the store reads they may make, the scan limit, the
// summaries of evidence, the known gate kinds and outcomes, and the size bound with every list full
// of the longest entries. What the routes answer over HTTP is in test/context-routes.test.ts.
import { describe, expect, it } from "vitest";

import {
  CONTEXT_DATA_NOTICE,
  CONTEXT_LIMITS,
  createContextReads,
  jsonBytes,
  readDecisionSearch,
  readSimilarSearch,
  type ContextQuery,
  type ContextReadStore,
  type DecisionSearchData,
  type ItemHistoryData,
} from "./context-reads.ts";
import { createMemoryStore } from "./memory-store.ts";
import { testRouteColumns } from "./routing-testing.ts";
import type { Evidence, EvidenceKind, Json, Node, Store, StoreOps } from "./store.ts";

const PROJECT = "00000000-0000-4000-8000-0000000000e1";
const OTHER = "00000000-0000-4000-8000-0000000000e2";
const SHA = "e".repeat(40);
const BASE = Date.parse("2026-11-20T09:00:00Z");
const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);
/** A control character: JSON writes it as six bytes, the worst case for the size bound. */
const WORST = "\u0001";

let n = 0;
const id = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const query = (entries: [string, string][]): ContextQuery => {
  const map = new Map<string, string[]>();
  for (const [name, value] of entries) map.set(name, [...(map.get(name) ?? []), value]);
  return map;
};

async function workItem(
  store: Store,
  projectId: string,
  body: Json,
  extra: Partial<Node> = {},
): Promise<Node> {
  const node: Node = {
    id: id(),
    projectId,
    type: "work_item",
    track: "code",
    state: "in_development",
    substate: null,
    ownerRole: "developer",
    title: "An item",
    body,
    hold: false,
    agentReady: true,
    stale: false,
    blockedReason: null,
    stateSince: at(0),
    linearIssueId: null,
    linearStatusSynced: null,
    version: 0,
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  };
  await store.insertNode(node);
  return node;
}

function evidence(
  nodeId: string,
  kind: EvidenceKind,
  payload: Json,
  minutes = 1,
): Evidence {
  return {
    id: id(),
    nodeId,
    runId: null,
    kind,
    ref: "r",
    commitSha: SHA,
    payload,
    recordedBy: "runner",
    recordedAt: at(minutes),
    supersedesId: null,
  };
}

describe("the decision search's query (unit, ADR 0119 slice 3b)", () => {
  it("reads 1 to 8 words of at least 2 characters, case-folded, each once", () => {
    expect(readDecisionSearch(query([["q", "  CSV  export csv\tD-468 "]]))).toEqual({
      search: { words: ["csv", "export", "d-468"] },
    });
    expect(readDecisionSearch(query([["q", "ab"]]))).toEqual({
      search: { words: ["ab"] },
    });
  });

  it.each([
    ["no q", [], "q is required"],
    [
      "q twice",
      [
        ["q", "ab"],
        ["q", "cd"],
      ],
      "q must be given once",
    ],
    [
      "another parameter",
      [
        ["q", "ab"],
        ["path", "x"],
      ],
      "unknown query parameter",
    ],
    ["a q of 1 character", [["q", " a "]], "q must be 2 to 200 characters"],
    [
      "a q of 201 characters",
      [["q", "a".repeat(201)]],
      "q must be 2 to 200 characters",
    ],
    ["9 words", [["q", "aa bb cc dd ee ff gg hh ii"]], "q must have 1 to 8 words"],
    ["a short word", [["q", "csv x"]], "each word of q must be at least 2 characters"],
  ] as [string, [string, string][], string][])(
    "refuses %s",
    (_label, entries, problem) => {
      const read = readDecisionSearch(query(entries));
      expect(read).toHaveProperty("problem");
      expect((read as { problem: string }).problem).toContain(problem);
    },
  );

  it("never echoes an unknown parameter's name", () => {
    const read = readDecisionSearch(query([["SECRET-NAME", "x"]]));
    expect(JSON.stringify(read)).not.toContain("SECRET-NAME");
  });
});

describe("the similar items' query (unit, ADR 0119 slice 3b)", () => {
  it("reads a text, paths, or both, trimmed", () => {
    expect(readSimilarSearch(query([["q", " Export CSV "]]))).toEqual({
      search: { text: "Export CSV", paths: [] },
    });
    expect(
      readSimilarSearch(
        query([
          ["path", " src/a.ts "],
          ["path", "docs/"],
        ]),
      ),
    ).toEqual({ search: { text: "", paths: ["src/a.ts", "docs/"] } });
  });

  it.each([
    ["neither", [], "give q, path or both"],
    [
      "q twice",
      [
        ["q", "a"],
        ["q", "b"],
      ],
      "q must be given once",
    ],
    ["a blank q", [["q", "  "]], "q must be 1 to 200 characters"],
    ["a long q", [["q", "q".repeat(201)]], "q must be 1 to 200 characters"],
    [
      "11 paths",
      Array.from({ length: 11 }, (_, i) => ["path", `p${i}`]),
      "path may be given at most 10 times",
    ],
    ["a blank path", [["path", " "]], "each path must be 1 to 300 characters"],
    [
      "a long path",
      [["path", "p".repeat(301)]],
      "each path must be 1 to 300 characters",
    ],
    [
      "another parameter",
      [
        ["q", "a"],
        ["limit", "9"],
      ],
      "unknown query parameter",
    ],
  ] as [string, [string, string][], string][])(
    "refuses %s",
    (_label, entries, problem) => {
      const read = readSimilarSearch(query(entries));
      expect((read as { problem: string }).problem).toContain(problem);
    },
  );
});

describe("what the context reads may read (unit, D-468)", () => {
  it("reads only the project's nodes, decisions, moves, runs, evidence and gate requests", async () => {
    const store = createMemoryStore();
    const node = await workItem(store, PROJECT, { pathsInScope: ["src/a.ts"] });
    const used = new Set<string>();
    const allowed: (keyof ContextReadStore)[] = [
      "getNode",
      "listNodes",
      "listProjectDecisions",
      "listDecisionsRecordedOn",
      "listTransitions",
      "listRuns",
      "listEvidence",
      "listGateRequestsForNode",
    ];
    // Any other method, a setting, a secret name, a run token or a handle, throws.
    const watched = new Proxy(store, {
      get(target, name) {
        const key = String(name);
        used.add(key);
        if (!(allowed as string[]).includes(key)) {
          throw new Error(`the context reads called ${key}`);
        }
        return (target as unknown as Record<string, unknown>)[key];
      },
    }) as StoreOps;
    const reads = createContextReads(watched);
    await reads.decisions(PROJECT, { words: ["csv"] });
    await reads.similarItems(PROJECT, null, { text: "item", paths: ["src/"] });
    await reads.itemHistory(PROJECT, node.id, "developer");
    expect([...used].sort()).toEqual([...allowed].sort());
  });

  it("finds no item of another project", async () => {
    const store = createMemoryStore();
    const foreign = await workItem(store, OTHER, {});
    const reads = createContextReads(store);
    expect(await reads.itemHistory(PROJECT, foreign.id, "triage")).toBeNull();
    expect(await reads.itemHistory(PROJECT, id(), "triage")).toBeNull();
    expect(
      (await reads.similarItems(PROJECT, null, { text: "item", paths: [] })).data.items,
    ).toEqual([]);
  });
});

describe("the decision search's scan (unit, ADR 0119 slice 3b)", () => {
  it("reads only the newest 5,000 decisions, says so, and says the answer is not complete", async () => {
    const store = createMemoryStore();
    const total = CONTEXT_LIMITS.decisions.scanned + 3;
    for (let i = 0; i < total; i++) {
      await store.insertDecision({
        id: id(),
        projectId: PROJECT,
        nodeId: null,
        kind: "interview_answer",
        scope: {},
        // The three oldest hold the word; the scan never reaches them.
        textVerbatim: i < 3 ? `ancient ${i}` : `answer ${i}`,
        byActor: "triage",
        recordedAt: at(i),
      });
    }
    const reads = createContextReads(store);
    const old = await reads.decisions(PROJECT, { words: ["ancient"] });
    expect(old.data).toMatchObject({ scanned: 5_000, matched: 0, decisions: [] });
    expect(old.truncated).toBe(true);
    const recent = await reads.decisions(PROJECT, { words: ["answer", "5002"] });
    expect(recent.data.decisions.map((d) => d.text)).toEqual(["answer 5002"]);
  });
});

describe("decision fields read from a scope (unit, D-468)", () => {
  it.each([
    [
      "every gate kind it knows",
      { gateKind: "privileged_path", outcome: "rejected" },
      true,
    ],
    ["an unknown gate kind", { gateKind: "Spend", outcome: "Approved" }, false],
    ["values that are not text", { gateKind: 3, outcome: ["approved"] }, false],
    ["no scope object", ["approved"], false],
  ])("shows a gate kind and an outcome only for %s", async (_label, scope, shown) => {
    const store = createMemoryStore();
    await store.insertDecision({
      id: id(),
      projectId: PROJECT,
      nodeId: null,
      kind: "answer",
      scope: scope as Json,
      textVerbatim: "an answer",
      byActor: "didi",
      recordedAt: at(0),
    });
    const [view] = (
      await createContextReads(store).decisions(PROJECT, { words: ["answer"] })
    ).data.decisions;
    if (shown) {
      expect(view).toMatchObject({ gateKind: "privileged_path", outcome: "rejected" });
    } else {
      expect(view).not.toHaveProperty("gateKind");
      expect(view).not.toHaveProperty("outcome");
    }
    expect(view).not.toHaveProperty("scope");
  });
});

describe("evidence summaries (unit, D-468, ADR 0112)", () => {
  it.each([
    [
      "ci_run",
      { conclusion: "failure", pr: 7, changedPaths: ["x"] },
      { conclusion: "failure", pr: 7 },
    ],
    ["ci_run", { conclusion: "maybe", pr: 7 }, null],
    ["preview_check", { pass: true, url: "https://x.invalid" }, { pass: true }],
    ["staging_check", { pass: false, servedCommitSha: SHA }, { pass: false }],
    ["test_report", { suite: "gallery", pass: true }, { pass: true }],
    [
      "visual_comparison",
      {
        pass: false,
        outcome: "differs",
        option: "b",
        components: [
          {
            component: "C",
            variant: "v",
            result: "differs",
            findings: [{ what: "w", specLine: "s" }],
          },
        ],
      },
      { pass: false, outcome: "differs", findings: 1 },
    ],
    ["merge_check", { pr: 7, mergeable: null }, { mergeable: null }],
    ["staging_deploy_failed", { cause: "file_set" }, { countsAsFailure: true }],
    [
      "qa_verdict",
      { verdict: "pass", findings: [], evidenceIds: [] },
      { verdict: "pass", findings: 0 },
    ],
    ["qa_verdict", { verdict: "pass" }, null],
    ["merge_commit", { pr: 7 }, null],
    ["dispatch_record", { repo: "r", branch: "b" }, null],
    ["agent_report", { summary: "the builder's words" }, null],
    ["docs_note", { impact: "updated", note: "the builder's note" }, null],
    ["screenshot", { path: "x.png" }, null],
  ] as [EvidenceKind, Json, Json][])(
    "summarizes a %s as fixed values only",
    async (kind, payload, summary) => {
      const store = createMemoryStore();
      const node = await workItem(store, PROJECT, {});
      await store.insertEvidence(evidence(node.id, kind, payload));
      const history = await createContextReads(store).itemHistory(
        PROJECT,
        node.id,
        "developer",
      );
      expect(history?.data.evidence).toEqual([
        {
          kind,
          recordedAt: at(1).toISOString(),
          commitSha: SHA,
          recordedBy: "runner",
          summary,
        },
      ]);
    },
  );

  it("leaves the builder's report and docs note out of a QA run's history only", async () => {
    const store = createMemoryStore();
    const node = await workItem(store, PROJECT, {});
    for (const kind of ["agent_report", "docs_note", "ci_run"] as const) {
      await store.insertEvidence(
        evidence(node.id, kind, { conclusion: "success", pr: 1 }),
      );
    }
    const reads = createContextReads(store);
    const kinds = async (role: "qa" | "developer" | "designer" | "triage") =>
      (await reads.itemHistory(PROJECT, node.id, role))?.data.evidence.map(
        (e) => e.kind,
      );
    expect(await kinds("qa")).toEqual(["ci_run"]);
    for (const role of ["developer", "designer", "triage"] as const) {
      expect(await kinds(role)).toEqual(["ci_run", "docs_note", "agent_report"]);
    }
  });
});

describe("the size bound (unit, ADR 0119 slice 3b)", () => {
  const bound = CONTEXT_LIMITS.responseBytes;

  it("keeps the decision search within 48 KiB with every entry at its longest", async () => {
    const store = createMemoryStore();
    const node = await workItem(store, PROJECT, {}, { title: WORST.repeat(1_000) });
    for (let i = 0; i < 20; i++) {
      await store.insertDecision({
        id: id(),
        projectId: PROJECT,
        nodeId: node.id,
        kind: "approval",
        scope: { gateKind: "spend", outcome: "approved" },
        textVerbatim: `bound ${WORST.repeat(3_000)}`,
        byActor: "didi",
        recordedAt: at(i),
      });
    }
    const answer = await createContextReads(store).decisions(PROJECT, {
      words: ["bound", WORST.repeat(2)],
    });
    expect(jsonBytes(answer)).toBeLessThanOrEqual(bound);
    expect(answer.truncated).toBe(true);
    expect(answer.data.decisions.length).toBeGreaterThan(0);
    expect(Object.keys(answer)).toEqual(["notice", "data", "truncated"]);
    expect(answer.notice).toBe(CONTEXT_DATA_NOTICE);
  });

  it("keeps similar items within 48 KiB with every entry at its longest", async () => {
    const store = createMemoryStore();
    const longPath = (i: number): string => `src/${WORST.repeat(290)}/${i}`;
    for (let i = 0; i < 8; i++) {
      await workItem(
        store,
        PROJECT,
        {
          description: `wide ${WORST.repeat(800)}`,
          pathsInScope: Array.from({ length: 12 }, (_, j) => longPath(j)),
        },
        { title: `wide ${WORST.repeat(400)}` },
      );
    }
    const answer = await createContextReads(store).similarItems(PROJECT, null, {
      text: "wide",
      paths: Array.from({ length: 10 }, (_, j) => longPath(j)),
    });
    expect(jsonBytes(answer)).toBeLessThanOrEqual(bound);
    expect(answer.truncated).toBe(true);
    expect(answer.data.items.length).toBeGreaterThan(0);
  });

  it("keeps an item's history within 48 KiB with every list full of the longest entries", async () => {
    const store = createMemoryStore();
    const node = await workItem(store, PROJECT, {
      description: WORST.repeat(3_000),
      acceptanceCriteria: Array.from({ length: 30 }, () => WORST.repeat(500)),
      pathsInScope: Array.from({ length: 30 }, () => WORST.repeat(500)),
    });
    for (let i = 0; i < 40; i++) {
      await store.insertTransition({
        id: id(),
        nodeId: node.id,
        fromState: "a",
        toState: "b",
        fromSubstate: null,
        toSubstate: null,
        triggerKind: "reconcile",
        triggerRef: null,
        actorKind: "runner",
        actorId: "runner",
        guardResult: Array.from({ length: 30 }, (_, j) => ({
          name: `guard_${"g".repeat(70)}_${j}`,
          pass: false,
          evidenceIds: [],
        })),
        evidenceIds: [],
        specVersion: "s",
        mode: "applied",
        reason: WORST.repeat(500),
        at: at(i),
      });
      await store.insertRun({
        id: id(),
        projectId: PROJECT,
        nodeId: node.id,
        bot: "developer",
        agentId: null,
        runtime: "claude_code",
        model: "m",
        headSha: null,
        prNumber: null,
        botVersion: "v",
        startedAt: at(i),
        endedAt: at(i + 1),
        outcome: "budget_exceeded",
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: {},
        parentRunId: null,
        transcriptRef: null,
        usageExhaustedCause: null,
        retryAfterSeconds: null,
        questionTopic: null,
        ...testRouteColumns("developer"),
      });
      await store.insertEvidence(
        evidence(
          node.id,
          "visual_comparison",
          { pass: false, outcome: "cannot_tell", option: "o", components: [] },
          i,
        ),
      );
      await store.insertDecision({
        id: id(),
        projectId: PROJECT,
        nodeId: node.id,
        kind: "council_decision",
        scope: { outcome: "cannot_resolve" },
        textVerbatim: WORST.repeat(3_000),
        byActor: "council",
        recordedAt: at(i),
      });
      await store.insertGateRequest({
        id: id(),
        projectId: PROJECT,
        nodeId: node.id,
        topicKey: `t:${i}`,
        kind: "council_question",
        owner: "council",
        blocking: true,
        payload: {},
        approvalUrl: null,
        status: "expired",
        decisionId: null,
        supersededBy: null,
        createdAt: at(i),
        answeredAt: null,
        lastNotifiedAt: null,
      });
    }
    const answer = await createContextReads(store).itemHistory(PROJECT, node.id, "qa");
    if (!answer) throw new Error("the item is missing");
    const data: ItemHistoryData = answer.data;
    expect(jsonBytes(answer)).toBeLessThanOrEqual(bound);
    expect(answer.truncated).toBe(true);
    expect(data.totals).toEqual({
      transitions: 40,
      runs: 40,
      evidence: 40,
      decisions: 40,
      gateRequests: 40,
    });
    // The item itself and its description always stay; the oldest entries go first, and each
    // list keeps at least its newest entry.
    expect(data.item.description?.endsWith(" [cut at 1500 characters]")).toBe(true);
    expect(data.transitions[0]?.failedGuards).toHaveLength(
      CONTEXT_LIMITS.history.failedGuards,
    );
    expect(data.transitions[0]?.at).toBe(at(39).toISOString());
    expect(data.decisions[0]?.recordedAt).toBe(at(39).toISOString());
    for (const list of [
      data.transitions,
      data.runs,
      data.evidence,
      data.decisions,
      data.gateRequests,
      data.item.acceptanceCriteria,
      data.item.pathsInScope,
    ]) {
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.length).toBeLessThanOrEqual(30);
    }
  });

  it("leaves a small answer whole and says nothing was left out", async () => {
    const store = createMemoryStore();
    const answer = await createContextReads(store).decisions(PROJECT, {
      words: ["none"],
    });
    const data: DecisionSearchData = answer.data;
    expect(answer).toEqual({
      notice: CONTEXT_DATA_NOTICE,
      data: { words: ["none"], scanned: 0, matched: 0, decisions: [] },
      truncated: false,
    });
    expect(data.decisions).toEqual([]);
  });
});
