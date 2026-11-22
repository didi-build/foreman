// Didi's New project form (ADR 0118 appendix C, D-434, D-435, D-442 to D-447, O-161). The called
// flow `f/foreman/new_project` (flows/new-project.ts) takes four boxes, the short name (slug), the
// display name, a one-line purpose and the personal-data answer (ticked by default, D-435), and
// running it is Didi's one approval (D-434). Everything else is fixed: a public repository
// (D-348), the standard size (D-436) and the Cloudflare target (D-441).
//
// Checks, before any effect:
// 1. The input. The slug follows the project file's rule (`isProjectEntrySlug`, ./project-entry.ts)
//    and is not `foreman`, Foreman's own (appendix G). The display name and purpose are trimmed,
//    then follow the file's rules. The personal-data answer is a box.
// 2. The switches, read as the other Didi forms read them: the kill switch refuses before anything
//    is read, and dry run goes on with the reads only and says what each step would do.
// 3. Reads only: Foreman's standard size from `foreman`'s main (check 4 of the appendix, read first
//    because the file's values depend on it); then each piece must be absent, or present as an
//    earlier run of this form made it: the settings file with exactly these values (all but
//    `createdOn`, the day it was written); the store's row as this form records it; the repository
//    public and generated from Launchpad under exactly this name (./project-repository.ts); and,
//    only while the settings file is absent, no public DNS record for `<slug>.didi.build`. A piece
//    held by anything else refuses with fixed text, and nothing is created.
//
// Effects, in order, each found before it is made, so running the form again after a partial
// failure does the rest and makes nothing twice:
// 1. and 2. The deploy target's `setUp` (O-160): the D1 database `<slug>-staging` with the hint
//    `enam` (D-447), then the placeholder Worker, kept when a Worker exists (D-438). First, because
//    the route needs the Worker (O-112, O-140).
// 3. The settings file `projects/<slug>.json`, through a write that can only create (D-442,
//    D-443): no `sha`, so GitHub never replaces a file. When GitHub does not create it, the file
//    is read again and kept only when it holds these values.
// 4. The Platform and Infra runs on `foreman`'s main, with `projects_commit` set to the commit that
//    holds the file (D-443, D-444). Starting them again is harmless: a plan with nothing to do
//    applies nothing. The form does not wait for them.
// 5. The repository from `didi-build/launchpad`, with the purpose as its description (D-346).
// 6. The store's row: the display name as `name`, the Cloudflare target, staging at
//    `https://<slug>.didi.build` and no production (D-345), in one transaction that reads both
//    switches again.
// 7. Bootstrap (D-358, O-114): the repository gets `BOOTSTRAP_TOKEN`'s access, then Bootstrap is
//    started again on main with the display name and the personal-data answer (N-92). On a row an
//    earlier run recorded, Bootstrap's newest restarted run is read first: a run that succeeded
//    or is still going starts nothing.
// Both switches are read again before each step, so a switch turned on during a run stops it
// before the next one.
//
// What Didi sees: `created`, `completed` (an earlier run had done part of it), `dry_run`, or
// `refused`, with one line per step (created, found, started, skipped, refused, or what dry run
// would do), the links (the repository, the settings commit, the two runs, Bootstrap's runs and
// the staging site) and what to expect next. A refusal's text is fixed and quotes no input, token
// or answer; the step lines name only what is made from the checked slug. No secret, token or
// database id is ever in a result, and nothing here logs.
import {
  BOOTSTRAP_WORKFLOW_FILE,
  setupStateOf,
  startSetup,
  type BootstrapAccess,
  type BootstrapRuns,
  type SetupRefusal,
  type SetupState,
} from "./bootstrap-access.ts";
import {
  projectTargetOf,
  type ProjectSetUp,
  type ProjectTarget,
} from "./deploy-target.ts";
import type { DeployTargetName } from "./project-entry.ts";
import type { Clock, IdSource } from "./library.ts";
import {
  DISPLAY_NAME_MAX_CHARS,
  PROJECTS_FOLDER,
  PROJECTS_REPOSITORY,
  PROJECTS_SCHEMA,
  isProjectDisplayName,
  isProjectEntrySlug,
  isProjectPurpose,
  parseProjectEntry,
  projectFileName,
  type ProjectEntry,
  type ProjectQuota,
} from "./project-entry.ts";
import {
  DESCRIPTION_MAX_CHARS,
  createdAsAsked,
  projectRepository,
  projectStagingUrl,
  reuseRefusal,
  type ProjectRepositories,
  type RepositoryFacts,
  type ReuseRefusal,
  type TemplateGenerate,
} from "./project-repository.ts";
import type { DeployRefusalDetail } from "./staging-deploy.ts";
import { StoreConflictError, type Project, type Store } from "./store.ts";

/** The slug the form never takes: Foreman's own project (ADR 0118 appendix G, D-441). */
export const RESERVED_SLUG = "foreman";

