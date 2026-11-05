// Steps 2 to 4 of the reconcile pass in live mode (architecture section 2.5, D-329 slice 3,
// O-103). The pass (src/core/reconcile.ts) plans them with the same code in both modes. With
// `dry_run` off it writes nothing and reports what is due, and this acts on that plan through the
// existing paths, in the section's order:
//
// 2. Release: each move the plan found `due` is asked of the library with the pass's own trigger
//    and actor (`reconcile`), so the guards decide again and a lost race retries from a fresh read;
//    a second pass at once finds the item moved and writes nothing. Once the move is applied, the
//    item's first run starts at once (./ready-runs.ts, D-329), before the dispatch step.
// 3. Dispatch: the first run of each ready node the plan admitted (`planned`, a node in a state
//    with the dispatch move) starts through the dispatch's start path (./start-run.ts) with the
//    plan's role, so admission decides again under its lock and the start records the dispatch
//    move. So does QA's run on each node in review the plan admitted (N-80, O-104), on the plan's
//    pull request and head commit with its task type (the review, or the visual comparison); it
//    records no move. A node no longer in the state the plan saw is not started
//    (`state_changed`). A run the plan's admission refused (a limit, no route) is reported with its
//    reason. The plan's other dispatches, a builder's fix round or a builder's or Triage run
//    resumed after `usage_exhausted`, stay with the passes that already take them live (the
//    builder runs pass, the Council and Triage passes), so each has one path.
// 4. Advance from evidence: each move guarded by `ci_green_on_head` the plan found `due` (into In
//    QA review) is asked of the library the same way. Once it is applied, QA's run starts on the
//    plan's pull request and head commit, when the plan admitted it. The called flow
//    `f/foreman/advance_item` acts on one item's plan with the same step (`advanceSteps`,
//    flows/advance-item.ts, D-329 slice 4, O-104), so the event and the pass cannot drift.
//
// Nothing here throws on a refusal or a failed start: each is reported, and the next pass or event
// tries again. The kill switch and dry run are read by the library and the dispatch, as on every
// path, so a switch turned on during the pass stops what is left of it. The steps run inside the
// reconcile flow's own run and add no Windmill run (D-164).
import { ADVANCE_ACTOR, ADVANCE_TRIGGER } from "../../src/core/advances.ts";
import { createLibrary, type TransitionOutcome } from "../../src/core/library.ts";
import { createReadyRuns } from "../../src/core/ready-runs.ts";
import type {
  AdvancePlan,
  DispatchPlan,
  DispatchPlanOutcome,
  MovePlan,
  ReconcileReport,
} from "../../src/core/reconcile.ts";
import type { AgentRole } from "../../src/core/store.ts";
import { VISUAL_TASK_TYPE } from "../../src/core/visual-comparison.ts";
import type { FlowDeps } from "./compose.ts";
import { startReadyRuns, type ReadyRunStart } from "./ready-runs.ts";
import { startRun, type StartRunResult } from "./start-run.ts";

// The pass's own trigger and actor, which the advance check also asks with (O-104).
const ACTOR = ADVANCE_ACTOR;
const TRIGGER = ADVANCE_TRIGGER;

/** What the library did with a move the plan found due. */
export interface StepMove {
  outcome: TransitionOutcome;
  reason?: string;
  transitionId?: string;
  failedGuards: string[];
}

/**
 * What a start did: the dispatch's result, `start_failed` when it threw (the error is not kept),
 * or `state_changed` when the node left the state the plan saw before it was started.
 */
export type StepStart =
  StartRunResult | { outcome: "start_failed" } | { outcome: "state_changed" };

export interface ReleaseStep {
  nodeId: string;
  toState: string;
  move: StepMove;
  /** The item's first run, started once the move is applied (D-329). */
  firstRuns: ReadyRunStart[];
}

/** A run in the plan: a ready node's first run, or QA's run on a node in review. */
export interface DispatchStep {
  nodeId: string;
  role: AgentRole | null;
  /** What the plan decided: `planned`, or `refused` by admission. */
  plan: Extract<DispatchPlanOutcome, "planned" | "refused">;
  /** With `refused`: admission's reason (a limit, `no_route`, ...). */
  reason?: string;
  /** With `planned`: what the start did. */
  result?: StepStart;
}

export interface AdvanceStep {
  nodeId: string;
  toState: string;
  move: StepMove;
  /** QA's run on the plan's head, once the move is applied: what the plan and the start did. */
  qa?: {
    role: AgentRole | null;
    plan: DispatchPlanOutcome;
    reason?: string;
    result?: StepStart;
  };
}

export interface ReconcileSteps {
  releases: ReleaseStep[];
  dispatches: DispatchStep[];
  advances: AdvanceStep[];
}

