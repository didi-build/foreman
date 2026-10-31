// The passes the reconcile flow runs with `dry_run` off, while the live reconcile pass is not
// built (M2.4 stops on `dry_run` false, which the pass reports as `live_mode_not_built`). The
// merge pass merges what QA passed and recovers a merge whose move was not written (M3.3, O-31).
// The staging pass then checks each merged item on staging and recovers its moves, its escalation
// and its dependents' release (M3.4, O-37). Under any other stop, neither runs.
import { createMerges, type MergeResult } from "../../src/core/merge.ts";
import type { ReconcileReport } from "../../src/core/reconcile.ts";
import { createStaging, type StagingResult } from "../../src/core/staging.ts";
import type { FlowDeps } from "./compose.ts";

export interface LivePasses {
  merged: { nodeId: string; result: MergeResult }[] | null;
  verified: StagingResult[] | null;
}

export async function runLivePasses(
  deps: FlowDeps,
  stopped: ReconcileReport["stopped"],
): Promise<LivePasses> {
  if (stopped !== "live_mode_not_built") return { merged: null, verified: null };
  const merged = await createMerges(deps).mergeReady();
  const verified = await createStaging({
    ...deps,
    checker: deps.stagingChecker,
  }).verifyReady();
  return { merged, verified };
}
