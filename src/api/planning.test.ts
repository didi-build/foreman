// Seam: API (docs/test-plan.md, D-266). The planning chat's identity on the state API over the
// in-memory store, through real HTTP on the loopback address: it can submit a plan with
// `POST /plans` and nothing else; every other route refuses it; no run token can submit a plan;
// a submission is checked strictly and recorded once, verbatim, and never moves the idea or
// records `plan_accepted`. The token is generated per test run and never asserted on or logged.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLibrary } from "../core/library.ts";
import { createMemoryStore } from "../core/memory-store.ts";
import { PLAN_LIMITS, PLAN_SUBMISSION_KIND } from "../core/plans.ts";
import { testRouteColumns } from "../core/routing-testing.ts";
import type { AgentRole, Node, Store } from "../core/store.ts";
import { createLogger } from "../service-kit/logger.ts";
import { startService, type RunningService } from "../service-kit/server.ts";
import { hashToken } from "./auth.ts";
import { ENTRY_CONTRACTS } from "./entry.ts";
import { createApiHandler } from "./routes.ts";

const NOW = new Date("2026-11-03T12:00:00Z");
const PROJECT = "00000000-0000-4000-8000-0000000000b1";
const OTHER_PROJECT = "00000000-0000-4000-8000-0000000000b2";
/** An idea already past planning, in Triage. */
const ITEM = "00000000-0000-4000-8000-0000000000c1";

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const planningToken = randomBytes(32).toString("base64url");
let store: Store;
let withPlanning: RunningService;
let withoutPlanning: RunningService;
let item: Node;

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

