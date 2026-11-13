// Seam: GitHub ingestion in the core (build plan M2.3, ADR 0113). The core's plain functions over
// the memory store and the fake GitHub: events to evidence, linking, the head rule, the QA check
// exclusion, both levels of idempotency, the polling backstop, and a fresh `deployment_status`
// delivery naming nothing (O-104, O-116). Since D-381 (O-128) a delivery is read in two places:
// what the receiver decides from the signed payload alone and exactly what it hands the ingest
// flow (`decideDelivery`, `receiveDelivery`), the flow's strict read of that input
// (`readHandedOnDelivery`), and what the flow records from GitHub (`ingestHandedOn`); the tests
// of events to evidence take each delivery through both, as production does. The receiver's HTTP
// and signature layer is tested in test/github-receiver.test.ts; the flow in
// test/flows/ingest-delivery-flows.test.ts; Postgres in test/db/.
import { describe, expect, it } from "vitest";

import {
  checkCompletedEvent,
  deploymentStatusEvent,
  pullRequestEvent,
} from "../src/adapters/github/fake.ts";
import {
  ciRunKey,
  conclude,
  decideDelivery,
  HANDED_ON,
  ingestHandedOn,
  mergeCommitKey,
  pollRepository,
  QA_CHECK_RUN,
  readHandedOnDelivery,
  receiveDelivery,
  type HandedOnDelivery,
} from "../src/core/github-ingest.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import type { CheckRun } from "../src/core/github.ts";
import type { Evidence } from "../src/core/store.ts";
import {
  BRANCH,
  CHANGED,
  DESIGNER_APP,
  DEVELOPER_APP,
  MERGE_SHA,
  PR,
  REPO,
  SHA_A,
  SHA_B,
  createIngestFixture,
  deliverAndIngest,
  RUNNER_APP,
  check,
  passing,
  type IngestFixture,
} from "./github-fixture.ts";

async function deliver(f: IngestFixture, event: string, payload: unknown, id?: string) {
  return deliverAndIngest(f.deps, { id: id ?? f.nextDeliveryId(), event, payload });
}

const opened = async (f: IngestFixture, action: "opened" | "synchronize" = "opened") =>
  deliver(f, "pull_request", pullRequestEvent(action, await f.pr()));

const checksDone = (f: IngestFixture, sha: string) =>
  deliver(f, "check_suite", checkCompletedEvent("check_suite", REPO, sha, [PR]));

/** The head the guards see: the newest ci_run (docs/guards.md). */
const head = async (f: IngestFixture): Promise<Evidence | undefined> =>
  (await f.evidence("ci_run")).at(-1);

describe("CI conclusion over check runs (unit: ADR 0113 section 5, D-160)", () => {
  const ok = (runs: CheckRun[]) => conclude(runs, RUNNER_APP)?.conclusion ?? null;

  it("is null while any check runs, and when there are none", () => {
    expect(ok([])).toBeNull();
    expect(ok([...passing("lint"), check("test", "queued")])).toBeNull();
  });

  it("passes on success, neutral and skipped, and fails on anything else", () => {
    expect(
      ok([
        ...passing("lint"),
        check("docs", "completed", "skipped"),
        check("info", "completed", "neutral"),
      ]),
    ).toBe("success");
    for (const bad of ["failure", "cancelled", "timed_out", "action_required"]) {
      expect(ok([...passing("lint"), check("test", "completed", bad)])).toBe("failure");
    }
  });

  it("ignores the runner App's own QA check run, finished or not", () => {
    const failedQa = check(QA_CHECK_RUN, "completed", "failure", RUNNER_APP);
    const runningQa = check(QA_CHECK_RUN, "in_progress", null, RUNNER_APP);
    expect(ok([...passing("build"), failedQa])).toBe("success");
    expect(ok([...passing("build"), runningQa])).toBe("success");
    expect(ok([failedQa])).toBeNull();
  });

  it("counts a check named QA that another App created", () => {
    expect(ok([...passing("build"), check(QA_CHECK_RUN, "completed", "failure")])).toBe(
      "failure",
    );
    expect(ok([...passing("build"), check(QA_CHECK_RUN, "in_progress")])).toBeNull();
    expect(
      ok([
        ...passing("build"),
        check(QA_CHECK_RUN, "completed", "failure", "other-app"),
      ]),
    ).toBe("failure");
  });

  it("names the attempt by the highest counted check run id, which a rerun raises", () => {
    const first = [...passing("build", "test")];
    const qa = check(QA_CHECK_RUN, "completed", "success", RUNNER_APP);
    expect(conclude([...first, qa], RUNNER_APP)?.attempt).toBe(
      Math.max(...first.map((run) => run.id)),
    );
    const rerun = [first[0]!, check("test", "completed", "success")];
    expect(conclude(rerun, RUNNER_APP)!.attempt).toBeGreaterThan(
      conclude(first, RUNNER_APP)!.attempt,
    );
  });
});

