// Seam: CI's preview check in GitHub ingestion (unit with the fake GitHub and the memory store,
// D-354, O-111). With a final CI result on a PR head, ingestion reads the named job of the named
// workflow on that head and records its conclusion as `preview_check`: passing only on `success`,
// from the webhook and the polling backstop under one key, again on a rerun, and nothing for a job
// of another name or workflow, a fork's run, another commit or event, or a job still running. The
// guard `qa_verdict_independent_on_head` then passes on a passing check from this source and
// refuses a failing one. Fake data only; no network.
import { describe, expect, it } from "vitest";

import { checkCompletedEvent, pullRequestEvent } from "../src/adapters/github/fake.ts";
import { ingestDelivery, pollRepository } from "../src/core/github-ingest.ts";
import type { WorkflowJob, WorkflowRun } from "../src/core/github.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import {
  PREVIEW_CHECK_JOB,
  PREVIEW_CHECK_WORKFLOW,
  PREVIEW_CHECK_WORKFLOW_FILE,
  previewCheckKey,
} from "../src/core/preview-check.ts";
import { testRouteColumns } from "../src/core/routing-testing.ts";
import { REHEARSAL_RUN_LIMITS } from "../src/core/runs.ts";
import type { Evidence } from "../src/core/store.ts";
import {
  PR,
  REPO,
  SHA_A,
  SHA_B,
  check,
  createIngestFixture,
  passing,
  type IngestFixture,
} from "./github-fixture.ts";
import { createReconcileFixture } from "./reconcile-fixture.ts";

const RUN_ID = 501;

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: RUN_ID,
  path: PREVIEW_CHECK_WORKFLOW,
  event: "pull_request",
  headSha: SHA_A,
  headRepo: REPO,
  ...overrides,
});

let jobIds = 9000;
const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id: ++jobIds,
  runId: RUN_ID,
  name: PREVIEW_CHECK_JOB,
  headSha: SHA_A,
  status: "completed",
  conclusion: "success",
  ...overrides,
});

/** CI finished on the head: every check run done, and GitHub lists these runs and jobs. */
function ciFinished(
  f: IngestFixture,
  runs: WorkflowRun[],
  jobs: Record<number, WorkflowJob[]>,
  sha = SHA_A,
): void {
  f.github.setCheckRuns(REPO, sha, passing("check", PREVIEW_CHECK_JOB));
  f.github.setWorkflowRuns(REPO, PREVIEW_CHECK_WORKFLOW_FILE, sha, runs);
  for (const [id, list] of Object.entries(jobs))
    f.github.setWorkflowJobs(REPO, Number(id), list);
}

const deliver = (f: IngestFixture, event: string, payload: unknown) =>
  ingestDelivery(f.deps, { id: f.nextDeliveryId(), event, payload });

const checksDone = (f: IngestFixture, sha = SHA_A) =>
  deliver(f, "check_suite", checkCompletedEvent("check_suite", REPO, sha, [PR]));

const previews = (f: IngestFixture): Promise<Evidence[]> => f.evidence("preview_check");

