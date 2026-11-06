// Seam: API (docs/test-plan.md, D-271, D-282, D-343). The state API's public listener, the one the
// Cloudflare Tunnel forwards the planning chat's paths to, over the in-memory store through real
// HTTP on the loopback address: it serves the planning chat's routes under `/api`
// (`POST /api/plans` and the three planning reads) and nothing else, not even the same routes
// without the prefix, refuses a declared body over the size limit and requests past the rate limit
// before the API reads them, and otherwise behaves exactly as those routes on the internal port.
// The token is generated per test run and never asserted on or logged.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeFlowStart } from "../adapters/windmill/fake-flow-start.ts";
import { createLibrary } from "../core/library.ts";
import { createMemoryStore } from "../core/memory-store.ts";
import type { Store } from "../core/store.ts";
import { createLogger } from "../service-kit/logger.ts";
import { startService, type RunningService } from "../service-kit/server.ts";
import { hashToken } from "./auth.ts";
import { ENTRY_CONTRACTS } from "./entry.ts";
import { createPublicHandler, PUBLIC_API_PREFIX, PUBLIC_LIMITS } from "./public.ts";
import { createApiHandler, MAX_BODY_BYTES } from "./routes.ts";

const START = new Date("2026-11-03T12:00:00Z").getTime();
const PROJECT = "00000000-0000-4000-8000-0000000000d1";
const LIMITS = { maxBodyBytes: 2048, requestsPerWindow: 3, windowSeconds: 60 };

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const planningToken = randomBytes(32).toString("base64url");
const logLines: string[] = [];
let nowMs = START;
let store: Store;
let service: RunningService;
const approvalFlow = createFakeFlowStart();

const submission = {
  projectSlug: "rehearsal",
  title: "Settings page",
  plan: "Plan: a settings page.",
  productDirection: "Settings stay on one page.",
  answers: [],
  needsDidi: { needed: "yes", reason: "A settings page is a new feature." },
};

async function send(
  method: string,
  path: string,
  token: string | null,
  body?: string,
): Promise<{
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | null;
}> {
  const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    retryAfter: response.headers.get("retry-after"),
  };
}

const ideaCount = async () => (await store.listNodes({})).length;

beforeAll(async () => {
  store = createMemoryStore();
  // A live runner, so a submission starts the plan-approval flow (D-333).
  for (const [key, value] of [
    ["kill_switch", false],
    ["dry_run", false],
  ] as const) {
    await store.setSetting({
      key,
      value,
      updatedBy: "test",
      updatedAt: new Date(nowMs),
    });
  }
  const clock = { now: () => new Date(nowMs) };
  const ids = { next: nextId };
  const library = createLibrary({
    store,
    contracts: ENTRY_CONTRACTS,
    guards: {},
    clock,
    ids,
  });
  await store.insertProject({
    id: PROJECT,
    slug: "rehearsal",
    name: "rehearsal",
    repo: "didi-build/rehearsal",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: new Date(START),
  });
  const logger = createLogger("state-api-public-test", (line) => logLines.push(line));
  const api = createApiHandler({
    store,
    library,
    clock,
    planning: {
      tokenSha256: hashToken(planningToken),
      ids,
      store,
      approvalFlow,
      logger,
    },
  });
  service = await startService({
    name: "state-api-public-test",
    port: 0,
    logger,
    handle: createPublicHandler({ api, clock, logger, limits: LIMITS }),
  });
});

afterAll(async () => {
  await service.stop();
});

