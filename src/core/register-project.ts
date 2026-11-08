// Didi's register-project form (D-345, D-346, D-348, D-358, O-109, O-114). The called flow
// `f/foreman/register_project` (flows/register-project.ts) takes a slug and a one-line description
// and does these steps, in order:
//
// 1. Checks both. The slug follows the project-slug rule the state API's planning reads and the
//    tunnel's path already use (`PROJECT_SLUG`). The description is trimmed, then must be
//    non-empty, one line, free of control and invisible format characters, and at most
//    `DESCRIPTION_MAX_CHARS` long (GitHub documents no limit, so the cap is conservative, O-109).
// 2. The kill switch refuses before anything is read, created or written. Dry run goes on with
//    the reads only and says what would happen; it creates and writes nothing.
// 3. The slug must be listed in `projects[].slug` of the platform settings file as merged on main
//    (`PLATFORM_SETTINGS`), read through the `ProjectSettings` port.
// 4. A project already in the store with this slug is `already_registered`: nothing is created.
// 5. `didi-build/<slug>` is created from the `didi-build/launchpad` template with the description,
//    always public (D-348), through the `ProjectRepositories` port. Its token is minted for that
//    one call and carries only `contents: read` and `repository_creation: write` on `launchpad`
//    (D-346). A refused token or create stops the form: nothing is recorded and nothing is tried
//    again. When GitHub answers that it cannot create the repository (the name is taken), the
//    existing one is reused only if GitHub shows it public, generated from `didi-build/launchpad`,
//    under exactly this name: an earlier run that created it and failed before recording it.
//    Anything else is refused and nothing is recorded.
// 6. The project row is inserted in one transaction that reads both switches again, so a switch
//    turned on while the repository was being created stops the write. A project with the slug
//    found there, or a concurrent insert the slug's uniqueness rule refuses, is
//    `already_registered`.
// 7. Setup (D-358 lock (2), O-114, ./bootstrap-access.ts): the repository is added to the
//    organization secret `BOOTSTRAP_TOKEN`'s selected repositories, then Bootstrap is started
//    again on main, since its first run, at creation, had no token. Each step mints its own token,
//    once, narrowed to the new repository; a refusal stops the form, nothing is tried again, and
//    the text says that running the form again picks up where it stopped.
//
// Run again on a project already recorded, the form reads the newest restarted Bootstrap run on
// its repository: setup finished well is `already_registered`; a run still going changes
// nothing; otherwise (no restarted run yet, or one that failed) the form checks the repository as
// it checks one to reuse, then grants and restarts again (`setup_restarted`).
//
// Every refusal is fixed text from `REGISTER_REFUSALS`: it quotes no input, no token and no
// answer from GitHub. Nothing here logs.
import {
  BOOTSTRAP_REF,
  BOOTSTRAP_SECRET,
  BOOTSTRAP_WORKFLOW_PATH,
  GITHUB_ORGANIZATION,
  setupStateOf,
  startSetup,
  type BootstrapAccess,
  type BootstrapRuns,
  type SetupState,
} from "./bootstrap-access.ts";
import type { Clock, IdSource } from "./library.ts";
import { StoreConflictError, type Project, type Store } from "./store.ts";

/**
 * The project-slug rule: the state API's planning reads (src/api/routes.ts) and the tunnel's path
 * for them (infra/kubernetes/platform.ts, `STATE_API_PUBLIC.tunnelPath`) use the same pattern.
 */
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The GitHub organization that owns every project repository (D-345). */
export const PROJECT_OWNER = GITHUB_ORGANIZATION;

/** The template every project repository is created from (D-345). */
export const PROJECT_TEMPLATE = "didi-build/launchpad";

/** Where the slugs a project may be registered with are listed (D-345). */
export const PLATFORM_SETTINGS = {
  repository: "didi-build/foreman",
  path: "infra/kubernetes/settings/production.json",
  ref: "main",
} as const;

/**
 * The longest description the form sends, in UTF-16 code units (JavaScript's `length`), which is
 * never fewer than the characters GitHub could count. GitHub's docs state no limit (O-109).
 */
export const DESCRIPTION_MAX_CHARS = 200;

