// Seam: the ingest flow `f/foreman/ingest_delivery` from the receiver's hand-on (flow with fake
// adapters, D-381, O-128). The receiver runs in process over real HTTP with a fake ingest start
// that keeps each input exactly as Windmill would get it; the test then runs the flow on that
// input, as Windmill would, on the same memory store, the fake GitHub, a fake screenshot port and
// a fake agent runtime, with the real contracts and guards. The flow refuses any other input, reads
// GitHub again, records the evidence under the polling backstop's keys (a delivery and a poll
// record each fact once), and then takes option capture and the advance into In QA review exactly
// when their own due checks say so, the steps the receiver used to start as their own flows
// (O-101, O-104): never for a pending result, a replay, a fact already recorded, an item not due
// or under the switches. A check that throws is reported as `failed` and changes nothing else.
// Synthetic data only; no Windmill, no GitHub and no network.
import { afterEach, describe, expect, it } from "vitest";

import { run as ingestFlow } from "../../flows/ingest-delivery.ts";
import type { IngestDeliveryResult } from "../../flows/lib/ingest-delivery.ts";
import type { FlowDeps } from "../../flows/lib/compose.ts";
import {
  checkCompletedEvent,
  pullRequestEvent,
} from "../../src/adapters/github/fake.ts";
import {
  createFakeIngestStart,
  type FakeIngestStart,
} from "../../src/adapters/windmill/fake-flow-start.ts";
import type { CheckRun, PullRequest } from "../../src/core/github.ts";
import { ciRunKey, pollRepository } from "../../src/core/github-ingest.ts";
import { optionScreenshotRef } from "../../src/core/option-capture.ts";
import type { Json, Node } from "../../src/core/store.ts";
import {
  WEBHOOK_PATH,
  createReceiverHandler,
} from "../../src/github-receiver/handler.ts";
import { createIngestStarts } from "../../src/github-receiver/ingest-starts.ts";
import { createLogger } from "../../src/service-kit/logger.ts";
import { startService, type RunningService } from "../../src/service-kit/server.ts";
import { FEATURE, setupCapture, type CaptureSetup } from "../option-capture-fixture.ts";
import { DEVELOPER_APP, HEAD, REPO } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const DESIGNER_APP = "foreman-designer[bot]";
const DESIGN_BRANCH = "foreman/design-item";
const CODE_BRANCH = "foreman/code-item";
const DESIGN_PR = 7;
const CODE_PR = 9;
const NEXT_HEAD = "e".repeat(40);
const CODE_HEAD = "f".repeat(40);

let checkRunIds = 7000;
const checks = (
  conclusion: string | null = "success",
  status: CheckRun["status"] = "completed",
): CheckRun[] => [
  { id: ++checkRunIds, name: "build", status, conclusion, appSlug: "github-actions" },
];

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

let running: RunningService | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

interface Harness {
  f: FlowFixture;
  /** The flow's deps: the fixture's, with the Designer App's login too (D-156). */
  deps: FlowDeps;
  ingest: FakeIngestStart;
  capture: CaptureSetup;
  design: string;
  code: Node;
  send(event: string, delivery: string, payload: unknown): Promise<unknown>;
  /** Runs the flow on each start the receiver made since the last call, as Windmill would. */
  runStarted(deps?: FlowDeps): Promise<IngestDeliveryResult[]>;
  ciRuns(nodeId: string): Promise<{ commitSha: string | null; conclusion: unknown }[]>;
}

/** Makes the clock move one second at each read, as a real clock moves between steps. */
function ticking(f: FlowFixture) {
  const read = f.clock.now;
  f.clock.now = () => {
    f.advanceMinutes(1 / 60);
    return read();
  };
}