/** The zone every project's staging name is in (D-357). */
export const PROJECT_ZONE = "didi.build";

/** `projects/<slug>.json` in the settings repository. */
export const projectFilePath = (slug: string): string =>
  `${PROJECTS_FOLDER}/${projectFileName(slug)}`;

/** A project file on the settings repository's main. */
export interface ProjectFile {
  /** The file's contents. */
  text: string;
  /** The newest commit on main that changed it: 40 lowercase hexadecimal characters. */
  commit: string;
}

/** What one create-only write of a project file came to. */
export type ProjectFileCreate =
  /** GitHub made the commit that adds the file. */
  | { kind: "created"; commit: string }
  /**
   * GitHub answered that it cannot make the file this way (409 or 422), as it does when a file is
   * already there: the form reads the file to tell. Never followed by an update.
   */
  | { kind: "not_created" }
  /** The write token was not minted, or GitHub refused or failed the write. */
  | { kind: "refused"; step: "token" | "call"; status?: number };

/** The settings Foreman reads and writes for a new project (ADR 0118 appendix A, D-436). */
export interface ProjectSettings {
  /**
   * `projectStandardQuota` of Foreman's own settings file on `didi-build/foreman`'s main, the
   * size every new project gets (D-436). Throws on a failed read or a quota not in full.
   */
  standardQuota(): Promise<ProjectQuota>;
  /** `projects/<slug>.json` on the settings repository's main, or null when absent. Throws on a failed read. */
  readFile(slug: string): Promise<ProjectFile | null>;
  /**
   * Creates `projects/<slug>.json` on main with this text and commit message, never replacing a
   * file. Mints the write token (`contents: write` on the settings repository only) for this one
   * call, and never tries again.
   */
  createFile(request: {
    slug: string;
    text: string;
    message: string;
  }): Promise<ProjectFileCreate>;
}

/** One workflow start. `link` is the run's page, or the workflow's runs when GitHub names no run. */
export type WorkflowStart =
  | { kind: "started"; link: string }
  | { kind: "refused"; step: "token" | "call"; status?: number };

/** The Platform and Infra runs (D-443): one start token for exactly these two calls. */
export interface ProjectWorkflows {
  /**
   * Starts the Platform workflow, then the Infra apply workflow, on `foreman`'s main with this
   * `projects_commit`. Mints one token (`actions: write` on `foreman` only) for the two calls; a
   * refused token starts neither. Never tries a call again.
   */
  start(
    projectsCommit: string,
  ): Promise<{ platform: WorkflowStart; infra: WorkflowStart }>;
}

/** A public DNS lookup (appendix C, check 3). */
export interface PublicNames {
  /** Whether a public lookup of `host` finds any address or alias. Throws when the lookup fails. */
  inUse(host: string): Promise<boolean>;
}

export interface NewProjectDeps {
  store: Store;
  clock: Clock;
  ids: IdSource;
  /**
   * The deploy targets by name (O-166). The form's row names `cloudflare` (D-435, D-441), so its
   * database and placeholder are set up there (O-160).
   */
  targets: { readonly [name in DeployTargetName]: Pick<ProjectTarget, "setUp"> };
  projectSettings: ProjectSettings;
  projectWorkflows: ProjectWorkflows;
  projectRepositories: ProjectRepositories;
  publicNames: PublicNames;
  bootstrapAccess: BootstrapAccess;
  bootstrapRuns: BootstrapRuns;
}

export interface NewProjectInput {
  /** The short name: `didi-build/<slug>`, `<slug>.didi.build` and `agents-<slug>` (D-435). */
  slug: string;
  displayName: string;
  /** One line: the repository's description, which Bootstrap reads, and the placeholder's text. */
  purpose: string;
  collectsPersonalData: boolean;
  /** The Windmill run's id, named in the settings commit's message. Left out when not a UUID. */
  runId?: string | null;
}

/** The form's steps, in order (appendix C, "Effects"). */
export const NEW_PROJECT_STEPS = [
  "database",
  "placeholder",
  "settings_file",
  "workflows",
  "repository",
  "record",
  "bootstrap",
] as const;
export type NewProjectStep = (typeof NEW_PROJECT_STEPS)[number];

export type StepOutcome =
  | "created"
  | "found"
  | "started"
  | "skipped"
  | "would_create"
  | "would_start"
  | "refused"
  | "not_reached";

/** One step's line. `text` is fixed, naming only what is made from the checked slug. */
export interface StepLine {
  step: NewProjectStep;
  outcome: StepOutcome;
  text: string;
}

export interface NewProjectLinks {
  repository?: string;
  settingsCommit?: string;
  platformRun?: string;
  infraRun?: string;
  bootstrap?: string;
  staging?: string;
  health?: string;
}

