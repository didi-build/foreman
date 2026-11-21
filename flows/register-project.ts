// The register-project form, `f/foreman/register_project` (D-345), is retired (ADR 0118 slice 6,
// O-161): the New project form, `f/foreman/new_project` (flows/new-project.ts), replaces it.
//
// The entry stays, refusing with fixed text, because the Windmill deploy never deletes a script
// (.github/scripts/windmill-deploy.sh): without an entry, the old script would stay in the
// workspace and could still create a repository and record a project with no database, Worker,
// project file or deploy target. Each deploy replaces it with this one, which takes no box, reads
// no setting, secret or variable, and changes nothing.

/** The one answer, fixed text. */
export const REGISTER_PROJECT_RETIRED = {
  outcome: "refused",
  reason: "retired",
  message:
    "This form is retired (ADR 0118): start a project with the New project form, f/foreman/new_project, from its page in this workspace. Nothing was read, created or recorded.",
} as const;

export type RegisterProjectRetired = typeof REGISTER_PROJECT_RETIRED;

export async function run(): Promise<RegisterProjectRetired> {
  return REGISTER_PROJECT_RETIRED;
}

export async function main(): Promise<RegisterProjectRetired> {
  return run();
}
