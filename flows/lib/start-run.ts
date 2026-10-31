// How the dispatch flow starts a run (build plan M3.2, ADR 0102, ADR 0106 sections 5 to 7). The
// order is chosen so a failure part way leaves no running agent the store does not know about,
// and no move without a running agent:
//
// 1. Read the item and build the run's input (D-213). A malformed item refuses here, before
//    anything is written.
// 2. Check the dispatch move's guards (`checkStart`), so a run is not started only for its move
//    to be refused, and read the Flex capacity bounds from the settings, so a bad setting
//    refuses before anything is written.
// 3. Mint the state API token and admit the run (`runs.dispatch`): the run, its route and the
//    token's hash commit together.
// 4. Build the task and `start` it. If either fails, nothing runs: the run ends `fail` and its
//    token is revoked.
// 5. Record the start (`recordStart`): the handle, the `dispatch_record` and the move, in one
//    transaction. If it refuses (the kill switch, dry run, a guard, or the run was ended by the
//    kill switch's cancel pass meanwhile) or fails, the started run is cancelled through the
//    runtime and ends `cancelled`, token revoked. If that cancel fails too, the handle is kept on
//    the run so the cancel pass can stop it later.
//
// What remains if the store itself is unreachable after `start`: the agent runs with no handle on
// record until its own deadline (activeDeadlineSeconds), its token expires on its own, and the
// stall check reports the run. Nothing the agent does can move the item, since the move was never
// written.
import { createRunStart } from "../../src/core/run-start.ts";
import { hashRunToken } from "../../src/core/run-tokens.ts";
import {
  createRuns,
  runCapacityLimits,
  type DispatchRefusal,
  type Runs,
} from "../../src/core/runs.ts";
import type { NoRoute } from "../../src/core/routing.ts";
import type { AgentRole, Json, Run } from "../../src/core/store.ts";
import {
  PUSHING_ROLES,
  qaEvidenceIds,
  runBranch,
  taskInput,
} from "../../src/core/task-input.ts";
import type { FlowDeps } from "./compose.ts";
import { dryRunOn } from "./switches.ts";

export interface StartRunInput {
  nodeId: string;
  role: AgentRole;
  headSha?: string | null;
  prNumber?: number | null;
}

export type StartRunResult =
  | { outcome: "planned"; run: Run }
  | { outcome: "not_started"; reason: string; failedGuards: string[] }
  | {
      outcome: "not_admitted";
      reason: DispatchRefusal | "qa_newer_head";
      cancelRunIds?: string[];
      /** With `no_route`: why no candidate passed, for the runner's alert (ADR 0114 section 5). */
      noRoute?: NoRoute;
    }
  | { outcome: "cancelled"; runId: string; reason: string }
  | {
      outcome: "started";
      runId: string;
      handle: unknown;
      transitionId: string | null;
      dispatchRecordId: string | null;
    };

/** Stops a started run and records its end. The end is recorded only once the stop succeeded. */
async function stopStarted(deps: FlowDeps, runs: Runs, runId: string, handle: unknown) {
  try {
    await deps.runtime.cancel(handle);
  } catch (error) {
    // Keep the handle, so the cancel pass can stop the run later. It may already be set.
    await deps.store.setRunHandle(runId, handle as Json).catch(() => false);
    throw error;
  }
  await runs.recordRunnerEnd(runId, "cancelled");
  await deps.runtime.cleanup?.(handle);
}

export async function startRun(
  deps: FlowDeps,
  input: StartRunInput,
): Promise<StartRunResult> {
  const runs = createRuns(deps);
  const request = { ...input, ...deps.bots[input.role] };
  if (await dryRunOn(deps.store)) {
    const plan = await runs.planDispatch(request);
    return plan.admitted
      ? { outcome: "planned", run: plan.run }
      : { outcome: "not_admitted", ...plan };
  }

  const node = await deps.store.getNode(input.nodeId);
  const project = node && (await deps.store.getProject(node.projectId));
  if (!node || !project)
    return { outcome: "not_started", reason: "no_node", failedGuards: [] };
  const branch = PUSHING_ROLES.includes(input.role) ? runBranch(node.id) : null;
  const text = taskInput({ ...input, node, project, branch: branch ?? undefined });

  const starts = createRunStart(deps);
  const check = await starts.checkStart(node.id, input.role);
  if (!check.allowed) return { outcome: "not_started", ...check };
  const capacity = await runCapacityLimits(deps.store);

  const stateApiToken = deps.newRunToken();
  const admitted = await runs.dispatch(request, {
    tokenHash: hashRunToken(stateApiToken),
  });
  if (!admitted.admitted) return { outcome: "not_admitted", ...admitted };
  const { run } = admitted;

  let handle: unknown;
  try {
    const evidenceIds =
      input.role === "qa" && run.headSha
        ? await qaEvidenceIds(deps.store, node.id, run.headSha)
        : [];
    const task = await deps.tasks.taskFor({
      run,
      node,
      project,
      input: text,
      branch,
      evidenceIds,
      capacity,
      stateApiToken,
    });
    handle = await deps.runtime.start(task, deps.limits[input.role]);
  } catch (error) {
    // Nothing was started: the run ends `fail`, which also revokes its token.
    await runs.recordRunnerEnd(run.id, "fail").catch(() => false);
    throw error;
  }

  let recorded;
  try {
    recorded = await starts.recordStart(run, handle as Json);
  } catch (error) {
    await stopStarted(deps, runs, run.id, handle).catch(() => undefined);
    throw error;
  }
  if (!recorded.recorded) {
    await stopStarted(deps, runs, run.id, handle);
    return { outcome: "cancelled", runId: run.id, reason: recorded.reason };
  }
  return {
    outcome: "started",
    runId: run.id,
    handle,
    transitionId: recorded.transitionId,
    dispatchRecordId: recorded.dispatchRecordId,
  };
}
