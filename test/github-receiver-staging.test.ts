// Seam: the GitHub receiver's start of the staging deploy over real HTTP, in process (D-353, D-356,
// O-116). Signed fake deliveries against the memory store, the fake GitHub and fake flow starts.
// After a delivery records a `workflow_run` `completed` with conclusion `success` for exactly
// `.github/workflows/ci.yml`, started by `push` on the repository's default branch, whose head
// repository is the run's own repository, the receiver starts `f/foreman/deploy_staging` once with
// the repository and the run's id: never for a replay, a pull request's run, another branch, a fork,
// a failed or unfinished run, another workflow, a payload ingestion rejects, a `deployment_status`,
// or under either switch. A failed start leaves the webhook's answer as it was, and its log lines
// name no repository. Fake data only; no Windmill and no network.
import { afterEach, describe, expect, it } from "vitest";

import { deploymentStatusEvent } from "../src/adapters/github/fake.ts";
import {
  createFakeFlowStart,
  type FakeFlowStart,
} from "../src/adapters/windmill/fake-flow-start.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { createBootstrapStarts } from "../src/github-receiver/bootstrap-starts.ts";
import { createFlowStarts } from "../src/github-receiver/flow-starts.ts";
import { WEBHOOK_PATH, createReceiverHandler } from "../src/github-receiver/handler.ts";
import {
  STAGING_DEPLOY_NOT_STARTED,
  STAGING_DEPLOY_STARTED,
  createStagingStarts,
  finishedMainBuild,
} from "../src/github-receiver/staging-starts.ts";
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

const REPO = "didi-build/garden-notes";

/** A `workflow_run` delivery as GitHub documents it, trimmed to what the receiver reads. */
const ciEnd = (
  run: Record<string, unknown> = {},
  repository: Record<string, unknown> = {},
  action = "completed",
) => ({
  action,
  repository: { full_name: REPO, default_branch: "main", ...repository },
  workflow_run: {
    id: 4321,
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: "a".repeat(40),
    head_branch: "main",
    head_repository: { full_name: REPO },
    pull_requests: [],
    ...run,
  },
});

