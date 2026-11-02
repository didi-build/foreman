// The passes the reconcile flow runs with `dry_run` off, while the live reconcile pass is not
// built (M2.4 stops on `dry_run` false, which the pass reports as `live_mode_not_built`). The
// merge pass merges what QA passed and recovers a merge whose move was not written (M3.3, O-31).
// The staging pass then checks each merged item on staging and recovers its moves, its escalation
// and its dependents' release (M3.4, O-37), and reports the items that have waited past
// `staging_deploy_attention_after_minutes` with no deploy recorded (D-225, O-40). The escalation
// pass then takes each escalated item on once the Council or Didi has answered (M3.5,
// src/core/escalations.ts): back where it was escalated from with the counters reset, or on to
// Didi with a gate request. The Council pass then starts a Council run for each open question
// that has none, or sends a question whose runs gave no usable answer to Didi (D-228, D-229,
// ./council-runs.ts). Last, the builder runs pass starts the fix round of each item a failed
// QA round, a staging check, a refused done report or an answered escalation sent back, and
// resumes a builder run queued after `usage_exhausted` (O-41, O-43). It runs after the staging and
// escalation passes, so an escalation that pass recovers is taken first. Under any other stop,
// none runs.
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import { createMerges, type MergeResult } from "../../src/core/merge.ts";
import type { ReconcileReport } from "../../src/core/reconcile.ts";
import {
  createStaging,
  type StagingDeployWait,
  type StagingResult,
} from "../../src/core/staging.ts";
import { startBuilderRuns, type BuilderRunStart } from "./builder-runs.ts";
import type { FlowDeps } from "./compose.ts";
import { councilPass, type CouncilPassStep } from "./council-runs.ts";

export interface LivePasses {
  merged: { nodeId: string; result: MergeResult }[] | null;
  verified: StagingResult[] | null;
  /** Items in Verifying on staging past the wait setting with no deploy, for the attention list. */
  stagingWaits: StagingDeployWait[] | null;
  /** What the escalation pass did for each escalated item (M3.5). */
  escalations: EscalationStep[] | null;
  /** What the Council pass did for each open Council question (D-228, D-229). */
  councilRuns: CouncilPassStep[] | null;
  /** The builder runs due with no move, and what their dispatch did. */
  builderRuns: BuilderRunStart[] | null;
  /** Settings the passes needed and could not read. */
  problems: string[];
}

export async function runLivePasses(
  deps: FlowDeps,
  stopped: ReconcileReport["stopped"],
): Promise<LivePasses> {
  if (stopped !== "live_mode_not_built") {
    return {
      merged: null,
      verified: null,
      stagingWaits: null,
      escalations: null,
      councilRuns: null,
      builderRuns: null,
      problems: [],
    };
  }
  const merged = await createMerges(deps).mergeReady();
  const staging = createStaging({ ...deps, checker: deps.stagingChecker });
  const verified = await staging.verifyReady();
  const { waits, problem } = await staging.deployWaits(verified);
  const escalations = await createEscalations(deps).resolveAll();
  const councilRuns = await councilPass(deps);
  const builderRuns = await startBuilderRuns(deps);
  return {
    merged,
    verified,
    stagingWaits: waits,
    escalations,
    councilRuns,
    builderRuns,
    problems: problem ? [problem] : [],
  };
}