describe("CI's preview check to evidence (unit: GitHub ingestion, D-354, O-111)", () => {
  it("records the named job's success as a passing preview_check on the PR head", async () => {
    const f = await createIngestFixture();
    const passed = job();
    ciFinished(f, [run()], { [RUN_ID]: [job({ name: "check" }), passed] });

    const result = await checksDone(f);

    expect(result.outcome).toBe("recorded");
    const [row] = await previews(f);
    const expected = {
      pass: true,
      conclusion: "success",
      workflowRunId: RUN_ID,
      jobId: passed.id,
    };
    expect(row).toMatchObject({
      nodeId: f.nodeId,
      commitSha: SHA_A,
      runId: null,
      recordedBy: "github",
      payload: { ...expected, pr: PR },
      ref: previewCheckKey(REPO, PR, SHA_A, expected),
    });
    expect(result.evidenceIds).toContain(row!.id);
    // The CI result is recorded as before, and only it names a finished head for the flows.
    expect((await f.evidence("ci_run")).at(-1)?.payload).toMatchObject({
      conclusion: "success",
    });
    expect(result.finishedCi).toEqual([{ nodeId: f.nodeId, commitSha: SHA_A }]);
  });

  it("records a failure, and every conclusion but success, as not passing", async () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "skipped",
      "neutral",
    ]) {
      const f = await createIngestFixture();
      ciFinished(f, [run()], { [RUN_ID]: [job({ conclusion })] });
      await checksDone(f);
      expect(
        (await previews(f)).map((e) => e.payload),
        conclusion,
      ).toMatchObject([{ pass: false, conclusion }]);
    }
  });

  it("reads nothing while CI is pending or still running on the head", async () => {
    const f = await createIngestFixture();
    ciFinished(f, [run()], { [RUN_ID]: [job()] });
    await deliver(f, "pull_request", pullRequestEvent("opened", await f.pr()));
    f.github.setCheckRuns(REPO, SHA_A, [check("check", "in_progress")]);
    expect((await checksDone(f)).reason).toBe("checks still running");
    expect(await previews(f)).toEqual([]);
  });

  it("records once from the webhook and the polling backstop, and a replay adds nothing", async () => {
    const f = await createIngestFixture();
    ciFinished(f, [run()], { [RUN_ID]: [job()] });
    const payload = checkCompletedEvent("check_suite", REPO, SHA_A, [PR]);
    const delivery = { id: "preview-delivery-1", event: "check_suite", payload };
    await ingestDelivery(f.deps, delivery);
    expect((await ingestDelivery(f.deps, delivery)).outcome).toBe("duplicate");
    await checksDone(f);
    await pollRepository(f.deps, REPO);
    expect(await previews(f)).toHaveLength(1);
  });

  it("records the polling backstop's preview check when no webhook came", async () => {
    const f = await createIngestFixture();
    ciFinished(f, [run()], { [RUN_ID]: [job({ conclusion: "failure" })] });
    const [polled] = await pollRepository(f.deps, REPO);
    expect(polled?.outcome).toBe("recorded");
    expect((await previews(f)).map((e) => e.payload)).toMatchObject([{ pass: false }]);
  });

  it("records a rerun again, and the newest wins", async () => {
    const f = await createIngestFixture();
    const pass = async () =>
      (
        await GUARDS.qa_verdict_independent_on_head!({
          node: (await f.store.getNode(f.nodeId))!,
          store: f.store,
        })
      ).detail;
    for (const conclusion of ["failure", "success", "failure"]) {
      // A rerun of the job is a new attempt of the same run, with a new job id.
      ciFinished(f, [run()], { [RUN_ID]: [job({ conclusion })] });
      expect((await checksDone(f)).outcome).toBe("recorded");
      expect(await pass()).toMatch(
        conclusion === "success" ? /no QA verdict/ : /preview check failed/,
      );
    }
    expect((await previews(f)).map((e) => e.payload)).toMatchObject([
      { pass: false },
      { pass: true },
      { pass: false },
    ]);
  });

  it("takes only the newest run of the workflow on the head, and waits while its job runs", async () => {
    const f = await createIngestFixture();
    ciFinished(f, [run(), run({ id: RUN_ID + 1 })], {
      [RUN_ID]: [job()],
      [RUN_ID + 1]: [
        job({ runId: RUN_ID + 1, status: "in_progress", conclusion: null }),
      ],
    });
    await checksDone(f);
    expect(await previews(f)).toEqual([]);

    f.github.setWorkflowJobs(REPO, RUN_ID + 1, [
      job({ runId: RUN_ID + 1, conclusion: "failure" }),
    ]);
    await checksDone(f);
    expect((await previews(f)).map((e) => e.payload)).toMatchObject([
      { pass: false, workflowRunId: RUN_ID + 1 },
    ]);
  });

  describe("records nothing from any other source", () => {
    const cases: [string, WorkflowRun[], WorkflowJob[]][] = [
      ["a job with another name", [run()], [job({ name: "preview-check-extra" })]],
      ["a job named in another case", [run()], [job({ name: "Preview-check" })]],
      ["two jobs with the name", [run()], [job(), job()]],
      ["another workflow", [run({ path: ".github/workflows/other.yml" })], [job()]],
      ["a fork's run", [run({ headRepo: "someone/rehearsal" })], [job()]],
      ["a run with no head repository", [run({ headRepo: null })], [job()]],
      ["a run on another commit", [run({ headSha: SHA_B })], [job()]],
      ["a job on another commit", [run()], [job({ headSha: SHA_B })]],
      ["a job of another run", [run()], [job({ runId: RUN_ID + 7 })]],
      ["a push run", [run({ event: "push" })], [job()]],
      ["a run started by hand", [run({ event: "workflow_dispatch" })], [job()]],
      [
        "a job still running",
        [run()],
        [job({ status: "in_progress", conclusion: null })],
      ],
      [
        "a job with a conclusion but not completed",
        [run()],
        [job({ status: "in_progress" })],
      ],
      ["a conclusion that is not a word", [run()], [job({ conclusion: "Success!" })]],
      ["no run of the workflow", [], []],
    ];
    for (const [label, runs, jobs] of cases) {
      it(label, async () => {
        const f = await createIngestFixture();
        ciFinished(f, runs, { [RUN_ID]: jobs });
        expect((await checksDone(f)).outcome).toBe("recorded");
        expect(await previews(f)).toEqual([]);
        // The CI result itself is still recorded.
        expect((await f.evidence("ci_run")).at(-1)?.payload).toMatchObject({
          conclusion: "success",
        });
      });
    }

    it("a job the workflow runs for another workflow file", async () => {
      // GitHub's answer for another file is never asked for, so it never counts.
      const f = await createIngestFixture();
      ciFinished(f, [], {});
      f.github.setWorkflowRuns(REPO, "other.yml", SHA_A, [run()]);
      f.github.setWorkflowJobs(REPO, RUN_ID, [job()]);
      await checksDone(f);
      expect(await previews(f)).toEqual([]);
    });

    it("a fork pull request, or a commit that is no longer the head", async () => {
      const fork = await createIngestFixture();
      fork.github.putPullRequest({
        ...(await fork.pr()),
        headRepo: "someone/rehearsal",
      });
      ciFinished(fork, [run()], { [RUN_ID]: [job()] });
      expect((await checksDone(fork)).reason).toBe("fork pull request");
      expect(await previews(fork)).toEqual([]);

      const moved = await createIngestFixture();
      ciFinished(moved, [run()], { [RUN_ID]: [job()] });
      moved.github.pushHead(REPO, PR, SHA_B);
      expect((await checksDone(moved, SHA_A)).reason).toBe("not the current head");
      expect(await previews(moved)).toEqual([]);
    });
  });

  it("records in dry run and under the kill switch on a webhook, like ci_run: a fact, not an act", async () => {
    const f = await createIngestFixture();
    for (const [key, value] of [
      ["dry_run", true],
      ["kill_switch", true],
    ] as const) {
      await f.store.setSetting({
        key,
        value,
        updatedBy: "test",
        updatedAt: f.deps.clock.now(),
      });
    }
    ciFinished(f, [run()], { [RUN_ID]: [job()] });
    await checksDone(f);
    expect(await previews(f)).toHaveLength(1);
  });
});

