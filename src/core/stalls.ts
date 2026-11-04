// The stall check (D-302, D-112, O-94): both kinds of stalled work, from one read-only check that
// the reconcile pass, the reconcile flow's result and Didi's daily check all read, so they cannot
// drift. Plain logic over the store, the contracts, the guards and a passed-in clock (D-162). It
// writes nothing: the id source it hands the library refuses, and every store call is a read.
//
// Stalled runs (the reconcile pass's step 5, architecture section 2.5): active runs with no
// activity within their budget window. Activity is the run's start and any evidence recorded
// under the run. A run whose `budget.maxMinutes` cannot be read counts as stalled.
//
// Stalled items (D-112): items the runner would start a run for, found the way the reconcile
// pass's step 3 finds them, from the contracts and the dispatch guard, never from a list here:
// - ready to start: the node's state has a move guarded by `agent_ready_not_on_hold` (the
//   dispatch move), or its latest run ended `usage_exhausted` (a queued dispatch), or a builder
//   run is due with no move (src/core/builder-runs.ts, O-41); and the library would dispatch it
//   (`canDispatch`: not escalated, not held, agent-ready and not stale);
// - left out: an item with an open blocker (the `blockers_done` guard fails), the subject of an
//   open blocking gate request, held, or with an active run;
// - stalled: ready to start for at least one reconcile cycle (`reconcile_interval_minutes`, the
//   setting the pass reads; flows/windmill.yaml keeps the schedule equal to it). Ready since is
//   the later of when the item entered its state and when its latest run ended.
// What each one waits on is what the runner would say right now, in the pass's order: the kill
// switch and dry run; no agent owner; the usage-exhausted wait and when it ends; each failing
// guard of the dispatch move with the guard's own note; no head commit for QA; or admission's
// refusal (`runs.planDispatch`, read only). Runs admitted earlier in the same check count as
// active, as in the pass, so the cluster and Developer limits are counted. When nothing would
// stop it: "nothing found: the runner should have started it".
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import { createBuilderRuns } from "./builder-runs.ts";
import { blockersDone } from "./guards/dispatch.ts";
import { readCiRun } from "./guards/evidence.ts";
import { createLibrary, type Clock, type IdSource } from "./library.ts";
import { DISPATCH_GUARD } from "./run-start.ts";
import {
  createRuns,
  DEVELOPER_RUNS_PER_PROJECT,
  type DispatchRefusal,
  type DispatchRequest,
  type RoleRunLimits,
} from "./runs.ts";
import type { AgentRole, Node, Run, Store, StoreOps } from "./store.ts";
import type { TaskTypes } from "./task-types.ts";

/** The setting the reconcile pass and its schedule use for one cycle (D-164). */
export const RECONCILE_INTERVAL_SETTING = "reconcile_interval_minutes";

export const CYCLE_SETTING_PROBLEM = `${RECONCILE_INTERVAL_SETTING} is missing or invalid: no stalled items list`;

const MINUTE = 60_000;

const AGENT_ROLES: readonly AgentRole[] = [
  "developer",
  "qa",
  "designer",
  "council",
  "triage",
];

const roleOf = (name: string | undefined | null): AgentRole | null => {
  const lower = name?.toLowerCase();
  return AGENT_ROLES.find((role) => role === lower) ?? null;
};

/** An active run with no activity within its budget window. */
export interface StalledRun {
  runId: string;
  projectId: string;
  nodeId: string | null;
  bot: string;
  lastActivityAt: Date;
  /** The run's `budget.maxMinutes`, or null when the budget is unreadable. */
  budgetMinutes: number | null;
  idleMinutes: number;
}

/** Why a stalled item has not started, as the runner would say it now. */
export type StallWaitCode =
  | "kill_switch"
  | "dry_run"
  | "no_role"
  | "guard_failed"
  | "no_head"
  | "qa_newer_head"
  | "nothing_found"
  | Exclude<DispatchRefusal, "kill_switch">;

export interface StallWait {
  code: StallWaitCode;
  /** For `guard_failed`: the failing guard's name. */
  guard?: string;
  /** The failing guard's own note, the usage-exhausted cause, or why no route passed. */
  detail: string | null;
  /** When a usage-exhausted wait ends; null while its setting is missing. */
  until?: Date | null;
}

