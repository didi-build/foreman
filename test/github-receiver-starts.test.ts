// Seam: the GitHub receiver's flow starts over real HTTP, in process (D-291, D-327, D-329, O-101,
// O-104). Signed fake deliveries against the memory store with the real contracts and guards, the
// fake GitHub and fake flow starts. After a delivery records CI's end on a PR head, the receiver
// starts `f/foreman/option_capture` once for a design item due a capture, and
// `f/foreman/advance_item` once for an item due an advance from evidence; after a finished
// `deployment_status` to `staging`, it starts `f/foreman/verify_staging` once when an item of the
// repository is in Verifying on staging. Each only when its own check says it is due: never for a
// pending result, a replay, a fact already recorded, an item not due or under the switches. A
// failed start, or a check that cannot be read, leaves the webhook's answer and the evidence as
// they were. Fake data only; no Windmill and no network.
import { afterEach, describe, expect, it } from "vitest";

import {
  checkCompletedEvent,
  deploymentStatusEvent,
  pullRequestEvent,
} from "../src/adapters/github/fake.ts";
import {
  createFakeFlowStart,
  type FakeFlowStart,
} from "../src/adapters/windmill/fake-flow-start.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { optionScreenshotRef } from "../src/core/option-capture.ts";
import type { CheckRun, PullRequest } from "../src/core/github.ts";
import type { Node, Store } from "../src/core/store.ts";
import {
  ADVANCE_NOT_STARTED,
  ADVANCE_STARTED,
  OPTION_CAPTURE_NOT_STARTED,
  OPTION_CAPTURE_STARTED,
  STAGING_NOT_STARTED,
  STAGING_STARTED,
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
  /** The option capture start. */
  flow: FakeFlowStart;
  advance: FakeFlowStart;
  staging: FakeFlowStart;
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

async function setup(
  options: { store?: (store: Store) => Store } = {},
): Promise<Harness> {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const flow = createFakeFlowStart();
  const advance = createFakeFlowStart();
  const staging = createFakeFlowStart();
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
        store: options.store ? options.store(f.store) : f.store,
        contracts: f.contracts,
        guards: GUARDS,
        clock: f.clock,
        ids: f.deps.ids,
        optionCapture: flow,
        advanceItem: advance,
        verifyStaging: staging,
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

  return { f, flow, advance, staging, design, code, logs, send, push, ciRuns };
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

/** The code item's done report: the docs note the Developer's wrapper posts for its head. */
const docsNote = (h: Harness, sha = CODE_HEAD) =>
  h.f.evidence(h.code.id, "docs_note", { impact: "none" }, { commitSha: sha });

const codeCiEnd = (sha = CODE_HEAD) => ciEnd(sha, CODE_PR);

describe("the receiver starts the advance on CI's end (in-process end to end, O-104)", () => {
  it("starts the advance flow once for an item whose advance into QA review is due, and nothing else", async () => {
    const h = await setup();
    await docsNote(h);
    const answer = await h.send("check_suite", "d-1", codeCiEnd());
    expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect(await h.ciRuns(h.code.id)).toEqual([
      { commitSha: CODE_HEAD, conclusion: "success" },
    ]);
    expect(h.advance.started).toEqual([h.code.id]);
    expect(h.flow.started).toEqual([]);
    expect(h.staging.started).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: ADVANCE_STARTED, deliveryId: "d-1" }),
    );
    // The receiver only starts the flow: the item has not moved.
    expect((await h.f.store.getNode(h.code.id))?.state).toBe("in_development");
  });

  it("starts nothing when the advance is not due: CI failed, or no docs note for the head", async () => {
    const h = await setup();
    // No docs note yet: the Developer has not reported on this head.
    await h.send("check_suite", "d-1", codeCiEnd());
    expect(await h.ciRuns(h.code.id)).toHaveLength(1);
    // CI fails on a new head that has a docs note.
    h.f.github.putPullRequest(pr(CODE_PR, CODE_BRANCH, NEXT_HEAD, DEVELOPER_APP));
    h.f.github.setCheckRuns(REPO, NEXT_HEAD, [
      { ...passing()[0]!, conclusion: "failure" },
    ]);
    await docsNote(h, NEXT_HEAD);
    await h.send("check_suite", "d-2", codeCiEnd(NEXT_HEAD));
    expect(await h.ciRuns(h.code.id)).toEqual([
      { commitSha: CODE_HEAD, conclusion: "success" },
      { commitSha: NEXT_HEAD, conclusion: "failure" },
    ]);
    expect(h.advance.started).toEqual([]);
  });

  it("starts nothing more for a replay, the same CI end from another delivery, or a pending result", async () => {
    const h = await setup();
    await docsNote(h);
    await h.send("check_suite", "d-1", codeCiEnd());
    expect(await h.send("check_suite", "d-1", codeCiEnd())).toEqual({
      status: 202,
      body: { outcome: "duplicate" },
    });
    expect(
      await h.send(
        "workflow_run",
        "d-2",
        checkCompletedEvent("workflow_run", REPO, CODE_HEAD, [CODE_PR]),
      ),
    ).toEqual({ status: 202, body: { outcome: "ignored" } });
    // Checks starting on a new head: a pending result is not CI's end.
    h.f.github.putPullRequest(pr(CODE_PR, CODE_BRANCH, NEXT_HEAD, DEVELOPER_APP));
    h.f.github.setCheckRuns(REPO, NEXT_HEAD, [
      { ...passing()[0]!, status: "in_progress", conclusion: null },
    ]);
    await docsNote(h, NEXT_HEAD);
    await h.send(
      "pull_request",
      "d-3",
      pullRequestEvent(
        "synchronize",
        pr(CODE_PR, CODE_BRANCH, NEXT_HEAD, DEVELOPER_APP),
      ),
    );
    expect((await h.ciRuns(h.code.id)).at(-1)).toEqual({
      commitSha: NEXT_HEAD,
      conclusion: "pending",
    });
    expect(h.advance.started).toEqual([h.code.id]);
  });

  it("starts nothing under the kill switch or in dry run, and still records the evidence", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      const h = await setup();
      await docsNote(h);
      await h.f.setting(key, value);
      const answer = await h.send("check_suite", "d-1", codeCiEnd());
      expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
      expect(await h.ciRuns(h.code.id)).toHaveLength(1);
      expect(h.advance.started, key).toEqual([]);
      await running?.stop();
      running = undefined;
    }
  });

  it("keeps the webhook's answer and the evidence when the start fails, and logs only the error's type", async () => {
    const h = await setup();
    await docsNote(h);
    const secretish = "windmill-refusal-text-0123456789";
    h.advance.failWith = new TypeError(`refused with ${secretish}`);
    const answer = await h.send("check_suite", "d-1", codeCiEnd());
    expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect(await h.ciRuns(h.code.id)).toEqual([
      { commitSha: CODE_HEAD, conclusion: "success" },
    ]);
    expect((await h.f.store.getGithubDelivery("d-1"))?.outcome).toBe("recorded");
    expect(h.advance.started).toEqual([h.code.id]);
    expect(h.logs.find((line) => line.message === ADVANCE_NOT_STARTED)).toEqual({
      time: expect.any(String),
      level: "warn",
      service: "github-receiver",
      message: ADVANCE_NOT_STARTED,
      deliveryId: "d-1",
      errorType: "TypeError",
    });
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(secretish);
    expect(text).not.toContain(h.code.id);
  });

  it("starts nothing, and keeps the answer, when the check needs a read the receiver's role does not have", async () => {
    // As factory_ingest, the database refuses decisions (test/db/github-ingest.test.ts): the
    // guards read one only on a design head QA already reported on. Here every decision read is
    // refused, as the role's would be.
    const refused = new Error("permission denied for table decisions");
    const h = await setup({
      store: (store) => ({
        ...store,
        listDecisionsForNode: async () => {
          throw refused;
        },
      }),
    });
    // A design item back in Building components on a head QA passed, then CI ran again there.
    const design = await h.f.node("building_components", {
      track: "design",
      ownerRole: "designer",
    });
    const branch = "foreman/design-build";
    await h.f.evidence(design.id, "dispatch_record", { repo: REPO, branch });
    h.f.github.putPullRequest(pr(12, branch, HEAD, DESIGNER_APP));
    h.f.github.setCheckRuns(REPO, HEAD, passing());
    // The PR still carries an option folder, so the guard asks which option Didi approved.
    h.f.github.setChangedPaths(REPO, 12, [
      "design/gallery/example-button/spec.md",
      "design/gallery/example-button/options/a/index.html",
    ]);
    await h.f.run(design.id, "qa", 10, {
      endedAt: h.f.clock.now(),
      outcome: "success",
      headSha: HEAD,
      prNumber: 12,
    });
    const answer = await h.send("check_suite", "d-1", ciEnd(HEAD, 12));
    expect(answer).toEqual({ status: 202, body: { outcome: "recorded" } });
    expect(h.advance.started).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: ADVANCE_NOT_STARTED, errorType: "Error" }),
    );
    expect(JSON.stringify(h.logs)).not.toContain(refused.message);
  });
});

