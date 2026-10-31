// The reconcile pass in dry run (build plan M2.4, technical architecture section 2.5). A plain
// function over an injected store, contracts, guards, clock, id source and GitHub reader (D-162).
// The reconcile flow (M3.1) calls it on the `reconcile_interval_minutes` schedule; the schedule and
// the Windmill execution count are the flow's, and the count is passed in here.
//
// What a dry-run pass writes, and what it never writes:
// - It writes dry-run transition rows (mode `dry_run`) through the library, which writes that mode
//   whenever the `dry_run` setting is on or missing. The node itself never changes.
// - It writes the evidence the GitHub polling backstop records (`ci_run`, `merge_commit`), the
//   `merge_check` the merge step reads from GitHub (M3.3), and the `staging_deploy` or
//   `staging_deploy_failed` the staging step reads from GitHub (M3.4, D-225). That is real evidence of what GitHub reports, recorded the same
//   way as a webhook, and webhooks record it in dry run too (ADR 0113 sections 5 and 6).
//   Recording a fact is not acting on it. It runs no staging check.
// - It never inserts a run, starts an agent, records a dispatch, closes or opens a gate request,
//   changes a counter or a setting, or sends anything. Dispatch admission is evaluated with
//   `runs.planDispatch`, which reads only.
// Live mode is not built: with `dry_run` set to false the pass stops before doing anything.
//
// Which contract moves each step uses comes from the contracts, never from a list here: release
// takes the moves out of a non-escalated state that requires a blocked reason (Blocked);
// dispatch takes the moves guarded by `agent_ready_not_on_hold`, the guard that says a node is
// ready for an agent, and plans with no move the builder run of an item a fail move sent back
// (src/core/builder-runs.ts); advance from evidence takes the moves guarded by
// `ci_green_on_head`, the evidence section 2.5 step 4 names, except the moves on which the runner
// merges (guard `qa_verdict_independent_on_head`): those need the merge, so the merge step plans
// them through src/core/merge.ts, which also records GitHub's mergeable state as a fact. The
// moves a staging check takes (guards `staging_check_on_merge_commit` and `staging_check_failed`)
// go through src/core/staging.ts, which records the staging deploy of the merge commit as a fact.
// The bot to dispatch is the owner of the state, from the contracts. The merge and the staging
// check are never done here: in live mode the reconcile flow runs the merge pass, the staging pass
// and the builder runs pass (flows/reconcile.ts, O-31, O-37, O-41).
import type {
  Contracts,
  GuardCheck,
  GuardRegistry,
  TransitionContract,
} from "./contracts.ts";
import { createBuilderRuns } from "./builder-runs.ts";
import type { GitHub } from "./github.ts";
import { pollRepository, type PollResult } from "./github-ingest.ts";
import { readCiRun } from "./guards/evidence.ts";
import {
  createLibrary,
  LibraryError,
  type Clock,
  type IdSource,
  type TransitionOutcome,
  type TransitionRequest,
} from "./library.ts";
import { createMerges, MERGE_MOVE_GUARD } from "./merge.ts";
import {
  createRuns,
  type DispatchRefusal,
  type DispatchRequest,
  type RoleRunLimits,
} from "./runs.ts";
import { DISPATCH_GUARD } from "./run-start.ts";
import { createStaging, type StagingResult } from "./staging.ts";
import type { AgentRole, GateRequest, Node, Run, Store, StoreOps } from "./store.ts";
import type { TaskTypes } from "./task-types.ts";

export { DISPATCH_GUARD };

/** The guard section 2.5 step 4 advances on: CI green on the head commit. */
export const ADVANCE_GUARD = "ci_green_on_head";

const AGENT_ROLES: readonly AgentRole[] = [
  "developer",
  "qa",
  "designer",
  "council",
  "triage",
];

const ACTOR = { kind: "runner" as const, id: "reconcile" };
const TRIGGER = { kind: "reconcile" as const, ref: null };

/**
 * What the runner starts a role with. From each bot file once bot files are loaded. The model is
 * not here: each run's route names it (ADR 0114 section 5).
 */
export interface BotProfile {
  runtime: string;
  botVersion: string;
}

