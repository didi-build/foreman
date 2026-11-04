// Council runs (build plan M3.5, D-228, D-229, src/core/council.ts). The Council pass starts one
// Council run for each open question that has none: an item in Escalated to Council with no
// Council decision yet, and a reversal's open Council question. Each start goes through the
// dispatch (./start-run.ts), so admission decides under its lock as for every run: the kill switch,
// dry run, one active run per item, the cluster limit, the usage-exhausted wait and the route for
// task type `council`. Two triggers at once give one run, and a trigger while the run is active
// starts nothing. A question whose run and one re-run gave no usable answer goes to Didi instead.
// The Council's call on a visual approval (D-270) is a question too: its run starts the same way,
// with task type `council:visual` (./start-run.ts), and with no usable answer after the re-run it
// is recorded as dropped, never sent to Didi. So is the question on a scanner idea the Scanner no
// longer finds (D-301, src/core/scan-ideas.ts), opened by the scan and run with task type
// `council`; its answer is recorded and nothing moves the idea. The Council's plan for a scanner
// idea in Submitted (D-307, src/core/council.ts kind `plan`) starts the same way; once its answer
// is recorded, `afterCouncilRun` takes the idea's plan approval step at once (src/core/plans.ts):
// the Council's own acceptance and the Triage pass when Didi is not needed, else Didi's
// plan-approval request.
// `council`; its answer is recorded, and a `stop` is taken on by the cancel pass below (D-308). So
// is a work item's "is this still needed?" question (D-308, src/core/still-needed.ts).
//
// The reconcile flow's live passes run the Council pass for every open question; the run-end
// flow runs it for an item whose report has just escalated it, so its Council run starts at once.
//
// When a Council run has finished, the run-end flow (flows/record-run-end.ts) takes the steps of
// `runEndSteps`. Before the end is recorded, the runner validates the run's structured
// answer against its question's output schema and records the `council_decision` itself, once per
// run (src/core/council.ts, D-228); the agent's text is never read. An answer that does not fit
// the schema ends the run `fail`. Recording the answer first means a flow cut short after it finds
// the run still running on the next trigger, polls again and records the end; the answer is keyed
// by the run, so it is recorded once. After the end is recorded, `afterCouncilRun` acts on the
// answer: an escalation answer is taken on by the escalation pass (back where the item came from,
// with the builder's next run, or on to Didi), and a question still open gets its re-run or goes to
// Didi. A reversal answer was already applied when it was recorded, except the redo moves: the
// redo pass then takes each item the answer left due one (D-231).
//
// The redo pass (`redoPass`) sends each stale item whose Council `redo` stands back to the start
// of its track (src/core/council.ts). In live mode it first cancels the item's active runs, other
// than a Council run, through the runtime as the kill switch's cancel pass does (D-202,
// ./cancel-runs.ts), and only then asks for the move, which refuses while such a run is active. A
// run the runtime could not stop leaves the item where it is for the next pass. Under the kill
// switch or in dry run it cancels nothing, and the move refuses and writes nothing. The reconcile
// flow's live passes run it for every stale item, after the Council pass, so an item an
// escalation returned, or a pass cut short, is taken on later. For a merged item it opens the
// item's rework item instead (D-233): no run is cancelled, since the item does not move.
//
// A QA run of task type `qa:visual` (D-242) is checked the same way before its end is recorded:
// the runner validates its answer and records `visual_comparison` itself
// (src/core/visual-comparison.ts), and an answer it cannot record ends the run `fail`. Its report
// then asks for QA's moves like any QA run: the merge guard decides, so the merge happens once the
// review's verdict and the visual comparison both pass on the head. A comparison that differs
// sends the item back to Building components through QA's fail move (D-252). After a
// `cannot_tell`, the report asks for the escalation, which the guards allow on the second one on
// the head; after the first, `visualRerun` starts the one more run on the same head, at the end
// of that run or of the review run still active on the head, whichever ends last.
//
// The cancel pass (`cancelPass`, D-308, src/core/cancel.ts) acts on every cancel that stands and
// every Council stop: it opens Didi's request to confirm a stop on a plan Didi approved, cancels
// each work item a cancel stands on once no run is active on it, and then moves the idea to
// Rejected. A run in progress is never stopped: the item waits. So the pass runs right after the
// Council run's end, after the end of any run on the idea or one of its work items (the run-end
// flow), after Didi's answer on the request (./approval.ts), and in the reconcile flow's live
// passes. It closes no pull request (O-97).
//
// The questions on a work item (D-308 (3), src/core/still-needed.ts): after a QA run whose report
// merged its item, each open item touching the same design feature folder is asked about, and
// after a builder run that stopped reporting the work already done, its own item is; the Council
// pass then starts each question's run. The reconcile flow's live passes ask about merges again
// as a safety net (`mergedChangePass`).
//
// The follow-up pass (`followUpPass`, D-234) opens the follow-up Council question on a reversal
// whose gate request Didi has answered, and the Council pass then starts its run. The approval
// resume step runs it right after Didi's answer (./approval.ts), and the reconcile flow's live
// passes run it before the Council pass for every reversal a stale item relies on, so an answer
// recorded under the kill switch or in dry run (D-201), or a step cut short, is acted on later.
import {
  COUNCIL_PLAN_PREFIX,
  createCouncil,
  ESCALATION_PREFIX,
  REVERSAL_PREFIX,
  SCANNER_GONE_PREFIX,
  STILL_NEEDED_PREFIX,
  type CouncilAnswer,
  type CouncilNext,
  type CouncilQuestion,
  type VisualCallRecord,
  type FollowUpStep,
  type RedoStep,
} from "../../src/core/council.ts";
import { createCancels, type CancelStep } from "../../src/core/cancel.ts";
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import {
  createStillNeeded,
  type StillNeededOpen,
} from "../../src/core/still-needed.ts";
import { createFindingIdeas, type FindingIdeas } from "../../src/core/finding-ideas.ts";
import {
  createVisualComparisons,
  VISUAL_TASK_TYPE,
  visualRerunCheck,
  type VisualRecord,
} from "../../src/core/visual-comparison.ts";
import {
  createOptionCaptures,
  type CaptureStep,
} from "../../src/core/option-capture.ts";
import { pngCodec } from "../../src/adapters/screenshots/png.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { createRunReports } from "../../src/core/run-reports.ts";
import type { RunReport } from "../../src/core/runs.ts";
import type { Run } from "../../src/core/store.ts";
import {
  reportedMoveAndFixRound,
  startBuilderRuns,
  type AfterReport,
  type BuilderRunStart,
} from "./builder-runs.ts";
import { cancelRun } from "./cancel-runs.ts";
import { countedRefusal } from "./option-capture.ts";
import type { FlowDeps } from "./compose.ts";
import { heldBy } from "./switches.ts";
import { startRun, type StartRunResult } from "./start-run.ts";
import { recordTriageAnswer, triagePass, type TriagePassStep } from "./triage-runs.ts";
import type { TriageRecord } from "../../src/core/triage.ts";
import { createPlanApprovals, type PlanApprovalStep } from "../../src/core/plans.ts";

