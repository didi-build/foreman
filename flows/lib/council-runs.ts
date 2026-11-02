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
// Didi. A reversal answer was already applied when it was recorded.
import {
  createCouncil,
  ESCALATION_PREFIX,
  type CouncilAnswer,
  type CouncilNext,
} from "../../src/core/council.ts";
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import type { RunReport } from "../../src/core/runs.ts";
import type { Run } from "../../src/core/store.ts";
import {
  reportedMoveAndFixRound,
  startBuilderRuns,
  type AfterReport,
  type BuilderRunStart,
} from "./builder-runs.ts";
import type { FlowDeps } from "./compose.ts";
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

/** What follows a Council run's recorded end. */
export interface AfterCouncilRun {
  /** The run's answer as the runner recorded it, when the end was recorded now. */
  answer?: CouncilAnswer;
  /** For an escalation: what the escalation pass did with the item. */
  escalation?: EscalationStep;
  builderRuns: BuilderRunStart[];
  /** The question's next step, when it is still open: its re-run, or Didi. */
  council: CouncilPassStep[];
}

/**
 * After a Council run's end: the escalation pass for its item, the builder's next run if the item
 * returned, and the question's re-run or Didi if it is still open. Each step is idempotent, so a
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
export type AfterRunEnd = AfterReport & CouncilAfter;

/**
 * The run-end flow's steps around recording one run's end. `record` checks and records a finished
 * Council run's answer and returns the report to record its end with (`fail` for an unusable
 * answer); any other role's report is returned as it is. `after` runs once the end is recorded:
 * the reported move and fix round (./builder-runs.ts), then for a Council run `afterCouncilRun`.
 */
export function runEndSteps(deps: FlowDeps, run: Run) {
  let answer: CouncilAnswer | undefined;
  const isCouncil = run.bot === "council";
  return {
    async record(result: AgentRunResult, report: RunReport): Promise<RunReport> {
      if (!isCouncil || report.outcome !== "success") return report;
      answer = await createCouncil(deps).recordAnswer(run.id, result.structured);
      return answer.recorded === false && answer.reason === "invalid"
        ? { ...report, outcome: "fail" }
        : report;
    },
    async after(): Promise<AfterRunEnd> {
      const reported = await reportedMoveAndFixRound(deps, run.id);
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
