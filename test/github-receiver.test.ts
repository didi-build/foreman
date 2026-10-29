// Seam: the GitHub webhook receiver over real HTTP, in process (build plan M2.3, ADR 0113
// sections 2 and 8). Signed fake deliveries against the memory store and the fake GitHub: the
// size cap and signature come before parsing, a bad request stores nothing, a replay records
// nothing new, and logs carry only ids, event, repository, PR number and outcome.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkCompletedEvent, pullRequestEvent } from "../src/adapters/github/fake.ts";
import {
  MAX_BODY_BYTES,
  WEBHOOK_PATH,
  createReceiverHandler,
} from "../src/github-receiver/handler.ts";
import { createLogger } from "../src/service-kit/logger.ts";
import { startService, type RunningService } from "../src/service-kit/server.ts";
import {
  BRANCH,
  DEVELOPER_APP,
  PR,
  REPO,
  SHA_A,
  createIngestFixture,
  passing,
  type IngestFixture,
} from "./github-fixture.ts";

let f: IngestFixture;
let service: RunningService;
let url: string;
const logs: Record<string, unknown>[] = [];

beforeAll(async () => {
  f = await createIngestFixture();
  const logger = createLogger("github-receiver", (line) => logs.push(JSON.parse(line)));
  const { store, clock, ids, appLogins } = f.deps;
  service = await startService({
    name: "github-receiver",
    port: 0,
    logger,
    handle: createReceiverHandler({
      github: f.github,
      ingest: { store, clock, ids, appLogins },
      logger,
    }),
  });
  url = `http://127.0.0.1:${service.port}${WEBHOOK_PATH}`;
});

afterAll(() => service.stop());

interface Send {
  event?: string;
  delivery?: string;
  body: string;
  signature?: string | null;
}

async function send({ event = "pull_request", delivery, body, signature }: Send) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
  };
  if (delivery !== undefined) headers["x-github-delivery"] = delivery;
  const sig = signature === undefined ? f.github.sign(body) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  const response = await fetch(url, { method: "POST", headers, body });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const openedBody = async () => JSON.stringify(pullRequestEvent("opened", await f.pr()));

describe("GitHub receiver over HTTP (in-process end to end, ADR 0113)", () => {
  it("rejects a delivery with no signature: 401, nothing parsed, read or stored", async () => {
    const body = await openedBody();
    const reads = f.github.reads;
    const result = await send({ delivery: "no-sig", body, signature: null });
    expect(result.status).toBe(401);
    expect(await f.store.getGithubDelivery("no-sig")).toBeNull();
    expect(await f.evidence()).toHaveLength(0);
    expect(f.github.reads).toBe(reads);
  });

  it("rejects a delivery with a wrong signature, or one signed over other bytes", async () => {
    const body = await openedBody();
    const reads = f.github.reads;
    for (const signature of [`sha256=${"0".repeat(64)}`, f.github.sign(`${body} `)]) {
      const result = await send({ delivery: "bad-sig", body, signature });
      expect(result.status).toBe(401);
    }
    expect(f.github.reads).toBe(reads);
    expect(await f.store.getGithubDelivery("bad-sig")).toBeNull();
    expect(await f.evidence()).toHaveLength(0);
  });

  it("refuses a body over 1 MB unread", async () => {
    const body = JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) });
    const result = await send({ delivery: "too-big", body });
    expect(result.status).toBe(413);
    expect(await f.store.getGithubDelivery("too-big")).toBeNull();
  });

  it("refuses a signed delivery without a delivery id", async () => {
    expect((await send({ body: await openedBody() })).status).toBe(400);
  });

  it("accepts a signed delivery, records its evidence, and records a replay once", async () => {
    const body = await openedBody();
    const first = await send({ delivery: "delivery-1", body });
    expect(first).toEqual({ status: 202, body: { outcome: "recorded" } });
    const replay = await send({ delivery: "delivery-1", body });
    expect(replay).toEqual({ status: 202, body: { outcome: "duplicate" } });
    const rows = await f.evidence("ci_run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commitSha: SHA_A,
      payload: { conclusion: "pending" },
    });
    expect((await f.store.getGithubDelivery("delivery-1"))?.outcome).toBe("recorded");
  });

  it("records the final result from a check suite completion", async () => {
    f.github.setCheckRuns(REPO, SHA_A, passing("build"));
    const body = JSON.stringify(checkCompletedEvent("check_suite", REPO, SHA_A, [PR]));
    const result = await send({ event: "check_suite", delivery: "delivery-2", body });
    expect(result).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect((await f.evidence("ci_run")).at(-1)?.payload).toMatchObject({
      conclusion: "success",
    });
  });

  it("answers 202 to an event type it does not read, and stores nothing", async () => {
    const body = JSON.stringify({ action: "created", repository: { full_name: REPO } });
    const result = await send({ event: "issue_comment", delivery: "delivery-3", body });
    expect(result).toEqual({ status: 202, body: { outcome: "unhandled" } });
    expect(await f.store.getGithubDelivery("delivery-3")).toBeNull();
  });

  it("answers 400 to a signed body that is not JSON, and records it as rejected", async () => {
    const result = await send({ delivery: "delivery-4", body: "not json" });
    expect(result.status).toBe(400);
    expect((await f.store.getGithubDelivery("delivery-4"))?.outcome).toBe("rejected");
  });

  it("logs only the delivery id, event, repository, PR number and outcome", () => {
    const standard = new Set(["time", "level", "service", "message"]);
    const allowed = new Set(["deliveryId", "event", "repo", "pr", "outcome"]);
    const deliveries = logs.filter((line) => line.message !== "listening");
    expect(deliveries.length).toBeGreaterThan(0);
    for (const line of deliveries) {
      for (const key of Object.keys(line)) {
        expect(standard.has(key) || allowed.has(key), key).toBe(true);
      }
      const text = JSON.stringify(line);
      expect(text).not.toContain(BRANCH);
      expect(text).not.toContain(DEVELOPER_APP);
      expect(text).not.toContain("never read");
    }
    expect(deliveries).toContainEqual(
      expect.objectContaining({
        deliveryId: "delivery-1",
        event: "pull_request",
        repo: REPO,
        pr: PR,
        outcome: "recorded",
      }),
    );
  });
});