/** `didi-build/<slug>`: the repository name equals the slug (D-345). */
export const projectRepository = (slug: string): string => `${PROJECT_OWNER}/${slug}`;

/** The project's staging address, updated on every push to main with no approval (D-345). */
export const projectStagingUrl = (slug: string): string => `https://${slug}.didi.build`;

/** The slugs listed in the platform settings file on main. A failed read throws. */
export interface ProjectSettings {
  listedSlugs(): Promise<string[]>;
}

/** What GitHub shows about one repository. */
export interface RepositoryFacts {
  /** `full_name`, exactly as GitHub gives it. */
  fullName: string;
  private: boolean;
  /** `visibility` when GitHub gives it (`public`, `private` or `internal`), else null. */
  visibility: string | null;
  /** `template_repository.full_name`, or null when GitHub names no template. */
  templateFullName: string | null;
}

/** What one attempt to create a project repository from the template came to. */
export type TemplateGenerate =
  /** GitHub created it (201). `repository` is null when its answer could not be read. */
  | { kind: "created"; repository: RepositoryFacts | null }
  /**
   * GitHub answered 422, which it gives when the name is already taken (and for a request it
   * cannot process). The form reads the repository to tell which.
   */
  | { kind: "not_created" }
  /** The creation token was not minted, or GitHub refused or failed the create. */
  | { kind: "refused"; step: "creation_token" | "create" };

export interface ProjectRepositories {
  /**
   * Creates `didi-build/<name>` from `didi-build/launchpad` with this description, public, with
   * the template's default branch only. Mints the creation token for this one call and never
   * tries again, with this token or another.
   */
  generate(request: { name: string; description: string }): Promise<TemplateGenerate>;
  /** What GitHub shows about `didi-build/<name>`, or null when it does not exist. Throws on a failed read. */
  read(name: string): Promise<RepositoryFacts | null>;
}

export interface RegisterProjectDeps {
  store: Store;
  clock: Clock;
  ids: IdSource;
  projectSettings: ProjectSettings;
  projectRepositories: ProjectRepositories;
  /** `BOOTSTRAP_TOKEN`'s selected repositories (D-358, O-114). */
  bootstrapAccess: BootstrapAccess;
  /** Bootstrap's restart and its newest restarted run (D-358, O-114). */
  bootstrapRuns: BootstrapRuns;
}

export interface RegisterProjectInput {
  /** The project's slug, which is also its repository's name (D-345). */
  slug: string;
  /** One line, set as the repository's description, which Launchpad's Bootstrap reads. */
  description: string;
}

/** The project row the form records, apart from its id and time. */
export type PlannedProject = Omit<Project, "id" | "createdAt">;

