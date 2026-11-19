// The weekly model test's summary for the daily check (ADR 0117, D-428, D-430, O-156): per model,
// how many cases it got right and what it cost in the latest week with results; which cases
// changed outcome since the week before; and which cases every tested model has got right in each
// of the last 8 weeks with results, as candidates to replace with harder ones (D-428). Plain logic
// over the stored Jobs and results: no clock, no store, no text a model wrote.
//
// A week's results are those of its finished Jobs. When a case ran more than once on a model in
// the week (a second Job), the latest started run counts; a skipped run counts only for the week's
// skipped total. Outcomes are compared only at the same case version (ADR 0117: editing a case
// raises its version).
import type { JobFailure } from "./model-eval.ts";
import type { ModelEvalJob, ModelEvalResult } from "./store.ts";

/** How many weeks in a row a case must pass on every tested model to be flagged (D-428). */
export const REPLACE_AFTER_WEEKS = 8;

export interface ModelEvalModelLine {
  model: string;
  provider: string;
  baseline: boolean;
  /** Cases it got right, of `total`, the cases it ran (each once). */
  correct: number;
  total: number;
  costUsd: number;
}

export interface ModelEvalWeek {
  /** The Sunday (UTC) the week starts on. */
  weekStart: string;
  baseline: boolean;
  capUsd: number;
  /** What the week's finished Jobs spent. */
  costUsd: number;
  /** Runs that started, and runs skipped at the cap, across the week's finished Jobs. */
  runs: number;
  skipped: number;
  models: ModelEvalModelLine[];
}

export interface ModelEvalChange {
  caseId: string;
  model: string;
  provider: string;
}

export interface ModelEvalSummary {
  /** The latest week with a finished Job, or null when none has finished. */
  latest: ModelEvalWeek | null;
  /** The week before it with a finished Job, which the changes compare with. */
  previousWeekStart: string | null;
  newlyWrong: ModelEvalChange[];
  newlyRight: ModelEvalChange[];
  /** Case ids every tested model got right in each of the last 8 weeks with results (D-428). */
  replaceCandidates: string[];
  /** The Job still running, if one is. */
  running: { weekStart: string; startedAt: Date } | null;
  /** The newest Job, when it failed after the latest finished one. */
  failed: {
    weekStart: string;
    startedAt: Date;
    reason: JobFailure;
    detail: string | null;
  } | null;
}

interface WeekRows {
  weekStart: string;
  jobs: ModelEvalJob[];
  rows: ModelEvalResult[];
  /** The latest started run of each case on each model. */
  started: Map<string, ModelEvalResult>;
}

const keyOf = (r: Pick<ModelEvalResult, "caseId" | "provider" | "model">): string =>
  `${r.caseId}\u0000${r.provider}\u0000${r.model}`;