describe("webhook deliveries to evidence (unit: GitHub ingestion, ADR 0113)", () => {
  it("records a pending ci_run for the new head when a PR opens, with the changed paths", async () => {
    const f = await createIngestFixture();
    const result = await opened(f);
    expect(result).toMatchObject({ outcome: "recorded", repo: REPO, pr: PR });
    const [row] = await f.evidence("ci_run");
    expect(row).toMatchObject({
      commitSha: SHA_A,
      payload: { conclusion: "pending", pr: PR, changedPaths: CHANGED },
      ref: ciRunKey(REPO, PR, SHA_A, "pending"),
      recordedBy: "github",
      runId: null,
    });
  });

  it("records one evidence row when the same delivery is replayed", async () => {
    const f = await createIngestFixture();
    const payload = pullRequestEvent("opened", await f.pr());
    const first = await deliver(f, "pull_request", payload, "delivery-1");
    const replay = await deliver(f, "pull_request", payload, "delivery-1");
    expect(first.outcome).toBe("recorded");
    expect(replay).toMatchObject({ outcome: "duplicate", evidenceIds: [] });
    expect(await f.evidence()).toHaveLength(1);
    // The receiver records the delivery and hands it on; the flow records the evidence (O-128).
    expect(await f.store.getGithubDelivery("delivery-1")).toMatchObject({
      eventType: "pull_request",
      repository: REPO,
      outcome: "recorded",
      reason: HANDED_ON,
    });
    expect(replay.received.handedOn).toBeNull();
  });

  it("records the same fact once even under a new delivery id (the ingest key)", async () => {
    const f = await createIngestFixture();
    await opened(f);
    const again = await deliver(
      f,
      "pull_request",
      pullRequestEvent("reopened", await f.pr()),
    );
    expect(again.outcome).toBe("ignored");
    expect(await f.evidence()).toHaveLength(1);
  });

  it("records the final result when checks finish on the head, excluding the QA check run", async () => {
    const f = await createIngestFixture();
    await opened(f);
    const counted = passing("build", "test");
    f.github.setCheckRuns(REPO, SHA_A, [
      ...counted,
      check(QA_CHECK_RUN, "completed", "failure", RUNNER_APP),
    ]);
    expect((await checksDone(f, SHA_A)).outcome).toBe("recorded");
    expect(await head(f)).toMatchObject({
      commitSha: SHA_A,
      payload: { conclusion: "success", pr: PR, changedPaths: CHANGED },
      ref: ciRunKey(REPO, PR, SHA_A, "success", counted[1]!.id),
    });
    const guard = await GUARDS.ci_green_on_head!({
      node: (await f.store.getNode(f.nodeId))!,
      store: f.store,
    });
    expect(guard.pass).toBe(true);
  });

  it("records a failure when any counted check run fails, from a workflow_run event too", async () => {
    const f = await createIngestFixture();
    f.github.setCheckRuns(REPO, SHA_A, [
      ...passing("build"),
      check("test", "completed", "failure"),
    ]);
    const result = await deliver(
      f,
      "workflow_run",
      checkCompletedEvent("workflow_run", REPO, SHA_A, [PR]),
    );
    expect(result.outcome).toBe("recorded");
    expect((await head(f))?.payload).toMatchObject({ conclusion: "failure" });
  });

  it("names the head whose CI just ended, once: never a pending result, a replay or a fact already recorded (O-101)", async () => {
    const f = await createIngestFixture();
    expect((await opened(f)).finishedCi).toEqual([]);
    f.github.setCheckRuns(REPO, SHA_A, [
      ...passing("build"),
      check("test", "completed", "failure"),
    ]);
    const ended = await checksDone(f, SHA_A);
    expect(ended).toMatchObject({ outcome: "recorded" });
    expect(ended.finishedCi).toEqual([{ nodeId: f.nodeId, commitSha: SHA_A }]);
    const payload = checkCompletedEvent("workflow_run", REPO, SHA_A, [PR]);
    const same = await deliver(f, "workflow_run", payload, "delivery-same");
    expect(same).toMatchObject({ outcome: "ignored", finishedCi: [] });
    expect(
      (await deliver(f, "workflow_run", payload, "delivery-same")).finishedCi,
    ).toEqual([]);
    // A rerun is a new CI attempt on the same head, so its end is named again.
    f.github.setCheckRuns(REPO, SHA_A, passing("build", "test"));
    expect((await checksDone(f, SHA_A)).finishedCi).toEqual([
      { nodeId: f.nodeId, commitSha: SHA_A },
    ]);
  });

  it("records nothing while other checks on the head are still running", async () => {
    const f = await createIngestFixture();
    await opened(f);
    const result = await checksDone(f, SHA_A);
    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "checks still running",
    });
    expect(await f.evidence()).toHaveLength(1);
  });

  it("ignores a check completion on an older commit, so the head never moves back", async () => {
    const f = await createIngestFixture();
    await opened(f);
    f.github.pushHead(REPO, PR, SHA_B);
    await opened(f, "synchronize");
    f.github.setCheckRuns(REPO, SHA_A, passing("build"));
    const late = await checksDone(f, SHA_A);
    expect(late).toMatchObject({ outcome: "ignored", reason: "not the current head" });
    expect((await f.evidence("ci_run")).map((e) => e.commitSha)).toEqual([
      SHA_A,
      SHA_B,
    ]);
    expect((await head(f))?.commitSha).toBe(SHA_B);
  });

  it("ignores a pull_request event whose head GitHub no longer reports", async () => {
    const f = await createIngestFixture();
    const stale = pullRequestEvent("opened", await f.pr());
    f.github.pushHead(REPO, PR, SHA_B);
    expect((await deliver(f, "pull_request", stale)).reason).toBe(
      "not the current head",
    );
    expect(await f.evidence()).toHaveLength(0);
  });

  it("never lets a late pending event hide a finished result on the same commit", async () => {
    const f = await createIngestFixture();
    f.github.setCheckRuns(REPO, SHA_A, passing("build"));
    await checksDone(f, SHA_A);
    const late = await opened(f);
    expect(late).toMatchObject({
      outcome: "ignored",
      reason: "head already has a ci_run",
    });
    expect((await head(f))?.payload).toMatchObject({ conclusion: "success" });
  });

  it("records failure, success, failure on one commit as three results, newest failing", async () => {
    const f = await createIngestFixture();
    const green = async () =>
      (
        await GUARDS.ci_green_on_head!({
          node: (await f.store.getNode(f.nodeId))!,
          store: f.store,
        })
      ).pass;
    for (const conclusion of ["failure", "success", "failure"]) {
      // Each rerun creates a new check run, with a new id (the CI attempt).
      f.github.setCheckRuns(REPO, SHA_A, [check("test", "completed", conclusion)]);
      expect((await checksDone(f, SHA_A)).outcome).toBe("recorded");
      expect(await green()).toBe(conclusion === "success");
    }
    const rows = await f.evidence("ci_run");
    expect(rows.map((e) => e.payload)).toMatchObject([
      { conclusion: "failure" },
      { conclusion: "success" },
      { conclusion: "failure" },
    ]);
    expect(new Set(rows.map((e) => e.ref)).size).toBe(3);
    expect((await head(f))?.payload).toMatchObject({ conclusion: "failure" });
  });

  it("records one CI attempt once, whether a webhook or a poll sees it first", async () => {
    const f = await createIngestFixture();
    const attempt = [check("test", "completed", "failure")];
    f.github.setCheckRuns(REPO, SHA_A, attempt);
    const payload = checkCompletedEvent("check_suite", REPO, SHA_A, [PR]);
    expect((await deliver(f, "check_suite", payload, "attempt-1")).outcome).toBe(
      "recorded",
    );
    expect((await deliver(f, "check_suite", payload, "attempt-1")).outcome).toBe(
      "duplicate",
    );
    expect((await deliver(f, "check_suite", payload)).outcome).toBe("ignored");
    expect((await pollRepository(f.deps, REPO)).map((r) => r.outcome)).toEqual([
      "ignored",
    ]);
    expect((await f.evidence("ci_run")).map((e) => e.ref)).toEqual([
      ciRunKey(REPO, PR, SHA_A, "failure", attempt[0]!.id),
    ]);
  });

  it("records a check rerun that changes the result on the head", async () => {
    const f = await createIngestFixture();
    f.github.setCheckRuns(REPO, SHA_A, [check("test", "completed", "failure")]);
    await checksDone(f, SHA_A);
    f.github.setCheckRuns(REPO, SHA_A, passing("test"));
    await checksDone(f, SHA_A);
    expect((await f.evidence("ci_run")).map((e) => e.payload)).toMatchObject([
      { conclusion: "failure" },
      { conclusion: "success" },
    ]);
  });

  it("records the merge commit once when a linked PR is merged", async () => {
    const f = await createIngestFixture();
    f.github.merge(REPO, PR, MERGE_SHA);
    const closed = pullRequestEvent("closed", await f.pr());
    expect((await deliver(f, "pull_request", closed)).outcome).toBe("recorded");
    expect((await deliver(f, "pull_request", closed)).outcome).toBe("ignored");
    const merges = await f.evidence("merge_commit");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      commitSha: MERGE_SHA,
      payload: { pr: PR },
      ref: mergeCommitKey(REPO, PR),
    });
  });

  it("records nothing for a PR closed without merging", async () => {
    const f = await createIngestFixture();
    const pr = { ...(await f.pr()), state: "closed" as const };
    const result = await deliver(f, "pull_request", pullRequestEvent("closed", pr));
    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "closed without merging",
    });
  });

  it.each(["deployment_status", "push"])(
    "records only the delivery for %s, never evidence",
    async (event) => {
      const f = await createIngestFixture();
      const result = await deliver(
        f,
        event,
        { repository: { full_name: REPO } },
        "d-1",
      );
      expect(result).toMatchObject({
        outcome: "ignored",
        reason: "not evidence by itself",
      });
      expect(await f.evidence()).toHaveLength(0);
      expect((await f.store.getGithubDelivery("d-1"))?.outcome).toBe("ignored");
    },
  );

  it("records a deployment_status delivery and names nothing in it: nothing starts on one (D-356, O-116)", async () => {
    const f = await createIngestFixture();
    const event = deploymentStatusEvent(REPO, MERGE_SHA, "staging", "success");
    const delivery = { id: "d-1", event: "deployment_status", payload: event };
    const fresh = await receiveDelivery(f.deps, delivery);
    expect(fresh).toEqual({
      outcome: "ignored",
      reason: "not evidence by itself",
      repo: REPO,
      pr: null,
      handedOn: null,
    });
    expect("deployment" in fresh).toBe(false);
    expect((await f.store.getGithubDelivery("d-1"))?.outcome).toBe("ignored");
    expect(await f.evidence()).toHaveLength(0);
    expect(await receiveDelivery(f.deps, delivery)).toMatchObject({
      outcome: "duplicate",
      handedOn: null,
    });
    expect(f.github.reads).toBe(0);
  });

  it("stores nothing for an event type it does not read", async () => {
    const f = await createIngestFixture();
    const result = await deliver(
      f,
      "issues",
      { repository: { full_name: REPO } },
      "d-1",
    );
    expect(result.outcome).toBe("unhandled");
    expect(await f.store.getGithubDelivery("d-1")).toBeNull();
    expect(f.github.reads).toBe(0);
  });

  it("records a signed payload it cannot read as rejected, with no evidence", async () => {
    const f = await createIngestFixture();
    const result = await deliver(
      f,
      "pull_request",
      { action: "opened", repository: { full_name: REPO } },
      "d-1",
    );
    expect(result).toMatchObject({ outcome: "rejected", reason: "malformed payload" });
    expect((await f.store.getGithubDelivery("d-1"))?.outcome).toBe("rejected");
    expect(await f.evidence()).toHaveLength(0);
  });
});

