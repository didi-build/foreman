// How the dispatch flow starts a run (build plan M3.2, ADR 0102, ADR 0106 sections 5 to 7). The
// order is chosen so a failure part way leaves no running agent the store does not know about,
// and no move without a running agent:
//
// 1. Read the item and build the run's input (D-213), with why the item came back on a fix round
//    (O-41). A malformed item refuses here, before anything is written. A Council run's input is
//    its question instead, with the output schema of the question's kind (src/core/council.ts,
//    D-228); a question no longer open refuses here. The Council's call on a visual approval
//    (D-270) has task type `council:visual` and gets the option screenshots as images; one whose
//    screenshots cannot be read refuses here. A QA run of task type `qa:visual` gets the
//    runner's visual comparison instead: the image pairs with their located differences and the
//    spec sections, and the visual answer schema (src/core/visual-comparison.ts, D-242, D-250); a
//    comparison that cannot be built (no approved option, a screenshot missing or changed)
//    refuses here.
// 2. Check the dispatch move's guards (`checkStart`), so a run is not started only for its move
//    to be refused, and read the Flex capacity bounds from the settings, so a bad setting
//    refuses before anything is written.
// 3. Mint the state API token and admit the run (`runs.dispatch`): the run, its route and the
//    token's hash commit together.
// 4. Build the task and `start` it. If either fails, nothing runs: the run ends `fail` and its
//    token is revoked. When the run before it on the item failed to start too, that counts one
//    toward `failure` and asks for the escalation (P-03, src/core/failures.ts, O-44).
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
import { createBuilderRuns } from "../../src/core/builder-runs.ts";
import { createCouncil } from "../../src/core/council.ts";
import {
  VISUAL_CALL_PREFIX,
  VISUAL_CALL_TASK_TYPE,
} from "../../src/core/visual-call.ts";
import { createFailures } from "../../src/core/failures.ts";
import { createRunStart } from "../../src/core/run-start.ts";
import { createTriage } from "../../src/core/triage.ts";
import {
  approvedOptionRecord,
  createVisualComparisons,
  VISUAL_TASK_TYPE,
  type VisualTask,
} from "../../src/core/visual-comparison.ts";
import { pngCodec } from "../../src/adapters/screenshots/png.ts";
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
  /** Council: the topic key of the question the run answers. */
  questionTopic?: string | null;
  /** QA: `qa:visual` for the visual comparison (D-242); left out for the review. */
  taskType?: string | null;
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
  const { runtime, botVersion } = deps.bots[input.role];
  // A Council run's task type follows its question: the visual call is routed as `council:visual`
  // (D-270), every other question as the Council's default.
  const taskType =
    input.role === "council"
      ? input.questionTopic?.startsWith(VISUAL_CALL_PREFIX)
        ? VISUAL_CALL_TASK_TYPE
        : null
      : input.taskType;
  const request = { ...input, taskType, runtime, botVersion };
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
  // A fix round's input says why the item came back (D-213, O-41).
  const returned = branch ? await createBuilderRuns(deps).returnReason(node.id) : null;
  const councilTask =
    input.role === "council" && input.questionTopic
      ? await createCouncil(deps).taskFor(input.questionTopic)
      : null;
  if (input.role === "council" && !councilTask) {
    return { outcome: "not_started", reason: "no_open_question", failedGuards: [] };
  }
  if (councilTask && "refused" in councilTask) {
    return { outcome: "not_started", reason: councilTask.refused, failedGuards: [] };
  }
  const council = councilTask;
  // A Triage run's input is the idea's accepted plan and the repo map brief at the default
  // branch's head now; the run records that commit as its headSha, so its answer is checked
  // against the same map (src/core/triage.ts, D-251, D-262).
  const triage =
    input.role === "triage"
      ? await createTriage(deps).taskFor(
          node.id,
          await deps.repoMaps.read(project.repo),
        )
      : null;
  if (input.role === "triage" && !triage) {
    return { outcome: "not_started", reason: "no_accepted_plan", failedGuards: [] };
  }
  const isVisual = input.taskType === VISUAL_TASK_TYPE;
  if (isVisual && input.role !== "qa") {
    return { outcome: "not_started", reason: "not_a_qa_run", failedGuards: [] };
  }
  let visual: VisualTask | null = null;
  if (isVisual) {
    if (!input.headSha) {
      return { outcome: "not_started", reason: "no_head", failedGuards: [] };
    }
    const built = await createVisualComparisons({
      ...deps,
      png: pngCodec,
    }).taskFor(node.id, input.headSha);
    if ("refused" in built) {
      return { outcome: "not_started", reason: built.refused, failedGuards: [] };
    }
    visual = built;
  }
  const text = council
    ? council.input
    : triage
      ? triage.input
      : visual
        ? visual.input
        : taskInput({
            ...input,
            node,
            project,
            branch: branch ?? undefined,
            returned,
            // The Designer's step comes from the item's state (D-238): the state as the contracts
            // name it and its label, never a database id. It also gets the option Didi approved,
            // once one is recorded (D-242, D-243 rule 3).
            ...(input.role === "designer"
              ? {
                  approvedOption: await approvedOptionRecord(deps.store, node.id),
                  state: {
                    name: node.state,
                    label: Object.hasOwn(deps.contracts.states, node.state)
                      ? (deps.contracts.states[node.state]?.label ?? node.state)
                      : node.state,
                  },
                }
              : {}),
          });

  const starts = createRunStart(deps);
  const check = await starts.checkStart(node.id, input.role);
  if (!check.allowed) return { outcome: "not_started", ...check };
  const capacity = await runCapacityLimits(deps.store);

  const stateApiToken = deps.newRunToken();
  const admitted = await runs.dispatch(
    triage ? { ...request, headSha: triage.commitSha } : request,
    {
      tokenHash: hashRunToken(stateApiToken),
    },
  );
  if (!admitted.admitted) return { outcome: "not_admitted", ...admitted };
  const { run } = admitted;

  let handle: unknown;
  try {
    const evidenceIds =
      input.role === "qa" && run.headSha && !visual
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
      ...(council ? { outputSchema: council.outputSchema } : {}),
      ...(council?.images ? { images: council.images } : {}),
      ...(visual ? { outputSchema: visual.outputSchema, images: visual.images } : {}),
    });
    handle = await deps.runtime.start(task, deps.limits[input.role]);
  } catch (error) {
    // Nothing was started: the run ends `fail`, which also revokes its token. A failed start
    // after another one in a row counts toward `failure` and asks for the escalation (P-03, O-44).
    await runs.recordRunnerEnd(run.id, "fail").catch(() => false);
    await createFailures(deps)
      .dispatchFailed(run.id)
      .catch(() => undefined);
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
