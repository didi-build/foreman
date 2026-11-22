// Didi's New project form, `f/foreman/new_project` (ADR 0118 appendix C, D-434, D-435, O-161).
// Didi starts it from its page in the Windmill workspace, signed in (O-97, D-295), and running it
// is Didi's one approval for the project: no schedule, pass, service or other flow starts it, and it
// is never a public or signed-token link.
//
// Its four boxes are the short name (slug), the display name, a one-line purpose, and whether the
// project collects personal data, ticked by default (D-435, D-376). It sets the project up on
// Cloudflare, writes its file to didi-build/foreman-projects, starts the Platform and Infra runs,
// creates didi-build/<slug> from didi-build/launchpad, records the project and starts Bootstrap,
// in that order, each found before it is made (src/core/new-project.ts). The kill switch refuses;
// dry run only reads and says what each step would do. Run again, it does what is missing and
// makes nothing twice.
import {
  createNewProjectForm,
  type NewProjectInput,
  type NewProjectResult,
} from "../src/core/new-project.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { windmillEnvironment, windmillJobId } from "./lib/windmill.ts";

export type { NewProjectInput, NewProjectResult };

export function run(deps: FlowDeps, input: NewProjectInput): Promise<NewProjectResult> {
  return createNewProjectForm({ ...deps, targets: deps.deployTargets }).create(input);
}

/**
 * Didi's form: one plain field per value, which Windmill shows as its own box (D-376); the
 * personal-data box is ticked by default (D-435). A type imported from another file would show
 * as a single resource picker instead (O-121).
 */
export async function main(
  slug: string,
  displayName: string,
  purpose: string,
  collectsPersonalData: boolean = true,
): Promise<NewProjectResult> {
  const input = {
    slug,
    displayName,
    purpose,
    collectsPersonalData,
    runId: windmillJobId(),
  };
  return withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
}