async function idea(projectId: string, state: string, id = nextId()): Promise<Node> {
  const created: Node = {
    id,
    projectId,
    type: "idea",
    track: null,
    state,
    substate: null,
    ownerRole: "runner",
    title: "An idea",
    body: {},
    hold: false,
    agentReady: false,
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

/** A run and its token for an agent role, the way the runner issues them. */
async function runToken(role: AgentRole): Promise<string> {
  const runId = nextId();
  const token = randomBytes(32).toString("base64url");
  await store.insertRun({
    id: runId,
    projectId: PROJECT,
    nodeId: null,
    bot: role,
    agentId: null,
    runtime: "claude_code",
    model: "model-a",
    headSha: null,
    prNumber: null,
    botVersion: "v1",
    startedAt: NOW,
    endedAt: null,
    outcome: null,
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
    projectId: PROJECT,
    expiresAt: new Date("2026-11-03T13:00:00Z"),
    revokedAt: null,
  });
  return token;
}

async function call(
  service: RunningService,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const PLAN = "Plan: a settings page.\n1. Design it.\n2. Wire it in.";
const submission = (extra: Record<string, unknown> = {}) => ({
  projectSlug: "rehearsal",
  title: "Settings page",
  plan: PLAN,
  productDirection: "Settings stay on one page.",
  answers: [{ question: "One page or two?", answer: "One page,\nplease." }],
  ...extra,
});

/** Everything a submission could write, to compare before and after a refusal. */
async function footprint(): Promise<string> {
  const nodes = await store.listNodes({});
  return JSON.stringify({
    nodes,
    evidence: await Promise.all(nodes.map((x) => store.listEvidence({ nodeId: x.id }))),
    decisions: await Promise.all(nodes.map((x) => store.listDecisionsForNode(x.id))),
    gates: [
      ...(await store.listOpenGateRequests(PROJECT)),
      ...(await store.listOpenGateRequests(OTHER_PROJECT)),
    ],
  });
}

beforeAll(async () => {
  store = createMemoryStore();
  const clock = { now: () => NOW };
  const ids = { next: nextId };
  const library = createLibrary({
    store,
    contracts: ENTRY_CONTRACTS,
    guards: {},
    clock,
    ids,
  });
  await project(PROJECT, "rehearsal");
  await project(OTHER_PROJECT, "elsewhere");
  item = await idea(PROJECT, "triage", ITEM);
  const start = (planning: boolean) =>
    startService({
      name: "state-api-planning-test",
      port: 0,
      logger: createLogger("state-api-planning-test", () => undefined),
      handle: createApiHandler({
        store,
        library,
        clock,
        ...(planning
          ? { planning: { tokenSha256: hashToken(planningToken), ids, store } }
          : {}),
      }),
    });
  withPlanning = await start(true);
  withoutPlanning = await start(false);
});

afterAll(async () => {
  await withPlanning.stop();
  await withoutPlanning.stop();
});

describe("the planning chat's identity can only submit a plan (API seam, D-266)", () => {
  // Every route the state API serves to agents (src/api/routes.ts), with a body each would
  // accept from its own role, so a refusal is the identity's and not the body's.
  const otherRoutes: [string, string, unknown][] = [
    ["POST", "/ideas", { title: "Another idea" }],
    ["POST", "/edges", { fromNode: ITEM, toNode: ITEM, type: "blocks" }],
    ["POST", "/reports", { nodeId: ITEM, kind: "agent_report", ref: "r", payload: {} }],
    ["POST", "/qa-verdicts", { nodeId: ITEM, verdict: "fail" }],
    [
      "POST",
      "/decisions",
      { nodeId: ITEM, kind: "product_direction", text: "A direction." },
    ],
    ["GET", `/nodes/${ITEM}`, undefined],
    ["GET", "/attention", undefined],
  ];

  it.each(otherRoutes)(
    "%s %s refuses the planning chat with 403 and writes nothing",
    async (method, path, body) => {
      const before = await footprint();
      const result = await call(withPlanning, method, path, planningToken, body);
      expect(result.status).toBe(403);
      expect(await footprint()).toBe(before);
    },
  );

  it("cannot reach a route that is not served", async () => {
    for (const [method, path] of [
      ["GET", "/plans"],
      ["POST", `/nodes/${item.id}/transition`],
      ["POST", "/transitions"],
    ] as const) {
      expect(
        (
          await call(
            withPlanning,
            method,
            path,
            planningToken,
            method === "GET" ? undefined : {},
          )
        ).status,
      ).toBe(404);
    }
  });

  it.each(["developer", "designer", "qa", "council", "triage"] as const)(
    "refuses a %s run token on POST /plans with 403",
    async (role) => {
      const before = await footprint();
      const token = await runToken(role);
      expect(
        (await call(withPlanning, "POST", "/plans", token, submission())).status,
      ).toBe(403);
      expect(await footprint()).toBe(before);
    },
  );

  it("refuses no token, another token, and any token when no planning hash is set, with 401", async () => {
    const before = await footprint();
    expect(
      (await call(withPlanning, "POST", "/plans", null, submission())).status,
    ).toBe(401);
    const other = randomBytes(32).toString("base64url");
    expect(
      (await call(withPlanning, "POST", "/plans", other, submission())).status,
    ).toBe(401);
    expect(
      (await call(withoutPlanning, "POST", "/plans", planningToken, submission()))
        .status,
    ).toBe(401);
    expect(await footprint()).toBe(before);
  });
});

describe("a plan submission (API seam, D-266)", () => {
  it("records a new idea in Submitted with the plan, the direction and Didi's answers verbatim", async () => {
    const result = await call(
      withPlanning,
      "POST",
      "/plans",
      planningToken,
      submission(),
    );
    expect(result.status).toBe(201);
    expect(result.body.created).toBe(true);
    const ideaId = result.body.ideaId as string;
    const created = await store.getNode(ideaId);
    expect(created).toMatchObject({
      projectId: PROJECT,
      type: "idea",
      state: "submitted",
      ownerRole: "runner",
      title: "Settings page",
    });
    // No move, no gate request, no plan_accepted: only the runner does those (D-230).
    expect(await store.listTransitions(ideaId)).toEqual([]);
    expect(await store.listOpenGateRequests(PROJECT)).toEqual([]);
    const decisions = await store.listDecisionsForNode(ideaId);
    expect(decisions.map((d) => [d.kind, d.byActor, d.textVerbatim])).toEqual([
      ["product_direction", "planning", "Settings stay on one page."],
      ["interview_answer", "planning", "One page,\nplease."],
    ]);
    expect(decisions.some((d) => d.kind === "council_decision")).toBe(false);
    const reports = await store.listEvidence({ nodeId: ideaId, kind: "agent_report" });
    expect(reports).toMatchObject([
      {
        runId: null,
        recordedBy: "planning",
        commitSha: null,
        payload: {
          kind: PLAN_SUBMISSION_KIND,
          plan: PLAN,
          productDirection: "Settings stay on one page.",
          answers: [{ question: "One page or two?", answer: "One page,\nplease." }],
        },
      },
    ]);
  });

  it("records a resubmission on an idea in Council planning, and refuses an idea past it", async () => {
    const planning = await idea(PROJECT, "council_planning");
    const again = await call(
      withPlanning,
      "POST",
      "/plans",
      planningToken,
      submission({ ideaId: planning.id, plan: "Plan, second version." }),
    );
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ ideaId: planning.id, created: false });
    expect((await store.getNode(planning.id))?.state).toBe("council_planning");

    const before = await footprint();
    expect(
      (
        await call(
          withPlanning,
          "POST",
          "/plans",
          planningToken,
          submission({ ideaId: item.id }),
        )
      ).status,
    ).toBe(409);
    const foreign = await idea(OTHER_PROJECT, "submitted");
    const afterForeign = await footprint();
    expect(
      (
        await call(
          withPlanning,
          "POST",
          "/plans",
          planningToken,
          submission({ ideaId: foreign.id }),
        )
      ).status,
    ).toBe(404);
    expect(await footprint()).toBe(afterForeign);
    expect(before).not.toBe(afterForeign);
  });

  it.each([
    ["an unknown project", { projectSlug: "nowhere" }, 404],
    ["an unknown field", { secretToken: "x" }, 400],
    ["a blank plan", { plan: "  " }, 400],
    ["a plan over its bound", { plan: "p".repeat(PLAN_LIMITS.planChars + 1) }, 400],
    ["a title on two lines", { title: "Settings\npage" }, 400],
    ["no product direction", { productDirection: undefined }, 400],
    [
      "too many answers",
      { answers: Array(PLAN_LIMITS.answers + 1).fill({ question: "q", answer: "a" }) },
      400,
    ],
    [
      "an answer with an extra field",
      { answers: [{ question: "q", answer: "a", by: "x" }] },
      400,
    ],
    ["a malformed idea id", { ideaId: "not-an-id" }, 400],
  ] as const)("refuses %s and writes nothing", async (_label, change, status) => {
    const before = await footprint();
    const body = submission(change as Record<string, unknown>);
    const result = await call(withPlanning, "POST", "/plans", planningToken, body);
    expect(result.status).toBe(status);
    expect(JSON.stringify(result.body)).not.toContain(planningToken);
    expect(await footprint()).toBe(before);
  });
});