export interface ReconcileDeps {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  /** Read by the polling backstop and the merge step; the merge calls are made only in live mode. */
  github: GitHub;
  /** Logins of the Developer and Designer Apps (D-156), for the polling backstop. */
  appLogins: readonly string[];
  /** The runner App's slug (D-156), for the polling backstop. */
  runnerAppSlug: string;
  limits: RoleRunLimits;
  bots: Record<AgentRole, BotProfile>;
  /** The task types at the spec version (contracts/task-types.yaml, ADR 0114 section 1). */
  taskTypes: TaskTypes;
}

export interface ReconcileInput {
  /** This month's Windmill executions, counted by the flow (D-167). Omit to skip the check. */
  windmillExecutionsThisMonth?: number;
}

/** One transition the pass asked for. `already_planned`: an identical dry-run row exists. */
export interface MovePlan {
  nodeId: string;
  fromState: string;
  toState: string;
  outcome: TransitionOutcome | "already_planned";
  reason?: string;
  guardReport: GuardCheck[];
  transitionId?: string;
}

export type DispatchPlanOutcome =
  /** Admission passed: the dispatch would start. Nothing was inserted. */
  | "planned"
  /** Admission refused it; `reason` says why. */
  | "refused"
  /** The dispatch move's guards fail, so nothing is dispatched. */
  | "guard_failed"
  /** Queued after `usage_exhausted` and its wait has not passed. */
  | "waiting"
  /** On hold, not agent-ready, or escalated (schema invariant 6). */
  | "not_dispatchable"
  /** A QA dispatch needs a head commit, and no `ci_run` names one. */
  | "no_head"
  /** The state's owner is not an agent role. */
  | "no_role";

export interface DispatchPlan {
  nodeId: string;
  state: string;
  role: AgentRole | null;
  outcome: DispatchPlanOutcome;
  reason?: DispatchRefusal | "qa_newer_head" | string;
  /** The run `dispatch` would record (planned id, never stored), when planned. */
  run?: Run;
  /** When a queued dispatch may resume. */
  resumeAt?: Date | null;
  /** The dry-run transition of the dispatch move, when one was planned. */
  transition?: MovePlan;
}

/** A ready node that was already ready one interval ago and still has no run (section 2.5 step 3). */
export interface NotRunningAttentionItem {
  kind: "not_running";
  nodeId: string;
  state: string;
  readySince: Date;
  /** What this pass decided for it. */
  dispatch: DispatchPlanOutcome;
  reason?: string;
}

/**
 * A node in Verifying on staging with no staging deploy recorded for longer than
 * `staging_deploy_attention_after_minutes` (D-225, O-40).
 */
export interface StagingDeployWaitAttentionItem {
  kind: "staging_deploy_wait";
  nodeId: string;
  state: string;
  waitingSince: Date;
  waitedMinutes: number;
  limitMinutes: number;
}

export type AttentionItem = NotRunningAttentionItem | StagingDeployWaitAttentionItem;

export interface AdvancePlan extends MovePlan {
  /** The dispatch of the next state's owner (QA), evaluated only when the move is planned. */
  dispatch?: DispatchPlan;
}

/** An active run with no activity within its budget window (report only). */
export interface Stall {
  runId: string;
  nodeId: string | null;
  bot: string;
  lastActivityAt: Date;
  /** The run's `budget.maxMinutes`, or null when the budget is unreadable. */
  budgetMinutes: number | null;
  idleMinutes: number;
}

/**
 * A gate request the pass would close (D-199): `cancelled` when its node is Done, `expired` when
 * it has waited unanswered for `gate_request_expiry_days`. Dry run reports it and closes nothing.
 */
export interface GateCleanupCandidate {
  gateRequestId: string;
  projectId: string;
  topicKey: string;
  nodeId: string | null;
  reason: "node_done" | "expired";
  closeAs: "cancelled" | "expired";
}

export interface PollReport {
  repo: string;
  results: PollResult[];
  /** Set when the GitHub reader failed; the pass goes on with the other steps. */
  error?: string;
}

export interface ExecutionLimits {
  monthlyLimit: number;
  /** The share of the limit, in percent, at which Didi is alerted. */
  alertPercent: number;
}

export interface ExecutionAlert extends ExecutionLimits {
  count: number;
  /** The count at which the alert is raised. */
  threshold: number;
  alert: boolean;
}

