// Seam: the GitHub receiver's start of the ingest flow over real HTTP, in process (D-381, O-128).
// Signed fake deliveries against the memory store with a fake GitHub that counts reads and a fake
// ingest start. The receiver reads nothing from GitHub and records no evidence: each delivery whose
// evidence needs a GitHub read (a pull request's new commits or merge, CI's end on a commit that
// names pull requests) is recorded as `recorded`, reason "handed to the ingest flow", and starts
// `f/foreman/ingest_delivery` once with exactly the delivery id, event, action, repository, pull
// request numbers and head commit. A delivery decided from its payload alone, a replay and a
// payload ingestion rejects start nothing; the switches do not stop the hand-on, as they did not
// stop the evidence before. A failed start is logged with the error's type and the client's step
// and status only, is not tried again, and leaves the delivery row and the answer as they were.
// What the flow then records, and the steps that follow CI's end, are in
// test/flows/ingest-delivery-flows.test.ts. Fake data only; no Windmill and no network.
import { afterEach, describe, expect, it } from "vitest";

import {
  checkCompletedEvent,
  deploymentStatusEvent,
  pullRequestEvent,
} from "../src/adapters/github/fake.ts";
import { WindmillStartError } from "../src/adapters/windmill/client.ts";
import {
  createFakeFlowStart,
  createFakeIngestStart,
  type FakeFlowStart,
  type FakeIngestStart,
} from "../src/adapters/windmill/fake-flow-start.ts";
import type { PullRequest } from "../src/core/github.ts";
import { HANDED_ON } from "../src/core/github-ingest.ts";
import { createBootstrapStarts } from "../src/github-receiver/bootstrap-starts.ts";
import { WEBHOOK_PATH, createReceiverHandler } from "../src/github-receiver/handler.ts";
import {
  INGEST_NOT_STARTED,
  INGEST_STARTED,
  createIngestStarts,
} from "../src/github-receiver/ingest-starts.ts";
import { createStagingStarts } from "../src/github-receiver/staging-starts.ts";
import { createLogger } from "../src/service-kit/logger.ts";
import { startService, type RunningService } from "../src/service-kit/server.ts";
import {
  DEVELOPER_APP,
  REPO,
  createReconcileFixture,
  type ReconcileFixture,
} from "./reconcile-fixture.ts";

const BRANCH = "foreman/code-item";
const NUMBER = 9;
const HEAD = "f".repeat(40);
const MERGE_SHA = "c".repeat(40);

interface Harness {
  f: ReconcileFixture;
  ingest: FakeIngestStart;
  /** The staging deploy and access removal starts, which none of these deliveries makes. */
  others: FakeFlowStart;
  logs: Record<string, unknown>[];
  send(
    event: string,
    delivery: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

let running: RunningService | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  repo: REPO,
  number: NUMBER,
  state: "open",
  merged: false,
  mergeCommitSha: null,
  headSha: HEAD,
  headBranch: BRANCH,
  headRepo: REPO,
  author: DEVELOPER_APP,
  ...overrides,
});

async function setup(): Promise<Harness> {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  // An item dispatched on the branch, whose PR and green CI GitHub would report: ingestion would
  // record evidence for it, so a receiver that read GitHub or wrote evidence would show.
  const item = await f.node("in_development");
  await f.evidence(item.id, "dispatch_record", { repo: REPO, branch: BRANCH });
  f.github.putPullRequest(pr());
  f.github.setChangedPaths(REPO, NUMBER, ["src/app.ts"]);
  f.github.setCheckRuns(REPO, HEAD, [
    {
      id: 1,
      name: "build",
      status: "completed",
      conclusion: "success",
      appSlug: "github-actions",
    },
  ]);
  const ingest = createFakeIngestStart();
  const others = createFakeFlowStart();
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger("github-receiver", (line) => logs.push(JSON.parse(line)));
  running = await startService({
    name: "github-receiver",
    port: 0,
    logger,
    handle: createReceiverHandler({
      github: f.github,
      ingest: { store: f.store, clock: f.clock },
      ingestStarts: createIngestStarts({ ingestDelivery: ingest, logger }),
      bootstrapStarts: createBootstrapStarts({
        store: f.store,
        removeBootstrapAccess: others,
        logger,
      }),
      stagingStarts: createStagingStarts({
        store: f.store,
        deployStaging: others,
        logger,
      }),
      logger,
    }),
  });
  const url = `http://127.0.0.1:${running.port}${WEBHOOK_PATH}`;
  async function send(event: string, delivery: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": f.github.sign(body),
      },
      body,
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }
  return { f, ingest, others, logs, send };
}

