// The weekly model test's pass (ADR 0117, D-204, D-427 to D-433, O-156). The scheduled flow
// f/foreman/weekly_model_test runs it once a day:
//
// 1. **Read** each started Job of the weekly test that has no end yet (`collect`): still running,
//    or ended. An ended Job's result is checked against the Job it came from, stored as one row
//    per run with the Job's end in one transaction, and only then are the Job's objects deleted,
//    so a failed write reads the Job again the next day. A Job that failed is ended with its fixed
//    reason. Its key Secret and its proxy are deleted as soon as the read sees the Job ended.
// 2. **Start** this week's Job when the week has none yet (src/core/model-eval.ts
//    `planWeekStart`): never under the kill switch or in dry run, never while the test job's image
//    is not pinned, and never with a setting, the catalog or the case list it cannot read. It
//    reads the keys of only the providers this week's plan uses, from their Windmill paths
//    `eval/models/<provider>` (D-433), and hands them to the port, which puts them only into the
//    Secret the proxy reads. The Job's row is written before its objects, so a start that fails
//    halfway is ended as `start_failed` and its objects deleted.
//
// Why the flow never waits for the Job: Windmill counts one execution per second of a job's run
// (D-369), and a week's Job runs for an hour or more, so a waiting flow would spend thousands of
// the 10,000 a month. Reading it the next day costs a few seconds.
//
// The result names Jobs, weeks, models, counts, amounts and fixed reasons: never a key, a value
// from the settings or a model's text.
import {
  EVAL_TASK_TYPES,
  JOB_FAILURE_TEXT,
  LEFT_OUT_TEXT,
  MODEL_EVAL_SETTING,
  NOT_STARTED_TEXT,
  parseModelEvalSettings,
  planWeekStart,
  storedPlan,
  storedPlanEntries,
  weeksBefore,
  type EvalCaseRef,
  type EvalJobCollect,
  type EvalJobs,
  type EvalRole,
  type JobFailure,
} from "../../src/core/model-eval.ts";
import {
  EvalJobResultError,
  checkResultOfJob,
  resultRows,
} from "../../src/core/model-eval-result.ts";
import { parseModelCatalog, ROUTING_SETTINGS } from "../../src/core/routing.ts";
import { runCapacityLimits } from "../../src/core/runs.ts";
import type { ModelEvalJob } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import { heldBy } from "./switches.ts";

/** The scheduled flow that runs this pass (flows/windmill.yaml). */
export const WEEKLY_MODEL_TEST_FLOW_PATH = "f/foreman/weekly_model_test";
/** Who the Jobs and results are recorded by. */
export const MODEL_EVAL_RECORDED_BY = "runner:weekly-model-test";
/** How long past its deadline the pass still waits for a Job to end before it stops it. */
export const EVAL_COLLECT_MARGIN_MINUTES = 30;
/** How many weeks back the pass reads: the summary's 8 weeks, and every day of this month. */
export const EVAL_HISTORY_WEEKS = 9;

export const IMAGE_NOT_PINNED =
  "the weekly test job's image is not pinned yet (runSettings.evalImage is empty), so no Job starts";

/** The weekly test's ports in the flow (flows/lib/compose.ts). */
export interface ModelEvalPorts {
  jobs: EvalJobs;
  /** A weekly test key by its path, `eval/models/<provider>` only (D-433). Never logged. */
  key(path: string): Promise<string>;
  /** The test set's cases, from the bundled `eval/cases/`. */
  cases(): EvalCaseRef[];
}

export interface CollectedJob {
  jobId: string;
  weekStart: string;
  /** `unread`: the cluster could not be read; the next day tries again. */
  outcome: "running" | "finished" | "failed" | "unread";
  reason?: JobFailure;
  runs?: number;
  skipped?: number;
  spentUsd?: number;
  /** False when an object of the Job could not be deleted. */
  removed?: boolean;
}

export interface WeeklyModelTestResult {
  collected: CollectedJob[];
  started: {
    jobId: string;
    weekStart: string;
    baseline: boolean;
    models: string[];
    runs: number;
    capUsd: number;
    spentBeforeUsd: number;
  } | null;
  /** Why no Job started, in plain words; null when one started. */
  notStarted: string | null;
  /** Models left out of the plan, each with why. */
  leftOut: { model: string; provider: string; reason: string }[];
}

const ended = (
  outcome: "finished" | "failed",
  at: Date,
  fields: { reason?: JobFailure; detail?: string | null; spentUsd: number | null },
) => ({
  endedAt: at,
  outcome,
  reason: fields.reason ?? null,
  detail: fields.detail ?? null,
  spentUsd: fields.spentUsd,
});

/** Records what reading an ended Job gave: its result and end, or its failure. */
async function record(
  deps: FlowDeps,
  job: ModelEvalJob,
  read: Exclude<EvalJobCollect, { state: "running" }>,
): Promise<CollectedJob> {
  const { store, clock, ids } = deps;
  const base = { jobId: job.id, weekStart: job.weekStart };
  const at = clock.now();
  let failure: { reason: Exclude<JobFailure, "start_failed">; detail: string | null };
  if (read.state === "finished") {
    const entries = storedPlanEntries(job.plan);
    try {
      checkResultOfJob(read.result, job, entries);
      const result = read.result;
      const rows = resultRows(job, result, entries, ids, at, MODEL_EVAL_RECORDED_BY);
      await store.transaction(async (tx) => {
        const end = ended("finished", at, { spentUsd: result.totals.spentUsd });
        if (!(await tx.endModelEvalJob(job.id, end))) return;
        for (const row of rows) await tx.insertModelEvalResult(row);
      });
      return {
        ...base,
        outcome: "finished",
        runs: result.totals.runs,
        skipped: result.totals.skipped,
        spentUsd: result.totals.spentUsd,
      };
    } catch (error) {
      if (!(error instanceof EvalJobResultError)) throw error;
      // The check names the field only, never a value.
      failure = { reason: "bad_result", detail: null };
    }
  } else {
    failure = { reason: read.reason, detail: read.detail };
  }
  await store.endModelEvalJob(
    job.id,
    ended("failed", at, { ...failure, spentUsd: null }),
  );
  return { ...base, outcome: "failed", reason: failure.reason };
}

