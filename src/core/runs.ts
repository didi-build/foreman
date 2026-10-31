// Agent runs: dispatch admission, budgets and run ends (ADR 0106 sections 6 and 7, ADR 0107,
// build plan M3.2). Plain rules over the store, with the clock and ids injected (D-162). The core
// decides; it never starts, stops or cancels a run itself. The runner does that through the agent
// runtime adapter and reports back here.
//
// Admission also chooses the run's model route (ADR 0114 sections 2 and 5): the route is recorded
// on the run, with its P-11 decision record, in the same transaction that inserts the run. The
// run's state API token is stored there too, as its hash (ADR 0102), and ending the run revokes it.
//
// After a capacity end, a task type whose policy says `onCapacity: "next_candidate"` is not held
// by the usage-exhausted wait when a later candidate passes the hard rules: the next dispatch takes
// that candidate at once. Otherwise the dispatch waits as for `wait` (D-221).
import { LibraryError, type Clock, type IdSource } from "./library.ts";
import {
  chooseRoute,
  type CapacityEnd,
  MODEL_ROUTE_DECIDER,
  MODEL_ROUTE_DECISION_POINT,
  routeInputHash,
  routeOutput,
  ROUTING_SETTINGS,
  type NoRoute,
  type Route,
  type RouteInput,
} from "./routing.ts";
import type {
  AgentRole,
  Json,
  Node,
  Run,
  RunOutcome,
  ServedTier,
  Store,
  StoreOps,
  UsageExhaustedCause,
} from "./store.ts";
import { RUN_TOKEN_HASH, runTokenExpiry } from "./run-tokens.ts";
import { taskTypeFor, type TaskTypes } from "./task-types.ts";

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

/** What a dispatch asks for. It names no model: the run's route does (ADR 0114 section 2). */
export interface DispatchRequest {
  nodeId: string;
  /** Stored as the run's `bot`. */
  role: AgentRole;
  runtime: string;
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
  | "cluster_full"
  | "no_route";

/** The run's state API token as the core sees it: only its SHA-256 hash (src/core/run-tokens.ts). */
export interface RunCredential {
  tokenHash: string;
}

/**
 * A refused dispatch wrote nothing. `qa_newer_head`: the pull request has an active QA run on an
 * older head. The runner cancels those runs, records their end, and dispatches again. `no_route`:
 * no policy candidate passed the hard rules, or the routing settings are malformed; `noRoute`
 * says why, for the runner's alert.
 */
export type DispatchResult =
  | { admitted: true; run: Run }
  | { admitted: false; reason: Exclude<DispatchRefusal, "no_route"> }
  | { admitted: false; reason: "no_route"; noRoute: NoRoute }
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
  // What the runtime measured about the route (ADR 0114 sections 2, 8 and 9). Each is null or
  // left out when the runtime could not report it.
  /** The tier the provider's responses reported: one tier, or `mixed`. */
  serviceTierServed?: ServedTier | null;
  /** Flex capacity rejections the runtime retried inside the run. */
  capacityRetries?: number | null;
  /** The whole seconds the runtime waited on those retries. */
  capacityWaitSeconds?: number | null;
  firstTokenMs?: number | null;
  /** The runtime's own cost figure. */
  reportedCostUsd?: number | null;
}

/** A node whose latest run ended `usage_exhausted`: its dispatch waits (ADR 0106 section 6). */
export interface QueuedDispatch {
  runId: string;
  cause: UsageExhaustedCause;
  /** When it may be dispatched again; null while the wait setting is missing. */
  resumeAt: Date | null;
  /** True once the wait has passed, or at once when the next candidate applies. */
  ready: boolean;
  /**
   * True after a capacity end when the policy says `next_candidate` and a later candidate passes
   * the hard rules: the next dispatch takes it without waiting (ADR 0114 section 5).
   */
  nextCandidate: boolean;
}

/** The Flex capacity bounds a run is started with (ADR 0114 section 9, migration 0007). */
export interface RunCapacityLimits {
  /** How many Flex capacity rejections one run retries. 0 means none. */
  flexCapacityRetries: number;
  /** How many requests the run's proxy lets through after a 429 before it answers 403. */
  maxRejectedModelRequests: number;
}