export interface CouncilPassStep {
  topicKey: string;
  kind: CouncilQuestion["kind"];
  step: CouncilNext["step"];
  /** With `start`: the dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result?: StartRunResult | { outcome: "start_failed" };
  /**
   * With `to_didi`: the escalation's move to Didi, or the gate request for Didi of a reversal or
   * a scanner idea that is no longer found (D-301).
   */
  didi?: EscalationStep | { gateRequestId: string | null };
  /** With `drop`: the visual call recorded as dropped, or why not (D-270). */
  dropped?: VisualCallRecord;
}

/** Takes each open Council question one step: on the given topics, or on every open one. */
export async function councilPass(
  deps: FlowDeps,
  topicKeys?: readonly string[],
): Promise<CouncilPassStep[]> {
  const council = createCouncil(deps);
  const questions = topicKeys
    ? (await Promise.all(topicKeys.map((t) => council.question(t)))).filter(
        (q) => q !== null,
      )
    : await council.questions();
  const steps: CouncilPassStep[] = [];
  for (const question of questions) {
    const next = await council.next(question);
    const step: CouncilPassStep = {
      topicKey: question.topicKey,
      kind: question.kind,
      step: next.step,
    };
    if (next.step === "start") {
      try {
        step.result = await startRun(deps, {
          nodeId: next.nodeId,
          role: "council",
          questionTopic: question.topicKey,
        });
      } catch {
        // The run ended `fail` before it started (./start-run.ts). It counts as one of the
        // question's runs, so a start that always fails reaches Didi after the re-run.
        step.result = { outcome: "start_failed" };
      }
    }
    if (next.step === "to_didi") {
      const sent = await council.toDidi(next.question, next.lastRunId, next.reason);
      step.didi =
        sent.kind === "escalation" ? sent.step : { gateRequestId: sent.gateRequestId };
    }
    if (next.step === "drop") {
      step.dropped = await council.dropVisualCall(
        next.question,
        next.lastRunId,
        next.reason,
      );
    }
    steps.push(step);
  }
  return steps;
}