export interface ReconcileReport {
  mode: "dry_run";
  /** Why the pass did nothing, or null when it ran. */
  stopped: "kill_switch" | "live_mode_not_built" | null;
  at: Date;
  specVersion: string;
  polls: PollReport[];
  releases: MovePlan[];
  dispatches: DispatchPlan[];
  attention: AttentionItem[];
  advances: AdvancePlan[];
  /** The merge moves (In QA review to Verifying on staging) the pass planned or found blocked. */
  merges: MovePlan[];
  /**
   * The items in Verifying on staging: the staging deploy covering each merge commit, recorded
   * when GitHub reports it, and the dry-run row of the move a recorded staging check or failed
   * deploy calls for.
   */
  staging: StagingResult[];
  stalls: Stall[];
  gateCleanup: GateCleanupCandidate[];
  executions: ExecutionAlert | null;
  /** Settings the pass needed and could not read, with what it did instead. */
  problems: string[];
}

/** The D-167 values, also seeded by migration 0001. Used only while a setting is missing. */
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  monthlyLimit: 1000,
  alertPercent: 80,
};

/**
 * Whether this month's Windmill executions call for the alert to Didi (D-167, P-21): at or
 * above `alertPercent` of `monthlyLimit`, so 800 of 1,000 with the defaults.
 */
export function executionAlert(count: number, limits: ExecutionLimits): ExecutionAlert {
  if (!Number.isInteger(count) || count < 0) {
    throw new LibraryError("The execution count must be a whole number of at least 0");
  }
  const threshold = Math.ceil((limits.monthlyLimit * limits.alertPercent) / 100);
  return { ...limits, count, threshold, alert: count >= threshold };
}

