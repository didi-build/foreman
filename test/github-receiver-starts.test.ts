// Seam: the GitHub receiver's flow starts over real HTTP, in process (D-291, D-327, D-329, O-101).
// Signed fake deliveries against the memory store with the real contracts, the fake GitHub and a
// fake option capture flow start. After a delivery records CI's end on a design item's PR head,
// the receiver starts `f/foreman/option_capture` once, only when a capture is due by capture's own
// check: never for a pending result, a replay, a fact already recorded, an item not due or under
// the switches. A failed start leaves the webhook's answer and the evidence as they were. Fake data
// only; no Windmill and no network.
import { afterEach, describe, expect, it } from "vitest";

import { checkCompletedEvent, pullRequestEvent } from "../src/adapters/github/fake.ts";
import {
  createFakeFlowStart,
  type FakeFlowStart,
} from "../src/adapters/windmill/fake-flow-start.ts";
import { optionScreenshotRef } from "../src/core/option-capture.ts";
import type { CheckRun, PullRequest } from "../src/core/github.ts";
import type { Node } from "../src/core/store.ts";
import {
  OPTION_CAPTURE_NOT_STARTED,
  OPTION_CAPTURE_STARTED,
  createFlowStarts,
} from "../src/github-receiver/flow-starts.ts";
import { WEBHOOK_PATH, createReceiverHandler } from "../src/github-receiver/handler.ts";
import { createLogger } from "../src/service-kit/logger.ts";
import { startService, type RunningService } from "../src/service-kit/server.ts";
import {
  DEVELOPER_APP,
  REPO,
  RUNNER_APP,
  createReconcileFixture,
  type ReconcileFixture,
} from "./reconcile-fixture.ts";

const DESIGNER_APP = "foreman-designer[bot]";
const DESIGN_BRANCH = "foreman/design-item";
const CODE_BRANCH = "foreman/code-item";
const DESIGN_PR = 8;
const CODE_PR = 9;
const HEAD = "d".repeat(40);
const NEXT_HEAD = "e".repeat(40);
const CODE_HEAD = "f".repeat(40);

let checkRunIds = 5000;
const passing = (): CheckRun[] => [
  {
    id: ++checkRunIds,
    name: "build",
    status: "completed",
    conclusion: "success",
    appSlug: "github-actions",
  },
];

interface Harness {
  f: ReconcileFixture;
  flow: FakeFlowStart;
  design: Node;
  code: Node;
  logs: Record<string, unknown>[];
  send(
    event: string,
    delivery: string,
    payload: unknown,
  ): Promise<{
    status: number;
    body: unknown;
  }>;
  /** Moves the design PR to a new head, with CI finished on it. */
  push(sha: string): void;
  ciRuns(nodeId: string): Promise<{ commitSha: string | null; conclusion: unknown }[]>;
}

let running: RunningService | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const pr = (
  number: number,
  branch: string,
  sha: string,
  author: string,
): PullRequest => ({
  repo: REPO,
  number,
  state: "open",
  merged: false,
  mergeCommitSha: null,
  headSha: sha,
  headBranch: branch,
  headRepo: REPO,
  author,
});

