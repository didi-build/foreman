// Seam: the GitHub receiver's start of the BOOTSTRAP_TOKEN access removal over real HTTP, in
// process (D-358 lock (2), O-114). Signed fake deliveries against the memory store, the fake
// GitHub and a fake flow start. After a delivery records a `workflow_run` `completed` for
// `.github/workflows/bootstrap.yml` started by `workflow_dispatch` in a repository of didi-build,
// whatever its conclusion, the receiver starts `f/foreman/remove_bootstrap_access` once with the
// repository: never for a replay, a run started by a push, another workflow, another organization,
// a payload ingestion rejects, or under either switch. A failed start leaves the webhook's answer
// as it was, and the removal's log lines name no repository. Fake data only; no Windmill and no
// network.
import { afterEach, describe, expect, it } from "vitest";

import {
  createFakeFlowStart,
  type FakeFlowStart,
} from "../src/adapters/windmill/fake-flow-start.ts";
import {
  BOOTSTRAP_REMOVAL_NOT_STARTED,
  BOOTSTRAP_REMOVAL_STARTED,
  createBootstrapStarts,
  endedBootstrapRestart,
} from "../src/github-receiver/bootstrap-starts.ts";
import { createFlowStarts } from "../src/github-receiver/flow-starts.ts";
import { WEBHOOK_PATH, createReceiverHandler } from "../src/github-receiver/handler.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { createLogger } from "../src/service-kit/logger.ts";
import { startService, type RunningService } from "../src/service-kit/server.ts";
import {
  DEVELOPER_APP,
  RUNNER_APP,
  createReconcileFixture,
  type ReconcileFixture,
} from "./reconcile-fixture.ts";

let running: RunningService | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** A `workflow_run` delivery as GitHub documents it, trimmed to what the receiver reads. */
const runEnd = (
  run: Record<string, unknown> = {},
  repository = "didi-build/garden-notes",
  action = "completed",
) => ({
  action,
  repository: { full_name: repository },
  workflow_run: {
    path: ".github/workflows/bootstrap.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: "a".repeat(40),
    pull_requests: [],
    ...run,
  },
});