describe("linking a PR to a node (unit: ADR 0113 section 4)", () => {
  it("ignores a PR from a branch no node was dispatched on", async () => {
    const f = await createIngestFixture();
    f.github.putPullRequest({ ...(await f.pr()), headBranch: "someone/else" });
    const result = await opened(f);
    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "no node dispatched on this branch",
    });
    expect(await f.evidence()).toHaveLength(0);
  });

  it("ignores a fork PR, even on the dispatched branch name", async () => {
    const f = await createIngestFixture();
    f.github.putPullRequest({ ...(await f.pr()), headRepo: "someone/rehearsal" });
    expect((await opened(f)).reason).toBe("fork pull request");
    expect(await f.evidence()).toHaveLength(0);
  });

  it("ignores a PR not opened by the Developer or Designer App", async () => {
    const f = await createIngestFixture();
    f.github.putPullRequest({ ...(await f.pr()), author: "a-person" });
    expect((await opened(f)).reason).toBe("author is not a factory App");
    expect(await f.evidence()).toHaveLength(0);
  });

  it("links a PR opened by the Designer App", async () => {
    const f = await createIngestFixture();
    f.github.putPullRequest({ ...(await f.pr()), author: DESIGNER_APP });
    expect((await opened(f)).outcome).toBe("recorded");
  });

  it("follows the node's latest dispatch record only", async () => {
    const f = await createIngestFixture();
    await f.redispatch(f.nodeId, "foreman/item-1-retry");
    expect((await opened(f)).reason).toBe("no node dispatched on this branch");
  });

  it("refuses to guess when two nodes name the same branch", async () => {
    const f = await createIngestFixture();
    await f.dispatchNode(BRANCH);
    expect((await opened(f)).reason).toBe("branch dispatched to more than one node");
  });

  it("does not link a node dispatched for another repository", async () => {
    const f = await createIngestFixture();
    await f.redispatch(f.nodeId, BRANCH);
    const other = await f.dispatchNode(BRANCH, "didi-build/elsewhere");
    expect((await opened(f)).outcome).toBe("recorded");
    expect(await f.store.listEvidence({ nodeId: other, kind: "ci_run" })).toHaveLength(
      0,
    );
  });
});

