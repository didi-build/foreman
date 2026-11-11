// The removal of `BOOTSTRAP_TOKEN`'s access once Bootstrap's restarted run ends (D-358 lock (2),
// O-114). The GitHub receiver starts it with `{repo}` after it records a `workflow_run`
// `completed` for `.github/workflows/bootstrap.yml` started by `workflow_dispatch` in a
// repository of didi-build, whatever the run's conclusion, and only when neither switch holds the
// runner. It removes the repository from the secret's selected repositories with a token minted
// for that one call (src/core/bootstrap-access.ts). Under the kill switch it does nothing (N-100);
// in dry run it says what it would remove. The reconcile pass's backstop removes any access this
// missed.
import {
  removeAfterBootstrap,
  type RemovalResult,
} from "../src/core/bootstrap-access.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface RemoveBootstrapAccessInput {
  /** The repository whose Bootstrap run ended, `didi-build/<name>`. */
  repo: string;
}

export type { RemovalResult };

export function run(
  deps: FlowDeps,
  input: RemoveBootstrapAccessInput,
): Promise<RemovalResult> {
  return removeAfterBootstrap(deps, input?.repo);
}

export async function main(input: RemoveBootstrapAccessInput): Promise<RemovalResult> {
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