async function setup(): Promise<Harness> {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const flow = createFakeFlowStart();
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger("github-receiver", (line) => logs.push(JSON.parse(line)));

  // A design item in exploration whose Designer run ended `success`, and a code item.
  const design = await f.node("in_design_exploration", {
    track: "design",
    ownerRole: "designer",
    title: "Example button",
  });
  await f.run(design.id, "designer", 30, {
    endedAt: f.clock.now(),
    outcome: "success",
  });
  await f.evidence(design.id, "dispatch_record", { repo: REPO, branch: DESIGN_BRANCH });
  const code = await f.node("in_development");
  await f.evidence(code.id, "dispatch_record", { repo: REPO, branch: CODE_BRANCH });

  const push = (sha: string) => {
    f.github.putPullRequest(pr(DESIGN_PR, DESIGN_BRANCH, sha, DESIGNER_APP));
    f.github.setCheckRuns(REPO, sha, passing());
  };
  push(HEAD);
  f.github.setChangedPaths(REPO, DESIGN_PR, [
    "design/gallery/example-button/options/a/index.html",
    "design/gallery/example-button/options/b/index.html",
  ]);
  f.github.putPullRequest(pr(CODE_PR, CODE_BRANCH, CODE_HEAD, DEVELOPER_APP));
  f.github.setCheckRuns(REPO, CODE_HEAD, passing());
  f.github.setChangedPaths(REPO, CODE_PR, ["src/app.ts"]);

  const ingest = {
    store: f.store,
    clock: f.clock,
    ids: f.deps.ids,
    appLogins: [DEVELOPER_APP, DESIGNER_APP],
    runnerAppSlug: RUNNER_APP,
  };
  running = await startService({
    name: "github-receiver",
    port: 0,
    logger,
    handle: createReceiverHandler({
      github: f.github,
      ingest,
      flowStarts: createFlowStarts({
        store: f.store,
        contracts: f.contracts,
        optionCapture: flow,
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

  const ciRuns = async (nodeId: string) =>
    (await f.store.listEvidence({ nodeId, kind: "ci_run" })).map((e) => ({
      commitSha: e.commitSha,
      conclusion: (e.payload as { conclusion?: unknown }).conclusion,
    }));

  return { f, flow, design, code, logs, send, push, ciRuns };
}

const ciEnd = (sha: string, prNumber = DESIGN_PR) =>
  checkCompletedEvent("check_suite", REPO, sha, [prNumber]);

describe("the receiver starts option capture on CI's end (in-process end to end, O-101)", () => {
  it("starts the flow once for a design item due a capture, after recording CI's end", async () => {
    const h = await setup();
    const answer = await h.send("check_suite", "d-1", ciEnd(HEAD));
    expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect(await h.ciRuns(h.design.id)).toEqual([
      { commitSha: HEAD, conclusion: "success" },
    ]);
    expect(h.flow.started).toEqual([h.design.id]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: OPTION_CAPTURE_STARTED, deliveryId: "d-1" }),
    );
  });

  it("starts nothing more for a replay, or for the same CI end from another delivery", async () => {
    const h = await setup();
    await h.send("check_suite", "d-1", ciEnd(HEAD));
    const replay = await h.send("check_suite", "d-1", ciEnd(HEAD));
    expect(replay).toEqual({ status: 202, body: { outcome: "duplicate" } });
    const same = await h.send(
      "workflow_run",
      "d-2",
      checkCompletedEvent("workflow_run", REPO, HEAD, [DESIGN_PR]),
    );
    expect(same).toEqual({ status: 202, body: { outcome: "ignored" } });
    expect(h.flow.started).toEqual([h.design.id]);
    expect(await h.ciRuns(h.design.id)).toHaveLength(1);
  });

  it("starts nothing for a pending result: checks starting on a new head are not CI's end", async () => {
    const h = await setup();
    h.push(NEXT_HEAD);
    h.f.github.setCheckRuns(REPO, NEXT_HEAD, [
      { ...passing()[0]!, status: "in_progress", conclusion: null },
    ]);
    const opened = await h.send(
      "pull_request",
      "d-1",
      pullRequestEvent(
        "synchronize",
        pr(DESIGN_PR, DESIGN_BRANCH, NEXT_HEAD, DESIGNER_APP),
      ),
    );
    expect(opened).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect(await h.ciRuns(h.design.id)).toEqual([
      { commitSha: NEXT_HEAD, conclusion: "pending" },
    ]);
    expect(h.flow.started).toEqual([]);
  });

  it("starts again for CI's end on a new head, which capture has not captured", async () => {
    const h = await setup();
    await h.send("check_suite", "d-1", ciEnd(HEAD));
    h.push(NEXT_HEAD);
    await h.send("check_suite", "d-2", ciEnd(NEXT_HEAD));
    expect(h.flow.started).toEqual([h.design.id, h.design.id]);
  });

  it("starts nothing when capture already captured the head, even for a rerun's new CI end", async () => {
    const h = await setup();
    await h.send("check_suite", "d-1", ciEnd(HEAD));
    // What capture writes when it opens the request for the head (src/core/option-capture.ts).
    await h.f.store.insertEvidence({
      id: h.f.deps.ids.next(),
      nodeId: h.design.id,
      runId: null,
      kind: "screenshot",
      ref: optionScreenshotRef(HEAD, "a"),
      commitSha: HEAD,
      payload: {},
      recordedBy: "runner",
      recordedAt: h.f.clock.now(),
      supersedesId: null,
    });
    // A rerun: new check runs, so a new CI attempt is recorded on the same head.
    h.f.github.setCheckRuns(REPO, HEAD, passing());
    expect(await h.send("check_suite", "d-2", ciEnd(HEAD))).toEqual({
      status: 202,
      body: { outcome: "recorded" },
    });
    expect(await h.ciRuns(h.design.id)).toHaveLength(2);
    expect(h.flow.started).toEqual([h.design.id]);
  });

  it("starts nothing for an item capture does not work on: a code item, or a Designer still running", async () => {
    const h = await setup();
    await h.send("check_suite", "d-1", ciEnd(CODE_HEAD, CODE_PR));
    expect(await h.ciRuns(h.code.id)).toHaveLength(1);
    await h.f.run(h.design.id, "designer", 1);
    await h.send("check_suite", "d-2", ciEnd(HEAD));
    expect(await h.ciRuns(h.design.id)).toHaveLength(1);
    expect(h.flow.started).toEqual([]);
  });

  it("starts nothing under the kill switch or in dry run, and still records the evidence", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      const h = await setup();
      await h.f.setting(key, value);
      const answer = await h.send("check_suite", "d-1", ciEnd(HEAD));
      expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
      expect(await h.ciRuns(h.design.id)).toHaveLength(1);
      expect(h.flow.started).toEqual([]);
      await running?.stop();
      running = undefined;
    }
  });

  it("keeps the webhook's answer and the evidence when the start fails, and logs only the error's type", async () => {
    const h = await setup();
    const secretish = "windmill-refusal-text-0123456789";
    h.flow.failWith = new TypeError(`refused with ${secretish}`);
    const answer = await h.send("check_suite", "d-1", ciEnd(HEAD));
    expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect(await h.ciRuns(h.design.id)).toEqual([
      { commitSha: HEAD, conclusion: "success" },
    ]);
    expect((await h.f.store.getGithubDelivery("d-1"))?.outcome).toBe("recorded");
    expect(h.flow.started).toEqual([h.design.id]);
    const warning = h.logs.find((line) => line.message === OPTION_CAPTURE_NOT_STARTED);
    expect(warning).toEqual({
      time: expect.any(String),
      level: "warn",
      service: "github-receiver",
      message: OPTION_CAPTURE_NOT_STARTED,
      deliveryId: "d-1",
      errorType: "TypeError",
    });
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(secretish);
    expect(text).not.toContain(h.design.id);
    expect(text).not.toContain(DESIGN_BRANCH);
  });
});