const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/** The finished weeks, newest first, each with its rows in the order they ran. */
function finishedWeeks(
  jobs: readonly ModelEvalJob[],
  results: readonly ModelEvalResult[],
): WeekRows[] {
  const finished = jobs
    .filter((j) => j.end?.outcome === "finished")
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const order = new Map(finished.map((j, i) => [j.id, i]));
  const weeks = new Map<string, WeekRows>();
  for (const job of finished) {
    const week: WeekRows = weeks.get(job.weekStart) ?? {
      weekStart: job.weekStart,
      jobs: [],
      rows: [],
      started: new Map(),
    };
    week.jobs.push(job);
    weeks.set(job.weekStart, week);
  }
  const rows = results
    .filter((r) => order.has(r.jobId))
    .sort(
      (a, b) => (order.get(a.jobId) ?? 0) - (order.get(b.jobId) ?? 0) || a.seq - b.seq,
    );
  const weekOfJob = new Map(finished.map((j) => [j.id, j.weekStart]));
  for (const row of rows) {
    const week = weeks.get(weekOfJob.get(row.jobId) as string) as WeekRows;
    week.rows.push(row);
    if (row.outcome !== "skipped") week.started.set(keyOf(row), row);
  }
  return [...weeks.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

function weekOf(week: WeekRows): ModelEvalWeek {
  const models: ModelEvalModelLine[] = [];
  const lineOf = (r: ModelEvalResult): ModelEvalModelLine => {
    let line = models.find((m) => m.model === r.model && m.provider === r.provider);
    if (!line) {
      line = {
        model: r.model,
        provider: r.provider,
        baseline: r.baseline,
        correct: 0,
        total: 0,
        costUsd: 0,
      };
      models.push(line);
    }
    return line;
  };
  for (const row of week.rows) {
    const line = lineOf(row);
    line.costUsd = roundUsd(line.costUsd + row.costUsd);
  }
  for (const row of week.started.values()) {
    const line = lineOf(row);
    line.total += 1;
    if (row.outcome === "correct") line.correct += 1;
  }
  const latestJob = week.jobs.at(-1) as ModelEvalJob;
  const skipped = week.rows.filter((r) => r.outcome === "skipped").length;
  return {
    weekStart: week.weekStart,
    baseline: week.jobs.some((j) => j.baseline),
    capUsd: latestJob.capUsd,
    costUsd: roundUsd(week.jobs.reduce((sum, j) => sum + (j.end?.spentUsd ?? 0), 0)),
    runs: week.rows.length - skipped,
    skipped,
    models,
  };
}

/** Cases whose outcome on a model changed between the two weeks, at the same case version. */
function changes(
  latest: WeekRows,
  previous: WeekRows,
): { newlyWrong: ModelEvalChange[]; newlyRight: ModelEvalChange[] } {
  const newlyWrong: ModelEvalChange[] = [];
  const newlyRight: ModelEvalChange[] = [];
  for (const [key, now] of latest.started) {
    const before = previous.started.get(key);
    if (!before || before.caseVersion !== now.caseVersion) continue;
    const change = { caseId: now.caseId, model: now.model, provider: now.provider };
    const wasRight = before.outcome === "correct";
    const isRight = now.outcome === "correct";
    if (wasRight && !isRight) newlyWrong.push(change);
    if (!wasRight && isRight) newlyRight.push(change);
  }
  return { newlyWrong, newlyRight };
}

/**
 * D-428: each case that, in each of the last 8 weeks with results, ran on at least one model, at
 * the same version, and every model that ran it got it right.
 */
function replaceCandidates(weeks: readonly WeekRows[]): string[] {
  const last = weeks.slice(0, REPLACE_AFTER_WEEKS);
  if (last.length < REPLACE_AFTER_WEEKS) return [];
  const [newest] = last;
  const cases = new Map<string, number>();
  for (const row of (newest as WeekRows).started.values()) {
    cases.set(row.caseId, row.caseVersion);
  }
  return [...cases.entries()]
    .filter(([caseId, version]) =>
      last.every((week) => {
        const own = [...week.started.values()].filter((r) => r.caseId === caseId);
        return (
          own.length > 0 &&
          own.every((r) => r.caseVersion === version && r.outcome === "correct")
        );
      }),
    )
    .map(([caseId]) => caseId)
    .sort();
}

/** The summary of the stored Jobs and their results (see above). */
export function modelEvalSummary(
  jobs: readonly ModelEvalJob[],
  results: readonly ModelEvalResult[],
): ModelEvalSummary {
  const weeks = finishedWeeks(jobs, results);
  const [latest, previous] = weeks;
  const byStart = [...jobs].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const open = byStart.filter((j) => j.end === null).at(-1);
  const newest = byStart.at(-1);
  const latestFinished = byStart.filter((j) => j.end?.outcome === "finished").at(-1);
  const failed =
    newest?.end?.outcome === "failed" &&
    (!latestFinished || newest.startedAt.getTime() > latestFinished.startedAt.getTime())
      ? newest
      : undefined;
  return {
    latest: latest ? weekOf(latest) : null,
    previousWeekStart: previous?.weekStart ?? null,
    ...(latest && previous
      ? changes(latest, previous)
      : { newlyWrong: [], newlyRight: [] }),
    replaceCandidates: replaceCandidates(weeks),
    running: open ? { weekStart: open.weekStart, startedAt: open.startedAt } : null,
    failed:
      failed && failed.end
        ? {
            weekStart: failed.weekStart,
            startedAt: failed.startedAt,
            reason: failed.end.reason as JobFailure,
            detail: failed.end.detail,
          }
        : null,
  };
}
