// One project's entry in the settings repository (ADR 0118 appendix A, D-377, D-442, O-157).
//
// The project list lives in `didi-build/foreman-projects`, public, with no code and no secret:
//
//   foreman-projects.json   {"schema": 1}, the marker that a checkout is this repository
//   projects/<slug>.json    one file per project
//
// The rules live here, in one place. The Platform workflow's render reads every file with them
// (infra/kubernetes/render.ts) and stops at the first bad one; the New project form will write
// with them (ADR 0118 appendix C). A file has exactly these fields: `schema` 1; `slug`, which is
// also the file's name; `displayName` and `purpose`, for people and for Bootstrap; the personal-
// data answer; the project's agent space `quota`, in full; `deployTarget`; and `createdOn`.
// Only the slug, the quota and the target reach the cluster or DNS (ADR 0118, Constraints).
//
// The standard size is not here: it is Foreman's own setting, `projectStandardQuota` in
// infra/kubernetes/settings/production.json (D-436), checked with `parseProjectQuota` below. Each
// file states its quota in full, so changing the standard later never changes an existing project.
//
// Every refusal is fixed text from `PROJECT_ENTRY_REFUSALS`: it quotes nothing from the file.
import { DESCRIPTION_MAX_CHARS, checkDescription } from "./register-project.ts";

/** The settings repository (D-442): public, so the workflows read it with no token. */
export const PROJECTS_REPOSITORY = "didi-build/foreman-projects";

/** The branch the workflows resolve to one commit per run (ADR 0118 appendix A). */
export const PROJECTS_BRANCH = "main";

/** The marker file at the repository's root, and the one text it may hold as JSON. */
export const PROJECTS_MARKER_FILE = "foreman-projects.json";

/** The folder of project files, `projects/<slug>.json`. */
export const PROJECTS_FOLDER = "projects";

/** The one format version of the marker and of a project file. */
export const PROJECTS_SCHEMA = 1;

/** The longest display name, in UTF-16 code units (ADR 0118 appendix A). */
export const DISPLAY_NAME_MAX_CHARS = 60;

/**
 * The slug rule (ADR 0118 appendix C, step 1): 1 to 47 lowercase letters, digits or hyphens,
 * starting and ending with a letter or digit, with no two hyphens together. It is the agent
 * namespace's rule (`checkSlug`, src/adapters/agent-runtime/kubernetes/names.ts), which also fits
 * the Worker name `<slug>-staging` and a DNS label, and no two hyphens keeps names clear of DNS's
 * reserved `xn--` form.
 */
