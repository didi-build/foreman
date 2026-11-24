// Seam: API (docs/test-plan.md, ADR 0119 slice 3b, ADR 0102). The state API's three context routes
// over the memory store, through real HTTP on the loopback address: who may call them (Triage, QA,
// the Developer and the Designer; the Council and the planning chat get 403, anything else 401),
// the caller's project only (another project's item is not found), the query checks (400), what
// each answer holds, the notice first, the size bound, and a walk over every answer's keys and text
// proving nothing the routes must never return comes out. test/db/context-routes.test.ts runs the
// same routes on Postgres as the state API's role.
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeFlowStart } from "../src/adapters/windmill/fake-flow-start.ts";
import { hashToken } from "../src/api/auth.ts";
import { ENTRY_CONTRACTS } from "../src/api/entry.ts";
import { CONTEXT_ROLES, createApiHandler } from "../src/api/routes.ts";
import {
  CONTEXT_DATA_NOTICE,
  CONTEXT_LIMITS,
  type DecisionSearchData,
  type ItemHistoryData,
  type SimilarItemsData,
} from "../src/core/context-reads.ts";
import { createLibrary } from "../src/core/library.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import type { AgentRole, Store } from "../src/core/store.ts";
import { createLogger } from "../src/service-kit/logger.ts";
import { startService, type RunningService } from "../src/service-kit/server.ts";
import {
  at,
  FORBIDDEN_KEY,
  HEAD,
  idsOf,
  issueToken,
  keysOf,
  NEVER_SHOWN,
  nextId,
  OTHER_PROJECT,
  PROJECT,
  seedContextRoutes,
  type ContextSeed,
} from "./context-routes-fixture.ts";

const PLANNING_TOKEN = randomBytes(32).toString("base64url");
const NOW = new Date("2026-11-24T12:00:00Z");

let store: Store;
let service: RunningService;
let seed: ContextSeed;
/** Every answer's raw text, for the walk over keys and markers at the end. */
const answers: string[] = [];

interface Answer<D> {
  status: number;
  text: string;
  body: { notice?: string; data?: D; truncated?: boolean; error?: string };
}

/** A GET as a run sends it. Answers of this project's runs are kept for the walk at the end. */
async function get<D = unknown>(
  path: string,
  token: string | null,
  record = true,
): Promise<Answer<D>> {
  const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  if (response.status === 200 && record) answers.push(text);
  return { status: response.status, text, body: JSON.parse(text) as Answer<D>["body"] };
}

const decisionsPath = (q: string): string =>
  `/context/decisions?${new URLSearchParams({ q }).toString()}`;
const historyPath = (id: string): string => `/context/items/${id}/history`;

beforeAll(async () => {
  store = createMemoryStore();
  seed = await seedContextRoutes(store);
  const clock = { now: () => NOW };
  const library = createLibrary({
    store,
    contracts: ENTRY_CONTRACTS,
    guards: {},
    clock,
    ids: { next: nextId },
  });
  const logger = createLogger("context-routes-test", () => undefined);
  service = await startService({
    name: "context-routes-test",
    port: 0,
    logger,
    handle: createApiHandler({
      store,
      library,
      clock,
      planning: {
        tokenSha256: hashToken(PLANNING_TOKEN),
        ids: { next: nextId },
        store,
        approvalFlow: createFakeFlowStart(),
        logger,
      },
    }),
  });
});

afterAll(async () => {
  await service.stop();
});