/** Every refusal, with its fixed text. None quotes the input, a token or an answer. */
export const NEW_PROJECT_REFUSALS = {
  invalid_slug:
    "The short name must be 1 to 47 lowercase letters, digits or hyphens, start and end with a letter or digit, and have no two hyphens together: nothing was read or created.",
  reserved_slug:
    "The short name foreman is Foreman's own (ADR 0118 appendix G), so this form never takes it: nothing was read or created.",
  invalid_display_name: `The display name must be one line of 1 to ${DISPLAY_NAME_MAX_CHARS} characters, with no control or format character: nothing was read or created.`,
  invalid_purpose: `The purpose must be one line of 1 to ${DESCRIPTION_MAX_CHARS} characters, with no control or format character: nothing was read or created.`,
  invalid_personal_data:
    "The personal-data answer must be the box, ticked or not: nothing was read or created.",
  kill_switch: "The kill switch is on: nothing was read, created, written or started.",
  standard_quota_unreadable:
    "Foreman's standard size (projectStandardQuota in infra/kubernetes/settings/production.json on didi-build/foreman's main) could not be read through GitHub, or is not a quota in full: nothing was created.",
  settings_unreadable:
    "The project's file in didi-build/foreman-projects on main could not be read through GitHub (the runner App's read token was refused or is not available yet): nothing was created.",
  settings_file_taken:
    "didi-build/foreman-projects already has a file for this short name with other values than these, so the name is taken: nothing was created. If an earlier run of this form wrote it, run the form again with the same values.",
  record_taken:
    "The store already has a project with this short name that this form did not record (another name, repository, target or setting), so the name is taken: nothing was created.",
  repository_unreadable:
    "The repository didi-build/<slug> could not be read through GitHub: nothing was created.",
  existing_not_from_template:
    "A repository with this name already exists and GitHub does not show it as generated from didi-build/launchpad, so the name is taken: nothing was created.",
  existing_not_public:
    "A repository with this name already exists and is not public, so the name is taken: nothing was created.",
  existing_other_name:
    "GitHub's answer names a repository other than didi-build/<slug> exactly, so it is not reused: nothing was created.",
  name_unreadable:
    "The public DNS lookup of <slug>.didi.build failed: nothing was created. Run the form again.",
  name_in_use:
    "<slug>.didi.build already answers a public DNS lookup while the project has no file in didi-build/foreman-projects, so the name is in use: nothing was created.",
  setup_refused:
    "The project's setup on Cloudflare stopped at the step its line marks refused (cloudflare, when present, names the call, its status and Cloudflare's codes): nothing after it was done. Running the form again picks up where it stopped.",
  settings_token_refused:
    "The token to write the project's file (contents: write on didi-build/foreman-projects only) was not minted: the file was not written and nothing after it was done. Running the form again picks up where it stopped.",
  settings_write_refused:
    "GitHub refused or failed the write of the project's file (githubStatus, when present, is its answer): nothing after it was done. Running the form again picks up where it stopped.",
  settings_file_changed:
    "GitHub did not create the project's file, and the file on main now holds other values than these, or could not be read: nothing after it was done.",
  workflows_token_refused:
    "The token to start the Platform and Infra runs (actions: write on didi-build/foreman only) was not minted: neither was started, and nothing after them was done. Running the form again picks up where it stopped.",
  workflows_refused:
    "GitHub refused or failed starting the Platform or the Infra run (githubStatus, when present, is its answer; a run that started has its link): nothing after them was done. Running the form again starts both again, which is harmless.",
  creation_token_refused:
    "The repository creation token was not minted (GitHub refused it, or the runner App is not registered yet): the repository was not created and nothing after it was done. Running the form again picks up where it stopped.",
  create_refused:
    "GitHub refused or failed the repository's creation from didi-build/launchpad: nothing after it was done. If it was created after all, running the form again reuses it.",
  existing_unreadable:
    "GitHub did not create the repository, and no existing repository with this name could be read: nothing after it was done.",
  created_unexpected:
    "GitHub answered that it created the repository, but its answer does not show a public repository named didi-build/<slug>: nothing after it was done. Check the repository on GitHub before running the form again.",
  switch_turned_on:
    "The kill switch or dry run was turned on while the form ran: it stopped before the next step. Run the form again once both are off: it picks up where it stopped.",
  grant_token_refused:
    "The project is recorded, but the token to give its repository access to BOOTSTRAP_TOKEN was not minted (GitHub refused it, or the runner App is not registered yet): nothing was granted and Bootstrap was not started. Run the form again: it picks up where it stopped.",
  secret_not_selected:
    "The project is recorded, but GitHub answered that BOOTSTRAP_TOKEN is not shared with selected repositories only, so nothing was granted and Bootstrap was not started. Set the secret's repository access to selected repositories (first-hosting runbook, step 13), then run the form again: it picks up where it stopped.",
  grant_refused:
    "The project is recorded, but GitHub refused or failed adding its repository to BOOTSTRAP_TOKEN's selected repositories: Bootstrap was not started. Run the form again: it picks up where it stopped.",
  restart_token_refused:
    "The project is recorded and its repository has access to BOOTSTRAP_TOKEN, but the token to start Bootstrap was not minted (GitHub refused it, or the runner App is not registered yet): Bootstrap was not started. Run the form again: it picks up where it stopped. The reconcile pass removes the access once the project is an hour old.",
  restart_refused:
    "The project is recorded and its repository has access to BOOTSTRAP_TOKEN, but GitHub refused or failed starting Bootstrap on main, after waiting up to a minute for a new repository's workflow to appear (githubStatus, when present, is GitHub's answer). Run the form again: it picks up where it stopped. The reconcile pass removes the access once the project is an hour old.",
  setup_unreadable:
    "The project is recorded, but Bootstrap's runs on its repository could not be read (the runner App's read token was refused or is not available yet): nothing was granted or started. Run the form again: it picks up where it stopped.",
} as const;

