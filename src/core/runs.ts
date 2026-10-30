// Agent runs: dispatch admission, budgets and run ends (ADR 0106 sections 6 and 7, ADR 0107,
// build plan M3.2). Plain rules over the store, with the clock and ids injected (D-162). The core
// decides; it never starts, stops or cancels a run itself. The runner does that through the agent
// runtime adapter and reports back here.
import { LibraryError, type Clock, type IdSource } from "./library.ts";
import type {
  AgentRole,
  Json,
  Node,
  Run,
  RunOutcome,
  Store,
  StoreOps,
  UsageExhaustedCause,
} from "./store.ts";

/** The limits a run is started with (ADR 0107). Recorded in `runs.budget`. */
export interface RunLimits {
  maxTurns: number;
  maxMinutes: number;
  maxUsd: number;
}

export type RoleRunLimits = Record<AgentRole, RunLimits>;

/**
 * The rehearsal limits (D-185, ADR 0106 section 6). They belong in each bot file; until bot
 * files are loaded, the runner passes these.
 */
export const REHEARSAL_RUN_LIMITS: RoleRunLimits = {
  developer: { maxTurns: 100, maxMinutes: 50, maxUsd: 5 },
  designer: { maxTurns: 100, maxMinutes: 50, maxUsd: 5 },
  qa: { maxTurns: 50, maxMinutes: 20, maxUsd: 2 },
  council: { maxTurns: 40, maxMinutes: 20, maxUsd: 3 },
  triage: { maxTurns: 40, maxMinutes: 20, maxUsd: 3 },
};

/** Up to 3 Developer agents at once per project (spec section 2). */
export const DEVELOPER_RUNS_PER_PROJECT = 3;

export interface DispatchRequest {
  nodeId: string;
  /** Stored as the run's `bot`. */
  role: AgentRole;
  runtime: string;
  model: string;
  botVersion: string;
  agentId?: string | null;
  /** The pull request's current head commit. Required for QA. */
  headSha?: string | null;
  /** Required for QA. */
  prNumber?: number | null;
  parentRunId?: string | null;
}

export type DispatchRefusal =
  | "kill_switch"
  | "usage_exhausted_wait"
  | "qa_duplicate"
  | "item_has_active_run"
  | "developer_limit"
  | "cluster_limit_unset"
  | "cluster_full";

/**
 * A refused dispatch wrote nothing. `qa_newer_head`: the pull request has an active QA run on an
 * older head. The runner cancels those runs, records their end, and dispatches again.
 */
export type DispatchResult =
  | { admitted: true; run: Run }
  | { admitted: false; reason: DispatchRefusal }
  | { admitted: false; reason: "qa_newer_head"; cancelRunIds: string[] };

/** Token counts as the runtime reports them. Cached input is kept apart from uncached (D-185). */
export interface RunTokens {
  /** Input read without the cache, not counting cache writes. */
  uncachedInput: number;
  /** Input read from the cache. */
  cachedInput: number;
  /** Input written to the cache, where the provider reports it. */
  cacheWriteInput?: number;
  output: number;
}

export interface RunReport {
  outcome: RunOutcome;
  turns: number | null;
  minutes: number | null;
  costUsd: number | null;
  tokens: RunTokens | null;
  transcriptRef?: string | null;
  /** Required with `usage_exhausted`, refused with any other outcome. */
  usageExhaustedCause?: UsageExhaustedCause | null;
  /** The provider's retry-after, only with `usage_exhausted`. */
  retryAfterSeconds?: number | null;
}

/** A node whose latest run ended `usage_exhausted`: its dispatch waits (ADR 0106 section 6). */
export interface QueuedDispatch {
  runId: string;
  cause: UsageExhaustedCause;
  /** When it may be dispatched again; null while the wait setting is missing. */
  resumeAt: Date | null;
  ready: boolean;
}