/** Every evidence row the store holds for the fixture's nodes, which the receiver never writes. */
const allEvidence = async (h: Harness) =>
  JSON.stringify(
    await Promise.all(
      (await h.f.store.listNodes({ projectId: h.f.projectId })).map((n) =>
        h.f.store.listEvidence({ nodeId: n.id }),
      ),
    ),
  );

describe("the receiver hands deliveries that need GitHub to the ingest flow (in-process end to end, D-381, O-128)", () => {
  it("hands on each event that needs a GitHub read once, with exactly its identifiers, and reads nothing from GitHub", async () => {
    const h = await setup();
    const before = await allEvidence(h);
    expect(before).toContain("dispatch_record");
    const deliveries: [string, unknown, Record<string, unknown>][] = [
      [
        "pull_request",
        pullRequestEvent("opened", pr()),
        {
          event: "pull_request",
          action: "opened",
          pullRequests: [NUMBER],
          headSha: HEAD,
        },
      ],
      [
        "pull_request",
        pullRequestEvent("synchronize", pr()),
        {
          event: "pull_request",
          action: "synchronize",
          pullRequests: [NUMBER],
          headSha: HEAD,
        },
      ],
      [
        "pull_request",
        pullRequestEvent("reopened", pr()),
        {
          event: "pull_request",
          action: "reopened",
          pullRequests: [NUMBER],
          headSha: HEAD,
        },
      ],
      [
        "pull_request",
        pullRequestEvent(
          "closed",
          pr({ state: "closed", merged: true, mergeCommitSha: MERGE_SHA }),
        ),
        {
          event: "pull_request",
          action: "closed",
          pullRequests: [NUMBER],
          headSha: null,
        },
      ],
      [
        "check_suite",
        checkCompletedEvent("check_suite", REPO, HEAD, [NUMBER, 3]),
        {
          event: "check_suite",
          action: "completed",
          pullRequests: [NUMBER, 3],
          headSha: HEAD,
        },
      ],
      [
        "workflow_run",
        checkCompletedEvent("workflow_run", REPO, HEAD, [NUMBER]),
        {
          event: "workflow_run",
          action: "completed",
          pullRequests: [NUMBER],
          headSha: HEAD,
        },
      ],
    ];
    let n = 0;
    for (const [event, payload, input] of deliveries) {
      const id = `h-${++n}`;
      expect(await h.send(event, id, payload)).toEqual({
        status: 202,
        body: { outcome: "recorded" },
      });
      expect(await h.f.store.getGithubDelivery(id)).toMatchObject({
        eventType: event,
        repository: REPO,
        outcome: "recorded",
        reason: HANDED_ON,
      });
      expect(h.ingest.started.at(-1), id).toEqual({
        deliveryId: id,
        repo: REPO,
        ...input,
      });
    }
    expect(h.ingest.started).toHaveLength(deliveries.length);
    expect(h.f.github.reads).toBe(0);
    expect(await allEvidence(h)).toEqual(before);
    expect(h.others.started).toEqual([]);
    expect(
      h.logs.filter((l) => l.message === INGEST_STARTED).map((l) => l.deliveryId),
    ).toEqual(deliveries.map((_, i) => `h-${i + 1}`));
    // Never a branch name, a login, a title or a body in what crosses or in the logs.
    const text = JSON.stringify([h.ingest.started, h.logs]);
    for (const leak of [BRANCH, DEVELOPER_APP, "Text from the PR body", "An item"])
      expect(text, leak).not.toContain(leak);
  });

  it("starts nothing for a delivery it decides from the payload alone, a payload it rejects or an event it does not read", async () => {
    const h = await setup();
    const payloads: [string, unknown, string][] = [
      ["pull_request", pullRequestEvent("edited", pr()), "ignored"],
      ["pull_request", pullRequestEvent("closed", pr({ state: "closed" })), "ignored"],
      [
        "check_suite",
        {
          ...checkCompletedEvent("check_suite", REPO, HEAD, [NUMBER]),
          action: "requested",
        },
        "ignored",
      ],
      ["workflow_run", checkCompletedEvent("workflow_run", REPO, HEAD, []), "ignored"],
      [
        "deployment_status",
        deploymentStatusEvent(REPO, MERGE_SHA, "staging", "success"),
        "ignored",
      ],
      ["push", { repository: { full_name: REPO } }, "ignored"],
      [
        "pull_request",
        { action: "opened", repository: { full_name: REPO } },
        "rejected",
      ],
      [
        "check_suite",
        checkCompletedEvent("check_suite", REPO, "a".repeat(39), [NUMBER]),
        "rejected",
      ],
      ["issue_comment", { repository: { full_name: REPO } }, "unhandled"],
    ];
    let n = 0;
    for (const [event, payload, outcome] of payloads) {
      const answer = await h.send(event, `x-${++n}`, payload);
      expect(answer.body, `${event} x-${n}`).toEqual({ outcome });
    }
    expect(h.ingest.started).toEqual([]);
    expect(h.f.github.reads).toBe(0);
  });

  it("starts nothing more for a replay", async () => {
    const h = await setup();
    const ciEnd = checkCompletedEvent("check_suite", REPO, HEAD, [NUMBER]);
    await h.send("check_suite", "d-1", ciEnd);
    expect(await h.send("check_suite", "d-1", ciEnd)).toEqual({
      status: 202,
      body: { outcome: "duplicate" },
    });
    expect(h.ingest.started.map((input) => input.deliveryId)).toEqual(["d-1"]);
  });

  it("hands on under the kill switch and in dry run too: the evidence was recorded under both before, and the flow's steps read the switches", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      const h = await setup();
      await h.f.setting(key, value);
      const answer = await h.send(
        "check_suite",
        "d-1",
        checkCompletedEvent("check_suite", REPO, HEAD, [NUMBER]),
      );
      expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
      expect(h.ingest.started, key).toHaveLength(1);
      await running?.stop();
      running = undefined;
    }
  });

  it("logs a failed start with the error's type, step and status only, tries once, and keeps the delivery and the answer", async () => {
    for (const failure of [
      new TypeError(
        "refused for didi-build/rehearsal windmill-refusal-text-0123456789",
      ),
      new WindmillStartError("start", 503),
    ]) {
      const h = await setup();
      h.ingest.failWith = failure;
      const answer = await h.send(
        "check_suite",
        "d-1",
        checkCompletedEvent("check_suite", REPO, HEAD, [NUMBER]),
      );
      expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
      expect(await h.f.store.getGithubDelivery("d-1")).toMatchObject({
        outcome: "recorded",
        reason: HANDED_ON,
      });
      // One start, not tried again: the polling backstop records the evidence later.
      expect(h.ingest.started).toHaveLength(1);
      expect(h.logs.filter((l) => l.message === INGEST_STARTED)).toEqual([]);
      expect(h.logs.find((l) => l.message === INGEST_NOT_STARTED)).toEqual({
        time: expect.any(String),
        level: "warn",
        service: "github-receiver",
        message: INGEST_NOT_STARTED,
        deliveryId: "d-1",
        ...(failure instanceof WindmillStartError
          ? { errorType: "WindmillStartError", step: "start", status: 503 }
          : { errorType: "TypeError" }),
      });
      const startLines = JSON.stringify(
        h.logs.filter((l) => String(l.message).startsWith("ingest flow")),
      );
      expect(startLines).not.toContain("rehearsal");
      expect(startLines).not.toContain("windmill-refusal-text");
      expect(startLines).not.toContain(HEAD);
      await running?.stop();
      running = undefined;
    }
  });

  it("still starts the access removal on Bootstrap's restarted run's end, which needs no GitHub read, and hands that delivery to no flow", async () => {
    const h = await setup();
    const answer = await h.send("workflow_run", "b-1", {
      action: "completed",
      repository: { full_name: "didi-build/garden-notes" },
      workflow_run: {
        path: ".github/workflows/bootstrap.yml",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        head_sha: "a".repeat(40),
        pull_requests: [],
      },
    });
    expect(answer).toEqual({ status: 202, body: { outcome: "ignored" } });
    expect(h.others.started).toEqual(["didi-build/garden-notes"]);
    expect(h.ingest.started).toEqual([]);
    expect(h.f.github.reads).toBe(0);
  });
});