export type NewProjectRefusal = keyof typeof NEW_PROJECT_REFUSALS;

/** The fixed text of each outcome. */
export const NEW_PROJECT_MESSAGES = {
  created:
    "The project is set up: each line says what was done. Its Platform and Infra runs and Bootstrap run now, and the form does not wait for them.",
  completed:
    "The project is complete: this run found what an earlier run had done and did the rest. Each line says which.",
  dry_run:
    "Dry run is on: nothing was created, written, started or recorded. Each line says what the form would do with dry run off.",
} as const;

export interface NewProjectResult {
  outcome: "created" | "completed" | "dry_run" | "refused";
  message: string;
  /** Set when refused. */
  reason?: NewProjectRefusal;
  /** GitHub's HTTP status, when a refused call was answered (O-114). Never its body. */
  githubStatus?: number;
  /** A Cloudflare refusal's call, status and codes (O-139). Never its message or an id. */
  cloudflare?: DeployRefusalDetail;
  /** One line per step reached, in order; empty when a check refused. */
  steps: StepLine[];
  links: NewProjectLinks;
  /** In a dry run, the project file the form would write. */
  wouldWrite?: ProjectEntry;
  /** What to expect next, and what to do. */
  next: string[];
}

/** Each step's line, by outcome. Only names made from the checked slug are filled in. */
const STEP_TEXTS: Record<
  NewProjectStep,
  Partial<Record<StepOutcome, (slug: string) => string>>
> = {
  database: {
    created: (s) =>
      `Created the D1 database ${s}-staging, in Eastern North America (D-447).`,
    found: (s) => `Found the D1 database ${s}-staging an earlier run made: reused.`,
    would_create: (s) =>
      `Would create the D1 database ${s}-staging, in Eastern North America (D-447).`,
  },
  placeholder: {
    created: (s) =>
      `Uploaded the placeholder Worker ${s}-staging: a page at / and an answer at /api/health (D-438).`,
    skipped: (s) =>
      `The Worker ${s}-staging exists already, so nothing was uploaded: a real build is never replaced.`,
    would_create: (s) =>
      `Would upload the placeholder Worker ${s}-staging: a page at / and an answer at /api/health (D-438).`,
  },
  settings_file: {
    created: (s) =>
      `Wrote ${projectFilePath(s)} to ${PROJECTS_REPOSITORY}, with the standard size and the Cloudflare target.`,
    found: (s) =>
      `${projectFilePath(s)} is already on ${PROJECTS_REPOSITORY}'s main with these values: kept as it is.`,
    would_create: (s) =>
      `Would write ${projectFilePath(s)} to ${PROJECTS_REPOSITORY}, with the standard size and the Cloudflare target.`,
  },
  workflows: {
    started: () =>
      "Started the Platform and Infra runs on didi-build/foreman with the settings commit. Each applies with no approval when its plan only adds this project (D-378); otherwise it waits for your approval in GitHub, and its summary says why.",
    would_start: () =>
      "Would start the Platform and Infra runs on didi-build/foreman with the settings commit.",
  },
  repository: {
    created: (s) =>
      `Created ${projectRepository(s)} from didi-build/launchpad, public, with the purpose as its description.`,
    found: (s) =>
      `${projectRepository(s)} exists, public and generated from didi-build/launchpad: reused.`,
    would_create: (s) =>
      `Would create ${projectRepository(s)} from didi-build/launchpad, public, with the purpose as its description.`,
  },
  record: {
    created: (s) =>
      `Recorded the project: staging at ${projectStagingUrl(s)}, the Cloudflare target, no production.`,
    found: () => "The store already records the project as this form does: kept.",
    would_create: (s) =>
      `Would record the project: staging at ${projectStagingUrl(s)}, the Cloudflare target, no production.`,
  },
  bootstrap: {
    started: (s) =>
      `Gave ${projectRepository(s)} access to BOOTSTRAP_TOKEN and started Bootstrap on main with the display name and the personal-data answer.`,
    found: (s) =>
      `Bootstrap already set ${projectRepository(s)} up: nothing was started.`,
    skipped: (s) =>
      `Bootstrap is running on ${projectRepository(s)} now: nothing was started. When it ends Foreman removes its access; if it failed, the daily check says so, and running the form again starts it again.`,
    would_start: (s) =>
      `Would give ${projectRepository(s)} access to BOOTSTRAP_TOKEN and start Bootstrap on main with the display name and the personal-data answer.`,
  },
};