export const CAPACITY_SETTINGS = {
  flexCapacityRetries: "flex_capacity_retries",
  maxRejectedModelRequests: "max_rejected_model_requests",
} as const;

export interface RunsOptions {
  store: Store;
  clock: Clock;
  ids: IdSource;
  limits: RoleRunLimits;
  /** The task types at the spec version (contracts/task-types.yaml). */
  taskTypes: TaskTypes;
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
  node: Node,
  taskTypes: TaskTypes,
  now: Date,
): Promise<QueuedDispatch | null> {
  const latest = (await store.listRuns({ nodeId: node.id })).at(-1);
  if (latest?.outcome !== "usage_exhausted" || !latest.usageExhaustedCause) return null;
  const waitMinutes = await positiveIntegerSetting(
    store,
    "usage_exhausted_wait_minutes",
  );
  const resumeAt = usageResumeAt(latest, waitMinutes);
  let nextCandidate = false;
  if (latest.usageExhaustedCause === "capacity" && isAgentRole(latest.bot)) {
    const choice = chooseRoute(await routeInput(store, latest.bot, node, taskTypes));
    nextCandidate = choice.routed && choice.route.afterCapacity === "next_candidate";
  }
  return {
    runId: latest.id,
    cause: latest.usageExhaustedCause,
    resumeAt,
    ready: nextCandidate || (resumeAt !== null && now.getTime() >= resumeAt.getTime()),
    nextCandidate,
  };
}

const AGENT_ROLES: readonly string[] = [
  "developer",
  "qa",
  "designer",
  "council",
  "triage",
];
const isAgentRole = (bot: string): bot is AgentRole => AGENT_ROLES.includes(bot);

/**
 * The run capacity bounds from settings. A missing or bad setting refuses the start before
 * anything is written, and the error names the setting, never its value.
 */
