// Seam: API (docs/test-plan.md, build plan M1.4). The state API over the in-memory store, through
// real HTTP: authentication, role allow-lists, project scoping and the QA verdict path (ADR 0102,
// ADR 0112). test/db/api.test.ts runs the same API against Postgres with the factory_api grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLibrary } from "../core/library.ts";
import { createMemoryStore } from "../core/memory-store.ts";
import { testRouteColumns } from "../core/routing-testing.ts";
import type { AgentRole, Node, Store } from "../core/store.ts";
import { createLogger } from "../service-kit/logger.ts";
import { startService, type RunningService } from "../service-kit/server.ts";
import { hashToken } from "./auth.ts";
import { ENTRY_CONTRACTS } from "./entry.ts";
import { createApiHandler } from "./routes.ts";

const NOW = new Date("2026-10-29T12:00:00Z");
const HEAD = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_PROJECT = "00000000-0000-4000-8000-0000000000a2";

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

interface Issued {
  token: string;
  runId: string;
}

let store: Store;
let service: RunningService;
let base: string;
let item: Node;
let otherItem: Node;
let foreignItem: Node;
let ciEvidence: string;
let oldCiEvidence: string;

async function project(id: string, slug: string) {
  await store.insertProject({
    id,
    slug,
    name: slug,
    repo: `didi-build/${slug}`,
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: NOW,
  });
}

async function node(projectId: string): Promise<Node> {
  const created: Node = {
    id: nextId(),
    projectId,
    type: "work_item",
    track: "code",
    state: "in_qa_review",
    substate: null,
    ownerRole: "qa",
    title: "An item",
    body: {},
    hold: false,
    agentReady: true,
    stale: false,
    blockedReason: null,
    stateSince: NOW,
    linearIssueId: null,
    linearStatusSynced: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.insertNode(created);
  return created;
}

/** Issues a run and its token, the way the runner will in M3.2. */
async function issue(
  role: AgentRole,
  options: {
    nodeId?: string | null;
    projectId?: string;
    headSha?: string | null;
    expiresAt?: Date;
    revoked?: boolean;
    ended?: boolean;
  } = {},
): Promise<Issued> {
  const runId = nextId();
  const token = `test-token-${runId.replaceAll("-", "")}`;
  await store.insertRun({
    id: runId,
    projectId: options.projectId ?? PROJECT,
    nodeId: options.nodeId === undefined ? null : options.nodeId,
    bot: role,
    agentId: null,
    runtime: "claude_code",
    model: "model-a",
    headSha: options.headSha ?? null,
    prNumber: null,
    botVersion: "v1",
    startedAt: NOW,
    endedAt: options.ended ? NOW : null,
    outcome: options.ended ? "success" : null,
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
    ...testRouteColumns(role),
  });
  await store.insertRunToken({
    tokenHash: hashToken(token),
    runId,
    role,
    projectId: options.projectId ?? PROJECT,
    expiresAt: options.expiresAt ?? new Date("2026-10-29T13:00:00Z"),
    revokedAt: options.revoked ? NOW : null,
  });
  return { token, runId };
}

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  store = createMemoryStore();
  const clock = { now: () => NOW };
  const library = createLibrary({
    store,
    contracts: ENTRY_CONTRACTS,
    guards: {},
    clock,
    ids: { next: nextId },
  });
  await project(PROJECT, "rehearsal");
  await project(OTHER_PROJECT, "elsewhere");
  item = await node(PROJECT);
  otherItem = await node(PROJECT);
  foreignItem = await node(OTHER_PROJECT);
  ciEvidence = nextId();
  oldCiEvidence = nextId();
  for (const [evidenceId, commitSha] of [
    [ciEvidence, HEAD],
    [oldCiEvidence, OTHER_COMMIT],
  ] as const) {
    await store.insertEvidence({
      id: evidenceId,
      nodeId: item.id,
      runId: null,
      kind: "ci_run",
      ref: "ci/1",
      commitSha,
      payload: { conclusion: "success" },
      recordedBy: "runner",
      recordedAt: NOW,
      supersedesId: null,
    });
  }
  service = await startService({
    name: "state-api-test",
    port: 0,
    logger: createLogger("state-api-test", () => undefined),
    handle: createApiHandler({ store, library, clock }),
  });
  base = `http://127.0.0.1:${service.port}`;
});

afterAll(async () => {
  await service.stop();
});