describe("polling backstop (unit: ADR 0113 section 6, M2.4)", () => {
  it("records the open PR's head, then its result, then its merge, and nothing twice", async () => {
    const f = await createIngestFixture();
    expect((await pollRepository(f.deps, REPO)).map((r) => r.outcome)).toEqual([
      "recorded",
    ]);
    expect((await head(f))?.payload).toMatchObject({ conclusion: "pending" });
    expect((await pollRepository(f.deps, REPO)).map((r) => r.outcome)).toEqual([
      "ignored",
    ]);

    const finished = passing("build");
    f.github.setCheckRuns(REPO, SHA_A, finished);
    await pollRepository(f.deps, REPO);
    expect((await head(f))?.payload).toMatchObject({ conclusion: "success" });

    f.github.merge(REPO, PR, MERGE_SHA);
    await pollRepository(f.deps, REPO);
    await pollRepository(f.deps, REPO);
    expect((await f.evidence()).map((e) => e.ref)).toEqual([
      ciRunKey(REPO, PR, SHA_A, "pending"),
      ciRunKey(REPO, PR, SHA_A, "success", finished[0]!.id),
      mergeCommitKey(REPO, PR),
    ]);
  });

  it("adds nothing after the webhooks already recorded every fact", async () => {
    const f = await createIngestFixture();
    await opened(f);
    f.github.setCheckRuns(REPO, SHA_A, passing("build"));
    await checksDone(f, SHA_A);
    const before = await f.evidence();
    const results = await pollRepository(f.deps, REPO);
    expect(results.every((r) => r.outcome === "ignored")).toBe(true);
    expect(await f.evidence()).toEqual(before);
  });

  it("links through the same rules, so a fork or foreign PR stays unlinked", async () => {
    const f = await createIngestFixture();
    f.github.putPullRequest({ ...(await f.pr()), author: "a-person" });
    f.github.putPullRequest({ ...(await f.pr()), number: 8, headRepo: "someone/fork" });
    const results = await pollRepository(f.deps, REPO);
    expect(results.map((r) => r.reason)).toEqual([
      "author is not a factory App",
      "fork pull request",
    ]);
    expect(await f.evidence()).toHaveLength(0);
  });

  it("records the same evidence with the receiver down as with webhooks (kill the receiver)", async () => {
    // One PR's life: opened, checks fail, a fix is pushed, checks pass, merged. Each step is
    // followed either by its webhook or, with the receiver down, by a reconcile pass.
    // Both runs see the same check runs, ids included, as GitHub would report them.
    const failedA = [check("test", "completed", "failure")];
    const runningB = [check("test", "in_progress")];
    const passedB = passing("test");
    type Step = (f: IngestFixture) => Promise<unknown>;
    const life: { change: (f: IngestFixture) => void; webhook: Step }[] = [
      { change: () => undefined, webhook: (f) => opened(f) },
      {
        change: (f) => f.github.setCheckRuns(REPO, SHA_A, failedA),
        webhook: (f) => checksDone(f, SHA_A),
      },
      {
        change: (f) => {
          f.github.pushHead(REPO, PR, SHA_B);
          f.github.setCheckRuns(REPO, SHA_B, runningB);
        },
        webhook: (f) => opened(f, "synchronize"),
      },
      {
        change: (f) => f.github.setCheckRuns(REPO, SHA_B, passedB),
        webhook: (f) => checksDone(f, SHA_B),
      },
      {
        change: (f) => f.github.merge(REPO, PR, MERGE_SHA),
        webhook: async (f) =>
          deliver(f, "pull_request", pullRequestEvent("closed", await f.pr())),
      },
    ];
    const facts = async (f: IngestFixture) =>
      (await f.evidence()).map(({ kind, ref, commitSha, payload }) => ({
        kind,
        ref,
        commitSha,
        payload,
      }));

    const withWebhooks = await createIngestFixture();
    const withPolling = await createIngestFixture();
    for (const step of life) {
      step.change(withWebhooks);
      await step.webhook(withWebhooks);
      step.change(withPolling);
      await pollRepository(withPolling.deps, REPO);
    }
    expect(await facts(withPolling)).toEqual(await facts(withWebhooks));
    expect((await facts(withWebhooks)).map((e) => e.ref)).toEqual([
      ciRunKey(REPO, PR, SHA_A, "pending"),
      ciRunKey(REPO, PR, SHA_A, "failure", failedA[0]!.id),
      ciRunKey(REPO, PR, SHA_B, "pending"),
      ciRunKey(REPO, PR, SHA_B, "success", passedB[0]!.id),
      mergeCommitKey(REPO, PR),
    ]);
  });
});

