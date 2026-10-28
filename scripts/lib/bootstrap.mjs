import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bootstrapCollectsPersonalData } from "./collects-personal-data.mjs";

const DEFAULT_PURPOSE =
  "Short description of what this project does — edit README and docs/architecture/overview.md.";
const DEFAULT_OWNER = "Didi Build";

export const MISSING_REPOSITORY_DESCRIPTION_MESSAGE =
  "This repository has no description. Add one (repository page, About section), then run Actions, Bootstrap, Run workflow.";

/**
 * @param {string | null | undefined} description
 * @returns {{ ok: true; purpose: string } | { ok: false; message: string }}
 */
export function resolveBootstrapRepositoryDescription(description) {
  if (
    description !== undefined &&
    description !== null &&
    String(description).trim() !== ""
  ) {
    return { ok: true, purpose: String(description).trim() };
  }
  return { ok: false, message: MISSING_REPOSITORY_DESCRIPTION_MESSAGE };
}

/**
 * @param {string | null | undefined} repositoryOwnerLogin
 * @returns {string}
 */
export function deriveProjectOwner(repositoryOwnerLogin) {
  const login = String(repositoryOwnerLogin ?? "").trim();
  if (!login) {
    return DEFAULT_OWNER;
  }
  if (login === "didi-build") {
    return "Didi Build";
  }
  return login;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function isInitialized(dir) {
  const readmeProject = join(dir, "README.project.md");
  const readmeAbsent = !statSync(readmeProject, { throwIfNoEntry: false })?.isFile();

  const pkgPath = join(dir, "package.json");
  let launchpadTemplateAbsent = true;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    launchpadTemplateAbsent = pkg.launchpadTemplate !== true;
  } catch {
    launchpadTemplateAbsent = true;
  }

  return readmeAbsent || launchpadTemplateAbsent;
}

/**
 * @param {{ initialized: boolean; event: string; runAttempt: number }} input
 * @returns {{ init: boolean; settings: boolean }}
 */
export function deriveBootstrapPlan({ initialized, event, runAttempt }) {
  if (!initialized) {
    return { init: true, settings: true };
  }
  if (event === "push" && runAttempt === 1) {
    return { init: false, settings: false };
  }
  if (event === "workflow_dispatch" || runAttempt > 1) {
    return { init: false, settings: true };
  }
  return { init: false, settings: false };
}

/**
 * @param {string} repoName
 * @returns {string}
 */
export function deriveSlug(repoName) {
  if (repoName === undefined || repoName === null || String(repoName).trim() === "") {
    return "project";
  }
  const slug = String(repoName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/**
 * @param {string} repoName
 * @returns {string}
 */
export function deriveDisplayName(repoName) {
  if (repoName === undefined || repoName === null || String(repoName).trim() === "") {
    return "Project";
  }
  const normalized = String(repoName)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "Project";
  }
  return normalized
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * @param {{
 *   repoName: string;
 *   description?: string | null;
 *   repositoryOwnerLogin?: string | null;
 *   allowDefaultPurpose?: boolean;
 * }} input
 * @returns {{ slug: string; displayName: string; purpose: string; owner: string }}
 */
export function deriveInitArgs({
  repoName,
  description,
  repositoryOwnerLogin,
  allowDefaultPurpose = true,
}) {
  const slug = deriveSlug(repoName);
  const displayName = deriveDisplayName(repoName);
  let purpose;
  if (
    description !== undefined &&
    description !== null &&
    String(description).trim() !== ""
  ) {
    purpose = String(description).trim();
  } else if (allowDefaultPurpose) {
    purpose = DEFAULT_PURPOSE;
  } else {
    throw new Error(MISSING_REPOSITORY_DESCRIPTION_MESSAGE);
  }
  const owner = deriveProjectOwner(repositoryOwnerLogin);
  return { slug, displayName, purpose, owner };
}

/**
 * @param {{ init: boolean; settings: boolean }} plan
 * @returns {boolean}
 */
export function planNeedsToken(plan) {
  return plan.init || plan.settings;
}

/**
 * Strip leading/trailing whitespace from a secret token and reject embedded control/whitespace.
 *
 * @param {string | null | undefined} raw
 * @returns {{ token: string; trimmed: boolean; valid: boolean }}
 */
export function sanitizeToken(raw) {
  const original = String(raw ?? "");
  const token = original.trim();
  const trimmed = token !== original;

  if (token === "") {
    return { token: "", trimmed, valid: false };
  }

  const hasInnerControlOrWhitespace = [...token].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || /\s/.test(ch);
  });
  return { token, trimmed, valid: !hasInnerControlOrWhitespace };
}

/**
 * @param {{ planNeedsToken: boolean; hasToken: boolean; repositoryOwner: string }} input
 * @returns {"ok" | "warn-skip" | "fail"}
 */
export function resolveTokenPolicy({
  planNeedsToken: needsToken,
  hasToken,
  repositoryOwner,
}) {
  if (!needsToken) {
    return "ok";
  }
  if (hasToken) {
    return "ok";
  }
  if (repositoryOwner === "didi-build") {
    return "fail";
  }
  return "warn-skip";
}

export const MANUAL_BOOTSTRAP_FALLBACK = [
  "Bootstrap skipped: no BOOTSTRAP_TOKEN repository secret.",
  "Manual fallback:",
  '  npm run init-project -- <slug> "<display name>" ["<purpose>"] [--personal-data | --no-personal-data]',
  "  npm run repo-settings -- --apply",
  "  npm run repo-settings -- --verify",
].join("\n");

/**
 * @param {{ plan: { init: boolean; settings: boolean }; tokenPolicy: string }} input
 * @returns {boolean}
 */
export function shouldExecuteBootstrap({ plan, tokenPolicy }) {
  if (tokenPolicy === "fail" || tokenPolicy === "warn-skip") {
    return false;
  }
  return plan.init || plan.settings;
}

/**
 * @param {{ init: boolean }} plan
 * @param {string | undefined} collectsPersonalDataEnv
 * @returns {boolean}
 */
export function shouldBootstrapRunNpmCiBeforeInit(plan, collectsPersonalDataEnv) {
  if (!plan.init) {
    return false;
  }
  return bootstrapCollectsPersonalData(collectsPersonalDataEnv);
}