/**
 * Opens each due follow-up Council question after Didi's answer to a reversal (D-234): on the
 * given topics, or on every reversal a stale item relies on. Topics with nothing due are left out
 * of the result.
 */
export async function followUpPass(
  deps: FlowDeps,
  topicKeys?: readonly string[],
): Promise<FollowUpStep[]> {
  const council = createCouncil(deps);
  const steps: FollowUpStep[] = [];
  for (const topicKey of topicKeys ?? (await council.followUpTopics())) {
    const step = await council.followUp(topicKey);
    if (step.step !== "not_due") steps.push(step);
  }
  return steps;
}

/**
 * Takes each cancel one step (D-308): on the given ideas (or work items with no idea), or on every
 * one a cancel or a Council stop is still to act on. Those with nothing due are left out.
 */
export async function cancelPass(
  deps: FlowDeps,
  ideaIds?: readonly string[],
): Promise<CancelStep[]> {
  const cancels = createCancels(deps);
  const steps: CancelStep[] = [];
  for (const ideaId of ideaIds ?? (await cancels.pending())) {
    const step = await cancels.step(ideaId);
    if (step.step !== "not_due") steps.push(step);
  }
  return steps;
}

/** The cancel pass for the idea of a node whose run just ended, when a cancel is pending. */
async function cancelAfterRun(
  deps: FlowDeps,
  nodeId: string | null,
): Promise<CancelStep[] | undefined> {
  if (!nodeId) return undefined;
  const ideaId = await createCancels(deps).pendingRootOf(nodeId);
  return ideaId ? cancelPass(deps, [ideaId]) : undefined;
}

/** What the redo pass did for one item: the runs it cancelled first, and the redo step. */
export interface RedoPassStep {
  nodeId: string;
  /** Runs stopped before the move (D-202). */
  cancelled: string[];
  /** Runs the runtime could not stop: the move waits for the next pass. */
  cancelFailed: string[];
  redo: RedoStep;
}

/**
 * Takes each stale item's redo (D-231): on the given items, or on every stale item. Items with no
 * redo standing are left out of the result.
 */
export async function redoPass(
  deps: FlowDeps,
  nodeIds?: readonly string[],
): Promise<RedoPassStep[]> {
  const council = createCouncil(deps);
  const live = (await heldBy(deps.store)) === null;
  const steps: RedoPassStep[] = [];
  for (const nodeId of nodeIds ?? (await council.staleItems())) {
    const check = await council.redoCheck(nodeId);
    if (check.step === "not_due" || check.step === "not_stale") continue;
    const step: RedoPassStep = { nodeId, cancelled: [], cancelFailed: [], redo: check };
    if (check.step === "due" && live) {
      for (const runId of check.activeRunIds) {
        const run = await deps.store.getRun(runId);
        if (!run) continue;
        if (await cancelRun(deps, run)) step.cancelled.push(runId);
        else step.cancelFailed.push(runId);
      }
    }
    if (
      (check.step === "due" && step.cancelFailed.length === 0) ||
      check.step === "rework_due"
    ) {
      step.redo = await council.redo(nodeId);
    }
    steps.push(step);
  }
  return steps;
}

