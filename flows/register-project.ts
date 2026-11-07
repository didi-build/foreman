// Didi's register-project form (D-345, D-346, D-348, O-109). Called with a project's slug and a
// one-line description, only when Didi starts it from its page in the Windmill workspace, signed
// in, as Didi's cancel is (O-97, D-295); never from a public or signed-token link. No schedule,
// pass or other flow starts it.
//
// It refuses a slug not listed in the platform settings file on main, creates
// `didi-build/<slug>` from the `didi-build/launchpad` template with the description, always
// public, and records the project in the store (src/core/register-project.ts). A project already
// recorded is `already_registered` and nothing is created; a repository an earlier run created is
// reused. The creation token is minted for the one create and refused fail closed (D-346). The
// kill switch refuses; dry run creates and writes nothing and says what would happen. Launchpad's
// Bootstrap workflow then sets up the new repository on its first push.
import {
  createProjectRegistration,
  type RegisterProjectInput,
  type RegisterProjectResult,
} from "../src/core/register-project.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export type { RegisterProjectInput, RegisterProjectResult };

export function run(
  deps: FlowDeps,
  input: RegisterProjectInput,
): Promise<RegisterProjectResult> {
  return createProjectRegistration(deps).register(input);
}

export const main = (input: RegisterProjectInput): Promise<RegisterProjectResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