interface Harness {
  f: ReconcileFixture;
  removal: FakeFlowStart;
  others: FakeFlowStart;
  logs: Record<string, unknown>[];
  send(
    event: string,
    delivery: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

async function setup(): Promise<Harness> {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const removal = createFakeFlowStart();
  const others = createFakeFlowStart();
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger("github-receiver", (line) => logs.push(JSON.parse(line)));
  running = await startService({
    name: "github-receiver",
    port: 0,
    logger,
    handle: createReceiverHandler({
      github: f.github,
      ingest: {
        store: f.store,
        clock: f.clock,
        ids: f.deps.ids,
        appLogins: [DEVELOPER_APP],
        runnerAppSlug: RUNNER_APP,
      },
      flowStarts: createFlowStarts({
        store: f.store,
        contracts: f.contracts,
        guards: GUARDS,
        clock: f.clock,
        ids: f.deps.ids,
        optionCapture: others,
        advanceItem: others,
        verifyStaging: others,
        logger,
      }),
      bootstrapStarts: createBootstrapStarts({
        store: f.store,
        removeBootstrapAccess: removal,
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
  return { f, removal, others, logs, send };
}

describe("the receiver removes BOOTSTRAP_TOKEN's access when Bootstrap's restart ends (in-process end to end, O-114)", () => {
  it("starts the removal once, with the repository, on success and on failure, and answers as before", async () => {
    for (const conclusion of ["success", "failure"]) {
      const h = await setup();
      const answer = await h.send(
        "workflow_run",
        `b-${conclusion}`,
        runEnd({ conclusion }),
      );
      // Ingestion records it as a delivery only, as before: no pull request names the commit.
      expect(answer).toEqual({ status: 202, body: { outcome: "ignored" } });
      expect(h.removal.started).toEqual(["didi-build/garden-notes"]);
      expect(h.others.started).toEqual([]);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          message: BOOTSTRAP_REMOVAL_STARTED,
          deliveryId: `b-${conclusion}`,
        }),
      );
      await running?.stop();
      running = undefined;
    }
  });

  it("starts nothing more for a replay", async () => {
    const h = await setup();
    await h.send("workflow_run", "b-1", runEnd());
    const replay = await h.send("workflow_run", "b-1", runEnd());
    expect(replay).toEqual({ status: 202, body: { outcome: "duplicate" } });
    expect(h.removal.started).toEqual(["didi-build/garden-notes"]);
  });

  it("starts nothing for a run started by a push, another workflow, another organization or an unfinished run", async () => {
    const h = await setup();
    const payloads: [string, unknown][] = [
      ["workflow_run", runEnd({ event: "push" })],
      ["workflow_run", runEnd({ path: ".github/workflows/ci.yml" })],
      ["workflow_run", runEnd({}, "someone-else/garden-notes")],
      ["workflow_run", runEnd({}, "didi-build/a/b")],
      [
        "workflow_run",
        runEnd({ status: "in_progress", conclusion: null }, undefined, "in_progress"),
      ],
      ["workflow_run", runEnd({}, undefined, "requested")],
      ["check_suite", runEnd()],
    ];
    let n = 0;
    for (const [event, payload] of payloads) {
      await h.send(event, `x-${++n}`, payload);
    }
    expect(h.removal.started).toEqual([]);
  });

  it("starts nothing for a payload ingestion rejects", async () => {
    const h = await setup();
    const rejected = await h.send("workflow_run", "b-1", runEnd({ head_sha: 7 }));
    expect(rejected).toEqual({ status: 400, body: { outcome: "rejected" } });
    expect(h.removal.started).toEqual([]);
  });

  it("starts for Bootstrap's path with GitHub's @ref", async () => {
    const h = await setup();
    await h.send(
      "workflow_run",
      "b-1",
      runEnd({ path: ".github/workflows/bootstrap.yml@main" }),
    );
    expect(h.removal.started).toEqual(["didi-build/garden-notes"]);
  });

  it("starts nothing under the kill switch or in dry run", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
      ["dry_run", "unset"],
    ] as const) {
      const h = await setup();
      await h.f.setting(key, value);
      await h.send("workflow_run", "b-1", runEnd());
      expect(h.removal.started, `${key}=${String(value)}`).toEqual([]);
      await running?.stop();
      running = undefined;
    }
  });

  it("logs a failed start without the repository, and answers as before", async () => {
    const h = await setup();
    h.removal.failWith = new Error("Windmill refused didi-build/garden-notes");
    const answer = await h.send("workflow_run", "b-1", runEnd());
    expect(answer).toEqual({ status: 202, body: { outcome: "ignored" } });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: BOOTSTRAP_REMOVAL_NOT_STARTED,
        deliveryId: "b-1",
        errorType: "Error",
      }),
    );
    // The handler's own delivery line names the repository (ADR 0113 section 8); the removal's
    // lines do not, nor the error's text.
    const removalLines = h.logs.filter((l) =>
      String(l.message).startsWith("bootstrap"),
    );
    expect(removalLines).toHaveLength(1);
    expect(JSON.stringify(removalLines)).not.toContain("garden-notes");
  });
});

describe("which deliveries are a Bootstrap restart's end (unit, O-114)", () => {
  it("names the repository only for a completed restarted Bootstrap run in didi-build", () => {
    expect(endedBootstrapRestart("workflow_run", runEnd())).toBe(
      "didi-build/garden-notes",
    );
    expect(
      endedBootstrapRestart("workflow_run", runEnd({ conclusion: "cancelled" })),
    ).toBe("didi-build/garden-notes");
    expect(
      endedBootstrapRestart("workflow_run", runEnd({ status: "queued" })),
    ).toBeNull();
    expect(endedBootstrapRestart("workflow_run", { action: "completed" })).toBeNull();
    expect(endedBootstrapRestart("workflow_run", null)).toBeNull();
    expect(endedBootstrapRestart("workflow_job", runEnd())).toBeNull();
  });
});