describe("the context routes' callers (API seam, ADR 0102, ADR 0119 slice 3b)", () => {
  const routes = (): string[] => [
    decisionsPath("csv export"),
    "/context/similar-items?q=report",
    historyPath(seed.item.id),
  ];

  it("lets runs of Triage, QA, the Developer and the Designer read, each for its own project", async () => {
    expect(CONTEXT_ROLES).toEqual(["triage", "qa", "developer", "designer"]);
    for (const role of CONTEXT_ROLES) {
      const token = await issueToken(store, role);
      for (const path of routes()) {
        expect((await get(path, token)).status, `${role} ${path}`).toBe(200);
      }
    }
  });

  it("refuses a Council run token with 403, until its personas come (slice 6)", async () => {
    const token = await issueToken(store, "council");
    for (const path of routes()) {
      expect((await get(path, token)).status, path).toBe(403);
    }
  });

  it("refuses the planning chat's token with 403", async () => {
    for (const path of routes()) {
      expect((await get(path, PLANNING_TOKEN)).status, path).toBe(403);
    }
  });

  it.each([
    ["no token", null],
    ["a malformed token", "short"],
    ["an unknown token", "unknown-token-0000000000000000000000000000"],
  ])("refuses %s with 401", async (_label, token) => {
    for (const path of routes()) {
      expect((await get(path, token)).status, path).toBe(401);
    }
  });

  it.each([
    ["expired", { expiresAt: NOW }],
    ["revoked", { revoked: true }],
    ["for a run that has ended", { ended: true }],
  ])("refuses a token that is %s with 401", async (_label, options) => {
    const token = await issueToken(store, "developer", options);
    for (const path of routes()) {
      expect((await get(path, token)).status, path).toBe(401);
    }
  });

  it("answers 404 for another project's item, an unknown item and a malformed id", async () => {
    const token = await issueToken(store, "developer");
    for (const id of [seed.foreign.id, nextId(), "not-a-uuid"]) {
      const result = await get(historyPath(id), token);
      expect(result.status, id).toBe(404);
      expect(result.body).toEqual({ error: "node not found" });
    }
    // The other project's run sees its own item and nothing of this project's.
    const foreignToken = await issueToken(store, "developer", {
      projectId: OTHER_PROJECT,
    });
    expect((await get(historyPath(seed.foreign.id), foreignToken, false)).status).toBe(
      200,
    );
    expect((await get(historyPath(seed.item.id), foreignToken)).status).toBe(404);
  });

  it("has no context route for any other method or path", async () => {
    const token = await issueToken(store, "triage");
    for (const path of [
      "/context",
      "/context/decisions/x",
      "/context/items/x",
      "/context/history",
    ]) {
      expect((await get(path, token)).status, path).toBe(404);
    }
    const posted = await fetch(
      `http://127.0.0.1:${service.port}${decisionsPath("csv")}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      },
    );
    expect(posted.status).toBe(404);
  });
});

describe("the context routes' queries (API seam, ADR 0119 slice 3b)", () => {
  it.each([
    ["no q", "/context/decisions"],
    ["a q of 1 character", decisionsPath("a")],
    ["a blank q", decisionsPath("    ")],
    ["a q of 201 characters", decisionsPath("x".repeat(201))],
    ["9 words", decisionsPath("aa bb cc dd ee ff gg hh ii")],
    ["a word of 1 character", decisionsPath("csv a")],
    ["q twice", "/context/decisions?q=csv&q=export"],
    ["another parameter", "/context/decisions?q=csv&limit=50"],
  ])("refuses a decision search with %s with 400", async (_label, path) => {
    const token = await issueToken(store, "triage");
    const result = await get(path, token);
    expect(result.status, path).toBe(400);
    expect(typeof result.body.error).toBe("string");
  });

  it("takes a q of exactly 200 characters, or of 8 words of 2 characters", async () => {
    const token = await issueToken(store, "triage");
    expect((await get(decisionsPath("aa bb cc dd ee ff gg hh"), token)).status).toBe(
      200,
    );
    expect((await get(decisionsPath("y".repeat(200)), token)).status).toBe(200);
    // Characters, not UTF-16 units: 200 emoji are 200 characters.
    expect((await get(decisionsPath("\u{1F642}".repeat(200)), token)).status).toBe(200);
    expect((await get(decisionsPath("\u{1F642}".repeat(201)), token)).status).toBe(400);
  });

  it.each([
    ["neither q nor path", "/context/similar-items"],
    ["a blank q", "/context/similar-items?q=%20"],
    ["a q of 201 characters", `/context/similar-items?q=${"x".repeat(201)}`],
    ["q twice", "/context/similar-items?q=a&q=b"],
    [
      "11 paths",
      `/context/similar-items?${Array.from({ length: 11 }, (_, i) => `path=src/${i}`).join("&")}`,
    ],
    ["a path of 301 characters", `/context/similar-items?path=${"p".repeat(301)}`],
    ["a blank path", "/context/similar-items?q=report&path="],
    ["another parameter", "/context/similar-items?q=report&limit=9"],
  ])("refuses similar items with %s with 400", async (_label, path) => {
    const token = await issueToken(store, "developer");
    expect((await get(path, token)).status, path).toBe(400);
  });

  it("takes 10 paths of 300 characters, with no q", async () => {
    const token = await issueToken(store, "developer");
    const paths = Array.from(
      { length: 10 },
      (_, i) => `path=${String(i).padEnd(300, "p")}`,
    );
    expect((await get(`/context/similar-items?${paths.join("&")}`, token)).status).toBe(
      200,
    );
  });
});

describe("the decision search (API seam, D-468)", () => {
  it("finds the project's decisions holding every word, case-folded, active first, then newest", async () => {
    const token = await issueToken(store, "triage");
    const result = await get<DecisionSearchData>(decisionsPath("CSV Export"), token);
    expect(result.status).toBe(200);
    const data = result.body.data as DecisionSearchData;
    const d = seed.decisions;
    expect(data.words).toEqual(["csv", "export"]);
    expect(idsOf(data.decisions)).toEqual([
      d.unknownActor.id,
      d.direction.id,
      d.council.id,
      d.answer.id,
      d.approval.id,
      d.superseded.id,
    ]);
    expect(data.matched).toBe(6);
    expect(data.scanned).toBe(6);
    expect(result.body.truncated).toBe(false);
    // A word must be in the text: "spreadsheet" is only in the superseded one.
    const one = await get<DecisionSearchData>(decisionsPath("spreadsheet csv"), token);
    expect(idsOf((one.body.data as DecisionSearchData).decisions)).toEqual([
      d.superseded.id,
    ]);
    const none = await get<DecisionSearchData>(decisionsPath("csv nowhere"), token);
    expect(none.body.data).toEqual({
      words: ["csv", "nowhere"],
      scanned: 6,
      matched: 0,
      decisions: [],
    });
  });

  it("shapes each decision with fixed fields, a known gate kind and outcome, and never its scope", async () => {
    const token = await issueToken(store, "developer");
    const data = (await get<DecisionSearchData>(decisionsPath("csv export"), token))
      .body.data as DecisionSearchData;
    const byId = new Map(data.decisions.map((d) => [d.id, d]));
    const d = seed.decisions;
    expect(byId.get(d.approval.id)).toEqual({
      id: d.approval.id,
      kind: "approval",
      status: "active",
      replacedById: null,
      nodeId: seed.item.id,
      nodeTitle: "Export the report as CSV",
      recordedAt: at(10).toISOString(),
      by: "didi",
      gateKind: "visual_approval",
      outcome: "approved",
      text: "Approved: the CSV export keeps one header row.",
    });
    // An unknown gate kind and outcome are left out, not shown as given.
    expect(byId.get(d.answer.id)).not.toHaveProperty("gateKind");
    expect(byId.get(d.answer.id)).not.toHaveProperty("outcome");
    expect(byId.get(d.council.id)).toMatchObject({
      kind: "council_decision",
      by: "council",
      outcome: "resolve",
    });
    expect(byId.get(d.direction.id)).toMatchObject({
      nodeId: null,
      nodeTitle: null,
      by: "triage",
    });
    expect(byId.get(d.unknownActor.id)).toMatchObject({
      by: "other",
      nodeTitle: "Report exports",
    });
    expect(byId.get(d.superseded.id)).toMatchObject({
      status: "superseded",
      replacedById: d.direction.id,
      by: "planning",
    });
    for (const view of data.decisions) {
      expect(Object.keys(view).sort()).toEqual(
        [
          "id",
          "kind",
          "status",
          "replacedById",
          "nodeId",
          "nodeTitle",
          "recordedAt",
          "by",
          "text",
          ...("gateKind" in view ? ["gateKind"] : []),
          ...("outcome" in view ? ["outcome"] : []),
        ].sort(),
      );
    }
  });

  it("gives at most 10, says how many matched, and cuts each text at 1,500 characters", async () => {
    for (let i = 0; i < 12; i++) {
      await store.insertDecision({
        id: nextId(),
        projectId: PROJECT,
        nodeId: null,
        kind: "interview_answer",
        scope: {},
        textVerbatim: `longmatch ${i} ${"w".repeat(2_000)}`,
        byActor: "triage",
        recordedAt: at(100 + i),
      });
    }
    const token = await issueToken(store, "triage");
    const result = await get<DecisionSearchData>(decisionsPath("longmatch"), token);
    const data = result.body.data as DecisionSearchData;
    expect(data.matched).toBe(12);
    expect(data.decisions).toHaveLength(CONTEXT_LIMITS.decisions.results);
    expect(data.decisions[0]?.text.startsWith("longmatch 11 ")).toBe(true);
    expect(data.decisions[0]?.text.endsWith(" [cut at 1500 characters]")).toBe(true);
    expect(data.decisions[0]?.text).toHaveLength(
      1_500 + " [cut at 1500 characters]".length,
    );
    expect(result.body.truncated).toBe(true);
  });
});

describe("similar items (API seam, D-410)", () => {
  const SEARCH =
    "/context/similar-items?q=Export%20the%20report%20as%20CSV&path=src/report/export.ts&path=src/report/csv/";

  it("ranks the project's items by shared paths and words, leaving out the caller's own item", async () => {
    // The run is on `similar`, which would rank second: it is left out.
    const token = await issueToken(store, "developer", { nodeId: seed.similar.id });
    const result = await get<SimilarItemsData>(SEARCH, token);
    expect(result.status).toBe(200);
    const data = result.body.data as SimilarItemsData;
    // The item: 2 paths and 3 words. Then two items with one word each, the newest first.
    expect(data.items.map((i) => i.id)).toEqual([
      seed.item.id,
      seed.design.id,
      seed.idea.id,
    ]);
    expect(data.matched).toBe(3);
    expect(data.items[0]).toEqual({
      id: seed.item.id,
      type: "work_item",
      track: "code",
      title: "Export the report as CSV",
      state: "in_development",
      pathsInScope: ["src/report/export.ts", "src/report/csv/"],
      matchedPaths: ["src/report/export.ts", "src/report/csv/"],
      matchedWords: ["csv", "export", "report"],
      description: "The report page exports its rows as a CSV file.",
    });
    expect(data.items[2]).toMatchObject({
      type: "idea",
      track: null,
      pathsInScope: [],
      matchedPaths: [],
      matchedWords: ["report"],
      description: "People want to take the report away as a file.",
    });
    expect(result.body.truncated).toBe(false);
    // The same search from a run on another item ranks `similar` second, by its path and words.
    const other = await issueToken(store, "developer", { nodeId: seed.unrelated.id });
    const all = (await get<SimilarItemsData>(SEARCH, other)).body
      .data as SimilarItemsData;
    expect(all.items.map((i) => i.id)).toEqual([
      seed.item.id,
      seed.similar.id,
      seed.design.id,
      seed.idea.id,
    ]);
  });

  it("finds by paths alone, and the caller's item when the run is on another", async () => {
    const token = await issueToken(store, "designer", { nodeId: seed.design.id });
    const data = (
      await get<SimilarItemsData>("/context/similar-items?path=src/report", token)
    ).body.data as SimilarItemsData;
    expect(data.items.map((i) => i.id)).toEqual([seed.item.id, seed.similar.id]);
    expect(data.items[0]?.matchedPaths).toEqual([
      "src/report/export.ts",
      "src/report/csv/",
    ]);
  });

  it("gives at most 5 and says how many matched", async () => {
    for (let i = 0; i < 6; i++) {
      await store.insertNode({
        ...seed.unrelated,
        id: nextId(),
        title: `Quarterly ledger ${i}`,
        body: { pathsInScope: ["ledger/"] },
        updatedAt: at(200 + i),
      });
    }
    const token = await issueToken(store, "developer");
    const result = await get<SimilarItemsData>(
      "/context/similar-items?q=ledger",
      token,
    );
    const data = result.body.data as SimilarItemsData;
    expect(data.matched).toBe(6);
    expect(data.items.map((i) => i.title)).toEqual(
      [5, 4, 3, 2, 1].map((i) => `Quarterly ledger ${i}`),
    );
    expect(result.body.truncated).toBe(true);
  });
});

describe("an item's history (API seam, D-470, ADR 0112)", () => {
  it("gives the item's own fields, its applied moves, runs, evidence, decisions and gate requests, newest first", async () => {
    const token = await issueToken(store, "developer");
    const result = await get<ItemHistoryData>(historyPath(seed.item.id), token);
    expect(result.status).toBe(200);
    const data = result.body.data as ItemHistoryData;
    expect(data.item).toEqual({
      id: seed.item.id,
      type: "work_item",
      track: "code",
      title: "Export the report as CSV",
      state: "in_development",
      description: "The report page exports its rows as a CSV file.",
      acceptanceCriteria: ["A CSV file downloads", "The header row names each column"],
      pathsInScope: ["src/report/export.ts", "src/report/csv/"],
    });
    // Applied moves only, newest first; the failed guards by name only.
    expect(data.transitions).toEqual([
      {
        at: at(23).toISOString(),
        from: "in_qa_review",
        to: "in_development",
        trigger: "bot_report",
        actor: "runner",
        reason: "QA failed the head: the CSV misses quotes.",
        failedGuards: ["ci_green_on_head"],
      },
      {
        at: at(22).toISOString(),
        from: "in_development",
        to: "in_qa_review",
        trigger: "bot_report",
        actor: "runner",
        reason: null,
        failedGuards: [],
      },
      {
        at: at(21).toISOString(),
        from: "ready_for_dev",
        to: "in_development",
        trigger: "event",
        actor: "runner",
        reason: null,
        failedGuards: [],
      },
      {
        at: at(20).toISOString(),
        from: "triage",
        to: "ready_for_dev",
        trigger: "reconcile",
        actor: "runner",
        reason: null,
        failedGuards: [],
      },
    ]);
    expect(data.runs).toEqual([
      {
        role: "developer",
        taskType: "developer:code",
        startedAt: at(25).toISOString(),
        endedAt: null,
        outcome: null,
      },
      {
        role: "qa",
        taskType: "qa:review",
        startedAt: at(22).toISOString(),
        endedAt: at(23).toISOString(),
        outcome: "fail",
      },
      {
        role: "developer",
        taskType: "developer:code",
        startedAt: at(21).toISOString(),
        endedAt: at(22).toISOString(),
        outcome: "success",
      },
    ]);
    expect(data.evidence.map((e) => [e.kind, e.recordedBy, e.summary])).toEqual([
      ["staging_check", "runner", { pass: false }],
      ["staging_deploy_failed", "runner", { countsAsFailure: false }],
      ["merge_check", "runner", { mergeable: true }],
      ["qa_verdict", "qa", { verdict: "fail", findings: 1 }],
      ["docs_note", "developer", null],
      ["agent_report", "developer", null],
      ["ci_run", "github", { conclusion: "success", pr: 12 }],
      ["dispatch_record", "runner", null],
    ]);
    expect(data.evidence.find((e) => e.kind === "qa_verdict")).toEqual({
      kind: "qa_verdict",
      recordedAt: at(23).toISOString(),
      commitSha: HEAD,
      recordedBy: "qa",
      summary: { verdict: "fail", findings: 1 },
    });
    const d = seed.decisions;
    expect(idsOf(data.decisions)).toEqual([d.council.id, d.answer.id, d.approval.id]);
    expect(data.decisions[2]).toMatchObject({
      gateKind: "visual_approval",
      outcome: "approved",
      nodeTitle: "Export the report as CSV",
    });
    expect(data.gateRequests).toEqual([
      {
        kind: "escalation",
        status: "open",
        createdAt: at(24).toISOString(),
        answeredAt: null,
      },
      {
        kind: "visual_approval",
        status: "answered",
        createdAt: at(9).toISOString(),
        answeredAt: at(10).toISOString(),
      },
    ]);
    expect(data.totals).toEqual({
      transitions: 4,
      runs: 3,
      evidence: 8,
      decisions: 3,
      gateRequests: 2,
    });
    expect(result.body.truncated).toBe(false);
  });

  it("never shows a QA run the builder's report or docs note, not even that they exist (ADR 0112)", async () => {
    const token = await issueToken(store, "qa");
    const data = (await get<ItemHistoryData>(historyPath(seed.item.id), token)).body
      .data as ItemHistoryData;
    expect(data.evidence.map((e) => e.kind)).toEqual([
      "staging_check",
      "staging_deploy_failed",
      "merge_check",
      "qa_verdict",
      "ci_run",
      "dispatch_record",
    ]);
    expect(data.totals.evidence).toBe(6);
  });

  it("keeps each list to its limit, newest first, and says so", async () => {
    const busy = {
      ...seed.unrelated,
      id: nextId(),
      title: "A busy item",
      body: {
        acceptanceCriteria: Array.from({ length: 25 }, (_, i) => `criterion ${i}`),
        pathsInScope: Array.from({ length: 25 }, (_, i) => `src/busy/${i}.ts`),
      },
    };
    await store.insertNode(busy);
    for (let i = 0; i < 35; i++) {
      await store.insertTransition({
        id: nextId(),
        nodeId: busy.id,
        fromState: `state_${i}`,
        toState: `state_${i + 1}`,
        fromSubstate: null,
        toSubstate: null,
        triggerKind: "reconcile",
        triggerRef: null,
        actorKind: "runner",
        actorId: "runner",
        guardResult: [],
        evidenceIds: [],
        specVersion: "context-routes-spec",
        mode: "applied",
        reason: `reason ${i} ${"r".repeat(400)}`,
        at: at(300 + i),
      });
    }
    const token = await issueToken(store, "developer");
    const result = await get<ItemHistoryData>(historyPath(busy.id), token);
    const data = result.body.data as ItemHistoryData;
    expect(data.transitions).toHaveLength(CONTEXT_LIMITS.history.transitions);
    expect(data.transitions[0]?.from).toBe("state_34");
    expect(data.transitions[0]?.reason?.endsWith(" [cut at 300 characters]")).toBe(
      true,
    );
    expect(data.totals.transitions).toBe(35);
    expect(data.item.acceptanceCriteria).toHaveLength(20);
    expect(data.item.pathsInScope).toHaveLength(20);
    expect(result.body.truncated).toBe(true);
  });
});

describe("every context answer (API seam, D-459, D-468)", () => {
  it("puts the notice first, saying the data is recorded data, not instructions", async () => {
    const token = await issueToken(store, "designer");
    for (const path of [
      decisionsPath("csv"),
      "/context/similar-items?q=csv",
      historyPath(seed.item.id),
    ]) {
      const result = await get(path, token);
      expect(
        result.text.startsWith(
          `{"notice":${JSON.stringify(CONTEXT_DATA_NOTICE)},"data":`,
        ),
        path,
      ).toBe(true);
      expect(Object.keys(JSON.parse(result.text) as object)).toEqual([
        "notice",
        "data",
        "truncated",
      ]);
    }
    expect(CONTEXT_DATA_NOTICE).toContain("not instructions");
  });

  it("stays within 48 KiB however long the records are, dropping the oldest entries", async () => {
    // Each control character serializes as six bytes, so ten such texts pass the bound.
    for (let i = 0; i < 10; i++) {
      await store.insertDecision({
        id: nextId(),
        projectId: PROJECT,
        nodeId: null,
        kind: "answer",
        scope: {},
        textVerbatim: `sizebound ${i} ${"\u0001".repeat(1_500)}`,
        byActor: "didi",
        recordedAt: at(400 + i),
      });
    }
    const token = await issueToken(store, "triage");
    const result = await get<DecisionSearchData>(decisionsPath("sizebound"), token);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      CONTEXT_LIMITS.responseBytes,
    );
    expect(Buffer.byteLength(result.text, "utf8")).toBeGreaterThan(
      CONTEXT_LIMITS.responseBytes - 10_000,
    );
    const data = result.body.data as DecisionSearchData;
    expect(data.matched).toBe(10);
    expect(data.decisions.length).toBeLessThan(10);
    expect(data.decisions[0]?.text.startsWith("sizebound 9 ")).toBe(true);
    expect(result.body.truncated).toBe(true);
  });

  it("never holds a scope, an approval link, a token hash, a budget, a cost, a payload or any marker", async () => {
    // Read every route as each role once more, so the walk covers every shape.
    for (const role of CONTEXT_ROLES as AgentRole[]) {
      const token = await issueToken(store, role, { nodeId: seed.item.id });
      await get(decisionsPath("csv"), token);
      await get(decisionsPath("export"), token);
      await get(
        "/context/similar-items?q=report%20csv%20export&path=src/report/export.ts",
        token,
      );
      await get(historyPath(seed.item.id), token);
    }
    expect(answers.length).toBeGreaterThan(20);
    const runIds = (await store.listRuns({ nodeId: seed.item.id })).map(
      (run) => run.id,
    );
    for (const text of answers) {
      for (const key of keysOf(JSON.parse(text))) {
        expect(key, key).not.toMatch(FORBIDDEN_KEY);
      }
      for (const marker of Object.values(NEVER_SHOWN)) {
        expect(text, marker).not.toContain(marker);
      }
      // Run ids are not shown either: a run is its role, task type, times and outcome.
      for (const runId of runIds) expect(text).not.toContain(runId);
      expect(text).not.toContain(seed.foreign.id);
      expect(text).not.toContain(seed.decisions.foreign.id);
      expect(text).not.toMatch(
        /"(?:scope|approvalUrl|tokenHash|budget|costUsd|payload)"/,
      );
    }
  });
});