/** Every refusal, with its fixed text. None quotes the input, a token or GitHub's answer. */
export const REGISTER_REFUSALS = {
  invalid_slug:
    "The slug must be 1 to 100 lowercase letters, digits or hyphens, starting with a letter or digit.",
  no_description: "The description is empty.",
  description_not_one_line: "The description must be one line.",
  description_has_control_characters:
    "The description has a control or invisible format character.",
  description_too_long: `The description is longer than ${DESCRIPTION_MAX_CHARS} characters.`,
  kill_switch: "The kill switch is on: nothing was read, created or recorded.",
  settings_unreadable:
    "The platform settings file on main could not be read through GitHub (the runner App's read token was refused or is not available yet): nothing was created or recorded.",
  not_in_settings:
    "The slug is not listed in projects in infra/kubernetes/settings/production.json on main. Add it with its quota in a pull request, merge it and approve the platform apply first: nothing was created or recorded.",
  creation_token_refused:
    "The repository creation token was not minted (GitHub refused it, or the runner App is not registered yet): nothing was created or recorded.",
  create_refused:
    "GitHub refused or failed the repository's creation from didi-build/launchpad: nothing was recorded. If it was created after all, running the form again reuses it.",
  existing_unreadable:
    "GitHub did not create the repository, and no existing repository with this name could be read: nothing was recorded.",
  existing_not_from_template:
    "A repository with this name already exists and GitHub does not show it as generated from didi-build/launchpad, so it is not reused: nothing was recorded.",
  existing_not_public:
    "A repository with this name already exists and is not public, so it is not reused: nothing was recorded.",
  existing_other_name:
    "GitHub's answer names a repository other than didi-build/<slug> exactly, so it is not reused: nothing was recorded.",
  created_unexpected:
    "GitHub answered that it created the repository, but its answer does not show a public repository named didi-build/<slug>: nothing was recorded. Check the repository on GitHub before running the form again.",
  switch_turned_on:
    "The kill switch or dry run was turned on while the repository was being created: the project was not recorded. Run the form again once both are off; it reuses the repository.",
  grant_token_refused:
    "The project is recorded, but the token to give its repository access to BOOTSTRAP_TOKEN was not minted (GitHub refused it, or the runner App is not registered yet): nothing was granted and Bootstrap was not started. Run the form again: it picks up where it stopped.",
  secret_not_selected:
    "The project is recorded, but GitHub answered that BOOTSTRAP_TOKEN is not shared with selected repositories only, so nothing was granted and Bootstrap was not started. Set the secret's repository access to selected repositories (first-hosting runbook, step 13), then run the form again: it picks up where it stopped.",
  grant_refused:
    "The project is recorded, but GitHub refused or failed adding its repository to BOOTSTRAP_TOKEN's selected repositories: Bootstrap was not started. Run the form again: it picks up where it stopped.",
  restart_token_refused:
    "The project is recorded and its repository has access to BOOTSTRAP_TOKEN, but the token to start Bootstrap was not minted (GitHub refused it, or the runner App is not registered yet): Bootstrap was not started. Run the form again: it picks up where it stopped. The reconcile pass removes the access once the project is an hour old.",
  restart_refused:
    "The project is recorded and its repository has access to BOOTSTRAP_TOKEN, but GitHub refused or failed starting Bootstrap on main. Run the form again: it picks up where it stopped. The reconcile pass removes the access once the project is an hour old.",
  setup_unreadable:
    "The project is already recorded, but Bootstrap's runs on its repository could not be read (the runner App's read token was refused or is not available yet): nothing was granted or started. Run the form again: it picks up where it stopped.",
  bootstrap_running:
    "The project is already recorded and Bootstrap is running on its repository now: nothing was granted or started. When the run ends Foreman removes the access; if it failed, the daily check says so, and running the form again picks up where it stopped.",
  registered_repository_unchecked:
    "The project is already recorded, but GitHub does not show its repository as public and generated from didi-build/launchpad under exactly didi-build/<slug>, or it could not be read: nothing was granted or started.",
} as const;

export type RegisterRefusal = keyof typeof REGISTER_REFUSALS;

export type RegisterProjectResult =
  | {
      outcome: "registered";
      /** Whether this run created the repository or reused one an earlier run created. */
      repository: "created" | "reused";
      project: Project;
      /** The repository was given access to `BOOTSTRAP_TOKEN` and Bootstrap was started again. */
      setup: "started";
    }
  /**
   * The project was recorded already and its setup had not finished: the repository was given
   * access again and Bootstrap was started again.
   */
  | { outcome: "setup_restarted"; slug: string; repo: string }
  /** The project's setup finished well, or another run of the form recorded it at the same time. */
  | { outcome: "already_registered"; slug: string; repo: string }
  | {
      outcome: "dry_run";
      message: string;
      /** Null for a project already recorded: nothing would be created. */
      wouldCreate: {
        repository: string;
        template: string;
        description: string;
        private: false;
      } | null;
      /** Null for a project already recorded: nothing would be recorded. */
      wouldRecord: PlannedProject | null;
      wouldGrant: { secret: string; repository: string };
      wouldRestart: { repository: string; workflow: string; ref: string };
    }
  | { outcome: "refused"; reason: RegisterRefusal; message: string };

const refused = (reason: RegisterRefusal): RegisterProjectResult => ({
  outcome: "refused",
  reason,
  message: REGISTER_REFUSALS[reason],
});

/** A line or paragraph break anywhere in the text (after trimming, so inside it). */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/;
/** Control, format, surrogate, private-use and unassigned characters (Unicode category C). */
const CONTROL_OR_FORMAT = /\p{C}/u;