describe("what the receiver decides from the signed payload alone, and what it hands on (unit: D-381, O-128)", () => {
  const decide = (event: string, payload: unknown, id = "delivery-x") =>
    decideDelivery({ id, event, payload });
  const open = async (f: IngestFixture) => f.pr();
  /** A completion of `event` on `sha` naming these pull requests, as GitHub sends it. */
  const completed = (
    event: "check_suite" | "workflow_run",
    sha: string,
    prs: number[],
  ) => checkCompletedEvent(event, REPO, sha, prs);

  it("hands on new commits on a pull request with the delivery id, event, action, repository, the PR's number and the head commit, and nothing else", async () => {
    const f = await createIngestFixture();
    for (const action of ["opened", "reopened", "synchronize"] as const) {
      const payload = pullRequestEvent(action, await open(f));
      expect(decide("pull_request", payload)).toEqual({
        kind: "handed_on",
        repo: REPO,
        pr: PR,
        delivery: {
          deliveryId: "delivery-x",
          event: "pull_request",
          action,
          repo: REPO,
          pullRequests: [PR],
          headSha: SHA_A,
        },
      });
    }
  });

  it("hands on a merged pull request by its number only, and decides one closed without merging alone", async () => {
    const f = await createIngestFixture();
    f.github.merge(REPO, PR, MERGE_SHA);
    expect(decide("pull_request", pullRequestEvent("closed", await open(f)))).toEqual({
      kind: "handed_on",
      repo: REPO,
      pr: PR,
      delivery: {
        deliveryId: "delivery-x",
        event: "pull_request",
        action: "closed",
        repo: REPO,
        pullRequests: [PR],
        headSha: null,
      },
    });
    const notMerged = { ...(await open(f)), state: "closed" as const, merged: false };
    expect(decide("pull_request", pullRequestEvent("closed", notMerged))).toEqual({
      kind: "ignored",
      repo: REPO,
      pr: PR,
      reason: "closed without merging",
    });
  });

  it("hands on CI's end on a commit with each pull request GitHub lists, once, and the commit", () => {
    for (const event of ["check_suite", "workflow_run"] as const) {
      expect(decide(event, completed(event, SHA_B, [PR, 9, PR]))).toEqual({
        kind: "handed_on",
        repo: REPO,
        pr: PR,
        delivery: {
          deliveryId: "delivery-x",
          event,
          action: "completed",
          repo: REPO,
          pullRequests: [PR, 9],
          headSha: SHA_B,
        },
      });
    }
  });

  it("decides alone, as ingestion did before, every delivery that needs no GitHub read", async () => {
    const f = await createIngestFixture();
    const pr = await open(f);
    const cases: [string, unknown, number | null, string][] = [
      [
        "pull_request",
        pullRequestEvent("edited", pr),
        PR,
        "pull request action not used",
      ],
      [
        "pull_request",
        { ...pullRequestEvent("opened", pr), action: "labeled" },
        PR,
        "pull request action not used",
      ],
      [
        "check_suite",
        { ...completed("check_suite", SHA_A, [PR]), action: "requested" },
        null,
        "not a completion",
      ],
      [
        "workflow_run",
        { ...completed("workflow_run", SHA_A, [PR]), action: "in_progress" },
        null,
        "not a completion",
      ],
      [
        "workflow_run",
        completed("workflow_run", SHA_A, []),
        null,
        "no pull request for this commit",
      ],
      // A commit that is not a full commit id, on a run naming no pull request: decided alone,
      // so it is read as before.
      [
        "check_suite",
        completed("check_suite", "not-a-commit", []),
        null,
        "no pull request for this commit",
      ],
      [
        "deployment_status",
        { repository: { full_name: REPO } },
        null,
        "not evidence by itself",
      ],
      ["push", { repository: { full_name: REPO } }, null, "not evidence by itself"],
    ];
    for (const [event, payload, number, reason] of cases) {
      expect(decide(event, payload), `${event} ${reason}`).toEqual({
        kind: "ignored",
        repo: REPO,
        pr: number,
        reason,
      });
    }
    expect(decide("issue_comment", { repository: { full_name: REPO } })).toEqual({
      kind: "unhandled",
      repo: REPO,
    });
  });

  it("rejects a signed payload it cannot read, and hands on only a full commit id and an `owner/name` repository", async () => {
    const f = await createIngestFixture();
    const pr = await open(f);
    const opened = pullRequestEvent("opened", pr) as {
      pull_request: Record<string, unknown>;
    };
    const payloads: [string, unknown][] = [
      ["pull_request", { action: "opened", repository: { full_name: REPO } }],
      ["pull_request", { ...opened, repository: undefined }],
      [
        "pull_request",
        { ...opened, pull_request: { ...opened.pull_request, number: 0 } },
      ],
      [
        "pull_request",
        { ...opened, pull_request: { ...opened.pull_request, number: 1.5 } },
      ],
      ["pull_request", pullRequestEvent("opened", { ...pr, headSha: "a".repeat(39) })],
      ["pull_request", pullRequestEvent("opened", { ...pr, headSha: "A".repeat(40) })],
      ["pull_request", pullRequestEvent("opened", { ...pr, repo: "not a repository" })],
      ["check_suite", completed("check_suite", "a".repeat(41), [PR])],
      ["workflow_run", { ...completed("workflow_run", SHA_A, []), workflow_run: {} }],
      [
        "check_suite",
        {
          action: "completed",
          repository: { full_name: REPO },
          check_suite: { head_sha: SHA_A, pull_requests: [{ number: "7" }] },
        },
      ],
      ["deployment_status", {}],
      ["push", null],
    ];
    for (const [event, payload] of payloads) {
      expect(decide(event, payload).kind, JSON.stringify(payload)).toBe("rejected");
    }
  });

  it("hands on no title, body, branch name, login, merge commit or other payload text", async () => {
    const f = await createIngestFixture();
    f.github.merge(REPO, PR, MERGE_SHA);
    const pr = await open(f);
    const delivered = [
      decide("pull_request", {
        ...pullRequestEvent("synchronize", pr),
        sender: { login: "a-person" },
      }),
      decide("pull_request", pullRequestEvent("closed", pr)),
      decide("check_suite", {
        ...completed("check_suite", SHA_A, [PR]),
        check_suite: {
          head_sha: SHA_A,
          head_branch: BRANCH,
          pull_requests: [{ number: PR, head: { ref: BRANCH, sha: SHA_A } }],
        },
      }),
    ];
    for (const decision of delivered) {
      expect(decision.kind).toBe("handed_on");
      const sent = decision.kind === "handed_on" ? decision.delivery : null;
      expect(Object.keys(sent ?? {}).sort()).toEqual(
        ["action", "deliveryId", "event", "headSha", "pullRequests", "repo"].sort(),
      );
      const text = JSON.stringify(sent);
      for (const leak of [
        BRANCH,
        DEVELOPER_APP,
        "a-person",
        MERGE_SHA,
        "Text from the PR body",
        "main",
      ]) {
        expect(text, leak).not.toContain(leak);
      }
    }
  });

  it("records the delivery as recorded and handed on, reads nothing from GitHub and writes no evidence; a replay hands nothing on", async () => {
    const f = await createIngestFixture();
    const delivery = {
      id: "receive-1",
      event: "check_suite",
      payload: completed("check_suite", SHA_A, [PR]),
    };
    const first = await receiveDelivery(f.deps, delivery);
    expect(first).toEqual({
      outcome: "recorded",
      reason: HANDED_ON,
      repo: REPO,
      pr: PR,
      handedOn: {
        deliveryId: "receive-1",
        event: "check_suite",
        action: "completed",
        repo: REPO,
        pullRequests: [PR],
        headSha: SHA_A,
      },
    });
    expect(await f.store.getGithubDelivery("receive-1")).toMatchObject({
      eventType: "check_suite",
      repository: REPO,
      outcome: "recorded",
      reason: HANDED_ON,
    });
    expect(f.github.reads).toBe(0);
    expect(await f.evidence()).toEqual([]);
    expect(await receiveDelivery(f.deps, delivery)).toEqual({
      outcome: "duplicate",
      reason: null,
      repo: REPO,
      pr: PR,
      handedOn: null,
    });
    // Two copies at once: the store records the id once, so one of them is handed on.
    const race = { ...delivery, id: "receive-2" };
    const copies = await Promise.all([
      receiveDelivery(f.deps, race),
      receiveDelivery(f.deps, race),
    ]);
    expect(copies.filter((c) => c.handedOn !== null)).toHaveLength(1);
    expect(f.github.reads).toBe(0);
  });

  it("records a delivery decided alone as ignored or rejected, and hands nothing on", async () => {
    const f = await createIngestFixture();
    const ignored = await receiveDelivery(f.deps, {
      id: "alone-1",
      event: "workflow_run",
      payload: completed("workflow_run", SHA_A, []),
    });
    expect(ignored).toMatchObject({ outcome: "ignored", handedOn: null });
    const rejected = await receiveDelivery(f.deps, {
      id: "alone-2",
      event: "pull_request",
      payload: { action: "opened", repository: { full_name: REPO } },
    });
    expect(rejected).toMatchObject({
      outcome: "rejected",
      reason: "malformed payload",
      handedOn: null,
    });
    expect((await f.store.getGithubDelivery("alone-2"))?.outcome).toBe("rejected");
    expect(f.github.reads).toBe(0);
  });
});