describe("state API authentication (API seam, ADR 0102)", () => {
  it("answers /health without a token", async () => {
    expect((await call("GET", "/health", null)).status).toBe(200);
  });

  it.each([
    ["no token", null],
    ["a malformed token", "short"],
    ["an unknown token", "unknown-token-0000000000000000000000000000"],
  ])("refuses %s with 401", async (_label, token) => {
    expect((await call("GET", `/nodes/${item.id}`, token)).status).toBe(401);
  });

  it.each([
    ["expired", { expiresAt: NOW }],
    ["revoked", { revoked: true }],
    ["for a run that has ended", { ended: true }],
  ])("refuses a token that is %s with 401", async (_label, options) => {
    const { token } = await issue("council", options);
    expect((await call("GET", `/nodes/${item.id}`, token)).status).toBe(401);
  });

  it("never echoes the token in an error", async () => {
    const token = "unknown-token-1111111111111111111111111111";
    const result = await call("GET", `/nodes/${item.id}`, token);
    expect(JSON.stringify(result.body)).not.toContain(token);
  });
});

describe("state API role allow-lists (API seam, ADR 0102)", () => {
  const routes: [string, string, AgentRole[]][] = [
    ["POST", "/ideas", ["council", "triage"]],
    ["POST", "/edges", ["council", "triage"]],
    ["POST", "/decisions", ["council", "triage"]],
    ["POST", "/qa-verdicts", ["qa"]],
    ["GET", "/attention", ["council", "triage"]],
  ];
  const everyone: AgentRole[] = ["developer", "designer", "qa", "council", "triage"];
  const forbidden = routes.flatMap(([method, path, allowed]) =>
    everyone
      .filter((role) => !allowed.includes(role))
      .map((role) => [method, path, role] as const),
  );

  it.each(forbidden)(
    "%s %s refuses the %s role with 403",
    async (method, path, role) => {
      const { token } = await issue(role);
      const result = await call(
        method,
        path,
        token,
        method === "POST" ? {} : undefined,
      );
      expect(result.status).toBe(403);
    },
  );

  it("has no route that changes a node's state (essential 1)", async () => {
    const { token } = await issue("council");
    for (const [method, path] of [
      ["POST", `/nodes/${item.id}/transition`],
      ["PATCH", `/nodes/${item.id}`],
      ["PUT", `/nodes/${item.id}`],
      ["POST", "/transitions"],
    ]) {
      expect((await call(method!, path!, token, { toState: "done" })).status).toBe(404);
    }
    expect((await store.getNode(item.id))?.state).toBe("in_qa_review");
  });
});

describe("state API calls (API seam, build plan M1.4)", () => {
  it("lets the Council submit an idea, which starts where the entry contract says", async () => {
    const { token } = await issue("council");
    const result = await call("POST", "/ideas", token, {
      title: "A new idea",
      body: { why: "x" },
    });
    expect(result.status).toBe(201);
    const created = result.body.node as Node;
    expect(created).toMatchObject({
      type: "idea",
      state: "submitted",
      projectId: PROJECT,
    });
  });

  it("lets Triage link two nodes in its project, and refuses a cycle", async () => {
    const { token } = await issue("triage");
    const ok = await call("POST", "/edges", token, {
      fromNode: item.id,
      toNode: otherItem.id,
      type: "blocks",
    });
    expect(ok.status).toBe(201);
    const cycle = await call("POST", "/edges", token, {
      fromNode: otherItem.id,
      toNode: item.id,
      type: "blocks",
    });
    expect(cycle.status).toBe(422);
  });

  it("returns 404 for a node in another project, so other projects stay invisible", async () => {
    const { token } = await issue("council");
    expect((await call("GET", `/nodes/${foreignItem.id}`, token)).status).toBe(404);
    expect(
      (
        await call("POST", "/edges", token, {
          fromNode: item.id,
          toNode: foreignItem.id,
          type: "blocks",
        })
      ).status,
    ).toBe(404);
  });

  it("lets a Developer report on its own node only, and records no commit from it", async () => {
    const { token } = await issue("developer", { nodeId: item.id });
    const ok = await call("POST", "/reports", token, {
      nodeId: item.id,
      kind: "agent_report",
      ref: "pr/12",
      payload: { done: true },
    });
    expect(ok.status).toBe(201);
    const saved = (
      await store.listEvidence({ nodeId: item.id, kind: "agent_report" })
    ).at(-1);
    expect(saved).toMatchObject({ commitSha: null, recordedBy: "developer" });
    const elsewhere = await call("POST", "/reports", token, {
      nodeId: otherItem.id,
      kind: "agent_report",
      ref: "pr/12",
    });
    expect(elsewhere.status).toBe(403);
  });

  it.each(["ci_run", "preview_check", "staging_check", "qa_verdict", "merge_commit"])(
    "refuses a Developer report of kind %s (essential 6)",
    async (kind) => {
      const { token } = await issue("developer", { nodeId: item.id });
      const result = await call("POST", "/reports", token, {
        nodeId: item.id,
        kind,
        ref: "x",
      });
      expect(result.status).toBe(400);
    },
  );

  it("refuses a docs note from QA, which writes only its verdict and agent reports (ADR 0112)", async () => {
    const { token } = await issue("qa", { nodeId: item.id, headSha: HEAD });
    const result = await call("POST", "/reports", token, {
      nodeId: item.id,
      kind: "docs_note",
      ref: "x",
    });
    expect(result.status).toBe(400);
  });

  it("records a decision verbatim, by the caller's role, and never an approval", async () => {
    const { token } = await issue("council");
    const text = "  Didi said: yes, ship the small version first.  ";
    const ok = await call("POST", "/decisions", token, {
      kind: "interview_answer",
      text,
    });
    expect(ok.status).toBe(201);
    const saved = await store.getDecision(ok.body.decisionId as string);
    expect(saved).toMatchObject({ textVerbatim: text, byActor: "council" });
    for (const kind of ["approval", "answer"]) {
      expect(
        (await call("POST", "/decisions", token, { kind, text: "yes" })).status,
      ).toBe(400);
    }
  });

  it("lists open blocking gate requests and blocked nodes for the caller's project", async () => {
    await store.insertGateRequest({
      id: nextId(),
      projectId: PROJECT,
      nodeId: null,
      topicKey: "spend:test",
      kind: "spend",
      owner: "didi",
      blocking: true,
      payload: {},
      approvalUrl: null,
      status: "open",
      decisionId: null,
      supersededBy: null,
      createdAt: NOW,
      answeredAt: null,
      lastNotifiedAt: null,
    });
    const { token } = await issue("triage");
    const result = await call("GET", "/attention", token);
    expect(result.status).toBe(200);
    expect((result.body.gateRequests as unknown[]).length).toBe(1);
  });

  it("refuses a malformed body with 400 and an oversized one with 413", async () => {
    const { token } = await issue("council");
    expect((await call("POST", "/ideas", token, "{not json")).status).toBe(400);
    expect(
      (await call("POST", "/ideas", token, { title: "x".repeat(70_000) })).status,
    ).toBe(413);
  });
});