interface Harness {
  f: ReconcileFixture;
  deploy: FakeFlowStart;
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
  const deploy = createFakeFlowStart();
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
        logger,
      }),
      bootstrapStarts: createBootstrapStarts({
        store: f.store,
        removeBootstrapAccess: others,
        logger,
      }),
      stagingStarts: createStagingStarts({
        store: f.store,
        deployStaging: deploy,
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
  return { f, deploy, others, logs, send };
}

describe("the receiver starts the staging deploy when CI's build on main ends (in-process end to end, O-116)", () => {
  it("starts the deploy once, with the repository and the run's id, and answers as before", async () => {
    const h = await setup();
    const answer = await h.send("workflow_run", "s-1", ciEnd());
    // Ingestion records it as a delivery only, as before: no pull request names the commit.
    expect(answer).toEqual({ status: 202, body: { outcome: "ignored" } });
    expect((await h.f.store.getGithubDelivery("s-1"))?.outcome).toBe("ignored");
    expect(h.deploy.started).toEqual([`${REPO}#4321`]);
    expect(h.others.started).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: STAGING_DEPLOY_STARTED, deliveryId: "s-1" }),
    );
  });

  it("starts nothing more for a replay", async () => {
    const h = await setup();
    await h.send("workflow_run", "s-1", ciEnd());
    expect(await h.send("workflow_run", "s-1", ciEnd())).toEqual({
      status: 202,
      body: { outcome: "duplicate" },
    });
    expect(h.deploy.started).toEqual([`${REPO}#4321`]);
  });

  it("starts nothing for any other run: workflow, event, branch, fork, conclusion, status or action", async () => {
    const h = await setup();
    const payloads: [string, unknown][] = [
      ["workflow_run", ciEnd({ path: ".github/workflows/screenshots.yml" })],
      ["workflow_run", ciEnd({ path: ".github/workflows/ci.yml@refs/heads/main" })],
      ["workflow_run", ciEnd({ event: "pull_request" })],
      ["workflow_run", ciEnd({ event: "workflow_dispatch" })],
      ["workflow_run", ciEnd({ head_branch: "feature" })],
      ["workflow_run", ciEnd({}, { default_branch: "trunk" })],
      ["workflow_run", ciEnd({}, { default_branch: undefined })],
      [
        "workflow_run",
        ciEnd({ head_repository: { full_name: "someone/garden-notes" } }),
      ],
      ["workflow_run", ciEnd({ head_repository: null })],
      ["workflow_run", ciEnd({ conclusion: "failure" })],
      ["workflow_run", ciEnd({ conclusion: "cancelled" })],
      [
        "workflow_run",
        ciEnd({ status: "in_progress", conclusion: null }, {}, "in_progress"),
      ],
      ["workflow_run", ciEnd({}, {}, "requested")],
      ["workflow_run", ciEnd({ id: 0 })],
      ["workflow_run", ciEnd({ id: "4321" })],
      ["workflow_run", ciEnd({}, { full_name: "not a repository" })],
      ["check_suite", ciEnd()],
      [
        "deployment_status",
        deploymentStatusEvent(REPO, "a".repeat(40), "staging", "success"),
      ],
    ];
    let n = 0;
    for (const [event, payload] of payloads) await h.send(event, `x-${++n}`, payload);
    expect(h.deploy.started).toEqual([]);
  });

  it("starts nothing for a payload ingestion rejects", async () => {
    const h = await setup();
    const rejected = await h.send("workflow_run", "s-1", ciEnd({ head_sha: 7 }));
    expect(rejected).toEqual({ status: 400, body: { outcome: "rejected" } });
    expect(h.deploy.started).toEqual([]);
  });

  it("starts nothing under the kill switch or in dry run", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
      ["dry_run", "unset"],
    ] as const) {
      const h = await setup();
      await h.f.setting(key, value);
      expect(await h.send("workflow_run", "s-1", ciEnd())).toEqual({
        status: 202,
        body: { outcome: "ignored" },
      });
      expect(h.deploy.started, `${key}=${String(value)}`).toEqual([]);
      await running?.stop();
      running = undefined;
    }
  });

  it("logs a failed start without the repository, and answers as before", async () => {
    const h = await setup();
    h.deploy.failWith = new TypeError("Windmill refused didi-build/garden-notes");
    expect(await h.send("workflow_run", "s-1", ciEnd())).toEqual({
      status: 202,
      body: { outcome: "ignored" },
    });
    expect(h.logs.find((l) => l.message === STAGING_DEPLOY_NOT_STARTED)).toEqual({
      time: expect.any(String),
      level: "warn",
      service: "github-receiver",
      message: STAGING_DEPLOY_NOT_STARTED,
      deliveryId: "s-1",
      errorType: "TypeError",
    });
    const deployLines = h.logs.filter((l) =>
      String(l.message).startsWith("staging deploy"),
    );
    expect(deployLines).toHaveLength(1);
    expect(JSON.stringify(deployLines)).not.toContain("garden-notes");
    expect(JSON.stringify(deployLines)).not.toContain("4321");
  });
});

describe("which deliveries are CI's finished build on main (unit, O-116)", () => {
  it("names the repository and run only for CI's successful push run on the default branch", () => {
    expect(finishedMainBuild("workflow_run", ciEnd())).toEqual({
      repo: REPO,
      runId: 4321,
    });
    expect(
      finishedMainBuild(
        "workflow_run",
        ciEnd({ head_branch: "trunk" }, { default_branch: "trunk" }),
      ),
    ).toEqual({ repo: REPO, runId: 4321 });
    expect(finishedMainBuild("workflow_run", { action: "completed" })).toBeNull();
    expect(finishedMainBuild("workflow_run", null)).toBeNull();
    expect(finishedMainBuild("workflow_job", ciEnd())).toBeNull();
  });
});