const MERGE_SHA = "c".repeat(40);
const deployed = (environment = "staging", state = "success", sha = MERGE_SHA) =>
  deploymentStatusEvent(REPO, sha, environment, state);

/** An item of the repository waiting in Verifying on staging. */
async function verifying(h: Harness) {
  const item = await h.f.node("verifying_on_staging");
  await h.f.evidence(item.id, "dispatch_record", {
    repo: REPO,
    branch: "foreman/merged",
  });
  await h.f.evidence(item.id, "merge_commit", { pr: 11 }, { commitSha: MERGE_SHA });
  return item;
}

describe("the receiver starts the staging flow on a staging deploy (in-process end to end, O-104)", () => {
  it("starts the staging flow once with the repository and commit while an item verifies on staging", async () => {
    const h = await setup();
    await verifying(h);
    const answer = await h.send("deployment_status", "d-1", deployed());
    // Still a delivery only: the flow reads the deploy from GitHub itself.
    expect(answer).toEqual({ status: 202, body: { outcome: "ignored" } });
    expect((await h.f.store.getGithubDelivery("d-1"))?.outcome).toBe("ignored");
    expect(h.staging.started).toEqual([`${REPO}@${MERGE_SHA}`]);
    expect(h.advance.started).toEqual([]);
    expect(h.flow.started).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ message: STAGING_STARTED, deliveryId: "d-1" }),
    );
    // A failed deploy to staging calls for the flow too: it records the failure (D-225).
    await h.send("deployment_status", "d-2", deployed("staging", "failure"));
    expect(h.staging.started).toHaveLength(2);
  });

  it("starts nothing for another environment, an unfinished status, a replay, or with no item verifying", async () => {
    const h = await setup();
    await h.send("deployment_status", "d-1", deployed());
    expect(h.staging.started).toEqual([]);
    await verifying(h);
    await h.send("deployment_status", "d-2", deployed("production"));
    await h.send("deployment_status", "d-3", deployed("preview"));
    for (const [i, state] of ["pending", "queued", "in_progress", "inactive"].entries())
      await h.send("deployment_status", `d-4${i}`, deployed("staging", state));
    expect(h.staging.started).toEqual([]);
    await h.send("deployment_status", "d-5", deployed());
    expect(await h.send("deployment_status", "d-5", deployed())).toEqual({
      status: 202,
      body: { outcome: "duplicate" },
    });
    expect(h.staging.started).toEqual([`${REPO}@${MERGE_SHA}`]);
  });

  it("starts nothing under the kill switch or in dry run", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      const h = await setup();
      await verifying(h);
      await h.f.setting(key, value);
      expect(await h.send("deployment_status", "d-1", deployed())).toEqual({
        status: 202,
        body: { outcome: "ignored" },
      });
      expect(h.staging.started, key).toEqual([]);
      await running?.stop();
      running = undefined;
    }
  });

  it("keeps the webhook's answer and the delivery when the start fails, and logs only the error's type", async () => {
    const h = await setup();
    await verifying(h);
    h.staging.failWith = new TypeError("refused with windmill-text-0123456789");
    expect(await h.send("deployment_status", "d-1", deployed())).toEqual({
      status: 202,
      body: { outcome: "ignored" },
    });
    expect((await h.f.store.getGithubDelivery("d-1"))?.outcome).toBe("ignored");
    expect(h.logs.find((line) => line.message === STAGING_NOT_STARTED)).toEqual({
      time: expect.any(String),
      level: "warn",
      service: "github-receiver",
      message: STAGING_NOT_STARTED,
      deliveryId: "d-1",
      errorType: "TypeError",
    });
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("windmill-text-0123456789");
    expect(text).not.toContain(MERGE_SHA);
  });
});