/** The fixed text for each wait, for the daily check. */
export const STALL_WAIT_TEXT: Record<StallWaitCode, string> = {
  kill_switch: "the kill switch is on",
  dry_run: "dry run is on: the runner plans dispatches and starts none",
  no_role: "its state's owner is not an agent role",
  guard_failed: "a guard on its dispatch move fails",
  usage_exhausted_wait: "it waits after a usage-exhausted end",
  no_head: "a QA dispatch needs a head commit, and no CI run names one",
  qa_duplicate: "a QA run on the same head is active",
  qa_newer_head: "a QA run on an older head of its pull request is active",
  item_has_active_run: "it has an active run",
  developer_limit: `the project's limit of ${DEVELOPER_RUNS_PER_PROJECT} Developer runs at once is reached`,
  cluster_limit_unset:
    "the cluster's active-run limit (agent_cluster_max_active_runs) is not set",
  cluster_full: "the cluster's active-run limit is reached",
  no_route: "no model route passes for its task type",
  close_already_run: "a close run for its pull request was already started",
  nothing_found: "nothing found: the runner should have started it",
};

export interface StalledItem {
  nodeId: string;
  projectId: string;
  /** Recorded text, as data. */
  title: string;
  state: string;
  /** The role the runner would start. */
  role: AgentRole | null;
  readySince: Date;
  stalledForMinutes: number;
  waits: StallWait[];
}

export interface StalledItems {
  /** One reconcile cycle in minutes, or null when the setting is missing or invalid. */
  cycleMinutes: number | null;
  /** Longest stalled first. */
  items: StalledItem[];
  /** Set when the cycle could not be read; the list is then empty. */
  problem: string | null;
}

export interface StalledRunsDeps {
  store: Pick<StoreOps, "listActiveRuns" | "listEvidence">;
  clock: Clock;
}

export interface StalledItemsDeps {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  limits: RoleRunLimits;
  /** What a dispatch names from each role's bot file. */
  bots: Record<AgentRole, { runtime: string; botVersion: string }>;
  taskTypes: TaskTypes;
}

/** The stall check writes nothing, so nothing it calls may ask for an id. */
const NO_IDS: IdSource = {
  next: () => {
    throw new Error("the stall check writes nothing");
  },
};

/** Active runs with no activity within their budget window, longest idle first. Reads only. */
export async function stalledRuns({
  store,
  clock,
}: StalledRunsDeps): Promise<StalledRun[]> {
  const now = clock.now().getTime();
  const stalls: StalledRun[] = [];
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
    const idleMinutes = (now - last) / MINUTE;
    if (budgetMinutes === null || idleMinutes > budgetMinutes) {
      stalls.push({
        runId: run.id,
        projectId: run.projectId,
        nodeId: run.nodeId,
        bot: run.bot,
        lastActivityAt: new Date(last),
        budgetMinutes,
        idleMinutes,
      });
    }
  }
  return stalls.sort(
    (a, b) =>
      a.lastActivityAt.getTime() - b.lastActivityAt.getTime() ||
      a.runId.localeCompare(b.runId),
  );
}