async function setup(options: { bundle?: boolean } = {}): Promise<Harness> {
  const f = await createFlowFixture();
  ticking(f);
  await f.live();
  const deps: FlowDeps = { ...f.deps, appLogins: [DEVELOPER_APP, DESIGNER_APP] };
  const ingest = createFakeIngestStart();
  const logger = createLogger("github-receiver", () => undefined);

  // A design item in exploration whose Designer run ended `success`, CI's options bundle at its
  // head, and its PR on the dispatched branch, opened by the Designer App.
  const capture = await setupCapture(f, {
    screenshots: f.screenshots,
    bundle: options.bundle ?? true,
  });
  await f.evidence(capture.nodeId, "dispatch_record", {
    repo: REPO,
    branch: DESIGN_BRANCH,
  });
  f.github.putPullRequest(pr(DESIGN_PR, DESIGN_BRANCH, HEAD, DESIGNER_APP));
  f.github.setChangedPaths(REPO, DESIGN_PR, [
    `${FEATURE}/options/a/index.html`,
    `${FEATURE}/options/b/index.html`,
  ]);
  f.github.setCheckRuns(REPO, HEAD, checks());
  // A code item In development, its PR on the dispatched branch, opened by the Developer App.
  const code = await f.node("in_development");
  await f.evidence(code.id, "dispatch_record", { repo: REPO, branch: CODE_BRANCH });
  f.github.putPullRequest(pr(CODE_PR, CODE_BRANCH, CODE_HEAD, DEVELOPER_APP));
  f.github.setChangedPaths(REPO, CODE_PR, ["src/app.ts"]);
  f.github.setCheckRuns(REPO, CODE_HEAD, checks());

  running = await startService({
    name: "github-receiver",
    port: 0,
    logger,
    handle: createReceiverHandler({
      github: f.github,
      ingest: { store: f.store, clock: f.clock },
      ingestStarts: createIngestStarts({ ingestDelivery: ingest, logger }),
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
    return response.json();
  }
  let ran = 0;
  async function runStarted(with_ = deps) {
    const results: IngestDeliveryResult[] = [];
    // The input crosses into Windmill as JSON.
    for (const input of ingest.started.slice(ran))
      results.push(await ingestFlow(with_, JSON.parse(JSON.stringify(input))));
    ran = ingest.started.length;
    return results;
  }
  const ciRuns = async (nodeId: string) =>
    (await f.store.listEvidence({ nodeId, kind: "ci_run" }))
      .filter((e) => e.recordedBy === "github")
      .map((e) => ({
        commitSha: e.commitSha,
        conclusion: (e.payload as { conclusion?: unknown }).conclusion,
      }));
  return {
    f,
    deps,
    ingest,
    capture,
    design: capture.nodeId,
    code,
    send,
    runStarted,
    ciRuns,
  };
}

const ciEnd = (
  sha: string,
  number: number,
  event: "check_suite" | "workflow_run" = "check_suite",
) => checkCompletedEvent(event, REPO, sha, [number]);

/** The code item's done report: the docs note the Developer's wrapper posts for its head. */
const docsNote = (h: Harness, sha = CODE_HEAD) =>
  h.f.evidence(h.code.id, "docs_note", { impact: "none" } as Json, { commitSha: sha });

const qaRuns = async (h: Harness) =>
  (await h.f.store.listRuns({ nodeId: h.code.id })).filter((r) => r.bot === "qa");

describe("the ingest flow records what GitHub reports for a handed-on delivery (flow: fake adapters, D-381, O-128)", () => {
  it("records a pull request's pending head and then CI's end, read from GitHub, under the polling backstop's keys, so a poll after each records nothing", async () => {
    const h = await setup();
    h.f.github.setCheckRuns(REPO, CODE_HEAD, checks(null, "in_progress"));
    await h.send(
      "pull_request",
      "p-1",
      pullRequestEvent("opened", pr(CODE_PR, CODE_BRANCH, CODE_HEAD, DEVELOPER_APP)),
    );
    expect(await h.runStarted()).toMatchObject([
      { deliveryId: "p-1", outcome: "recorded", pr: CODE_PR, afterCi: [] },
    ]);
    const pending = await h.f.store.listEvidence({ nodeId: h.code.id });
    await pollRepository(h.deps, REPO);
    expect(await h.f.store.listEvidence({ nodeId: h.code.id })).toEqual(pending);
    const finished = checks();
    h.f.github.setCheckRuns(REPO, CODE_HEAD, finished);
    await h.send("check_suite", "p-2", ciEnd(CODE_HEAD, CODE_PR));
    expect(await h.runStarted()).toMatchObject([
      {
        deliveryId: "p-2",
        outcome: "recorded",
        finishedCi: [{ nodeId: h.code.id, commitSha: CODE_HEAD }],
      },
    ]);
    const before = await h.f.store.listEvidence({ nodeId: h.code.id });
    await pollRepository(h.deps, REPO);
    expect(await h.f.store.listEvidence({ nodeId: h.code.id })).toEqual(before);
    expect(before.filter((e) => e.kind === "ci_run").map((e) => e.ref)).toEqual([
      ciRunKey(REPO, CODE_PR, CODE_HEAD, "pending"),
      ciRunKey(REPO, CODE_PR, CODE_HEAD, "success", finished[0]!.id),
    ]);
  });

  it("records what the poll already recorded once: a delivery after the poll records nothing and takes no step", async () => {
    const h = await setup();
    await docsNote(h);
    await pollRepository(h.deps, REPO);
    await h.send("check_suite", "p-1", ciEnd(CODE_HEAD, CODE_PR));
    expect(await h.runStarted()).toEqual([
      {
        deliveryId: "p-1",
        outcome: "ignored",
        reason: "already recorded",
        pr: CODE_PR,
        evidenceIds: [],
        finishedCi: [],
        afterCi: [],
      },
    ]);
    expect(await h.ciRuns(h.code.id)).toHaveLength(1);
    expect((await h.f.store.getNode(h.code.id))?.state).toBe("in_development");
  });

  it("reads GitHub again: a delivery about a head GitHub no longer reports records nothing", async () => {
    const h = await setup();
    await h.send(
      "pull_request",
      "p-1",
      pullRequestEvent(
        "synchronize",
        pr(CODE_PR, CODE_BRANCH, CODE_HEAD, DEVELOPER_APP),
      ),
    );
    h.f.github.pushHead(REPO, CODE_PR, NEXT_HEAD);
    expect(await h.runStarted()).toMatchObject([
      { outcome: "ignored", reason: "not the current head", evidenceIds: [] },
    ]);
    expect(await h.ciRuns(h.code.id)).toEqual([]);
  });

  it("refuses any input that is not a handed-on delivery, and reads and writes nothing", async () => {
    const h = await setup();
    const reads = h.f.github.reads;
    const before = await h.f.footprint(h.code.id, h.design);
    const valid = {
      deliveryId: "p-1",
      event: "check_suite",
      action: "completed",
      repo: REPO,
      pullRequests: [CODE_PR],
      headSha: CODE_HEAD,
    };
    for (const input of [
      { ...valid, title: "a title" },
      { ...valid, headSha: "main" },
      { ...valid, repo: "not a repository" },
      { ...valid, pullRequests: [] },
      null,
    ]) {
      expect(await ingestFlow(h.deps, input as never)).toEqual({
        outcome: "refused",
        reason: "invalid_input",
      });
    }
    expect(h.f.github.reads).toBe(reads);
    expect(await h.f.footprint(h.code.id, h.design)).toBe(before);
    expect(await h.ciRuns(h.code.id)).toEqual([]);
  });

  it("records the evidence under the kill switch and in dry run, as the receiver did, and takes no step", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      const h = await setup();
      await docsNote(h);
      await h.f.setting(key, value);
      await h.send("check_suite", "d-1", ciEnd(CODE_HEAD, CODE_PR));
      await h.send("check_suite", "d-2", ciEnd(HEAD, DESIGN_PR));
      const results = await h.runStarted();
      expect(
        results.map((r) => ("afterCi" in r ? [r.outcome, r.afterCi] : r)),
        key,
      ).toEqual([
        ["recorded", [{ nodeId: h.code.id }]],
        ["recorded", [{ nodeId: h.design }]],
      ]);
      expect((await h.f.store.getNode(h.code.id))?.state).toBe("in_development");
      expect(
        await h.f.store.listEvidence({ nodeId: h.design, kind: "screenshot" }),
      ).toEqual([]);
      expect(await qaRuns(h)).toEqual([]);
      expect(h.f.runtime.started).toEqual([]);
      await running?.stop();
      running = undefined;
    }
  });
});

describe("option capture follows CI's end in the ingest flow, when it was due before (flow: fake adapters, O-101, O-128)", () => {
  it("captures once for a design item due a capture, and nothing for a replay or the same CI end from another delivery", async () => {
    const h = await setup();
    await h.send("check_suite", "d-1", ciEnd(HEAD, DESIGN_PR));
    const [first] = await h.runStarted();
    expect(first).toMatchObject({
      outcome: "recorded",
      afterCi: [
        {
          nodeId: h.design,
          optionCapture: [{ capture: { nodeId: h.design, step: "opened" } }],
        },
      ],
    });
    expect(first).not.toHaveProperty("afterCi.0.advance");
    const shots = await h.f.store.listEvidence({
      nodeId: h.design,
      kind: "screenshot",
      commitSha: HEAD,
    });
    expect(shots.map((s) => s.ref).sort()).toEqual([
      optionScreenshotRef(HEAD, "a"),
      optionScreenshotRef(HEAD, "b"),
    ]);
    // A replay starts no run; the same CI end from a workflow_run records nothing new.
    await h.send("check_suite", "d-1", ciEnd(HEAD, DESIGN_PR));
    await h.send("workflow_run", "d-2", ciEnd(HEAD, DESIGN_PR, "workflow_run"));
    expect(await h.runStarted()).toMatchObject([
      { deliveryId: "d-2", outcome: "ignored", afterCi: [] },
    ]);
    expect(h.ingest.started.map((i) => i.deliveryId)).toEqual(["d-1", "d-2"]);
  });

  it("takes no step for a pending result: checks starting on a new head are not CI's end", async () => {
    const h = await setup();
    h.f.github.putPullRequest(pr(DESIGN_PR, DESIGN_BRANCH, NEXT_HEAD, DESIGNER_APP));
    h.f.github.setCheckRuns(REPO, NEXT_HEAD, checks(null, "in_progress"));
    await h.send(
      "pull_request",
      "d-1",
      pullRequestEvent(
        "synchronize",
        pr(DESIGN_PR, DESIGN_BRANCH, NEXT_HEAD, DESIGNER_APP),
      ),
    );
    expect(await h.runStarted()).toMatchObject([
      { outcome: "recorded", finishedCi: [], afterCi: [] },
    ]);
    expect(await h.ciRuns(h.design)).toEqual([
      { commitSha: NEXT_HEAD, conclusion: "pending" },
    ]);
  });

  it("takes no capture for a rerun on a head already captured", async () => {
    const h = await setup();
    await h.send("check_suite", "d-1", ciEnd(HEAD, DESIGN_PR));
    await h.runStarted();
    // A rerun: new check runs, so a new CI attempt is recorded on the same head.
    h.f.github.setCheckRuns(REPO, HEAD, checks());
    await h.send("check_suite", "d-2", ciEnd(HEAD, DESIGN_PR));
    const [rerun] = await h.runStarted();
    expect(rerun).toMatchObject({
      outcome: "recorded",
      afterCi: [{ nodeId: h.design }],
    });
    expect(rerun).not.toHaveProperty("afterCi.0.optionCapture");
    expect(await h.ciRuns(h.design)).toHaveLength(2);
  });

  it("captures again for CI's end on a new head the earlier capture did not capture", async () => {
    const h = await setup({ bundle: false });
    await h.send("check_suite", "d-1", ciEnd(HEAD, DESIGN_PR));
    expect(await h.runStarted()).toMatchObject([
      {
        afterCi: [
          {
            nodeId: h.design,
            optionCapture: [{ capture: { step: "bundle_missing" } }],
          },
        ],
      },
    ]);
    h.f.github.putPullRequest(pr(DESIGN_PR, DESIGN_BRANCH, NEXT_HEAD, DESIGNER_APP));
    h.f.github.setCheckRuns(REPO, NEXT_HEAD, checks());
    h.capture.putOptions(["a", "b"], { sha: NEXT_HEAD });
    await h.send("check_suite", "d-2", ciEnd(NEXT_HEAD, DESIGN_PR));
    expect(await h.runStarted()).toMatchObject([
      {
        afterCi: [
          {
            nodeId: h.design,
            optionCapture: [{ capture: { step: "opened" } }],
          },
        ],
      },
    ]);
  });

  it("takes no capture for a code item or while the Designer is running", async () => {
    const h = await setup();
    await h.f.run(h.design, "designer", 1);
    await h.send("check_suite", "d-1", ciEnd(CODE_HEAD, CODE_PR));
    await h.send("check_suite", "d-2", ciEnd(HEAD, DESIGN_PR));
    const results = await h.runStarted();
    expect(results.map((r) => ("afterCi" in r ? r.afterCi : null))).toEqual([
      [{ nodeId: h.code.id }],
      [{ nodeId: h.design }],
    ]);
  });
});

describe("the advance follows CI's end in the ingest flow, when it was due before (flow: fake adapters, O-104, O-128)", () => {
  it("advances an item whose move into In QA review is due and starts QA's run on the head, once", async () => {
    const h = await setup();
    await docsNote(h);
    await h.send("check_suite", "a-1", ciEnd(CODE_HEAD, CODE_PR));
    const [result] = await h.runStarted();
    expect(result).toMatchObject({
      outcome: "recorded",
      afterCi: [
        {
          nodeId: h.code.id,
          advance: {
            outcome: "advanced",
            advances: [
              {
                nodeId: h.code.id,
                toState: "in_qa_review",
                move: { outcome: "applied" },
                qa: { role: "qa", plan: "planned", result: { outcome: "started" } },
              },
            ],
          },
        },
      ],
    });
    expect(result).not.toHaveProperty("afterCi.0.optionCapture");
    expect((await h.f.store.getNode(h.code.id))?.state).toBe("in_qa_review");
    // The pass's own trigger and actor (O-103, O-104), and QA on the head the flow recorded.
    expect(
      (await h.f.transitions(h.code.id)).map((t) => [
        t.toState,
        t.triggerKind,
        t.actorId,
      ]),
    ).toEqual([["in_qa_review", "reconcile", "reconcile"]]);
    expect(await qaRuns(h)).toMatchObject([
      { headSha: CODE_HEAD, prNumber: CODE_PR, taskType: "qa:review" },
    ]);
    // The same CI end from another delivery records nothing and takes nothing again.
    await h.send("workflow_run", "a-2", ciEnd(CODE_HEAD, CODE_PR, "workflow_run"));
    expect(await h.runStarted()).toMatchObject([{ outcome: "ignored", afterCi: [] }]);
    expect(await qaRuns(h)).toHaveLength(1);
    expect(h.f.runtime.started).toHaveLength(1);
  });

  it("takes no advance when it is not due: CI failed, or no docs note for the head", async () => {
    const h = await setup();
    // No docs note yet: the Developer has not reported on this head.
    await h.send("check_suite", "a-1", ciEnd(CODE_HEAD, CODE_PR));
    const results = await h.runStarted();
    // CI fails on a new head that has a docs note.
    h.f.github.putPullRequest(pr(CODE_PR, CODE_BRANCH, NEXT_HEAD, DEVELOPER_APP));
    h.f.github.setCheckRuns(REPO, NEXT_HEAD, checks("failure"));
    await docsNote(h, NEXT_HEAD);
    await h.send("check_suite", "a-2", ciEnd(NEXT_HEAD, CODE_PR));
    results.push(...(await h.runStarted()));
    expect(results.map((r) => ("afterCi" in r ? r.afterCi : null))).toEqual([
      [{ nodeId: h.code.id }],
      [{ nodeId: h.code.id }],
    ]);
    expect(await h.ciRuns(h.code.id)).toEqual([
      { commitSha: CODE_HEAD, conclusion: "success" },
      { commitSha: NEXT_HEAD, conclusion: "failure" },
    ]);
    expect((await h.f.store.getNode(h.code.id))?.state).toBe("in_development");
  });

  it("reports a check that throws as failed, keeps the evidence, and still takes the other item's step in the same run", async () => {
    const h = await setup();
    // One CI end on a commit two pull requests share: the design item's and the code item's.
    h.f.github.putPullRequest(pr(CODE_PR, CODE_BRANCH, HEAD, DEVELOPER_APP));
    await docsNote(h, HEAD);
    const secretish = "store-refusal-text-0123456789";
    // The design item's runs cannot be read, so its capture check throws.
    const store = h.deps.store;
    const failing: FlowDeps = {
      ...h.deps,
      store: {
        ...store,
        listRuns: async (filter) => {
          if (filter.nodeId === h.design) throw new Error(secretish);
          return store.listRuns(filter);
        },
      },
    };
    await h.send(
      "check_suite",
      "a-1",
      checkCompletedEvent("check_suite", REPO, HEAD, [DESIGN_PR, CODE_PR]),
    );
    const [result] = await h.runStarted(failing);
    expect(result).toMatchObject({
      outcome: "recorded",
      afterCi: [
        { nodeId: h.design, optionCapture: "failed" },
        { nodeId: h.code.id, advance: { outcome: "advanced" } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secretish);
    expect(await h.ciRuns(h.design)).toHaveLength(1);
    expect((await h.f.store.getNode(h.code.id))?.state).toBe("in_qa_review");
  });
});