/** Reads one open Job, records what it gives, then deletes its objects. */
async function collectOne(deps: FlowDeps, job: ModelEvalJob): Promise<CollectedJob> {
  const { modelEval } = deps;
  const boundAt = new Date(
    job.deadlineAt.getTime() + EVAL_COLLECT_MARGIN_MINUTES * 60_000,
  );
  let read: EvalJobCollect;
  try {
    read = await modelEval.jobs.collect(job.id, boundAt);
  } catch {
    return { jobId: job.id, weekStart: job.weekStart, outcome: "unread" };
  }
  if (read.state === "running") {
    return { jobId: job.id, weekStart: job.weekStart, outcome: "running" };
  }
  const collected = await record(deps, job, read);
  // Only once the result is stored: a failed write finds the Job again the next day.
  try {
    await modelEval.jobs.remove(job.id);
    return { ...collected, removed: true };
  } catch {
    return { ...collected, removed: false };
  }
}

/** The limits a role's case runs with: its task type's own, else the role's (as the job does). */
function caseLimits(deps: FlowDeps) {
  return (role: EvalRole) =>
    deps.taskLimits?.[EVAL_TASK_TYPES[role]] ?? deps.limits[role];
}

export async function weeklyModelTest(deps: FlowDeps): Promise<WeeklyModelTestResult> {
  const { store, clock, ids, modelEval } = deps;
  const since = weeksBefore(clock.now(), EVAL_HISTORY_WEEKS);
  const result: WeeklyModelTestResult = {
    collected: [],
    started: null,
    notStarted: null,
    leftOut: [],
  };
  const open = (await store.listModelEvalJobs({ sinceWeek: since, open: true })).filter(
    (j) => j.end === null,
  );
  for (const job of open) result.collected.push(await collectOne(deps, job));

  const notStarted = (why: string): WeeklyModelTestResult => ({
    ...result,
    notStarted: why,
  });
  const held = await heldBy(store);
  if (held === "kill_switch") return notStarted("the kill switch is on");
  if (held === "dry_run") return notStarted("dry run is on");

  const problems: string[] = [];
  const settings = parseModelEvalSettings(
    (await store.getSetting(MODEL_EVAL_SETTING))?.value,
    problems,
  );
  const catalog = parseModelCatalog(
    (await store.getSetting(ROUTING_SETTINGS.catalog))?.value,
    problems,
  );
  if (!settings || !catalog) {
    return notStarted(`the settings cannot be used: ${problems.join("; ")}`);
  }
  let cases: EvalCaseRef[];
  try {
    cases = modelEval.cases();
  } catch (error) {
    // The case list names the file and the field, never a value.
    return notStarted(
      `the test cases cannot be read: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const capacity = await runCapacityLimits(store);
  const now = clock.now();
  const jobs = await store.listModelEvalJobs({ sinceWeek: since, open: true });
  const decision = planWeekStart({
    now,
    settings,
    catalog,
    cases,
    limits: caseLimits(deps),
    capacity,
    jobs,
    results: await store.listModelEvalResults(jobs.map((j) => j.id)),
  });
  result.leftOut = decision.leftOut.map((l) => ({
    model: l.model,
    provider: l.provider,
    reason: LEFT_OUT_TEXT[l.reason],
  }));
  if (!decision.start) return notStarted(NOT_STARTED_TEXT[decision.reason]);
  if (!(await modelEval.jobs.imagePinned())) return notStarted(IMAGE_NOT_PINNED);

  // Only the keys this week's plan needs, each from its own path (D-433).
  const keys: Record<string, string> = {};
  for (const path of Object.values(decision.keyPaths)) {
    try {
      keys[path] = await modelEval.key(path);
    } catch {
      return notStarted(`the key at its path ${path} could not be read`);
    }
  }
  const jobId = ids.next();
  await store.insertModelEvalJob({
    id: jobId,
    weekStart: decision.weekStart,
    startedAt: now,
    deadlineAt: decision.deadlineAt,
    baseline: decision.baseline,
    capUsd: decision.capUsd,
    spentBeforeUsd: decision.spentBeforeUsd,
    plan: storedPlan(decision.entries),
    recordedBy: MODEL_EVAL_RECORDED_BY,
    end: null,
  });
  try {
    await modelEval.jobs.start(
      {
        jobId,
        entries: decision.entries,
        caseIds: cases.map((c) => c.id),
        capUsd: decision.capUsd,
        spentBeforeUsd: decision.spentBeforeUsd,
        sizing: decision.sizing,
        flexCapacityRetries: capacity.flexCapacityRetries,
        keyPaths: decision.keyPaths,
      },
      keys,
    );
  } catch {
    await store.endModelEvalJob(
      jobId,
      ended("failed", clock.now(), { reason: "start_failed", spentUsd: 0 }),
    );
    return notStarted(`the week's Job did not start: ${JOB_FAILURE_TEXT.start_failed}`);
  }
  return {
    ...result,
    started: {
      jobId,
      weekStart: decision.weekStart,
      baseline: decision.baseline,
      models: decision.entries.map((e) => e.model),
      runs: decision.sizing.runs,
      capUsd: decision.capUsd,
      spentBeforeUsd: decision.spentBeforeUsd,
    },
  };
}