/** One reconcile cycle from settings, or null when missing or invalid. */
export async function reconcileCycleMinutes(
  store: Pick<StoreOps, "getSetting">,
): Promise<number | null> {
  const value = (await store.getSetting(RECONCILE_INTERVAL_SETTING))?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** The PR and head commit from the newest `ci_run`, which a QA dispatch needs. */
export async function qaHeadOf(
  store: Pick<StoreOps, "listEvidence">,
  nodeId: string,
): Promise<{ prNumber: number; headSha: string } | null> {
  const ciRun = (await store.listEvidence({ nodeId, kind: "ci_run" })).at(-1);
  const payload = ciRun ? readCiRun(ciRun.payload) : null;
  return ciRun?.commitSha && payload
    ? { prNumber: payload.pr, headSha: ciRun.commitSha }
    : null;
}

/** Items ready to start for at least one reconcile cycle with no run, longest first. Reads only. */
export async function stalledItems(deps: StalledItemsDeps): Promise<StalledItems> {
  const { store, contracts, clock } = deps;
  // One instant for the whole check, so every item is judged at the same time.
  const now = clock.now();
  const readDeps = { ...deps, clock: { now: () => now }, ids: NO_IDS };
  const library = createLibrary(readDeps);
  const runs = createRuns(readDeps);
  const builderRuns = createBuilderRuns(readDeps);

  const cycleMinutes = await reconcileCycleMinutes(store);
  if (cycleMinutes === null) {
    return { cycleMinutes, items: [], problem: CYCLE_SETTING_PROBLEM };
  }
  const killSwitch = (await store.getSetting("kill_switch"))?.value === true;
  // A missing setting means dry run, as in the library.
  const dryRun = (await store.getSetting("dry_run"))?.value !== false;

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;
  const movesFrom = (node: Node): TransitionContract[] =>
    contracts.transitions.filter(
      (move) =>
        !move.escalation &&
        move.from === node.state &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  const check = { kind: "reconcile" as const, ref: null };
  const actor = { kind: "runner" as const, id: "reconcile" };

  const active = await store.listActiveRuns();
  const activeNodeIds = new Set(active.map((r) => r.nodeId));
  const blockingGates = new Map<string, Set<string | null>>();
  const blockingGateOn = async (node: Node): Promise<boolean> => {
    let nodes = blockingGates.get(node.projectId);
    if (!nodes) {
      nodes = new Set(
        (await store.listOpenGateRequests(node.projectId))
          .filter((g) => g.blocking)
          .map((g) => g.nodeId),
      );
      blockingGates.set(node.projectId, nodes);
    }
    return nodes.has(node.id);
  };

  // Runs admitted earlier in this check: they count as active, as in the pass.
  const planned: Run[] = [];
  const items: StalledItem[] = [];
  for (const node of await store.listNodes({})) {
    if (stateOf(node.state)?.escalated || activeNodeIds.has(node.id)) continue;
    const dispatchMove = movesFrom(node).find((move) =>
      move.guards.includes(DISPATCH_GUARD),
    );
    const nodeRuns = await store.listRuns({ nodeId: node.id });
    const latestRun = nodeRuns.at(-1);
    const queuedBot = latestRun?.outcome === "usage_exhausted" ? latestRun.bot : null;
    const builderRun = dispatchMove ? null : await builderRuns.check(node.id);
    const builderRole = builderRun?.due ? builderRun.role : null;
    if (!dispatchMove && queuedBot === null && builderRole === null) continue;
    // Not ready to start: held, not agent-ready or stale; blocked; or behind a blocking gate.
    if (!library.canDispatch(node)) continue;
    if (!(await blockersDone({ node, store })).pass) continue;
    if (await blockingGateOn(node)) continue;

    const role = dispatchMove
      ? roleOf(stateOf(node.state)?.owner)
      : (builderRole ?? roleOf(queuedBot));
    const waits: StallWait[] = [];
    if (killSwitch) waits.push({ code: "kill_switch", detail: null });
    if (dryRun) waits.push({ code: "dry_run", detail: null });
    const add = (wait: StallWait): void => {
      const same = (w: StallWait) =>
        w.code === wait.code && w.guard === wait.guard && w.detail === wait.detail;
      if (!waits.some(same)) waits.push(wait);
    };

    const admit = async (agent: AgentRole): Promise<void> => {
      const request: DispatchRequest = {
        nodeId: node.id,
        role: agent,
        runtime: deps.bots[agent].runtime,
        botVersion: deps.bots[agent].botVersion,
      };
      if (agent === "qa") {
        const head = await qaHeadOf(store, node.id);
        if (!head) {
          add({ code: "no_head", detail: null });
          return;
        }
        Object.assign(request, head);
      }
      const result = await runs.planDispatch(request, planned);
      if (result.admitted) {
        planned.push(result.run);
        return;
      }
      if (result.reason === "no_route") {
        const { settingsProblems, rejected } = result.noRoute;
        add({
          code: "no_route",
          detail:
            settingsProblems.length > 0
              ? settingsProblems.join("; ")
              : rejected
                  .map((r) => `${r.model}: ${r.failed.map((f) => f.rule).join(", ")}`)
                  .join("; ") || null,
        });
        return;
      }
      add({ code: result.reason, detail: null });
    };

    if (role === null) {
      add({ code: "no_role", detail: null });
    } else {
      const queued = await runs.queuedDispatch(node.id);
      if (queued && !queued.ready) {
        add({
          code: "usage_exhausted_wait",
          detail: queued.cause,
          until: queued.resumeAt,
        });
      } else if (dispatchMove) {
        const result = await library.checkTransition({
          nodeId: node.id,
          toState: dispatchMove.to,
          trigger: check,
          actor,
        });
        if (result.outcome !== "allowed") {
          const failed = result.guardReport.filter((c) => !c.pass);
          for (const guard of failed) {
            add({
              code: "guard_failed",
              guard: guard.name,
              detail: guard.detail ?? null,
            });
          }
          if (failed.length === 0)
            add({ code: "guard_failed", detail: result.reason ?? null });
        } else {
          await admit(role);
        }
      } else {
        await admit(role);
      }
    }

    const lastEnd = latestRun?.endedAt?.getTime() ?? 0;
    const readySince = new Date(Math.max(node.stateSince.getTime(), lastEnd));
    const stalledFor = now.getTime() - readySince.getTime();
    if (stalledFor < cycleMinutes * MINUTE) continue;
    items.push({
      nodeId: node.id,
      projectId: node.projectId,
      title: node.title,
      state: node.state,
      role,
      readySince,
      stalledForMinutes: Math.floor(stalledFor / MINUTE),
      waits: waits.length > 0 ? waits : [{ code: "nothing_found", detail: null }],
    });
  }
  items.sort(
    (a, b) =>
      a.readySince.getTime() - b.readySince.getTime() ||
      a.nodeId.localeCompare(b.nodeId),
  );
  return { cycleMinutes, items, problem: null };
}
