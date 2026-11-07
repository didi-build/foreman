// Didi's register-project form (D-345, D-346, D-348, O-109). The called flow
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
//
// Every refusal is fixed text from `REGISTER_REFUSALS`: it quotes no input, no token and no
// answer from GitHub. Nothing here logs.
import type { Clock, IdSource } from "./library.ts";
import { StoreConflictError, type Project, type Store } from "./store.ts";

/**
 * The project-slug rule: the state API's planning reads (src/api/routes.ts) and the tunnel's path
 * for them (infra/kubernetes/platform.ts, `STATE_API_PUBLIC.tunnelPath`) use the same pattern.
 */
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The GitHub organization that owns every project repository (D-345). */
export const PROJECT_OWNER = "didi-build";

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
} as const;

export type RegisterRefusal = keyof typeof REGISTER_REFUSALS;

export type RegisterProjectResult =
  | {
      outcome: "registered";
      /** Whether this run created the repository or reused one an earlier run created. */
      repository: "created" | "reused";
      project: Project;
    }
  | { outcome: "already_registered"; slug: string; repo: string }
  | {
      outcome: "dry_run";
      message: string;
      wouldCreate: {
        repository: string;
        template: string;
        description: string;
        private: false;
      };
      wouldRecord: PlannedProject;
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

export function createProjectRegistration(deps: RegisterProjectDeps) {
  const { store, clock, ids, projectSettings, projectRepositories } = deps;

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
        return { outcome: "registered", repository: how, project };
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

      // 4. Registered already.
      if (await store.getProjectBySlug(slug)) {
        return { outcome: "already_registered", slug, repo: projectRepository(slug) };
      }

      if (dryRun) {
        return {
          outcome: "dry_run",
          message:
            "Dry run is on: nothing was created or recorded. With dry run off, the form would create the repository from didi-build/launchpad, public, with this description (or reuse it if an earlier run created it), then record the project.",
          wouldCreate: {
            repository: projectRepository(slug),
            template: PROJECT_TEMPLATE,
            description: description.text,
            private: false,
          },
          wouldRecord: plannedProject(slug),
        };
      }

      // 5. The repository, then 6. the row.
      const made = await repository(slug, description.text);
      if ("refusal" in made) return refused(made.refusal);
      return record(slug, made.how);
    },
  };
}

export type ProjectRegistration = ReturnType<typeof createProjectRegistration>;