/** The line of a step not reached because an earlier one stopped the form. */
export const NOT_REACHED_TEXT = "Not reached: an earlier step stopped the form.";

const COMMIT = /^[0-9a-f]{40}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The settings commit's message: the form and its Windmill run, when known (appendix A). */
export function settingsCommitMessage(slug: string, runId?: string | null): string {
  const run =
    typeof runId === "string" && RUN_ID.test(runId) ? `, Windmill run ${runId}` : "";
  return `Add project ${slug} (New project form${run}, ADR 0118)`;
}

/** The file the form writes: appendix A's format, keys in its order, two-space indent. */
export function projectFileText(entry: ProjectEntry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

/** Every project the form records deploys to Cloudflare (D-435, D-441). */
export const NEW_PROJECT_TARGET = "cloudflare" satisfies DeployTargetName;

/** The row the form records (D-345, D-441), apart from its id and time. */
export function plannedProject(
  slug: string,
  displayName: string,
): Omit<Project, "id" | "createdAt"> {
  return {
    slug,
    name: displayName,
    repo: projectRepository(slug),
    linearProjectId: null,
    galleryPathOverride: null,
    // Launchpad starts every project alike, so the shared list covers them all (D-345).
    privilegedPathsExtra: [],
    // A project starts with no production; production later needs Didi's approval (D-345, D-007).
    prodRequiresApproval: true,
    stagingUrl: projectStagingUrl(slug),
    deployTarget: NEW_PROJECT_TARGET,
  };
}

const sameQuota = (a: ProjectQuota, b: ProjectQuota): boolean =>
  a.pods === b.pods &&
  a.cpu === b.cpu &&
  a.memory === b.memory &&
  a.ephemeralStorage === b.ephemeralStorage &&
  a.storage === b.storage &&
  a.persistentVolumeClaims === b.persistentVolumeClaims;

/** Whether a file holds exactly the planned values; `createdOn` is the day an earlier run wrote it. */
function fileMatches(slug: string, text: string, planned: ProjectEntry): boolean {
  const parsed = parseProjectEntry(projectFileName(slug), text);
  if (!parsed.ok) return false;
  const e = parsed.entry;
  return (
    e.slug === planned.slug &&
    e.displayName === planned.displayName &&
    e.purpose === planned.purpose &&
    e.collectsPersonalData === planned.collectsPersonalData &&
    e.deployTarget === planned.deployTarget &&
    sameQuota(e.quota, planned.quota)
  );
}

/** Whether a store row is exactly the one this form records for these values. */
function rowMatches(row: Project, slug: string, displayName: string): boolean {
  const planned = plannedProject(slug, displayName);
  return (
    row.slug === planned.slug &&
    row.name === planned.name &&
    row.repo === planned.repo &&
    row.linearProjectId === null &&
    row.galleryPathOverride === null &&
    JSON.stringify(row.privilegedPathsExtra) === "[]" &&
    row.prodRequiresApproval === true &&
    row.stagingUrl === planned.stagingUrl &&
    row.deployTarget === planned.deployTarget
  );
}

/** The input, checked, or why it is refused. */
function checkInput(input: NewProjectInput):
  | {
      ok: true;
      slug: string;
      displayName: string;
      purpose: string;
      personalData: boolean;
    }
  | { ok: false; reason: NewProjectRefusal } {
  const slug: unknown = input?.slug;
  if (!isProjectEntrySlug(slug)) return { ok: false, reason: "invalid_slug" };
  if (slug === RESERVED_SLUG) return { ok: false, reason: "reserved_slug" };
  const displayName: unknown = input?.displayName;
  const name = typeof displayName === "string" ? displayName.trim() : null;
  if (!isProjectDisplayName(name)) return { ok: false, reason: "invalid_display_name" };
  const purposeIn: unknown = input?.purpose;
  const purpose = typeof purposeIn === "string" ? purposeIn.trim() : null;
  if (!isProjectPurpose(purpose)) return { ok: false, reason: "invalid_purpose" };
  const personalData: unknown = input?.collectsPersonalData;
  if (typeof personalData !== "boolean")
    return { ok: false, reason: "invalid_personal_data" };
  return { ok: true, slug, displayName: name, purpose, personalData };
}

/** What the checks found already there: each absent, or as an earlier run of this form made it. */
interface Found {
  quota: ProjectQuota;
  file: ProjectFile | null;
  record: Project | null;
  repository: boolean;
}

const SETUP_REFUSAL_REASONS: Record<SetupRefusal, NewProjectRefusal> = {
  grant_token_refused: "grant_token_refused",
  secret_not_selected: "secret_not_selected",
  grant_refused: "grant_refused",
  restart_token_refused: "restart_token_refused",
  restart_refused: "restart_refused",
};

export function createNewProjectForm(deps: NewProjectDeps) {
  const { store, clock, ids } = deps;

  /** Whether a switch now holds the form: the kill switch on, or dry run not off. */
  async function held(): Promise<boolean> {
    if ((await store.getSetting("kill_switch"))?.value === true) return true;
    return (await store.getSetting("dry_run"))?.value !== false;
  }

  /** Checks 3 and 4: reads only. A refusal when a piece is held by anything but this form. */
  async function check(
    slug: string,
    displayName: string,
    planned: (quota: ProjectQuota) => ProjectEntry,
  ): Promise<Found | { refusal: NewProjectRefusal }> {
    let quota: ProjectQuota;
    try {
      quota = await deps.projectSettings.standardQuota();
    } catch {
      return { refusal: "standard_quota_unreadable" };
    }
    let file: ProjectFile | null;
    try {
      file = await deps.projectSettings.readFile(slug);
    } catch {
      return { refusal: "settings_unreadable" };
    }
    if (file !== null && !fileMatches(slug, file.text, planned(quota)))
      return { refusal: "settings_file_taken" };
    const record = await store.getProjectBySlug(slug);
    if (record !== null && !rowMatches(record, slug, displayName))
      return { refusal: "record_taken" };
    let facts: RepositoryFacts | null;
    try {
      facts = await deps.projectRepositories.read(slug);
    } catch {
      return { refusal: "repository_unreadable" };
    }
    const reuse: ReuseRefusal | null =
      facts === null ? null : reuseRefusal(slug, facts);
    if (reuse !== null) return { refusal: reuse };
    // Once the file is there, the Infra run may have made the name already (appendix C).
    if (file === null) {
      let inUse: boolean;
      try {
        inUse = await deps.publicNames.inUse(`${slug}.${PROJECT_ZONE}`);
      } catch {
        return { refusal: "name_unreadable" };
      }
      if (inUse) return { refusal: "name_in_use" };
    }
    return { quota, file, record, repository: facts !== null };
  }

  /** Step 5: the repository, created now or reused from an earlier run. */
  async function repository(
    slug: string,
    purpose: string,
  ): Promise<"created" | "found" | { refusal: NewProjectRefusal }> {
    let attempt: TemplateGenerate;
    try {
      attempt = await deps.projectRepositories.generate({
        name: slug,
        description: purpose,
      });
    } catch {
      return { refusal: "create_refused" };
    }
    if (attempt.kind === "refused") {
      return {
        refusal:
          attempt.step === "creation_token"
            ? "creation_token_refused"
            : "create_refused",
      };
    }
    if (attempt.kind === "created") {
      return createdAsAsked(slug, attempt.repository)
        ? "created"
        : { refusal: "created_unexpected" };
    }
    let facts: RepositoryFacts | null;
    try {
      facts = await deps.projectRepositories.read(slug);
    } catch {
      return { refusal: "existing_unreadable" };
    }
    if (facts === null) return { refusal: "existing_unreadable" };
    const reuse = reuseRefusal(slug, facts);
    return reuse === null ? "found" : { refusal: reuse };
  }

  /** Step 6: the row, in one transaction that reads both switches again. */
  async function record(
    slug: string,
    displayName: string,
  ): Promise<"created" | "found" | { refusal: NewProjectRefusal }> {
    const existing = async (
      read: Pick<Store, "getProjectBySlug">,
    ): Promise<"found" | { refusal: NewProjectRefusal } | null> => {
      const row = await read.getProjectBySlug(slug);
      if (row === null) return null;
      return rowMatches(row, slug, displayName) ? "found" : { refusal: "record_taken" };
    };
    type Recorded = "created" | "found" | { refusal: NewProjectRefusal };
    try {
      return await store.transaction(async (tx): Promise<Recorded> => {
        if ((await tx.getSetting("kill_switch"))?.value === true)
          return { refusal: "switch_turned_on" };
        if ((await tx.getSetting("dry_run"))?.value !== false)
          return { refusal: "switch_turned_on" };
        const there = await existing(tx);
        if (there !== null) return there;
        await tx.insertProject({
          id: ids.next(),
          ...plannedProject(slug, displayName),
          createdAt: clock.now(),
        });
        return "created";
      });
    } catch (error) {
      // Another run inserted the same slug first (the slug is unique, migration 0001).
      if (
        error instanceof StoreConflictError &&
        error.constraint === "projects_slug_key"
      ) {
        return (await existing(store)) ?? { refusal: "record_taken" };
      }
      throw error;
    }
  }

  return {
    async create(input: NewProjectInput): Promise<NewProjectResult> {
      const early = (reason: NewProjectRefusal): NewProjectResult => ({
        outcome: "refused",
        reason,
        message: NEW_PROJECT_REFUSALS[reason],
        steps: [],
        links: {},
        next: [],
      });

      // 1. The input.
      const checked = checkInput(input);
      if (!checked.ok) return early(checked.reason);
      const { slug, displayName, purpose, personalData } = checked;

      // 2. The switches.
      if ((await store.getSetting("kill_switch"))?.value === true)
        return early("kill_switch");
      const dryRun = (await store.getSetting("dry_run"))?.value !== false;

      // 3 and 4. Reads only.
      const planned = (quota: ProjectQuota): ProjectEntry => ({
        schema: PROJECTS_SCHEMA,
        slug,
        displayName,
        purpose,
        collectsPersonalData: personalData,
        quota,
        deployTarget: NEW_PROJECT_TARGET,
        createdOn: clock.now().toISOString().slice(0, 10),
      });
      const found = await check(slug, displayName, planned);
      if ("refusal" in found) {
        return {
          ...early(found.refusal),
          next: [
            "Choose another short name, or run the form again with the values of the earlier run.",
          ],
        };
      }
      const entry = planned(found.quota);

      // What the result shows, built as the steps go.
      const steps: StepLine[] = [];
      const links: NewProjectLinks = {};
      const line = (step: NewProjectStep, outcome: StepOutcome): void => {
        const text = STEP_TEXTS[step][outcome];
        steps.push({ step, outcome, text: text ? text(slug) : NOT_REACHED_TEXT });
      };
      const stop = (
        step: NewProjectStep,
        reason: NewProjectRefusal,
        extra: Pick<NewProjectResult, "githubStatus" | "cloudflare"> = {},
      ): NewProjectResult => {
        steps.push({ step, outcome: "refused", text: NEW_PROJECT_REFUSALS[reason] });
        for (const later of NEW_PROJECT_STEPS.slice(
          NEW_PROJECT_STEPS.indexOf(step) + 1,
        ))
          steps.push({ step: later, outcome: "not_reached", text: NOT_REACHED_TEXT });
        return {
          outcome: "refused",
          reason,
          message: NEW_PROJECT_REFUSALS[reason],
          ...extra,
          steps,
          links,
          next: [
            "Fix what the message names, then run the form again with the same values: it finds what is done and does the rest.",
          ],
        };
      };
      const setUpLines = (setUp: ProjectSetUp): NewProjectResult | null => {
        const database = setUp.database;
        if (database !== undefined) line("database", database);
        if (setUp.outcome === "refused") {
          return stop(
            setUp.step === "placeholder" ? "placeholder" : "database",
            "setup_refused",
            {
              ...(setUp.detail ? { cloudflare: setUp.detail } : {}),
            },
          );
        }
        line(
          "placeholder",
          setUp.placeholder === "kept"
            ? "skipped"
            : setUp.placeholder === "uploaded"
              ? "created"
              : "would_create",
        );
        return null;
      };
      const repositoryLink = `https://github.com/${projectRepository(slug)}`;
      const bootstrapLink = `${repositoryLink}/actions/workflows/${BOOTSTRAP_WORKFLOW_FILE}`;
      const commitLink = (commit: string) =>
        `https://github.com/${PROJECTS_REPOSITORY}/commit/${commit}`;
      // The target the row this form records names: Cloudflare (D-441, O-166).
      const setUpTarget = projectTargetOf(deps.targets, {
        deployTarget: NEW_PROJECT_TARGET,
      });
      const bootstrapState = async (): Promise<SetupState | null> => {
        try {
          return setupStateOf(await deps.bootstrapRuns.latestRestart(slug));
        } catch {
          return null;
        }
      };

      if (dryRun) {
        const setUp = await setUpTarget.setUp({
          slug,
          displayName,
          purpose,
          dryRun: true,
        });
        const stopped = setUpLines(setUp);
        if (stopped) return stopped;
        line("settings_file", found.file ? "found" : "would_create");
        if (found.file) links.settingsCommit = commitLink(found.file.commit);
        line("workflows", "would_start");
        line("repository", found.repository ? "found" : "would_create");
        if (found.repository) links.repository = repositoryLink;
        line("record", found.record ? "found" : "would_create");
        if (found.record) {
          const state = await bootstrapState();
          if (state === null) return stop("bootstrap", "setup_unreadable");
          line(
            "bootstrap",
            state === "succeeded"
              ? "found"
              : state === "running"
                ? "skipped"
                : "would_start",
          );
        } else {
          line("bootstrap", "would_start");
        }
        return {
          outcome: "dry_run",
          message: NEW_PROJECT_MESSAGES.dry_run,
          steps,
          links,
          wouldWrite: entry,
          next: [
            "Turn dry run off and run the form again with the same values to create the project.",
          ],
        };
      }

      // 1 and 2. The database, then the placeholder Worker (O-160).
      const setUp = await setUpTarget.setUp({ slug, displayName, purpose });
      const stopped = setUpLines(setUp);
      if (stopped) return stopped;

      // 3. The settings file, created only.
      if (await held()) return stop("settings_file", "switch_turned_on");
      let commit: string;
      if (found.file) {
        commit = found.file.commit;
        line("settings_file", "found");
      } else {
        const write = await deps.projectSettings
          .createFile({
            slug,
            text: projectFileText(entry),
            message: settingsCommitMessage(slug, input.runId),
          })
          .catch((): ProjectFileCreate => ({ kind: "refused", step: "call" }));
        if (write.kind === "refused") {
          return write.step === "token"
            ? stop("settings_file", "settings_token_refused")
            : stop("settings_file", "settings_write_refused", {
                ...(write.status === undefined ? {} : { githubStatus: write.status }),
              });
        }
        if (write.kind === "created" && COMMIT.test(write.commit)) {
          commit = write.commit;
          line("settings_file", "created");
        } else {
          // Not created: kept only when the file now there holds these values.
          const now = await deps.projectSettings.readFile(slug).catch(() => null);
          if (
            now === null ||
            !COMMIT.test(now.commit) ||
            !fileMatches(slug, now.text, entry)
          )
            return stop("settings_file", "settings_file_changed");
          commit = now.commit;
          line("settings_file", "found");
        }
      }
      links.settingsCommit = commitLink(commit);

      // 4. The Platform and Infra runs, with the commit that holds the file.
      if (await held()) return stop("workflows", "switch_turned_on");
      const runs = await deps.projectWorkflows.start(commit).catch(() => ({
        platform: { kind: "refused", step: "call" } as WorkflowStart,
        infra: { kind: "refused", step: "call" } as WorkflowStart,
      }));
      if (runs.platform.kind === "started") links.platformRun = runs.platform.link;
      if (runs.infra.kind === "started") links.infraRun = runs.infra.link;
      const refusedStart = [runs.platform, runs.infra].find(
        (r) => r.kind === "refused",
      );
      if (refusedStart?.kind === "refused") {
        return refusedStart.step === "token"
          ? stop("workflows", "workflows_token_refused")
          : stop("workflows", "workflows_refused", {
              ...(refusedStart.status === undefined
                ? {}
                : { githubStatus: refusedStart.status }),
            });
      }
      line("workflows", "started");

      // 5. The repository.
      if (await held()) return stop("repository", "switch_turned_on");
      if (found.repository) {
        line("repository", "found");
      } else {
        const made = await repository(slug, purpose);
        if (typeof made === "object") return stop("repository", made.refusal);
        line("repository", made);
      }
      links.repository = repositoryLink;

      // 6. The store's row.
      const recorded = await record(slug, displayName);
      if (typeof recorded === "object") return stop("record", recorded.refusal);
      line("record", recorded);

      // 7. Bootstrap, unless an earlier run's restart succeeded or still runs.
      if (await held()) return stop("bootstrap", "switch_turned_on");
      const state: SetupState | null =
        recorded === "found" ? await bootstrapState() : "not_started";
      if (state === null) return stop("bootstrap", "setup_unreadable");
      if (state === "succeeded" || state === "running") {
        line("bootstrap", state === "succeeded" ? "found" : "skipped");
      } else {
        const setup = await startSetup(deps, slug, {
          displayName,
          collectsPersonalData: personalData,
        });
        if (!setup.started) {
          return stop("bootstrap", SETUP_REFUSAL_REASONS[setup.reason], {
            ...(setup.githubStatus === undefined
              ? {}
              : { githubStatus: setup.githubStatus }),
          });
        }
        line("bootstrap", "started");
      }
      links.bootstrap = bootstrapLink;
      links.staging = projectStagingUrl(slug);
      links.health = `${projectStagingUrl(slug)}/api/health`;

      const rerun = steps.some((l) => l.outcome === "found" || l.outcome === "skipped");
      return {
        outcome: rerun ? "completed" : "created",
        message: rerun ? NEW_PROJECT_MESSAGES.completed : NEW_PROJECT_MESSAGES.created,
        steps,
        links,
        next: [
          `In a few minutes ${projectStagingUrl(slug)} shows the placeholder and ${links.health} answers {"status":"ok"}. Once Bootstrap and CI finish, it shows the template's landing page.`,
          "The form does not wait for the Platform and Infra runs: open their links. A run whose plan is not add-only waits for your approval in GitHub, and its summary says why.",
          "Running the form again with the same values shows what is done and does what is not.",
          "The project's own keys, such as its model key, are separate steps (first-hosting runbook, Adding a project).",
        ],
      };
    },
  };
}

export type NewProjectForm = ReturnType<typeof createNewProjectForm>;
