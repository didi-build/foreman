// The passes the reconcile flow runs with `dry_run` off, while the live reconcile pass is not
// built (M2.4 stops on `dry_run` false, which the pass reports as `live_mode_not_built`). The
// merge pass merges what QA passed and recovers a merge whose move was not written (M3.3, O-31).
// The staging pass then checks each merged item on staging and recovers its moves, its escalation
// and its dependents' release (M3.4, O-37), and reports the items that have waited past
// `staging_deploy_attention_after_minutes` with no deploy recorded (D-225, O-40). Last, the
// builder runs pass starts the fix round of each item a failed QA round or staging check sent
// back, and resumes a builder run queued after `usage_exhausted` (O-41). It runs after the staging
// pass, so an escalation that pass recovers is taken first. Under any other stop, none runs.
import { createMerges, type MergeResult } from "../../src/core/merge.ts";
import type { ReconcileReport } from "../../src/core/reconcile.ts";
import {
  createStaging,
  type StagingDeployWait,
  type StagingResult,
} from "../../src/core/staging.ts";
import { startBuilderRuns, type BuilderRunStart } from "./builder-runs.ts";
import type { FlowDeps } from "./compose.ts";

export interface LivePasses {
  merged: { nodeId: string; result: MergeResult }[] | null;
  verified: StagingResult[] | null;
  /** Items in Verifying on staging past the wait setting with no deploy, for the attention list. */
  stagingWaits: StagingDeployWait[] | null;
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
      builderRuns: null,
      problems: [],
    };
  }
  const merged = await createMerges(deps).mergeReady();
  const staging = createStaging({ ...deps, checker: deps.stagingChecker });
  const verified = await staging.verifyReady();
  const { waits, problem } = await staging.deployWaits(verified);
  const builderRuns = await startBuilderRuns(deps);
  return {
    merged,
    verified,
    stagingWaits: waits,
    builderRuns,
    problems: problem ? [problem] : [],
  };
}