describe("the reconcile pass's polling backstop and CI's preview check (unit: ADR 0113 section 6)", () => {
  async function polled(killSwitch: boolean) {
    const f = await createReconcileFixture();
    const item = await f.node("in_development");
    await f.evidence(item.id, "dispatch_record", {
      repo: REPO,
      branch: "foreman/item-1",
    });
    f.github.putPullRequest({
      repo: REPO,
      number: PR,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headSha: SHA_A,
      headBranch: "foreman/item-1",
      headRepo: REPO,
      author: "foreman-developer[bot]",
    });
    f.github.setCheckRuns(REPO, SHA_A, passing(PREVIEW_CHECK_JOB));
    f.github.setWorkflowRuns(REPO, PREVIEW_CHECK_WORKFLOW_FILE, SHA_A, [run()]);
    f.github.setWorkflowJobs(REPO, RUN_ID, [job()]);
    if (killSwitch) await f.setting("kill_switch", true);
    const report = await f.pass();
    return {
      report,
      rows: await f.store.listEvidence({ nodeId: item.id, kind: "preview_check" }),
    };
  }

  it("records the preview check in dry run, and nothing under the kill switch", async () => {
    const dry = await polled(false);
    expect(dry.report.mode).toBe("dry_run");
    expect(dry.rows.map((e) => e.payload)).toMatchObject([{ pass: true }]);

    const stopped = await polled(true);
    expect(stopped.report.stopped).toBe("kill_switch");
    expect(stopped.rows).toEqual([]);
  });
});

