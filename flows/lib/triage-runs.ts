// Triage runs (build plan M3.6, D-262, D-265, src/core/triage.ts). The Triage pass takes each idea
// in Plan accepted to Triage, then gives each idea in Triage its next step: one Triage run through
// the dispatch (./start-run.ts), so admission decides under its lock as for every run (the kill
// switch, dry run, one active run per node, the cluster limit, the usage-exhausted wait and the
// route for task type `triage`); or, after two runs with no usable answer, the escalation to the
// Council and the Council's run. Two triggers at once give one run.
//
// The reconcile flow's live passes run it for every such idea; the run-end flow runs it for the
// idea of a Triage run whose answer was rejected, so its re-run starts at once; the Council's run
// end runs it for an idea the Council's decision returned to Triage.
//
// When a Triage run has finished, the run-end flow checks its answer before it records the end
// (`recordTriageAnswer`): the runner reads the repo map at the commit the run's input named
// (`headSha`) and hands a good answer off, or records why it rejected it and ends the run `fail`.
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import {
  createTriage,
  type TriageEscalation,
  type TriageNext,
  type TriageRecord,
} from "../../src/core/triage.ts";
import type { Run } from "../../src/core/store.ts";
import type { FlowDeps } from "./compose.ts";
import { councilPass, type CouncilPassStep } from "./council-runs.ts";
import { startRun, type StartRunResult } from "./start-run.ts";

export interface TriagePassStep {
  ideaId: string;
  /** For an idea in Plan accepted: the move to Triage. */
  toTriage?: { outcome: string; reason?: string };
  step: TriageNext["step"];
  /** With `start`: the dispatch's result, or `start_failed` when it threw (the error is not kept). */
  result?: StartRunResult | { outcome: "start_failed" };
  /** With `escalate`: the escalation, and the Council's run for it. */
  escalation?: TriageEscalation;
  councilRuns?: CouncilPassStep[];
}

/** Takes each idea one step: the given ideas, or every idea in Plan accepted or Triage. */
export async function triagePass(
  deps: FlowDeps,
  ideaIds?: readonly string[],
): Promise<TriagePassStep[]> {
  const triage = createTriage(deps);
  const steps: TriagePassStep[] = [];
  for (const ideaId of ideaIds ?? (await triage.pending())) {
    const step: Partial<TriagePassStep> & { ideaId: string } = { ideaId };
    const moved = await triage.toTriage(ideaId);
    if (moved.outcome !== "not_plan_accepted") step.toTriage = moved;
    const next = await triage.next(ideaId);
    step.step = next.step;
    if (next.step === "start") {
      try {
        step.result = await startRun(deps, { nodeId: ideaId, role: "triage" });
      } catch {
        // The repo map could not be read, or the run ended `fail` before it started
        // (./start-run.ts). Either way the next pass tries again.
        step.result = { outcome: "start_failed" };
      }
    }
    if (next.step === "escalate") {
      step.escalation = await triage.escalate(ideaId, next.lastRunId, next.reason);
      if (step.escalation.escalated) {
        step.councilRuns = await councilPass(deps, [escalationTopic(ideaId)]);
      }
    }
    steps.push(step as TriagePassStep);
  }
  return steps;
}

/**
 * Checks and records a finished Triage run's answer against the repo map at the run's commit
 * (src/core/triage.ts). The map is read through the runner's port; a map that cannot be read
 * throws, and the run-end flow tries again on its next trigger.
 */
export async function recordTriageAnswer(
  deps: FlowDeps,
  run: Run,
  structured: unknown,
): Promise<TriageRecord> {
  const node = run.nodeId ? await deps.store.getNode(run.nodeId) : null;
  const project = node ? await deps.store.getProject(node.projectId) : null;
  if (!node || !project) return { recorded: false, reason: "no_node" };
  if (!run.headSha) return { recorded: false, reason: "no_commit" };
  const map = await deps.repoMaps.read(project, run.headSha);
  return createTriage(deps).recordAnswer(run.id, structured, map);
}
