// The staging flow (build plan M3.4, O-34). A `deployment_status` event says main may have deployed
// a commit to staging. This flow verifies the item whose latest merge commit is exactly that commit:
// it reads the deploy from GitHub itself (never from the event), runs the runner's staging check,
// records the result and asks for the move it calls for, which the guards decide
// (src/core/staging.ts). A deploy of any other commit does nothing. The reconcile flow's staging
// pass is the backstop for a missed event. Under the kill switch it refuses; in dry run it runs no
// check and records only the deploy.
import { createStaging, type StagingResult } from "../src/core/staging.ts";
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
  | { outcome: "verified"; results: StagingResult[] };

export async function run(
  deps: FlowDeps,
  input: VerifyStagingInput,
): Promise<VerifyStagingResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  const staging = createStaging({ ...deps, checker: deps.stagingChecker });
  return {
    outcome: "verified",
    results: await staging.verifyCommit(input.repo, input.sha),
  };
}

export const main = (input: VerifyStagingInput): Promise<VerifyStagingResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