async function positiveNumberSetting(
  store: StoreOps,
  key: string,
): Promise<number | null> {
  const value = (await store.getSetting(key))?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** The execution limit and alert percent from settings, with the D-167 values when missing. */
export async function readExecutionLimits(
  store: StoreOps,
  problems: string[] = [],
): Promise<ExecutionLimits> {
  const limit = await positiveNumberSetting(store, "windmill_monthly_execution_limit");
  const percent = await positiveNumberSetting(store, "windmill_alert_percent");
  if (limit === null) {
    problems.push(
      "windmill_monthly_execution_limit is missing or invalid: used 1000 (D-167)",
    );
  }
  if (percent === null || percent > 100) {
    problems.push("windmill_alert_percent is missing or invalid: used 80 (D-167)");
  }
  return {
    monthlyLimit: limit ?? DEFAULT_EXECUTION_LIMITS.monthlyLimit,
    alertPercent:
      percent !== null && percent <= 100
        ? percent
        : DEFAULT_EXECUTION_LIMITS.alertPercent,
  };
}

const roleOf = (name: string | undefined | null): AgentRole | null => {
  const lower = name?.toLowerCase();
  return AGENT_ROLES.find((role) => role === lower) ?? null;
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

const MINUTE = 60_000;

/** Runs one reconcile pass in dry run and returns what it planned. */
export async function reconcile(
  deps: ReconcileDeps,
  input: ReconcileInput = {},
): Promise<ReconcileReport> {
  const { store, contracts, clock } = deps;
  const library = createLibrary(deps);
  const runs = createRuns(deps);
  const builderRuns = createBuilderRuns(deps);
  const now = clock.now();
  const problems: string[] = [];
  const report: ReconcileReport = {
    mode: "dry_run",
    stopped: null,
    at: now,
    specVersion: contracts.version,
    polls: [],
    releases: [],
    dispatches: [],
    attention: [],
    advances: [],
    merges: [],
    staging: [],
    stalls: [],
    gateCleanup: [],
    executions: null,
    problems,
  };

  if (input.windmillExecutionsThisMonth !== undefined) {
    report.executions = executionAlert(
      input.windmillExecutionsThisMonth,
      await readExecutionLimits(store, problems),
    );
  }

  // Step 1. The kill switch stops everything, the polling backstop included.
  if ((await store.getSetting("kill_switch"))?.value === true) {
    report.stopped = "kill_switch";
    return report;
  }
  // Only dry run is built. A missing setting means dry run, as in the library.
  if ((await store.getSetting("dry_run"))?.value === false) {
    report.stopped = "live_mode_not_built";
    return report;
  }

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;
  const movesFrom = (node: Node): TransitionContract[] =>
    contracts.transitions.filter(
      (move) =>
        !move.escalation &&
        move.from === node.state &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  /** A state with no way out except escalation: Done. */
  const isTerminal = (state: string): boolean =>
    !stateOf(state)?.escalated &&
    !contracts.transitions.some((move) => !move.escalation && move.from === state);

  const nodes = await store.listNodes({});
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const projectIds = [...new Set(nodes.map((n) => n.projectId))];

  // The polling backstop (ADR 0113 section 6), before the steps that read evidence. One poll
  // per repository with dispatched work.
  const repos = new Set<string>();
  for (const projectId of projectIds) {
    const project = await store.getProject(projectId);
    if (project && (await store.listDispatches({ repo: project.repo })).length > 0) {
      repos.add(project.repo);
    }
  }
  for (const repo of [...repos].sort()) {
    try {
      report.polls.push({ repo, results: await pollRepository(deps, repo) });
    } catch {
      report.polls.push({ repo, results: [], error: "poll_failed" });
    }
  }

  /**
   * Asks the library for one move, skipping a dry-run row identical to the node's latest
   * transition: same from and to state, same spec version, same evidence ids, written since the
   * node entered its state. An unchanged plan therefore writes one row, however many passes see
   * it; a change in the evidence the guards relied on writes a new one.
   */
  async function requestMove(node: Node, toState: string): Promise<MovePlan> {
    const request: TransitionRequest = {
      nodeId: node.id,
      toState,
      trigger: TRIGGER,
      actor: ACTOR,
    };
    const base = { nodeId: node.id, fromState: node.state, toState };
    const check = await library.checkTransition(request);
    if (check.outcome !== "allowed") {
      return {
        ...base,
        outcome: check.outcome,
        reason: check.reason,
        guardReport: check.guardReport,
      };
    }
    const latest = (await store.listTransitions(node.id)).at(-1);
    if (
      latest &&
      latest.mode === "dry_run" &&
      latest.fromState === node.state &&
      latest.toState === toState &&
      latest.specVersion === contracts.version &&
      latest.at.getTime() >= node.stateSince.getTime() &&
      sameIds(latest.evidenceIds, check.evidenceIds)
    ) {
      return {
        ...base,
        outcome: "already_planned",
        guardReport: check.guardReport,
        transitionId: latest.id,
      };
    }
    const result = await library.requestTransition(request);
    return {
      ...base,
      outcome: result.outcome,
      reason: result.reason,
      guardReport: result.guardReport,
      transitionId: result.transitionId,
    };
  }

  /** The PR and head commit from the newest `ci_run`, which a QA dispatch needs. */
  async function headOf(
    nodeId: string,
  ): Promise<{ prNumber: number; headSha: string } | null> {
    const ciRun = (await store.listEvidence({ nodeId, kind: "ci_run" })).at(-1);
    const payload = ciRun ? readCiRun(ciRun.payload) : null;
    return ciRun?.commitSha && payload
      ? { prNumber: payload.pr, headSha: ciRun.commitSha }
      : null;
  }

  // Runs this pass planned. They count as active for admission, so the limits hold.
  const planned: Run[] = [];

  async function planDispatch(node: Node, role: AgentRole): Promise<DispatchPlan> {
    const plan: DispatchPlan = {
      nodeId: node.id,
      state: node.state,
      role,
      outcome: "planned",
    };
    const request: DispatchRequest = { nodeId: node.id, role, ...deps.bots[role] };
    if (role === "qa") {
      const head = await headOf(node.id);
      if (!head) return { ...plan, outcome: "no_head" };
      Object.assign(request, head);
    }
    const result = await runs.planDispatch(request, planned);
    if (!result.admitted) return { ...plan, outcome: "refused", reason: result.reason };
    planned.push(result.run);
    return { ...plan, run: result.run };
  }

  // Step 2. Release: each Blocked node whose guards for the move to Ready pass.
  for (const node of nodes) {
    const state = stateOf(node.state);
    if (!state?.requiresBlockedReason || state.escalated) continue;
    for (const move of movesFrom(node))
      report.releases.push(await requestMove(node, move.to));
  }

  // Step 3. Dispatch: each node ready for an agent with no active run, each node queued after
  // `usage_exhausted` once its wait has passed, and each node a failed QA round or staging check
  // sent back to its building state with no builder run since (src/core/builder-runs.ts).
  const intervalMinutes = await positiveNumberSetting(
    store,
    "reconcile_interval_minutes",
  );
  if (intervalMinutes === null) {
    problems.push(
      "reconcile_interval_minutes is missing or invalid: no attention list",
    );
  }
  const activeNodeIds = new Set((await store.listActiveRuns()).map((r) => r.nodeId));
  for (const node of nodes) {
    if (stateOf(node.state)?.escalated || activeNodeIds.has(node.id)) continue;
    const dispatchMove = movesFrom(node).find((move) =>
      move.guards.includes(DISPATCH_GUARD),
    );
    const latestRun = (await store.listRuns({ nodeId: node.id })).at(-1);
    const queuedBot = latestRun?.outcome === "usage_exhausted" ? latestRun.bot : null;
    // A builder run due with no move: the item came back from a failed QA round or staging
    // check (O-41). It is planned like a queued dispatch.
    const builderRun = dispatchMove ? null : await builderRuns.check(node.id);
    const builderRole = builderRun?.due ? builderRun.role : null;
    if (!dispatchMove && queuedBot === null && builderRole === null) continue;

    const role = dispatchMove
      ? roleOf(stateOf(node.state)?.owner)
      : (builderRole ?? roleOf(queuedBot));
    let plan: DispatchPlan;
    if (role === null) {
      plan = { nodeId: node.id, state: node.state, role, outcome: "no_role" };
    } else if (!library.canDispatch(node)) {
      plan = { nodeId: node.id, state: node.state, role, outcome: "not_dispatchable" };
    } else {
      const queued = await runs.queuedDispatch(node.id);
      if (queued && !queued.ready) {
        plan = {
          nodeId: node.id,
          state: node.state,
          role,
          outcome: "waiting",
          reason: queued.cause,
          resumeAt: queued.resumeAt,
        };
      } else if (dispatchMove) {
        const check = await library.checkTransition({
          nodeId: node.id,
          toState: dispatchMove.to,
          trigger: TRIGGER,
          actor: ACTOR,
        });
        if (check.outcome !== "allowed") {
          plan = {
            nodeId: node.id,
            state: node.state,
            role,
            outcome: "guard_failed",
            reason: check.guardReport
              .filter((c) => !c.pass)
              .map((c) => c.name)
              .join(", "),
          };
        } else {
          plan = await planDispatch(node, role);
          if (plan.outcome === "planned")
            plan.transition = await requestMove(node, dispatchMove.to);
        }
      } else {
        plan = await planDispatch(node, role);
      }
    }
    report.dispatches.push(plan);

    // Ready at the previous pass (one interval ago) and still not running: in dry run that is
    // every ready node older than one interval, since nothing is started.
    const waiting = plan.outcome === "waiting" || plan.outcome === "not_dispatchable";
    if (
      dispatchMove &&
      !waiting &&
      intervalMinutes !== null &&
      now.getTime() - node.stateSince.getTime() >= intervalMinutes * MINUTE
    ) {
      report.attention.push({
        kind: "not_running",
        nodeId: node.id,
        state: node.state,
        readySince: node.stateSince,
        dispatch: plan.outcome,
        ...(plan.reason ? { reason: plan.reason } : {}),
      });
    }
  }

  // Step 4. Advance from evidence: the moves guarded by CI green on the head, then the dispatch
  // of the next state's owner (QA).
  for (const node of nodes) {
    if (stateOf(node.state)?.escalated) continue;
    for (const move of movesFrom(node).filter(
      (m) => m.guards.includes(ADVANCE_GUARD) && !m.guards.includes(MERGE_MOVE_GUARD),
    )) {
      const advance: AdvancePlan = await requestMove(node, move.to);
      if (advance.outcome === "planned" || advance.outcome === "already_planned") {
        const role = roleOf(stateOf(move.to)?.owner);
        advance.dispatch = role
          ? await planDispatch(node, role)
          : { nodeId: node.id, state: node.state, role, outcome: "no_role" };
      }
      report.advances.push(advance);
    }
  }
  // Step 4, the merge moves: a node whose QA passed on its head merges, or, when its PR is merged
  // already, records the move. The merge step reads the PR and records its mergeable state on the
  // head (a fact, like the polling backstop), then plans the move as a dry-run row. It merges
  // nothing and opens no gate request.
  const merges = createMerges(deps);
  for (const node of nodes) {
    if (stateOf(node.state)?.escalated) continue;
    const move = merges.mergeMoveFor(node);
    if (!move) continue;
    const base = { nodeId: node.id, fromState: node.state, toState: move.to };
    let inspected;
    try {
      inspected = await merges.inspect(node.id);
    } catch {
      report.merges.push({
        ...base,
        outcome: "rejected",
        reason: "github_read_failed",
        guardReport: [],
      });
      continue;
    }
    if (inspected.stop) {
      // Guards that fail before GitHub is read: the plan names them, and nothing is written.
      if (inspected.stop.reason === "guard_failed") {
        report.merges.push(await requestMove(node, move.to));
      } else {
        report.merges.push({
          ...base,
          outcome: inspected.stop.outcome,
          reason: inspected.stop.reason,
          guardReport: [],
        });
      }
      continue;
    }
    report.merges.push(await requestMove(node, move.to));
  }

  // Step 4 also says to dispatch the staging check once main has deployed to staging (M3.4). The
  // polling backstop for the deploy: the staging step reads GitHub's staging deployments covering
  // each merge commit and records the newest finished one as `staging_deploy` or
  // `staging_deploy_failed` (D-225). It runs no check (no checker in dry
  // run); a check already recorded gets the dry-run row of its move. A node that has waited past
  // `staging_deploy_attention_after_minutes` with no deploy recorded goes on the attention list
  // (D-225, O-40).
  const staging = createStaging({ ...deps, checker: null });
  for (const node of nodes) {
    if (stateOf(node.state)?.escalated || !staging.stagingMovesFor(node)) continue;
    report.staging.push(await staging.verify(node.id));
  }
  const stagingWaits = await staging.deployWaits(report.staging);
  if (stagingWaits.problem) problems.push(stagingWaits.problem);
  for (const wait of stagingWaits.waits) {
    report.attention.push({
      kind: "staging_deploy_wait",
      state: nodeById.get(wait.nodeId)?.state ?? "",
      ...wait,
    });
  }

  // Step 5. Stall check: active runs with no activity within their budget window. Activity is
  // the run's start and any evidence recorded under the run.
  for (const run of await store.listActiveRuns()) {
    const evidence = run.nodeId
      ? (await store.listEvidence({ nodeId: run.nodeId })).filter(
          (e) => e.runId === run.id,
        )
      : [];
    const last = Math.max(
      run.startedAt.getTime(),
      ...evidence.map((e) => e.recordedAt.getTime()),
    );
    const budget = run.budget as { maxMinutes?: unknown } | null;
    const budgetMinutes =
      typeof budget?.maxMinutes === "number" && budget.maxMinutes > 0
        ? budget.maxMinutes
        : null;
    const idleMinutes = (now.getTime() - last) / MINUTE;
    if (budgetMinutes === null || idleMinutes > budgetMinutes) {
      report.stalls.push({
        runId: run.id,
        nodeId: run.nodeId,
        bot: run.bot,
        lastActivityAt: new Date(last),
        budgetMinutes,
        idleMinutes,
      });
    }
  }

  // Step 6. Clean up (D-199). A newer request on the same topic already supersedes the older one
  // when it is opened (schema invariant 5). A request on a node that reached Done would be
  // cancelled, and one left unanswered for `gate_request_expiry_days` would expire. Dry run only
  // reports them; reopening a still-needed request after expiry is the gate lifecycle (M4.1).
  const expiryDays = await positiveNumberSetting(store, "gate_request_expiry_days");
  for (const projectId of projectIds) {
    const open: GateRequest[] = await store.listOpenGateRequests(projectId);
    for (const gate of open) {
      const node = gate.nodeId ? nodeById.get(gate.nodeId) : undefined;
      const base = {
        gateRequestId: gate.id,
        projectId,
        topicKey: gate.topicKey,
        nodeId: gate.nodeId,
      };
      if (node && isTerminal(node.state)) {
        report.gateCleanup.push({ ...base, reason: "node_done", closeAs: "cancelled" });
      } else if (
        expiryDays !== null &&
        now.getTime() - gate.createdAt.getTime() >= expiryDays * 24 * 60 * MINUTE
      ) {
        report.gateCleanup.push({ ...base, reason: "expired", closeAs: "expired" });
      }
    }
  }

  // Step 7, the Linear mirror, is dropped (D-192). Step 8, the spend roll-up, is M4.5.
  return report;
}
