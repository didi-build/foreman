// Didi's Set project secret form, `f/foreman/set_project_secret` (ADR 0118 appendix D, D-440,
// O-163). Didi starts it from its page in the Windmill workspace, signed in (O-97, D-295): no
// schedule, pass, service or other flow starts it, and it is never a public or signed-token link.
//
// Its three boxes are the project's short name, the secret's name and its value. The value box is
// a password field, from the schema the Windmill deploy sends for this one form (`form` in
// flows/windmill.yaml): Windmill keeps only a reference to a short-lived secret variable in the
// run's arguments, and the form deletes that variable at once. The form checks the boxes and the
// project, puts the value on the project's staging Worker and records the name and the time
// (src/core/set-project-secret.ts). The kill switch refuses; dry run deletes the variable and sets
// nothing. The answer holds the project and the name, never the value.
import {
  createSetProjectSecretForm,
  type SetProjectSecretInput,
  type SetProjectSecretResult,
} from "../src/core/set-project-secret.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment, windmillJobId } from "./lib/windmill.ts";

export type { SetProjectSecretInput, SetProjectSecretResult };

export function run(
  deps: FlowDeps,
  input: SetProjectSecretInput,
): Promise<SetProjectSecretResult> {
  return createSetProjectSecretForm({ ...deps, targets: deps.deployTargets }).set(
    input,
  );
}

/**
 * Didi's form: one plain field per value, each its own box (D-376). The deploy sends this form's
 * schema, which marks `value` as a password field (ADR 0118 appendix D).
 */
export async function main(
  project: string,
  name: string,
  value: string,
): Promise<SetProjectSecretResult> {
  const input = { project, name, value, runId: windmillJobId() };
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
