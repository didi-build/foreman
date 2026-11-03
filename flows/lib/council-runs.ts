// Council runs (build plan M3.5, D-228, D-229, src/core/council.ts). The Council pass starts one
// Council run for each open question that has none: an item in Escalated to Council with no
// Council decision yet, and a reversal's open Council question. Each start goes through the
// dispatch (./start-run.ts), so admission decides under its lock as for every run: the kill switch,
// dry run, one active run per item, the cluster limit, the usage-exhausted wait and the route for
// task type `council`. Two triggers at once give one run, and a trigger while the run is active
// starts nothing. A question whose run and one re-run gave no usable answer goes to Didi instead.
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
// The follow-up pass (`followUpPass`, D-234) opens the follow-up Council question on a reversal
// whose gate request Didi has answered, and the Council pass then starts its run. The approval
// resume step runs it right after Didi's answer (./approval.ts), and the reconcile flow's live
// passes run it before the Council pass for every reversal a stale item relies on, so an answer
// recorded under the kill switch or in dry run (D-201), or a step cut short, is acted on later.
import {
  createCouncil,
  ESCALATION_PREFIX,
  REVERSAL_PREFIX,
  type CouncilAnswer,
  type CouncilNext,
  type FollowUpStep,
  type RedoStep,
} from "../../src/core/council.ts";
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import { createFindingIdeas, type FindingIdeas } from "../../src/core/finding-ideas.ts";
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
import type { FlowDeps } from "./compose.ts";
import { heldBy } from "./switches.ts";
import { startRun, type StartRunResult } from "./start-run.ts";

export interface CouncilPassStep {
  topicKey: string;
  kind: "escalation" | "reversal";
  step: CouncilNext["step"];
  /** With `start`: the dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result?: StartRunResult | { outcome: "start_failed" };
  /** With `to_didi`: the escalation's move to Didi, or the reversal's gate request for Didi. */
  didi?: EscalationStep | { gateRequestId: string | null };
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
      const sent = await council.toDidi(question, next.lastRunId, next.reason);
      step.didi =
        sent.kind === "escalation" ? sent.step : { gateRequestId: sent.gateRequestId };
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
      after.builderRuns = await startBuilderRuns(deps, [run.nodeId]);
    }
  }
  if (topic.startsWith(REVERSAL_PREFIX) && answer?.recorded === true) {
    const due = (answer.verdicts ?? [])
      .filter((v) => v.result === "redo_move_due" || v.result === "rework_due")
      .map((v) => v.nodeId);
    if (due.length > 0) after.redos = await redoPass(deps, due);
  }
  after.council = await councilPass(deps, [topic]);
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
  };

/**
 * The run-end flow's steps around recording one run's end. `record` checks and records a finished
 * Council run's answer and returns the report to record its end with (`fail` for an unusable
 * answer); for a builder that stopped because the item needs a decision it records the reason
 * first (O-63); any other report is returned as it is. Then, for a successful Developer, Designer
 * or QA run, it submits each bug the run reported outside its item as a new idea (D-244, O-65),
 * still before the end is recorded: the runtime's result is not kept, so a flow cut short after
 * the end would lose them, while one cut short before it polls again and finds the ideas made.
 * The ideas never change the report or the item's move. `after` runs once the end is recorded:
 * the reported move and fix round (./builder-runs.ts), then for a Council run `afterCouncilRun`.
 */
export function runEndSteps(deps: FlowDeps, run: Run) {
  let answer: CouncilAnswer | undefined;
  let findingIdeas: FindingIdeas | undefined;
  const isCouncil = run.bot === "council";
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
          : await createRunReports(deps).recordNeedsDecision(run.id, reason);
      return recorded?.recorded ? report : { ...report, outcome: "fail" };
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
      const reported = {
        ...(await reportedMoveAndFixRound(deps, run.id)),
        ...(findingIdeas ? { findingIdeas } : {}),
      };
      if (isCouncil) {
        return { ...reported, council: await afterCouncilRun(deps, run, answer) };
      }
      // The report escalated the item (or an earlier call did): its Council run starts now
      // rather than at the next reconcile pass.
      const node = run.nodeId ? await deps.store.getNode(run.nodeId) : null;
      const escalated =
        node !== null && node.state === createEscalations(deps).councilState;
      return {
        ...reported,
        ...(escalated
          ? { councilRuns: await councilPass(deps, [escalationTopic(node.id)]) }
          : {}),
      };
    },
  };
}