export async function runCapacityLimits(store: StoreOps): Promise<RunCapacityLimits> {
  const retries = (await store.getSetting(CAPACITY_SETTINGS.flexCapacityRetries))
    ?.value;
  if (!isCount(retries)) {
    throw new LibraryError(
      `${CAPACITY_SETTINGS.flexCapacityRetries} must be a whole number of at least 0`,
    );
  }
  const rejected = await positiveIntegerSetting(
    store,
    CAPACITY_SETTINGS.maxRejectedModelRequests,
  );
  if (rejected === null) {
    throw new LibraryError(
      `${CAPACITY_SETTINGS.maxRejectedModelRequests} must be a whole number above 0`,
    );
  }
  return { flexCapacityRetries: retries, maxRejectedModelRequests: rejected };
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
): Exclude<DispatchResult, { admitted: true } | { reason: "no_route" }> | null {
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
    ["capacityRetries", report.capacityRetries ?? null],
    ["capacityWaitSeconds", report.capacityWaitSeconds ?? null],
    ["firstTokenMs", report.firstTokenMs ?? null],
  ] as const) {
    if (value !== null && !isCount(value)) {
      throw new LibraryError(`${name} must be a whole number of at least 0`);
    }
  }
  for (const [name, value] of [
    ["minutes", report.minutes],
    ["costUsd", report.costUsd],
    ["reportedCostUsd", report.reportedCostUsd ?? null],
  ] as const) {
    if (value !== null && !isAmount(value))
      throw new LibraryError(`${name} must be at least 0`);
  }
  const served = report.serviceTierServed ?? null;
  if (served !== null && !SERVED_TIERS.includes(served)) {
    throw new LibraryError(
      "serviceTierServed must be standard, flex, priority or mixed",
    );
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

const SERVED_TIERS: readonly ServedTier[] = ["standard", "flex", "priority", "mixed"];

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

/** The run a dispatch records. `planDispatch` builds one with a planned id and never stores it. */
function newRun(
  id: string,
  node: Node,
  request: DispatchRequest,
  route: Route,
  budget: RunLimits,
  now: Date,
): Run {
  return {
    id,
    projectId: node.projectId,
    nodeId: node.id,
    bot: request.role,
    agentId: request.agentId ?? null,
    runtime: request.runtime,
    model: route.model,
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
    taskType: route.taskType,
    provider: route.provider,
    modelFamily: route.family,
    serviceTierRequested: route.tier,
    serviceTierServed: null,
    routingPolicyVersion: route.policyVersion,
    modelCatalogVersion: route.catalogVersion,
    capacityRetries: null,
    capacityWaitSeconds: null,
    firstTokenMs: null,
    reportedCostUsd: null,
  };
}

/**
 * What the route choice reads: the role's task type, the item's runs, the routing settings and,
 * when the item's latest run ended with a capacity end on the same task type, that run's route.
 */
async function routeInput(
  store: StoreOps,
  role: AgentRole,
  node: Node,
  taskTypes: TaskTypes,
): Promise<RouteInput> {
  const value = async (key: string): Promise<Json> =>
    (await store.getSetting(key))?.value ?? null;
  const earlierRuns = await store.listRuns({ nodeId: node.id });
  const taskType = taskTypeFor(taskTypes, role);
  const latest = earlierRuns.at(-1);
  const capacityEnd: CapacityEnd | null =
    latest?.outcome === "usage_exhausted" &&
    latest.usageExhaustedCause === "capacity" &&
    latest.taskType === taskType
      ? {
          provider: latest.provider,
          model: latest.model,
          tier: latest.serviceTierRequested,
        }
      : null;
  return {
    role,
    taskType,
    earlierRuns,
    settings: {
      policy: await value(ROUTING_SETTINGS.policy),
      catalog: await value(ROUTING_SETTINGS.catalog),
      providers: await value(ROUTING_SETTINGS.providers),
      outputNeeds: await value(ROUTING_SETTINGS.outputNeeds),
    },
    ...(capacityEnd ? { capacityEnd } : {}),
  };
}

type Admitted = { admitted: true; node: Node; route: Route; routeInput: RouteInput };

/**
 * Every admission rule, read-only: the kill switch, the usage-exhausted wait, the capacity rules
 * over the active runs plus `alsoActive`, and then the route choice (ADR 0114 section 5). Returns
 * the node and its route when admitted.
 */
async function admission(
  store: StoreOps,
  request: DispatchRequest,
  taskTypes: TaskTypes,
  now: Date,
  alsoActive: readonly Run[],
): Promise<Exclude<DispatchResult, { admitted: true }> | Admitted> {
  if ((await store.getSetting("kill_switch"))?.value === true) {
    return { admitted: false, reason: "kill_switch" };
  }
  const node = await store.getNode(request.nodeId);
  if (!node) throw new LibraryError(`No node ${request.nodeId}`);
  const queued = await queuedDispatch(store, node, taskTypes, now);
  if (queued && !queued.ready) {
    return { admitted: false, reason: "usage_exhausted_wait" };
  }
  const refusal = admissionRefusal(
    request,
    node,
    [...(await store.listActiveRuns()), ...alsoActive],
    await positiveIntegerSetting(store, "agent_cluster_max_active_runs"),
  );
  if (refusal) return refusal;
  const input = await routeInput(store, request.role, node, taskTypes);
  const choice = chooseRoute(input);
  if (!choice.routed) {
    return { admitted: false, reason: "no_route", noRoute: choice.noRoute };
  }
  return { admitted: true, node, route: choice.route, routeInput: input };
}

/** The id a planned run carries. It is never stored, so it cannot collide with a real run. */
export const plannedRunId = (nodeId: string, role: AgentRole): string =>
  `planned:${role}:${nodeId}`;

export function createRuns({ store, clock, ids, limits, taskTypes }: RunsOptions) {
  /**
   * Records how a run ended and revokes its state API token, in one transaction (ADR 0102:
   * ending a run revokes its token). Returns false, changing nothing, if the run had already
   * ended or does not exist. It never touches a counter: the P-03 rules decide those, and a
   * usage_exhausted end is not a failure (FR-11).
   */
  async function recordEnd(runId: string, report: RunReport): Promise<boolean> {
    checkRunReport(report);
    const endedAt = clock.now();
    return store.transaction(async (tx) => {
      const ended = await tx.endRun(runId, {
        endedAt,
        outcome: report.outcome,
        turns: report.turns,
        minutes: report.minutes,
        costUsd: report.costUsd,
        tokens: report.tokens ? tokensJson(report.tokens) : null,
        transcriptRef: report.transcriptRef ?? null,
        usageExhaustedCause: report.usageExhaustedCause ?? null,
        retryAfterSeconds: report.retryAfterSeconds ?? null,
        serviceTierServed: report.serviceTierServed ?? null,
        capacityRetries: report.capacityRetries ?? null,
        capacityWaitSeconds: report.capacityWaitSeconds ?? null,
        firstTokenMs: report.firstTokenMs ?? null,
        reportedCostUsd: report.reportedCostUsd ?? null,
      });
      if (ended) await tx.revokeRunToken(runId, endedAt);
      return ended;
    });
  }

  return {
    /**
     * Decides whether a run may start now and, if so, records it with its role's limits and
     * its route, records the route as a P-11 decision (confidence 1: a rule decided), and stores
     * the hash of the run's state API token with its expiry (ADR 0102). The check and the inserts
     * are one transaction under the admission lock, so two dispatches can never both pass, and a
     * run never exists without its route or its token. A refusal writes nothing.
     */
    async dispatch(
      request: DispatchRequest,
      credential: RunCredential,
    ): Promise<DispatchResult> {
      checkDispatchRequest(request);
      if (!RUN_TOKEN_HASH.test(credential.tokenHash)) {
        throw new LibraryError("tokenHash must be a hex SHA-256");
      }
      const budget = limits[request.role];
      return store.transaction(async (tx) => {
        await tx.lockRunAdmission();
        const now = clock.now();
        const admitted = await admission(tx, request, taskTypes, now, []);
        if (!admitted.admitted) return admitted;
        const { node, route } = admitted;
        const run = newRun(ids.next(), node, request, route, budget, now);
        await tx.insertRun(run);
        await tx.insertRunToken({
          tokenHash: credential.tokenHash,
          runId: run.id,
          role: request.role,
          projectId: node.projectId,
          expiresAt: runTokenExpiry(now, budget.maxMinutes),
          revokedAt: null,
        });
        await tx.insertDecisionPointRecord({
          id: ids.next(),
          projectId: node.projectId,
          nodeId: node.id,
          decisionPoint: MODEL_ROUTE_DECISION_POINT,
          deciderId: MODEL_ROUTE_DECIDER,
          inputHash: routeInputHash(admitted.routeInput),
          output: routeOutput(route, run.id),
          confidence: 1,
          recordedAt: now,
        });
        return { admitted: true, run };
      });
    },

    /**
     * The dry-run path (M2.4): the same admission rules as `dispatch`, and it writes nothing.
     * `planned` are runs this caller has already planned in the same pass; they count as
     * active, so a pass never plans past the Developer or cluster limit. An admitted plan
     * returns the run `dispatch` would record, route included, with a planned id
     * (`plannedRunId`), unsaved. No decision record is written.
     */
    async planDispatch(
      request: DispatchRequest,
      planned: readonly Run[] = [],
    ): Promise<DispatchResult> {
      checkDispatchRequest(request);
      const now = clock.now();
      const admitted = await admission(store, request, taskTypes, now, planned);
      if (!admitted.admitted) return admitted;
      const { node, route } = admitted;
      const id = plannedRunId(node.id, request.role);
      return {
        admitted: true,
        run: newRun(id, node, request, route, limits[request.role], now),
      };
    },

    recordEnd,

    /**
     * Records an end the runner itself decided, with nothing measured: `cancelled` after it
     * stopped the run (the kill switch, D-202, or a start it could not record), `fail` when the
     * run never started. Same transaction and token revocation as `recordEnd`.
     */
    recordRunnerEnd(runId: string, outcome: "cancelled" | "fail"): Promise<boolean> {
      return recordEnd(runId, {
        outcome,
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
      });
    },

    /** The node's queued dispatch after a usage_exhausted end, or null if it is not queued. */
    async queuedDispatch(nodeId: string): Promise<QueuedDispatch | null> {
      const node = await store.getNode(nodeId);
      if (!node) throw new LibraryError(`No node ${nodeId}`);
      return queuedDispatch(store, node, taskTypes, clock.now());
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