/** The description as the form sends it, or why it is refused. */
export function checkDescription(
  description: unknown,
): { ok: true; text: string } | { ok: false; reason: RegisterRefusal } {
  if (typeof description !== "string") return { ok: false, reason: "no_description" };
  const text = description.trim();
  if (text === "") return { ok: false, reason: "no_description" };
  if (LINE_BREAK.test(text)) return { ok: false, reason: "description_not_one_line" };
  if (CONTROL_OR_FORMAT.test(text))
    return { ok: false, reason: "description_has_control_characters" };
  if (text.length > DESCRIPTION_MAX_CHARS)
    return { ok: false, reason: "description_too_long" };
  return { ok: true, text };
}

/** The row every project starts with (D-345): only the slug differs between projects. */
export function plannedProject(slug: string): PlannedProject {
  return {
    slug,
    name: slug,
    repo: projectRepository(slug),
    linearProjectId: null,
    galleryPathOverride: null,
    // Launchpad starts every project alike, so the shared list covers them all (D-345).
    privilegedPathsExtra: [],
    // A project starts with no production; production later needs Didi's approval (D-345, D-007).
    prodRequiresApproval: true,
    stagingUrl: projectStagingUrl(slug),
  };
}

/** Why an existing repository is not reused, or null when it is the one an earlier run made. */
function reuseRefusal(slug: string, facts: RepositoryFacts): RegisterRefusal | null {
  if (facts.fullName !== projectRepository(slug)) return "existing_other_name";
  if (facts.templateFullName !== PROJECT_TEMPLATE) return "existing_not_from_template";
  if (facts.private || (facts.visibility !== null && facts.visibility !== "public"))
    return "existing_not_public";
  return null;
}

/** Whether GitHub's answer to a create shows the public repository asked for. */
const createdAsAsked = (slug: string, facts: RepositoryFacts | null): boolean =>
  facts !== null &&
  facts.fullName === projectRepository(slug) &&
  !facts.private &&
  (facts.visibility === null || facts.visibility === "public");

/** What dry run says the setup step would do for `didi-build/<slug>`. */
const wouldSetUp = (slug: string) => ({
  wouldGrant: { secret: BOOTSTRAP_SECRET, repository: projectRepository(slug) },
  wouldRestart: {
    repository: projectRepository(slug),
    workflow: BOOTSTRAP_WORKFLOW_PATH,
    ref: BOOTSTRAP_REF,
  },
});