describe("the ingest flow's input and what it records (unit: D-381, O-128)", () => {
  const handedOn: HandedOnDelivery = {
    deliveryId: "delivery-1",
    event: "check_suite",
    action: "completed",
    repo: REPO,
    pullRequests: [PR],
    headSha: SHA_A,
  };

  it("reads exactly what the receiver hands on, and refuses anything else", () => {
    expect(readHandedOnDelivery(JSON.parse(JSON.stringify(handedOn)))).toEqual(
      handedOn,
    );
    const pending = {
      ...handedOn,
      event: "pull_request",
      action: "synchronize",
    };
    expect(readHandedOnDelivery(pending)).toEqual(pending);
    const merged = { ...pending, action: "closed", headSha: null };
    expect(readHandedOnDelivery(merged)).toEqual(merged);
    const refused: unknown[] = [
      null,
      "delivery-1",
      [handedOn],
      { ...handedOn, title: "a title" },
      { ...handedOn, branch: BRANCH },
      { ...handedOn, deliveryId: "has spaces" },
      { ...handedOn, deliveryId: "x".repeat(101) },
      { ...handedOn, repo: "didi-build" },
      { ...handedOn, repo: "didi-build/a/b" },
      { ...handedOn, pullRequests: [] },
      { ...handedOn, pullRequests: [0] },
      { ...handedOn, pullRequests: ["7"] },
      { ...handedOn, pullRequests: 7 },
      { ...handedOn, headSha: null },
      { ...handedOn, headSha: "a".repeat(39) },
      { ...handedOn, action: "requested" },
      { ...handedOn, event: "deployment_status" },
      { ...pending, pullRequests: [PR, 8] },
      { ...pending, headSha: null },
      { ...pending, action: "edited" },
      { ...merged, headSha: SHA_A },
      { ...handedOn, headSha: undefined },
    ];
    for (const input of refused)
      expect(readHandedOnDelivery(input), JSON.stringify(input)).toBeNull();
  });

  it("reads GitHub again and trusts nothing but the identifiers: a head that moved since records nothing", async () => {
    const f = await createIngestFixture();
    f.github.setCheckRuns(REPO, SHA_A, passing("build"));
    f.github.pushHead(REPO, PR, SHA_B);
    expect(await ingestHandedOn(f.deps, handedOn)).toEqual({
      outcome: "ignored",
      reason: "not the current head",
      pr: PR,
      evidenceIds: [],
      finishedCi: [],
    });
    expect(await f.evidence()).toEqual([]);
  });

  it("records under the polling backstop's keys, so a delivery and a poll record each fact once, whichever comes first", async () => {
    const f = await createIngestFixture();
    const finished = passing("build");
    f.github.setCheckRuns(REPO, SHA_A, finished);
    const first = await ingestHandedOn(f.deps, handedOn);
    expect(first).toMatchObject({
      outcome: "recorded",
      finishedCi: [{ nodeId: f.nodeId, commitSha: SHA_A }],
    });
    expect((await pollRepository(f.deps, REPO)).map((r) => r.outcome)).toEqual([
      "ignored",
    ]);
    // A second start for the same fact (another delivery of the same CI end) records nothing
    // and names no finished head, so nothing follows twice.
    expect(
      await ingestHandedOn(f.deps, { ...handedOn, deliveryId: "delivery-2" }),
    ).toEqual({
      outcome: "ignored",
      reason: "already recorded",
      pr: PR,
      evidenceIds: [],
      finishedCi: [],
    });
    // The merge: the poll sees the open PR's head, then the merge, before the delivery's flow.
    const merged = await createIngestFixture();
    await pollRepository(merged.deps, REPO);
    merged.github.merge(REPO, PR, MERGE_SHA);
    await pollRepository(merged.deps, REPO);
    expect(
      await ingestHandedOn(merged.deps, {
        deliveryId: "delivery-3",
        event: "pull_request",
        action: "closed",
        repo: REPO,
        pullRequests: [PR],
        headSha: null,
      }),
    ).toMatchObject({ outcome: "ignored", evidenceIds: [] });
    expect((await merged.evidence("merge_commit")).map((e) => e.ref)).toEqual([
      mergeCommitKey(REPO, PR),
    ]);
    expect((await f.evidence("ci_run")).map((e) => e.ref)).toEqual([
      ciRunKey(REPO, PR, SHA_A, "success", finished[0]!.id),
    ]);
  });

  it("records nothing for a pull request GitHub does not know", async () => {
    const f = await createIngestFixture();
    expect(
      await ingestHandedOn(f.deps, { ...handedOn, pullRequests: [404] }),
    ).toMatchObject({ outcome: "ignored", reason: "pull request not found", pr: 404 });
  });
});