describe("state API QA verdicts (API seam, ADR 0112)", () => {
  const verdict = (overrides: Record<string, unknown> = {}) => ({
    nodeId: item.id,
    verdict: "pass",
    evidenceIds: [ciEvidence],
    findings: [{ path: "src/a.ts", startLine: 3, endLine: 5, note: "Looks right" }],
    ...overrides,
  });

  it("stores the verdict against the run's head commit, once per run", async () => {
    const { token } = await issue("qa", { nodeId: item.id, headSha: HEAD });
    const ok = await call("POST", "/qa-verdicts", token, verdict());
    expect(ok.status).toBe(201);
    expect(ok.body.commitSha).toBe(HEAD);
    const saved = (
      await store.listEvidence({ nodeId: item.id, kind: "qa_verdict" })
    ).at(-1);
    expect(saved?.commitSha).toBe(HEAD);
    expect((await call("POST", "/qa-verdicts", token, verdict())).status).toBe(409);
  });

  it("rejects a commit that differs from the run's head commit", async () => {
    const { token } = await issue("qa", { nodeId: item.id, headSha: HEAD });
    const result = await call(
      "POST",
      "/qa-verdicts",
      token,
      verdict({ commitSha: OTHER_COMMIT }),
    );
    expect(result.status).toBe(422);
  });

  it.each([
    ["evidence for an older commit", () => [oldCiEvidence]],
    ["an id that is not evidence", () => ["00000000-0000-4000-8000-00000000ffff"]],
    ["no evidence at all for a pass", () => []],
  ])("rejects a pass citing %s", async (_label, cited) => {
    const { token } = await issue("qa", { nodeId: item.id, headSha: HEAD });
    const result = await call(
      "POST",
      "/qa-verdicts",
      token,
      verdict({ evidenceIds: cited() }),
    );
    expect(result.status).toBe(422);
  });

  it("rejects a verdict on a node the run was not dispatched for", async () => {
    const { token } = await issue("qa", { nodeId: otherItem.id, headSha: HEAD });
    expect((await call("POST", "/qa-verdicts", token, verdict())).status).toBe(403);
  });

  it("rejects findings without a valid line range", async () => {
    const { token } = await issue("qa", { nodeId: item.id, headSha: HEAD });
    const result = await call(
      "POST",
      "/qa-verdicts",
      token,
      verdict({
        findings: [{ path: "src/a.ts", startLine: 5, endLine: 2, note: "x" }],
      }),
    );
    expect(result.status).toBe(400);
  });
});