/** A move the plan found due, asked of the library, and a run it admitted, started. */
function createSteps(deps: FlowDeps) {
  const library = createLibrary(deps);

  async function move(plan: MovePlan): Promise<StepMove> {
    const result = await library.requestTransition({
      nodeId: plan.nodeId,
      toState: plan.toState,
      trigger: TRIGGER,
      actor: ACTOR,
    });
    return {
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.transitionId ? { transitionId: result.transitionId } : {}),
      failedGuards: result.guardReport.filter((c) => !c.pass).map((c) => c.name),
    };
  }

  /** Starts a run the plan admitted, while the node is still in `state`. */
  async function start(plan: DispatchPlan, state: string): Promise<StepStart> {
    const role = plan.role;
    const node = await deps.store.getNode(plan.nodeId);
    if (!role || !node || node.state !== state) return { outcome: "state_changed" };
    try {
      return await startRun(deps, {
        nodeId: plan.nodeId,
        role,
        // QA's dispatch names the pull request and head commit the plan read, and its task type:
        // the review by default, or the visual comparison (D-242).
        ...(role === "qa" && plan.run
          ? {
              headSha: plan.run.headSha,
              prNumber: plan.run.prNumber,
              ...(plan.run.taskType === VISUAL_TASK_TYPE
                ? { taskType: VISUAL_TASK_TYPE }
                : {}),
            }
          : {}),
      });
    } catch {
      // The run ended `fail` before it started (./start-run.ts); the next pass tries again.
      return { outcome: "start_failed" };
    }
  }

  return { move, start };
}

/**
 * Step 4 on the advances a plan found: each move due, through the library with the pass's
 * trigger and actor, then QA's run on the plan's head once the move is applied. The reconcile
 * flow runs it on the pass's plan, and `f/foreman/advance_item` on one item's (O-104).
 */
export async function advanceSteps(
  deps: FlowDeps,
  plans: readonly AdvancePlan[],
): Promise<AdvanceStep[]> {
  const { move, start } = createSteps(deps);
  const advances: AdvanceStep[] = [];
  for (const plan of plans) {
    if (plan.outcome !== "due") continue;
    const moved = await move(plan);
    const step: AdvanceStep = {
      nodeId: plan.nodeId,
      toState: plan.toState,
      move: moved,
    };
    const qa = plan.dispatch;
    if (moved.outcome === "applied" && qa) {
      step.qa = {
        role: qa.role,
        plan: qa.outcome,
        ...(qa.reason ? { reason: qa.reason } : {}),
        ...(qa.outcome === "planned" ? { result: await start(qa, plan.toState) } : {}),
      };
    }
    advances.push(step);
  }
  return advances;
}

/** Acts on the plan of a live pass: steps 2, 3 and 4 in order. */
export async function runReconcileSteps(
  deps: FlowDeps,
  report: Pick<ReconcileReport, "releases" | "dispatches" | "advances">,
): Promise<ReconcileSteps> {
  const ready = createReadyRuns(deps);
  const { move, start } = createSteps(deps);

  // Step 2. Release, then the released item's first run at once.
  const releases: ReleaseStep[] = [];
  for (const plan of report.releases) {
    if (plan.outcome !== "due") continue;
    const moved = await move(plan);
    releases.push({
      nodeId: plan.nodeId,
      toState: plan.toState,
      move: moved,
      firstRuns:
        moved.outcome === "applied" ? await startReadyRuns(deps, [plan.nodeId]) : [],
    });
  }

  // Step 3. The first runs and QA's runs in review the plan admitted; report the ones its
  // admission refused.
  const dispatches: DispatchStep[] = [];
  for (const plan of report.dispatches) {
    if (plan.outcome !== "planned" && plan.outcome !== "refused") continue;
    // A first run: the plan saw the node in a state with the dispatch move for its track. QA's
    // run: the plan saw the node in the state QA owns.
    const node = await deps.store.getNode(plan.nodeId);
    const seen = node ? { ...node, state: plan.state } : null;
    if (!seen) continue;
    const qaRun = plan.role === "qa" && ready.ownerRole(seen) === "qa";
    if (!qaRun && !ready.dispatchMoveOf(seen)) continue;
    if (plan.outcome === "refused") {
      dispatches.push({
        nodeId: plan.nodeId,
        role: plan.role,
        plan: plan.outcome,
        ...(plan.reason ? { reason: plan.reason } : {}),
      });
    } else {
      dispatches.push({
        nodeId: plan.nodeId,
        role: plan.role,
        plan: plan.outcome,
        result: await start(plan, plan.state),
      });
    }
  }

  // Step 4. Advance from evidence, then QA's run on the head.
  const advances = await advanceSteps(deps, report.advances);

  return { releases, dispatches, advances };
}