/** What follows a Council run's recorded end. */
export interface AfterCouncilRun {
  /** The run's answer as the runner recorded it, when the end was recorded now. */
  answer?: CouncilAnswer;
  /** For an escalation: what the escalation pass did with the item. */
  escalation?: EscalationStep;
  builderRuns: BuilderRunStart[];
  /** The question's next step, when it is still open: its re-run, or Didi. */
  council: CouncilPassStep[];
  /** For a reversal answer: the redo moves and rework items it left due (D-231, D-233). */
  redos?: RedoPassStep[];
  /** For an idea the Council's decision returned to Triage: its next Triage run (M3.6). */
  triage?: TriagePassStep[];
  /** For the Council's plan on a scanner idea: its plan approval step (D-307). */
  plan?: PlanApprovalStep;
  /** After a `stop`: the cancel step, or Didi's request to confirm it (D-308). */
  cancels?: CancelStep[];
}

/**
 * After a Council run's end: the escalation pass for its item, the builder's next run if the item
 * returned, the redo moves and rework items a reversal answer left due, and the question's re-run
 * or Didi if it is
 * still open. Each step is idempotent, so a
 * repeated run-end trigger does nothing more.
 */
export async function afterCouncilRun(
  deps: FlowDeps,
  run: Run,
  answer?: CouncilAnswer,
): Promise<AfterCouncilRun> {
  const topic = run.questionTopic;
  const after: AfterCouncilRun = {
    ...(answer ? { answer } : {}),
    builderRuns: [],
    council: [],
  };
  if (!topic) return after;
  if (topic.startsWith(ESCALATION_PREFIX) && run.nodeId) {
    after.escalation = await createEscalations(deps).resolve(run.nodeId);
    if (after.escalation.step === "returned") {
      const returned = await deps.store.getNode(run.nodeId);
      if (returned?.type === "idea")
        after.triage = await triagePass(deps, [run.nodeId]);
      else after.builderRuns = await startBuilderRuns(deps, [run.nodeId]);
    }
  }
  if (topic.startsWith(REVERSAL_PREFIX) && answer?.recorded === true) {
    const due = (answer.verdicts ?? [])
      .filter((v) => v.result === "redo_move_due" || v.result === "rework_due")
      .map((v) => v.nodeId);
    if (due.length > 0) after.redos = await redoPass(deps, due);
  }
  if (
    topic.startsWith(COUNCIL_PLAN_PREFIX) &&
    answer?.recorded === true &&
    run.nodeId
  ) {
    after.plan = await createPlanApprovals(deps).step(run.nodeId);
    if (
      after.plan.step === "council_accepted" &&
      after.plan.move.outcome === "applied"
    ) {
      after.triage = await triagePass(deps, [run.nodeId]);
    }
  }
  after.council = await councilPass(deps, [topic]);
  if (topic.startsWith(SCANNER_GONE_PREFIX) || topic.startsWith(STILL_NEEDED_PREFIX)) {
    const cancels = await cancelAfterRun(deps, run.nodeId);
    if (cancels) after.cancels = cancels;
  }
  return after;
}

/** A Council run's answer and what followed it, in the run-end flow's result. */
export interface CouncilAfter {
  council?: AfterCouncilRun;
  /** After another role's run whose report escalated the item: the Council's run for it. */
  councilRuns?: CouncilPassStep[];
}

/** What follows a recorded end in the run-end flow's result. */
export type AfterRunEnd = AfterReport &
  CouncilAfter & {
    /** When the end was recorded now: the ideas made from the run's findings (D-244, O-65). */
    findingIdeas?: FindingIdeas;
    /** A visual comparison run's answer as the runner recorded it, or why not (D-242). */
    visual?: VisualRecord;
    /** After a QA run: the visual comparison's one more run after a `cannot_tell` (D-252). */
    visualRerun?: VisualRerunStart;
    /** After a Designer run: the capture of its options at the PR head, or why not (O-88). */
    optionCapture?: CaptureStep;
    /** A Triage run's answer as the runner checked it: handed off or rejected (M3.6). */
    triageAnswer?: TriageRecord;
    /** After a Triage run: the idea's re-run, or its escalation to the Council (D-262). */
    triage?: TriagePassStep[];
    /** After a run on an item a cancel waits on: the cancel's next step (D-308). */
    cancels?: CancelStep[];
    /**
     * The "is this still needed?" questions the run's end opened (D-308 (3)): after a merge, on
     * each item touching the same feature; after a builder's already-done stop, on its item. With
     * the Council pass on them.
     */
    stillNeeded?: { opened: StillNeededOpen[]; council: CouncilPassStep[] };
  };

