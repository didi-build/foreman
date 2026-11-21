// The build's deploy manifest, `foreman-deploy.json` (ADR 0118 appendix E item 7, O-159): what a
// project's CI copies from its `wrangler.jsonc` and its committed list of required secrets into
// the root of the `staging-site` build. Plain code with no network. The runner takes nothing else
// from the build's configuration: no binding, no route, no name and no asset config (appendix G).
//
// The format, exactly these fields (the project file's style, ADR 0118 appendix A):
//
//   {"schema": 1, "compatibilityDate": "2026-10-26", "compatibilityFlags": ["nodejs_compat"],
//    "requiredSecrets": ["MODEL_API_KEY"]}
//
// - `compatibilityDate`: a real date written `YYYY-MM-DD`, not before 2025-04-01. From that date
//   on, a browser's navigation that matches no asset is served the site's `index.html` and does
//   not invoke the Worker (Cloudflare's "Single Page Application (SPA)" page, read 2026-11-21), so
//   pages stay free asset requests and code runs for `/api` (`run_worker_first`, D-439).
//   Cloudflare refuses a date in the future itself.
// - `compatibilityFlags`: an allow-list, `nodejs_compat` only (D-439: "only part of Node's APIs"),
//   each at most once. Any other flag, for example `assets_navigation_has_no_effect`, which lets
//   navigations reach the Worker, is refused; allowing one more is a Foreman change.
// - `requiredSecrets`: the names of the product secrets the Worker needs (D-440, D-448), never a
//   value: at most 64 distinct names, each 1 to 64 uppercase letters, digits or underscores
//   starting with a letter, and not a binding Foreman sets (`DB`, `ASSETS`), as the Set project
//   secret form's names (appendix D). Carried in the deploy's result for slice 7, which holds a
//   deploy while one is missing; nothing is enforced yet.
// The file is at most 16 KiB. Every refusal is fixed text that quotes nothing from the file.

/** The manifest's name at the root of the `staging-site` build. */
export const DEPLOY_MANIFEST_FILE = "foreman-deploy.json";

/** The manifest's schema. */
export const DEPLOY_MANIFEST_SCHEMA = 1;

/** The manifest's largest size, far above what 64 names and the flags need. */
export const DEPLOY_MANIFEST_MAX_BYTES = 16 * 1024;

/** The earliest compatibility date: navigations prefer assets from it on (see the header). */
export const MIN_COMPATIBILITY_DATE = "2025-04-01";

/** The only compatibility flags a build may ask for. */
export const ALLOWED_COMPATIBILITY_FLAGS: readonly string[] = ["nodejs_compat"];

/** The most secret names a build may require (Cloudflare allows 64 variables per Worker on Free). */
export const MAX_REQUIRED_SECRETS = 64;

/** A secret's name, as the Set project secret form takes it (ADR 0118 appendix D, step 2). */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The bindings Foreman sets, which no secret may shadow. */
export const RESERVED_BINDING_NAMES: readonly string[] = ["DB", "ASSETS"];

/** A product secret's name: the rule above, and not a binding Foreman sets (also O-160's calls). */
export const isProductSecretName = (name: unknown): name is string =>
  typeof name === "string" &&
  SECRET_NAME.test(name) &&
  !RESERVED_BINDING_NAMES.includes(name);

const FIELDS = ["schema", "compatibilityDate", "compatibilityFlags", "requiredSecrets"];

/** The fixed text of each refusal. None quotes the file. */
export const MANIFEST_REFUSALS = {
  manifest_too_large: `the staging-site build's ${DEPLOY_MANIFEST_FILE} is larger than 16 KiB`,
  manifest_malformed: `the staging-site build's ${DEPLOY_MANIFEST_FILE} is not a JSON object with exactly schema 1, compatibilityDate, compatibilityFlags and requiredSecrets`,
  manifest_date: `the staging-site build's ${DEPLOY_MANIFEST_FILE} gives a compatibilityDate that is not a real YYYY-MM-DD date from ${MIN_COMPATIBILITY_DATE} on`,
  manifest_flags: `the staging-site build's ${DEPLOY_MANIFEST_FILE} asks for a compatibility flag Foreman does not allow, or one twice`,
  manifest_secrets: `the staging-site build's ${DEPLOY_MANIFEST_FILE} lists requiredSecrets that are not at most 64 distinct secret names other than DB and ASSETS`,
} as const;

export type ManifestRefusal = keyof typeof MANIFEST_REFUSALS;

/** What the runner takes from the manifest. */
export interface DeployManifest {
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** Names only, never a value (D-440). */
  requiredSecrets: string[];
}

export type DeployManifestResult =
  { ok: true; manifest: DeployManifest } | { ok: false; reason: ManifestRefusal };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** A real calendar date written `YYYY-MM-DD`, from the earliest allowed date on. */
function isAllowedDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= MIN_COMPATIBILITY_DATE
  );
}

/** The manifest's fields, or the refusal of the file. */
export function parseDeployManifest(bytes: Uint8Array): DeployManifestResult {
  if (bytes.length > DEPLOY_MANIFEST_MAX_BYTES) {
    return { ok: false, reason: "manifest_too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "manifest_malformed" };
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== FIELDS.length ||
    !FIELDS.every((f) => Object.hasOwn(value, f)) ||
    value.schema !== DEPLOY_MANIFEST_SCHEMA
  ) {
    return { ok: false, reason: "manifest_malformed" };
  }
  const { compatibilityDate, compatibilityFlags, requiredSecrets } = value;
  if (!isAllowedDate(compatibilityDate)) return { ok: false, reason: "manifest_date" };
  if (
    !isStringList(compatibilityFlags) ||
    new Set(compatibilityFlags).size !== compatibilityFlags.length ||
    !compatibilityFlags.every((f) => ALLOWED_COMPATIBILITY_FLAGS.includes(f))
  ) {
    return { ok: false, reason: "manifest_flags" };
  }
  if (
    !isStringList(requiredSecrets) ||
    requiredSecrets.length > MAX_REQUIRED_SECRETS ||
    new Set(requiredSecrets).size !== requiredSecrets.length ||
    !requiredSecrets.every(isProductSecretName)
  ) {
    return { ok: false, reason: "manifest_secrets" };
  }
  return {
    ok: true,
    manifest: {
      compatibilityDate,
      compatibilityFlags: [...compatibilityFlags],
      requiredSecrets: [...requiredSecrets],
    },
  };
}