export function createProjectRegistration(deps: RegisterProjectDeps) {
  const { store, clock, ids, projectSettings, projectRepositories } = deps;

  /** Step 7: the grant, then the restart. Null once both are done. */
  async function setUp(slug: string): Promise<RegisterProjectResult | null> {
    const setup = await startSetup(deps, slug);
    return setup.started ? null : refused(setup.reason);
  }

  /** The form run again on a project already recorded: setup again unless it finished well. */
  async function resume(
    project: Project,
    dryRun: boolean,
  ): Promise<RegisterProjectResult> {
    const { slug } = project;
    const repo = projectRepository(slug);
    let state: SetupState;
    try {
      state = setupStateOf(await deps.bootstrapRuns.latestRestart(slug));
    } catch {
      return refused("setup_unreadable");
    }
    if (state === "succeeded") return { outcome: "already_registered", slug, repo };
    if (state === "running") return refused("bootstrap_running");
    if (dryRun) {
      return {
        outcome: "dry_run",
        message:
          "Dry run is on: nothing was granted or started. The project is recorded and its setup has not finished, so with dry run off the form would add the repository to BOOTSTRAP_TOKEN's selected repositories and start Bootstrap again on main.",
        wouldCreate: null,
        wouldRecord: null,
        ...wouldSetUp(slug),
      };
    }
    // The access goes only to a repository the form would reuse (step 5's checks).
    let facts: RepositoryFacts | null = null;
    try {
      facts = project.repo === repo ? await projectRepositories.read(slug) : null;
    } catch {
      facts = null;
    }
    if (facts === null || reuseRefusal(slug, facts) !== null)
      return refused("registered_repository_unchecked");
    return (await setUp(slug)) ?? { outcome: "setup_restarted", slug, repo };
  }

  /** Step 5: the repository, created now or reused from an earlier run. */
  async function repository(
    slug: string,
    description: string,
  ): Promise<{ how: "created" | "reused" } | { refusal: RegisterRefusal }> {
    let attempt: TemplateGenerate;
    try {
      attempt = await projectRepositories.generate({ name: slug, description });
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
        ? { how: "created" }
        : { refusal: "created_unexpected" };
    }
    let facts: RepositoryFacts | null;
    try {
      facts = await projectRepositories.read(slug);
    } catch {
      return { refusal: "existing_unreadable" };
    }
    if (facts === null) return { refusal: "existing_unreadable" };
    const refusal = reuseRefusal(slug, facts);
    return refusal === null ? { how: "reused" } : { refusal };
  }

  /** Step 6: the row, in one transaction that reads both switches again. */
  async function record(
    slug: string,
    how: "created" | "reused",
  ): Promise<RegisterProjectResult> {
    const already: RegisterProjectResult = {
      outcome: "already_registered",
      slug,
      repo: projectRepository(slug),
    };
    return store
      .transaction(async (tx): Promise<RegisterProjectResult> => {
        if ((await tx.getSetting("kill_switch"))?.value === true)
          return refused("switch_turned_on");
        if ((await tx.getSetting("dry_run"))?.value !== false)
          return refused("switch_turned_on");
        if (await tx.getProjectBySlug(slug)) return already;
        const project: Project = {
          id: ids.next(),
          ...plannedProject(slug),
          createdAt: clock.now(),
        };
        await tx.insertProject(project);
        return { outcome: "registered", repository: how, project, setup: "started" };
      })
      .catch((error: unknown): RegisterProjectResult => {
        // Another run inserted the same slug first (the slug is unique, migration 0001).
        if (
          error instanceof StoreConflictError &&
          error.constraint === "projects_slug_key"
        ) {
          return already;
        }
        throw error;
      });
  }

  return {
    async register(input: RegisterProjectInput): Promise<RegisterProjectResult> {
      // 1. The input.
      const slug: unknown = input?.slug;
      if (typeof slug !== "string" || !PROJECT_SLUG.test(slug))
        return refused("invalid_slug");
      const description = checkDescription(input?.description);
      if (!description.ok) return refused(description.reason);

      // 2. The switches, read the way the other Didi forms read them: the kill switch is on only
      // when set to true, and dry run is on unless set to false.
      if ((await store.getSetting("kill_switch"))?.value === true)
        return refused("kill_switch");
      const dryRun = (await store.getSetting("dry_run"))?.value !== false;

      // 3. The settings file on main.
      let listed: string[];
      try {
        listed = await projectSettings.listedSlugs();
      } catch {
        return refused("settings_unreadable");
      }
      if (!listed.includes(slug)) return refused("not_in_settings");

      // 4. Registered already: setup again unless it finished well.
      const existing = await store.getProjectBySlug(slug);
      if (existing) return resume(existing, dryRun);

      if (dryRun) {
        return {
          outcome: "dry_run",
          message:
            "Dry run is on: nothing was created, recorded, granted or started. With dry run off, the form would create the repository from didi-build/launchpad, public, with this description (or reuse it if an earlier run created it), record the project, add the repository to BOOTSTRAP_TOKEN's selected repositories and start Bootstrap again on main.",
          wouldCreate: {
            repository: projectRepository(slug),
            template: PROJECT_TEMPLATE,
            description: description.text,
            private: false,
          },
          wouldRecord: plannedProject(slug),
          ...wouldSetUp(slug),
        };
      }

      // 5. The repository, 6. the row, then 7. the setup.
      const made = await repository(slug, description.text);
      if ("refusal" in made) return refused(made.refusal);
      const recorded = await record(slug, made.how);
      if (recorded.outcome !== "registered") return recorded;
      return (await setUp(slug)) ?? recorded;
    },
  };
}

export type ProjectRegistration = ReturnType<typeof createProjectRegistration>;
