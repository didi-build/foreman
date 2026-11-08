// The staging deploy as the flows run it (D-353, D-356, O-116): the core's deploy
// (src/core/staging-deploy.ts) over the flow deps, then what its staging checks' moves call for in
// the same run: a fail move starts the builder's fix round (O-41), and a move to Done starts the
// first run of each item that Done frees (D-329). Used by the deploy flow
// (flows/deploy-staging.ts); the reconcile flow's staging deploy backstop (./live-passes.ts) takes
// the deploys from `stagingDeploysOf` and leaves the fix rounds to its builder runs pass.
import {
  createStagingDeploys,
  type StagingDeployResult,
  type StagingDeploys,
} from "../../src/core/staging-deploy.ts";
import type { StagingResult } from "../../src/core/staging.ts";
import { startBuilderRuns, type BuilderRunStart } from "./builder-runs.ts";
import type { FlowDeps } from "./compose.ts";
import { firstRunsAfterStaging, type ReadyRunStart } from "./ready-runs.ts";

/** The core's staging deploys over the flow deps. */
export function stagingDeploysOf(deps: FlowDeps): StagingDeploys {
  return createStagingDeploys({
    ...deps,
    checker: deps.stagingChecker,
    builds: deps.stagingBuilds,
    target: deps.stagingTarget,
  });
}

/** What the checks the deploys started moved: a fail move's fix round, a Done's freed items. */
export async function afterStagingDeploys(
  deps: FlowDeps,
  deploys: readonly StagingDeployResult[],
): Promise<{ builderRuns: BuilderRunStart[]; firstRuns: ReadyRunStart[] }> {
  const verified: StagingResult[] = deploys.flatMap((d) => d.verified ?? []);
  const moved = verified
    .filter((r) => r.move?.outcome === "applied")
    .map((r) => r.nodeId);
  const builderRuns = moved.length > 0 ? await startBuilderRuns(deps, moved) : [];
  const firstRuns = await firstRunsAfterStaging(deps, verified);
  return { builderRuns, firstRuns };
}