/** The one more visual run after a `cannot_tell`, when it was due (D-252). */
export interface VisualRerunStart {
  nodeId: string;
  /** The dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result: StartRunResult | { outcome: "start_failed" };
}

/**
 * Starts the visual comparison's one more run on the same head after a `cannot_tell` (D-252),
 * when it is due (src/core/visual-comparison.ts). It goes through the dispatch, so admission
 * decides as for every run: one QA run per pull request and head at a time, the kill switch and
 * dry run. Null when it is not due.
 */
export async function visualRerun(
  deps: FlowDeps,
  nodeId: string,
): Promise<VisualRerunStart | null> {
  const check = await visualRerunCheck(deps.store, nodeId);
  if (!check.due) return null;
  try {
    return {
      nodeId,
      result: await startRun(deps, {
        nodeId,
        role: "qa",
        headSha: check.headSha,
        prNumber: check.prNumber,
        taskType: VISUAL_TASK_TYPE,
      }),
    };
  } catch {
    // The run ended `fail` before it started (./start-run.ts); the next QA run's end asks again.
    return { nodeId, result: { outcome: "start_failed" } };
  }
}

/**
 * The run-end flow's steps around recording one run's end. `record` checks and records a finished
 * Council run's answer and returns the report to record its end with (`fail` for an unusable
 * answer); for a builder that stopped because the item needs a decision it records the reason
 * first (O-63); any other report is returned as it is. Then, for a successful Developer, Designer
 * or QA run, it submits each bug the run reported outside its item as a new idea (D-244, O-65),
 * still before the end is recorded: the runtime's result is not kept, so a flow cut short after
 * the end would lose them, while one cut short before it polls again and finds the ideas made.
 * The ideas never change the report or the item's move. `after` runs once the end is recorded:
 * for a Designer run the capture of its exploration options when CI has already rendered them
 * (src/core/option-capture.ts, O-88), the reported move and fix round (./builder-runs.ts), then
 * for a Council run `afterCouncilRun`.
 */
export function runEndSteps(deps: FlowDeps, run: Run) {
  let answer: CouncilAnswer | undefined;
  let findingIdeas: FindingIdeas | undefined;
  let visual: VisualRecord | undefined;
  let triageAnswer: TriageRecord | undefined;
  const isCouncil = run.bot === "council";
  const isTriage = run.bot === "triage";
  const isVisual = run.bot === "qa" && run.taskType === VISUAL_TASK_TYPE;
  async function reportToRecord(
    result: AgentRunResult,
    report: RunReport,
  ): Promise<RunReport> {
    if (result.detail === "needs_decision" && report.outcome === "success") {
      // A builder stopped because the item needs a decision (D-237, O-63): its reason is
      // recorded as its request to escalate, and its report then asks for the escalation. Any
      // other role, or a reason the runner cannot record, ends the run `fail`.
      const reason = result.needsDecision?.reason;
      const recorded =
        reason === undefined
          ? null
          : await createRunReports(deps).recordNeedsDecision(
              run.id,
              reason,
              result.needsDecision?.alreadyDone === true,
            );
      return recorded?.recorded ? report : { ...report, outcome: "fail" };
    }
    if (isVisual && report.outcome === "success") {
      // The runner checks the answer and records `visual_comparison` itself (D-242). Anything
      // but a recorded answer ends the run `fail`: an answer that does not fit, a run on a
      // builder's model (D-158), or a comparison that cannot be built again.
      visual = await createVisualComparisons({ ...deps, png: pngCodec }).recordAnswer(
        run.id,
        result.structured,
      );
      return visual.recorded === false &&
        visual.reason !== "kill_switch" &&
        visual.reason !== "dry_run"
        ? { ...report, outcome: "fail" }
        : report;
    }
    if (isTriage && report.outcome === "success") {
      // The runner checks the answer against the repo map at the run's commit and hands it off,
      // or records why it rejected it (M3.6, D-262). A rejected answer ends the run `fail`.
      triageAnswer = await recordTriageAnswer(deps, run, result.structured);
      return triageAnswer.recorded === false && triageAnswer.reason === "rejected"
        ? { ...report, outcome: "fail" }
        : report;
    }
    if (!isCouncil || report.outcome !== "success") return report;
    answer = await createCouncil(deps).recordAnswer(run.id, result.structured);
    return answer.recorded === false && answer.reason === "invalid"
      ? { ...report, outcome: "fail" }
      : report;
  }
  return {
    async record(result: AgentRunResult, report: RunReport): Promise<RunReport> {
      const recorded = await reportToRecord(result, report);
      if (recorded.outcome === "success" && result.detail !== "needs_decision") {
        findingIdeas = await createFindingIdeas(deps).submit(run.id, result.structured);
      }
      return recorded;
    },
    async after(): Promise<AfterRunEnd> {
      // A run on an idea or a work item a cancel waits on: the cancel takes its next step first,
      // so the item it waited on is cancelled before any next run of it could start (D-308). A
      // Council run's own stop is taken after its answer, below.
      const cancels = isCouncil ? undefined : await cancelAfterRun(deps, run.nodeId);
      // A Designer run in exploration: its options are captured first when CI has already
      // rendered them, so the report's move finds them (O-88).
      const optionCapture =
        run.bot === "designer" && run.nodeId
          ? await createOptionCaptures(deps).capture(run.nodeId)
          : undefined;
      const after = await reportedMoveAndFixRound(deps, run.id);
      // A capture refusal the Designer caused counted toward `failure` (O-89): the report's own
      // move does not count it, so its fix round starts here, when one is due.
      if (
        optionCapture &&
        countedRefusal(optionCapture) &&
        after.builderRuns.length === 0 &&
        run.nodeId
      ) {
        after.builderRuns = await startBuilderRuns(deps, [run.nodeId]);
      }
      const reported = {
        ...(optionCapture ? { optionCapture } : {}),
        ...after,
        ...(findingIdeas ? { findingIdeas } : {}),
        ...(visual ? { visual } : {}),
      };
      if (isCouncil) {
        return { ...reported, council: await afterCouncilRun(deps, run, answer) };
      }
      if (isTriage) {
        // The idea's next step: its re-run after a rejected answer, or the Council after two.
        const triage = run.nodeId ? await triagePass(deps, [run.nodeId]) : undefined;
        return {
          ...reported,
          ...(triageAnswer ? { triageAnswer } : {}),
          ...(triage ? { triage } : {}),
          ...(cancels ? { cancels } : {}),
        };
      }
      // The report escalated the item (or an earlier call did): its Council run starts now
      // rather than at the next reconcile pass.
      const node = run.nodeId ? await deps.store.getNode(run.nodeId) : null;
      const escalated =
        node !== null && node.state === createEscalations(deps).councilState;
      // After any QA run on an item still in review: the visual comparison's one more run after
      // a `cannot_tell`, once no other run on the item is active (D-252).
      const rerun =
        run.bot === "qa" && node !== null && !escalated
          ? await visualRerun(deps, node.id)
          : null;
      // The questions on work items this end raises (D-308 (3)): a QA run whose report merged
      // its item, and a builder run that stopped reporting the work already done.
      const stillNeeded = createStillNeeded(deps);
      const opened: StillNeededOpen[] = [];
      if (run.bot === "qa" && run.nodeId)
        opened.push(...(await stillNeeded.afterMerge(run.nodeId)));
      if (escalated) {
        const done = await stillNeeded.afterAlreadyDone(run.id);
        if (done) opened.push(done);
      }
      const asked = opened.filter((o) => o.opened);
      const stillNeededSteps =
        asked.length > 0
          ? {
              opened,
              council: await councilPass(
                deps,
                asked.map((o) => `${STILL_NEEDED_PREFIX}${o.nodeId}`),
              ),
            }
          : null;
      return {
        ...reported,
        ...(escalated
          ? { councilRuns: await councilPass(deps, [escalationTopic(node.id)]) }
          : {}),
        ...(stillNeededSteps ? { stillNeeded: stillNeededSteps } : {}),
        ...(rerun ? { visualRerun: rerun } : {}),
        ...(cancels ? { cancels } : {}),
      };
    },
  };
}