export const PROJECT_ENTRY_SLUG = /^(?=[a-z0-9-]{1,47}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where a project runs its product (D-441). Every new project defaults to Cloudflare. */
export const DEPLOY_TARGETS = ["cloudflare", "cluster"] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/**
 * A project's agent space quota (ADR 0106 section 4), the shape of `AgentQuota` in
 * src/adapters/agent-runtime/kubernetes/namespace.ts.
 */
export interface ProjectQuota {
  pods: number;
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  storage: string;
  persistentVolumeClaims: number;
}

export interface ProjectEntry {
  schema: typeof PROJECTS_SCHEMA;
  slug: string;
  displayName: string;
  purpose: string;
  collectsPersonalData: boolean;
  quota: ProjectQuota;
  deployTarget: DeployTarget;
  /** The day the project was created, `YYYY-MM-DD`. */
  createdOn: string;
}

const ENTRY_FIELDS = [
  "schema",
  "slug",
  "displayName",
  "purpose",
  "collectsPersonalData",
  "quota",
  "deployTarget",
  "createdOn",
] as const;

const QUOTA_FIELDS = [
  "pods",
  "cpu",
  "memory",
  "ephemeralStorage",
  "storage",
  "persistentVolumeClaims",
] as const;

/** A whole quantity with an optional unit, such as `6`, `500m` or `5Gi`. No sign, no fraction. */
const QUANTITY = /^(0|[1-9][0-9]{0,8})(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;

/** Every refusal, with its fixed text. */
export const PROJECT_ENTRY_REFUSALS = {
  marker_invalid: `The marker ${PROJECTS_MARKER_FILE} must be exactly {"schema": ${PROJECTS_SCHEMA}}.`,
  not_json: "The project file is not JSON.",
  not_an_object: "The project file is not one JSON object.",
  fields: `The project file must have exactly the fields ${ENTRY_FIELDS.join(", ")}.`,
  schema: `schema must be ${PROJECTS_SCHEMA}.`,
  slug: "slug must be 1 to 47 lowercase letters, digits or hyphens, start and end with a letter or digit, and have no two hyphens together.",
  file_name: "The project file's name must be its slug followed by .json.",
  display_name: `displayName must be one line of 1 to ${DISPLAY_NAME_MAX_CHARS} characters, with no control or format character and no space at either end.`,
  purpose: `purpose must be one line of 1 to ${DESCRIPTION_MAX_CHARS} characters, with no control or format character and no space at either end.`,
  personal_data: "collectsPersonalData must be true or false.",
  quota: `quota must have exactly the fields ${QUOTA_FIELDS.join(", ")}: whole numbers for pods and persistentVolumeClaims, and quantities such as 6, 500m or 5Gi for the others.`,
  deploy_target: `deployTarget must be ${DEPLOY_TARGETS.join(" or ")}.`,
  created_on: "createdOn must be a calendar date written YYYY-MM-DD.",
} as const;

export type ProjectEntryRefusal = keyof typeof PROJECT_ENTRY_REFUSALS;

export type ProjectEntryResult =
  | { ok: true; entry: ProjectEntry }
  | { ok: false; reason: ProjectEntryRefusal; message: string };

const refused = (reason: ProjectEntryRefusal): ProjectEntryResult => ({
  ok: false,
  reason,
  message: PROJECT_ENTRY_REFUSALS[reason],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether the object has exactly these keys, no more and no fewer. */
const hasExactly = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isQuantity = (value: unknown): value is string =>
  typeof value === "string" && QUANTITY.test(value);

/** A quota in full, or null when any field is missing, extra or not of its kind. */
export function parseProjectQuota(value: unknown): ProjectQuota | null {
  if (!isObject(value) || !hasExactly(value, QUOTA_FIELDS)) return null;
  const { pods, cpu, memory, ephemeralStorage, storage, persistentVolumeClaims } =
    value;
  if (!isCount(pods) || !isCount(persistentVolumeClaims)) return null;
  if (
    !isQuantity(cpu) ||
    !isQuantity(memory) ||
    !isQuantity(ephemeralStorage) ||
    !isQuantity(storage)
  )
    return null;
  return { pods, cpu, memory, ephemeralStorage, storage, persistentVolumeClaims };
}

/** One line, already trimmed, that the description rule accepts, at most `max` long. */
const isOneLine = (value: unknown, max: number): value is string => {
  if (typeof value !== "string") return false;
  const checked = checkDescription(value);
  return checked.ok && checked.text === value && value.length <= max;
};

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** A real calendar date written `YYYY-MM-DD`, years 2000 to 2999. */
const isDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = /^(2[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
};

const isDeployTarget = (value: unknown): value is DeployTarget =>
  (DEPLOY_TARGETS as readonly unknown[]).includes(value);

/** Whether a slug follows the entry's slug rule. */
export const isProjectEntrySlug = (slug: unknown): slug is string =>
  typeof slug === "string" && PROJECT_ENTRY_SLUG.test(slug);

/** `projects/<slug>.json`'s file name for a slug. */
export const projectFileName = (slug: string): string => `${slug}.json`;

/**
 * One project file, read strictly: `fileName` is its name inside `projects/` and `text` its
 * contents. The first rule it breaks is the refusal.
 */
export function parseProjectEntry(fileName: string, text: string): ProjectEntryResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refused("not_json");
  }
  if (!isObject(value)) return refused("not_an_object");
  if (!hasExactly(value, ENTRY_FIELDS)) return refused("fields");
  if (value.schema !== PROJECTS_SCHEMA) return refused("schema");
  if (!isProjectEntrySlug(value.slug)) return refused("slug");
  if (fileName !== projectFileName(value.slug)) return refused("file_name");
  if (!isOneLine(value.displayName, DISPLAY_NAME_MAX_CHARS))
    return refused("display_name");
  if (!isOneLine(value.purpose, DESCRIPTION_MAX_CHARS)) return refused("purpose");
  if (typeof value.collectsPersonalData !== "boolean") return refused("personal_data");
  const quota = parseProjectQuota(value.quota);
  if (quota === null) return refused("quota");
  if (!isDeployTarget(value.deployTarget)) return refused("deploy_target");
  if (!isDate(value.createdOn)) return refused("created_on");
  return {
    ok: true,
    entry: {
      schema: PROJECTS_SCHEMA,
      slug: value.slug,
      displayName: value.displayName,
      purpose: value.purpose,
      collectsPersonalData: value.collectsPersonalData,
      quota,
      deployTarget: value.deployTarget,
      createdOn: value.createdOn,
    },
  };
}

/** Whether the marker's text is the marker: one JSON object, exactly `{"schema": 1}`. */
export function isProjectsMarker(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    isObject(value) && hasExactly(value, ["schema"]) && value.schema === PROJECTS_SCHEMA
  );
}