describe("qa_verdict_independent_on_head on CI's preview check (unit: guard, ADR 0112, D-354)", () => {
  const MODEL_BUILDER = "claude-sonnet-5-5";
  const MODEL_QA = "claude-opus-5-5";

  async function runOf(
    f: IngestFixture,
    bot: "developer" | "qa",
    model: string,
  ): Promise<string> {
    const id = f.deps.ids.next();
    const at = f.deps.clock.now();
    await f.store.insertRun({
      id,
      projectId: f.projectId,
      nodeId: f.nodeId,
      bot,
      agentId: null,
      runtime: bot === "qa" ? "claude-api" : "opencode",
      model,
      headSha: SHA_A,
      prNumber: PR,
      botVersion: "v1",
      startedAt: at,
      endedAt: f.deps.clock.now(),
      outcome: "success",
      turns: null,
      minutes: null,
      costUsd: null,
      tokens: null,
      budget: { ...REHEARSAL_RUN_LIMITS[bot] },
      parentRunId: null,
      transcriptRef: null,
      usageExhaustedCause: null,
      retryAfterSeconds: null,
      questionTopic: null,
      ...testRouteColumns(bot),
    });
    return id;
  }

  /** Ingests CI and its preview check with `conclusion`, then QA's pass citing both. */
  async function reviewed(conclusion: string) {
    const f = await createIngestFixture();
    ciFinished(f, [run()], { [RUN_ID]: [job({ conclusion })] });
    await checksDone(f);
    const ci = (await f.evidence("ci_run")).at(-1)!;
    const preview = (await previews(f)).at(-1)!;
    await runOf(f, "developer", MODEL_BUILDER);
    const qaRun = await runOf(f, "qa", MODEL_QA);
    await f.store.insertEvidence({
      id: f.deps.ids.next(),
      nodeId: f.nodeId,
      runId: qaRun,
      kind: "qa_verdict",
      ref: `qa:${qaRun}`,
      commitSha: SHA_A,
      payload: { verdict: "pass", findings: [], evidenceIds: [ci.id, preview.id] },
      recordedBy: "qa",
      recordedAt: f.deps.clock.now(),
      supersedesId: null,
    });
    return GUARDS.qa_verdict_independent_on_head!({
      node: (await f.store.getNode(f.nodeId))!,
      store: f.store,
    });
  }

  it("passes on a passing preview check recorded from CI's job", async () => {
    const result = await reviewed("success");
    expect(result.pass, result.detail).toBe(true);
    expect(result.detail).toBe(`independent QA pass on head ${SHA_A}`);
  });

  it("refuses a failing one, and one that is missing", async () => {
    const failed = await reviewed("failure");
    expect(failed.pass).toBe(false);
    expect(failed.detail).toBe(`preview check failed on head ${SHA_A}`);

    const f = await createIngestFixture();
    ciFinished(f, [run({ path: ".github/workflows/other.yml" })], {
      [RUN_ID]: [job()],
    });
    await checksDone(f);
    const missing = await GUARDS.qa_verdict_independent_on_head!({
      node: (await f.store.getNode(f.nodeId))!,
      store: f.store,
    });
    expect(missing).toMatchObject({
      pass: false,
      detail: `no preview check on head ${SHA_A}`,
    });
  });
});