describe("the public listener (API seam, D-271)", () => {
  it("defaults to the API's own body cap and 20 requests a minute", () => {
    expect(PUBLIC_LIMITS).toEqual({
      maxBodyBytes: MAX_BODY_BYTES,
      requestsPerWindow: 20,
      windowSeconds: 60,
    });
  });

  it("puts every path it serves under /api (D-343)", () => {
    expect(PUBLIC_API_PREFIX).toBe("/api");
  });

  it("serves POST /api/plans exactly as the internal port serves POST /plans, and starts the flow", async () => {
    nowMs += 120_000;
    const result = await send(
      "POST",
      "/api/plans",
      planningToken,
      JSON.stringify(submission),
    );
    expect(result.status).toBe(201);
    expect(approvalFlow.started).toEqual([result.body.ideaId]);
    // The planning token's own checks still apply behind the listener.
    expect(
      (await send("POST", "/api/plans", null, JSON.stringify(submission))).status,
    ).toBe(401);
  });

  it("serves the three planning reads under /api exactly as the internal port does (D-282, D-343)", async () => {
    nowMs += 120_000;
    for (const read of ["submissions", "feedback", "accepted"]) {
      // A fresh window per read: the test's limit is 3 requests a minute.
      nowMs += 120_000;
      const path = `/api/planning/projects/rehearsal/${read}`;
      const result = await send("GET", path, planningToken);
      expect(result.status, path).toBe(200);
      expect(result.body.read, path).toBe(read);
      expect(result.body.project, path).toBe("rehearsal");
      // The planning token's own checks still apply behind the listener.
      expect((await send("GET", path, null)).status, path).toBe(401);
    }
    nowMs += 120_000;
    expect(
      (await send("GET", "/api/planning/projects/unknown/submissions", planningToken))
        .status,
    ).toBe(404);
    // The API's own slug rule still applies behind the listener.
    nowMs += 120_000;
    expect(
      (await send("GET", "/api/planning/projects/Rehearsal/submissions", planningToken))
        .status,
    ).toBe(404);
  });

  it("serves no other route, whatever the token, so nothing else is reachable through the tunnel", async () => {
    nowMs += 120_000;
    const before = await ideaCount();
    for (const [method, path] of [
      ["GET", "/api/plans"],
      ["PUT", "/api/plans"],
      ["POST", "/api/planning/projects/rehearsal/submissions"],
      ["PUT", "/api/planning/projects/rehearsal/feedback"],
      ["GET", "/api/planning/projects/rehearsal/runs"],
      ["GET", "/api/planning/projects/rehearsal/submissions/extra"],
      ["POST", "/api/ideas"],
      ["POST", "/api/decisions"],
      ["GET", "/api/attention"],
      ["GET", `/api/nodes/${PROJECT}`],
      ["GET", "/api/health"],
      ["POST", "/api/plans/extra"],
      ["POST", "/api/plans/"],
      ["POST", "/api//plans"],
      ["POST", "/api"],
      ["POST", "/API/plans"],
      ["POST", "/apiplans"],
      ["POST", "/api/api/plans"],
      ["POST", "/x/api/plans"],
      ["POST", "/ideas"],
      ["POST", "/decisions"],
      ["GET", "/attention"],
      ["GET", `/nodes/${PROJECT}`],
    ] as const) {
      const body = method === "GET" ? undefined : JSON.stringify(submission);
      expect((await send(method, path, planningToken, body)).status, path).toBe(404);
    }
    expect(await ideaCount()).toBe(before);
  });

  it("refuses the routes without the /api prefix with 404, as any unknown path (D-343)", async () => {
    nowMs += 120_000;
    const before = await ideaCount();
    for (const [method, path] of [
      ["POST", "/plans"],
      ["GET", "/planning/projects/rehearsal/submissions"],
      ["GET", "/planning/projects/rehearsal/feedback"],
      ["GET", "/planning/projects/rehearsal/accepted"],
    ] as const) {
      const body = method === "GET" ? undefined : JSON.stringify(submission);
      const result = await send(method, path, planningToken, body);
      expect(result.status, path).toBe(404);
      expect(result.body, path).toEqual({ error: "not found" });
    }
    expect(await ideaCount()).toBe(before);
    expect(approvalFlow.started).toHaveLength(1);
  });

  it("does not count an unknown path, the old ones included, toward the rate limit", async () => {
    nowMs += 120_000;
    for (let i = 0; i < LIMITS.requestsPerWindow + 2; i++) {
      expect((await send("POST", "/plans", planningToken, "{}")).status).toBe(404);
    }
    expect((await send("POST", "/api/plans", null, "{}")).status).toBe(401);
  });

  it("refuses a declared body over the size limit with 413, before the API reads it", async () => {
    nowMs += 120_000;
    const before = await ideaCount();
    const big = JSON.stringify({
      ...submission,
      plan: "p".repeat(LIMITS.maxBodyBytes),
    });
    const result = await send("POST", "/api/plans", planningToken, big);
    expect(result.status).toBe(413);
    expect(await ideaCount()).toBe(before);
    expect(approvalFlow.started).toHaveLength(1);
  });

  it("refuses requests past the rate limit with 429 and a wait, counting refused tokens too", async () => {
    nowMs += 120_000;
    const before = await ideaCount();
    const wrong = randomBytes(32).toString("base64url");
    for (let i = 0; i < LIMITS.requestsPerWindow; i++) {
      expect(
        (await send("POST", "/api/plans", wrong, JSON.stringify(submission))).status,
      ).toBe(401);
    }
    nowMs += 15_000;
    const limited = await send(
      "POST",
      "/api/plans",
      planningToken,
      JSON.stringify(submission),
    );
    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBe("45");
    expect(await ideaCount()).toBe(before);
    // A new window lets the planning chat in again.
    nowMs += 45_000;
    expect(
      (await send("POST", "/api/plans", planningToken, JSON.stringify(submission)))
        .status,
    ).toBe(201);
  });

  it("logs only the reason for a refusal: no token, path, body or id", async () => {
    const text = logLines.join("\n");
    const refusals = logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.message === "public request refused");
    expect(refusals.map((l) => l.reason).sort()).toEqual(["rate_limited", "too_large"]);
    for (const line of refusals) {
      expect(Object.keys(line).sort()).toEqual(
        ["level", "message", "reason", "service", "time"].sort(),
      );
    }
    expect(text).not.toContain(planningToken);
    expect(text).not.toContain(hashToken(planningToken));
    expect(text).not.toContain(submission.plan);
    for (const ideaId of approvalFlow.started) expect(text).not.toContain(ideaId);
  });
});
