// The staging flow (build plan M3.4, O-34). A `deployment_status` event says main may have deployed
// a commit to staging. This flow verifies each item of the repository in Verifying on staging, since
// a deploy of a later commit may cover its merge commit (D-225): it reads the deploys from GitHub
// itself (never from the event), runs the runner's staging check, records the result and asks for
// the move it calls for, which the guards decide (src/core/staging.ts). The reconcile flow's staging
// pass is the backstop for a missed event. Under the kill switch it refuses; in dry run it runs no
// check and records only the deploy. A fail move then starts the builder's fix round (O-41).
import { createStaging, type StagingResult } from "../src/core/staging.ts";
import { startBuilderRuns, type BuilderRunStart } from "./lib/builder-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface VerifyStagingInput {
  /** The repository the deploy is for, `owner/name`. */
  repo: string;
  /** The commit GitHub reports deployed. */
  sha: string;
}

export type VerifyStagingResult =
  | { outcome: "refused"; reason: "kill_switch" }
  | { outcome: "verified"; results: StagingResult[]; builderRuns: BuilderRunStart[] };

export async function run(
  deps: FlowDeps,
  input: VerifyStagingInput,
): Promise<VerifyStagingResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  const staging = createStaging({ ...deps, checker: deps.stagingChecker });
  const results = await staging.verifyCommit(input.repo, input.sha);
  const moved = results
    .filter((r) => r.move?.outcome === "applied")
    .map((r) => r.nodeId);
  const builderRuns = moved.length > 0 ? await startBuilderRuns(deps, moved) : [];
  return { outcome: "verified", results, builderRuns };
}

export const main = (input: VerifyStagingInput): Promise<VerifyStagingResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
