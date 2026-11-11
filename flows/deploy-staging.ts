// The staging deploy flow (D-353, D-356, O-116). The GitHub receiver starts it with a repository
// and a CI run's id once CI's build on main has finished (src/github-receiver/staging-starts.ts);
// the reconcile flow's staging deploy backstop does the same work inside its own run. It reads the
// run from GitHub again, fetches that run's `staging-site` build, has the deploy adapter check the
// file set and upload exactly those files to the project's staging Worker, records the deploy on
// each item in Verifying on staging whose merge commit it covers, and runs their staging check
// (src/core/staging-deploy.ts). A fail move then starts the builder's fix round (O-41), and a move
// to Done starts the first run of each item that Done frees (D-329, ./lib/ready-runs.ts). Under
// the kill switch it refuses; in dry run it says what it would deploy and does nothing.
import { REPOSITORY } from "../src/core/github.ts";
import type { StagingDeployResult } from "../src/core/staging-deploy.ts";
import type { BuilderRunStart } from "./lib/builder-runs.ts";
import type { ReadyRunStart } from "./lib/ready-runs.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { afterStagingDeploys, stagingDeploysOf } from "./lib/staging-deploys.ts";
import { killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface DeployStagingInput {
  /** The repository whose CI built main, `owner/name`. */
  repo: string;
  /** The CI run whose `staging-site` build is deployed. */
  runId: number;
}

export type DeployStagingResult =
  | { outcome: "refused"; reason: "kill_switch" | "invalid_input" }
  | {
      outcome: "done";
      deploy: StagingDeployResult;
      builderRuns: BuilderRunStart[];
      /** The first runs of the items a Done frees (D-329). */
      firstRuns: ReadyRunStart[];
    };

export async function run(
  deps: FlowDeps,
  input: DeployStagingInput,
): Promise<DeployStagingResult> {
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch" };
  const repo = input?.repo;
  const runId = input?.runId;
  if (
    typeof repo !== "string" ||
    !REPOSITORY.test(repo) ||
    !Number.isSafeInteger(runId) ||
    runId <= 0
  ) {
    return { outcome: "refused", reason: "invalid_input" };
  }
  const deploy = await stagingDeploysOf(deps).deployRun(repo, runId);
  return { outcome: "done", deploy, ...(await afterStagingDeploys(deps, [deploy])) };
}

export async function main(input: DeployStagingInput): Promise<DeployStagingResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