export interface RunsOptions {
  store: Store;
  clock: Clock;
  ids: IdSource;
  limits: RoleRunLimits;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

async function positiveIntegerSetting(
  store: StoreOps,
  key: string,
): Promise<number | null> {
  const value = (await store.getSetting(key))?.value;
  return isCount(value) && value > 0 ? value : null;
}

/**
 * When a usage_exhausted run's dispatch may resume: the end plus the wait setting, or plus the
 * provider's retry-after if that is longer. Null when the wait setting is missing or invalid.
 */
export function usageResumeAt(run: Run, waitMinutes: number | null): Date | null {
  if (waitMinutes === null || run.endedAt === null) return null;
  const waitSeconds = Math.max(waitMinutes * 60, run.retryAfterSeconds ?? 0);
  return new Date(run.endedAt.getTime() + waitSeconds * 1000);
}

async function queuedDispatch(
  store: StoreOps,
  nodeId: string,
  now: Date,
): Promise<QueuedDispatch | null> {
  const latest = (await store.listRuns({ nodeId })).at(-1);
  if (latest?.outcome !== "usage_exhausted" || !latest.usageExhaustedCause) return null;
  const waitMinutes = await positiveIntegerSetting(
    store,
    "usage_exhausted_wait_minutes",
  );
  const resumeAt = usageResumeAt(latest, waitMinutes);
  return {
    runId: latest.id,
    cause: latest.usageExhaustedCause,
    resumeAt,
    ready: resumeAt !== null && now.getTime() >= resumeAt.getTime(),
  };
}

/**
 * The capacity rules of ADR 0106 section 7 over the runs active now. QA comes first, so a
 * duplicate event is named as one and a newer head finds the run it replaces.
 */
export function admissionRefusal(
  request: DispatchRequest,
  node: Node,
  active: Run[],
  clusterLimit: number | null,
): Exclude<DispatchResult, { admitted: true }> | null {
  if (request.role === "qa") {
    const samePullRequest = active.filter(
      (r) =>
        r.bot === "qa" &&
        r.projectId === node.projectId &&
        r.prNumber === request.prNumber,
    );
    if (samePullRequest.some((r) => r.headSha === request.headSha)) {
      return { admitted: false, reason: "qa_duplicate" };
    }
    if (samePullRequest.length > 0) {
      return {
        admitted: false,
        reason: "qa_newer_head",
        cancelRunIds: samePullRequest.map((r) => r.id),
      };
    }
  }
  if (active.some((r) => r.nodeId === node.id)) {
    return { admitted: false, reason: "item_has_active_run" };
  }
  if (
    request.role === "developer" &&
    active.filter((r) => r.bot === "developer" && r.projectId === node.projectId)
      .length >= DEVELOPER_RUNS_PER_PROJECT
  ) {
    return { admitted: false, reason: "developer_limit" };
  }
  if (clusterLimit === null) return { admitted: false, reason: "cluster_limit_unset" };
  if (active.length >= clusterLimit) return { admitted: false, reason: "cluster_full" };
  return null;
}

function checkDispatchRequest(request: DispatchRequest): void {
  if (request.role !== "qa") return;
  const prNumber = request.prNumber;
  if (!request.headSha || !(isCount(prNumber) && prNumber > 0)) {
    throw new LibraryError(
      "A QA dispatch needs its pull request number and head commit",
    );
  }
}

function checkRunReport(report: RunReport): void {
  for (const [name, value] of [
    ["turns", report.turns],
    ["retryAfterSeconds", report.retryAfterSeconds ?? null],
  ] as const) {
    if (value !== null && !isCount(value)) {
      throw new LibraryError(`${name} must be a whole number of at least 0`);
    }
  }
  for (const [name, value] of [
    ["minutes", report.minutes],
    ["costUsd", report.costUsd],
  ] as const) {
    if (value !== null && !isAmount(value))
      throw new LibraryError(`${name} must be at least 0`);
  }
  if (report.tokens) {
    const { uncachedInput, cachedInput, cacheWriteInput, output } = report.tokens;
    if (
      ![uncachedInput, cachedInput, output].every(isCount) ||
      (cacheWriteInput !== undefined && !isCount(cacheWriteInput))
    ) {
      throw new LibraryError("token counts must be whole numbers of at least 0");
    }
  }
  const exhausted = report.outcome === "usage_exhausted";
  if (exhausted !== Boolean(report.usageExhaustedCause)) {
    throw new LibraryError(
      "a usage_exhausted end names its cause, and no other end does",
    );
  }
  if (!exhausted && report.retryAfterSeconds != null) {
    throw new LibraryError("only a usage_exhausted end has a retry-after");
  }
}

/** Only the known counts, so nothing else a runtime adds is stored. */
function tokensJson(tokens: RunTokens): Json {
  const counts: { [key: string]: Json } = {
    uncachedInput: tokens.uncachedInput,
    cachedInput: tokens.cachedInput,
    output: tokens.output,
  };
  if (tokens.cacheWriteInput !== undefined)
    counts.cacheWriteInput = tokens.cacheWriteInput;
  return counts;
}

export function createRuns({ store, clock, ids, limits }: RunsOptions) {
  return {
    /**
     * Decides whether a run may start now and, if so, records it with its role's limits. The
     * check and the insert are one transaction under the admission lock, so two dispatches can
     * never both pass. A refusal writes nothing.
     */
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      checkDispatchRequest(request);
      const budget = limits[request.role];
      return store.transaction(async (tx) => {
        await tx.lockRunAdmission();
        if ((await tx.getSetting("kill_switch"))?.value === true) {
          return { admitted: false, reason: "kill_switch" };
        }
        const node = await tx.getNode(request.nodeId);
        if (!node) throw new LibraryError(`No node ${request.nodeId}`);
        const now = clock.now();
        const queued = await queuedDispatch(tx, node.id, now);
        if (queued && !queued.ready) {
          return { admitted: false, reason: "usage_exhausted_wait" };
        }
        const refusal = admissionRefusal(
          request,
          node,
          await tx.listActiveRuns(),
          await positiveIntegerSetting(tx, "agent_cluster_max_active_runs"),
        );
        if (refusal) return refusal;
        const run: Run = {
          id: ids.next(),
          projectId: node.projectId,
          nodeId: node.id,
          bot: request.role,
          agentId: request.agentId ?? null,
          runtime: request.runtime,
          model: request.model,
          headSha: request.headSha ?? null,
          prNumber: request.prNumber ?? null,
          botVersion: request.botVersion,
          startedAt: now,
          endedAt: null,
          outcome: null,
          turns: null,
          minutes: null,
          costUsd: null,
          tokens: null,
          budget: { ...budget },
          parentRunId: request.parentRunId ?? null,
          transcriptRef: null,
          usageExhaustedCause: null,
          retryAfterSeconds: null,
        };
        await tx.insertRun(run);
        return { admitted: true, run };
      });
    },

    /**
     * Records how a run ended. Returns false, changing nothing, if the run had already ended or
     * does not exist. It never touches a counter: the P-03 rules decide those, and a
     * usage_exhausted end is not a failure (FR-11).
     */
    async recordEnd(runId: string, report: RunReport): Promise<boolean> {
      checkRunReport(report);
      return store.endRun(runId, {
        endedAt: clock.now(),
        outcome: report.outcome,
        turns: report.turns,
        minutes: report.minutes,
        costUsd: report.costUsd,
        tokens: report.tokens ? tokensJson(report.tokens) : null,
        transcriptRef: report.transcriptRef ?? null,
        usageExhaustedCause: report.usageExhaustedCause ?? null,
        retryAfterSeconds: report.retryAfterSeconds ?? null,
      });
    },

    /** The node's queued dispatch after a usage_exhausted end, or null if it is not queued. */
    queuedDispatch(nodeId: string): Promise<QueuedDispatch | null> {
      return queuedDispatch(store, nodeId, clock.now());
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
