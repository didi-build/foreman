// Seam: API (docs/test-plan.md, D-271). The state API's public listener, the one the Cloudflare
// Tunnel forwards the planning chat's `/plans` to, over the in-memory store through real HTTP on
// the loopback address: it serves `POST /plans` and nothing else, refuses a declared body over the
// size limit and requests past the rate limit before the API reads them, and otherwise behaves
// exactly as `POST /plans` on the internal port. The token is generated per test run and never
// asserted on or logged.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakePlanApprovalFlow } from "../adapters/windmill/fake-plan-approval-flow.ts";
import { createLibrary } from "../core/library.ts";
import { createMemoryStore } from "../core/memory-store.ts";
import type { Store } from "../core/store.ts";
import { createLogger } from "../service-kit/logger.ts";
import { startService, type RunningService } from "../service-kit/server.ts";
import { hashToken } from "./auth.ts";
import { ENTRY_CONTRACTS } from "./entry.ts";
import { createPublicHandler, PUBLIC_LIMITS } from "./public.ts";
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
const approvalFlow = createFakePlanApprovalFlow();

const submission = {
  projectSlug: "rehearsal",
  title: "Settings page",
  plan: "Plan: a settings page.",
  productDirection: "Settings stay on one page.",
  answers: [],
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

  it("serves POST /plans exactly as the internal port does, and starts the flow", async () => {
    nowMs += 120_000;
    const result = await send(
      "POST",
      "/plans",
      planningToken,
      JSON.stringify(submission),
    );
    expect(result.status).toBe(201);
    expect(approvalFlow.started).toEqual([result.body.ideaId]);
    // The planning token's own checks still apply behind the listener.
    expect(
      (await send("POST", "/plans", null, JSON.stringify(submission))).status,
    ).toBe(401);
  });

  it("serves no other route, whatever the token, so nothing else is reachable through the tunnel", async () => {
    nowMs += 120_000;
    const before = await ideaCount();
    for (const [method, path] of [
      ["GET", "/plans"],
      ["PUT", "/plans"],
      ["GET", "/planning/projects/rehearsal/submissions"],
      ["POST", "/ideas"],
      ["POST", "/decisions"],
      ["GET", "/attention"],
      ["GET", `/nodes/${PROJECT}`],
      ["POST", "/plans/extra"],
    ] as const) {
      const body = method === "GET" ? undefined : JSON.stringify(submission);
      expect((await send(method, path, planningToken, body)).status, path).toBe(404);
    }
    expect(await ideaCount()).toBe(before);
  });

  it("refuses a declared body over the size limit with 413, before the API reads it", async () => {
    nowMs += 120_000;
    const before = await ideaCount();
    const big = JSON.stringify({
      ...submission,
      plan: "p".repeat(LIMITS.maxBodyBytes),
    });
    const result = await send("POST", "/plans", planningToken, big);
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
        (await send("POST", "/plans", wrong, JSON.stringify(submission))).status,
      ).toBe(401);
    }
    nowMs += 15_000;
    const limited = await send(
      "POST",
      "/plans",
      planningToken,
      JSON.stringify(submission),
    );
    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBe("45");
    expect(await ideaCount()).toBe(before);
    // A new window lets the planning chat in again.
    nowMs += 45_000;
    expect(
      (await send("POST", "/plans", planningToken, JSON.stringify(submission))).status,
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
