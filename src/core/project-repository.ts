// A project's repository and the names made from its slug (D-345, D-346, D-348, O-109), shared by
// the New project form (./new-project.ts, ADR 0118 appendix C, O-161), the project file's rules
// (./project-entry.ts), the state API's planning reads and the deploy adapter. The register-
// project form that first held these rules is retired (O-161); its rules for the repository are
// kept here as they were:
//
// - Every project repository is `didi-build/<slug>`, created from the `didi-build/launchpad`
//   template, always public (D-348), through the `ProjectRepositories` port. Its token is minted
//   for that one call and carries only `contents: read` and `repository_creation: write` on
//   `launchpad` (D-346).
// - When GitHub answers that it cannot create the repository (the name is taken), the existing one
//   is reused only if GitHub shows it public, generated from `didi-build/launchpad`, under exactly
//   this name: an earlier run that created it and failed before recording it (`reuseRefusal`).
// - A description (the project's purpose, which Launchpad's Bootstrap reads from the repository)
//   is trimmed, then must be non-empty, one line, free of control and invisible format
//   characters, and at most `DESCRIPTION_MAX_CHARS` long (`checkDescription`; GitHub documents no
//   limit, so the cap is conservative, O-109).
import { GITHUB_ORGANIZATION } from "./bootstrap-access.ts";

/**
 * The project-slug pattern the state API's planning reads (src/api/routes.ts) and the tunnel's
 * path for them (infra/kubernetes/platform.ts, `STATE_API_PUBLIC.tunnelPath`) use. A new project's
 * slug follows the stricter entry rule (`PROJECT_ENTRY_SLUG` in ./project-entry.ts), which this
 * pattern accepts.
 */
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The GitHub organization that owns every project repository (D-345). */
export const PROJECT_OWNER = GITHUB_ORGANIZATION;

/** The template every project repository is created from (D-345). */
export const PROJECT_TEMPLATE = "didi-build/launchpad";

/**
 * The longest description the form sends, in UTF-16 code units (JavaScript's `length`), which is
 * never fewer than the characters GitHub could count. GitHub's docs state no limit (O-109).
 */
export const DESCRIPTION_MAX_CHARS = 200;

/** `didi-build/<slug>`: the repository name equals the slug (D-345). */
export const projectRepository = (slug: string): string => `${PROJECT_OWNER}/${slug}`;

/** The project's staging address, updated on every push to main with no approval (D-345). */
export const projectStagingUrl = (slug: string): string => `https://${slug}.didi.build`;

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

/** Why a description is refused. */
export type DescriptionRefusal =
  | "no_description"
  | "description_not_one_line"
  | "description_has_control_characters"
  | "description_too_long";

/** A line or paragraph break anywhere in the text (after trimming, so inside it). */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/;
/** Control, format, surrogate, private-use and unassigned characters (Unicode category C). */
const CONTROL_OR_FORMAT = /\p{C}/u;

/** The description as the form sends it, or why it is refused. */
export function checkDescription(
  description: unknown,
): { ok: true; text: string } | { ok: false; reason: DescriptionRefusal } {
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

/** Why an existing repository is not reused. */
export type ReuseRefusal =
  "existing_other_name" | "existing_not_from_template" | "existing_not_public";

/** Why an existing repository is not reused, or null when it is the one an earlier run made. */
export function reuseRefusal(
  slug: string,
  facts: RepositoryFacts,
): ReuseRefusal | null {
  if (facts.fullName !== projectRepository(slug)) return "existing_other_name";
  if (facts.templateFullName !== PROJECT_TEMPLATE) return "existing_not_from_template";
  if (facts.private || (facts.visibility !== null && facts.visibility !== "public"))
    return "existing_not_public";
  return null;
}

/** Whether GitHub's answer to a create shows the public repository asked for. */
export const createdAsAsked = (slug: string, facts: RepositoryFacts | null): boolean =>
  facts !== null &&
  facts.fullName === projectRepository(slug) &&
  !facts.private &&
  (facts.visibility === null || facts.visibility === "public");
