// Bootstrap's decide step (D-358 lock 1, O-113): the first step of the first job. It decides
// whether this repository still needs setting up, and nothing else in Bootstrap runs when it says
// no. Node built-ins only, and only relative files under .github/scripts/
// (`node .github/scripts/check-bootstrap-isolation.mjs` fails CI otherwise).
//
// The decision reads two kinds of fact. Today's signals, from the checkout of the default branch:
// the template's README.project.md and `"launchpadTemplate": true` in package.json. And one fact
// no bot can fake by changing a file: whether GitHub reports the default branch as protected.
// Bootstrap's settings step sets that protection last, so a protected default branch means the
// repository is already set up, and Bootstrap then does nothing.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  appendGithubOutput,
  appendStepSummary,
  envForGit,
  githubRequest,
  isMain,
  parseBranch,
  parseRepository,
  resolveApiUrl,
} from "./bootstrap-common.mjs";

const DEFAULT_OWNER = "Didi Build";

export const MISSING_REPOSITORY_DESCRIPTION_MESSAGE =
  "This repository has no description. Add one (repository page, About section), then run Actions, Bootstrap, Run workflow.";

export const INVALID_COLLECTS_PERSONAL_DATA_MESSAGE =
  "Invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA: use true/false, yes/no, or 1/0.";

export const ALREADY_SET_UP_MESSAGE =
  "The default branch is already protected, so this repository is already set up. Bootstrap does nothing.";

export const TEMPLATE_FILES_ON_PROTECTED_BRANCH_WARNING =
  "The template files (README.project.md and launchpadTemplate in package.json) are present, but the default branch is already protected. Bootstrap does nothing; set the repository up by hand if it still needs it (docs/new-project-checklist.md).";

export const MANUAL_BOOTSTRAP_FALLBACK = [
  "Bootstrap skipped: no BOOTSTRAP_TOKEN repository secret.",
  "Manual fallback:",
  '  npm run init-project -- <slug> "<display name>" ["<purpose>"] [--personal-data | --no-personal-data]',
  "  GITHUB_REPOSITORY=<owner>/<repo> GH_TOKEN=<admin token> npm run repo-settings -- --apply --verify",
].join("\n");

/**
 * @param {string | undefined} raw
 * @returns {boolean | undefined}
 */
export function parseCollectsPersonalDataEnv(raw) {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value = String(raw).trim().toLowerCase();
  if (value === "") {
    return undefined;
  }
  if (["1", "true", "yes", "y"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(value)) {
    return false;
  }
  throw new Error(INVALID_COLLECTS_PERSONAL_DATA_MESSAGE);
}

/**
 * @param {string | undefined} raw
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function validateCollectsPersonalDataEnv(raw) {
  try {
    parseCollectsPersonalDataEnv(raw);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bootstrap's default when the variable is unset: personal data collection on (D-359).
 *
 * @param {string | undefined} raw
 * @returns {boolean}
 */
export function bootstrapCollectsPersonalData(raw) {
  return parseCollectsPersonalDataEnv(raw) ?? true;
}

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
 * Today's signal: initialized unless both template markers are present.
 *
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
 * The plan from today's signals, before the protection fact is read.
 *
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
 * The init-project arguments. Init needs the repository description as the purpose.
 *
 * @param {{ repoName: string; description?: string | null; repositoryOwnerLogin?: string | null }} input
 * @returns {{ slug: string; displayName: string; purpose: string; owner: string }}
 */
export function deriveInitArgs({ repoName, description, repositoryOwnerLogin }) {
  const resolved = resolveBootstrapRepositoryDescription(description);
  if (!resolved.ok) {
    throw new Error(MISSING_REPOSITORY_DESCRIPTION_MESSAGE);
  }
  return {
    slug: deriveSlug(repoName),
    displayName: deriveDisplayName(repoName),
    purpose: resolved.purpose,
    owner: deriveProjectOwner(repositoryOwnerLogin),
  };
}

/**
 * @param {{ init: boolean; settings: boolean }} plan
 * @returns {boolean}
 */
export function planNeedsToken(plan) {
  return plan.init || plan.settings;
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
 * Whether GitHub reports the branch as protected (by branch protection or a ruleset). Read with
 * the workflow's own read-only token; no bot can change it without Administration.
 *
 * @param {import("./bootstrap-common.mjs").GithubClient} client
 * @param {string} repository
 * @param {string} branch
 * @returns {Promise<{ ok: true; protected: boolean } | { ok: false; status: number }>}
 */
export async function readBranchProtected(client, repository, branch) {
  const { status, json } = await githubRequest(
    client,
    "GET",
    `/repos/${repository}/branches/${branch}`,
  );
  if (status === 200 && json && typeof json === "object" && "protected" in json) {
    const value = /** @type {{ protected: unknown }} */ (json).protected;
    if (typeof value === "boolean") {
      return { ok: true, protected: value };
    }
  }
  return { ok: false, status };
}

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
function parseRunAttempt(raw) {
  const n = Number.parseInt(String(raw ?? "1"), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * @param {string | undefined} raw
 * @returns {boolean}
 */
function parseHasToken(raw) {
  return raw === "true" || raw === "1";
}

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} the commit the checkout holds
 */
function checkedOutCommit(cwd, env) {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd,
    encoding: "utf8",
    env: envForGit(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sha = (result.stdout ?? "").trim();
  return result.status === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
}

/**
 * @typedef {{
 *   event: string;
 *   runAttempt: number;
 *   initialized: boolean;
 *   branchProtected: boolean | null;
 *   plan: { init: boolean; settings: boolean };
 *   tokenPolicy: string;
 * }} PlanSummary
 */

/**
 * @param {PlanSummary} ctx
 * @param {string[]} notes
 * @returns {string[]}
 */
function summaryLines(ctx, notes) {
  const protectedCell =
    ctx.branchProtected === null ? "not read" : String(ctx.branchProtected);
  return [
    "## Bootstrap plan",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Event | \`${ctx.event}\` |`,
    `| Run attempt | ${ctx.runAttempt} |`,
    `| Initialized | ${ctx.initialized} |`,
    `| Default branch protected | ${protectedCell} |`,
    `| \`init\` | ${ctx.plan.init} |`,
    `| \`settings\` | ${ctx.plan.settings} |`,
    `| Token policy | \`${ctx.tokenPolicy}\` |`,
    ...(notes.length > 0 ? ["", ...notes] : []),
  ];
}

const NOTHING_TO_DO = { init: false, settings: false };

/**
 * The decide step. Returns the exit code.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<number>}
 */
export async function runPlan(env, cwd, fetchImpl) {
  const event = env.GITHUB_EVENT_NAME ?? "push";
  const runAttempt = parseRunAttempt(env.GITHUB_RUN_ATTEMPT);
  const repositoryFull = env.GITHUB_REPOSITORY ?? "";
  const slash = repositoryFull.indexOf("/");
  const owner = slash === -1 ? "" : repositoryFull.slice(0, slash);
  const repoName = slash === -1 ? repositoryFull : repositoryFull.slice(slash + 1);
  const initialized = isInitialized(cwd);
  const plan = deriveBootstrapPlan({ initialized, event, runAttempt });
  const hasToken = parseHasToken(env.HAS_BOOTSTRAP_TOKEN);
  const tokenPolicy = resolveTokenPolicy({
    planNeedsToken: planNeedsToken(plan),
    hasToken,
    repositoryOwner: owner,
  });
  /** @type {PlanSummary} */
  const ctx = {
    event,
    runAttempt,
    initialized,
    branchProtected: null,
    plan,
    tokenPolicy,
  };

  /**
   * @param {string} title
   * @param {string} message
   */
  const fail = (title, message) => {
    console.error(`::error title=${title}::${message}`);
    console.error(message);
    appendStepSummary(env, summaryLines(ctx, [`_${message}_`]));
    return 1;
  };

  /** @param {{ init: boolean; settings: boolean }} shown @param {string} policy @param {boolean} execute */
  const writeDecision = (shown, policy, execute) =>
    appendGithubOutput(env, {
      init: String(shown.init),
      settings: String(shown.settings),
      needs_token: String(planNeedsToken(shown)),
      token_policy: policy,
      execute: String(execute),
    });

  const collects = validateCollectsPersonalDataEnv(
    env.LAUNCHPAD_COLLECTS_PERSONAL_DATA,
  );
  if (!collects.ok) {
    return fail("Invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA", collects.message);
  }

  // Foreman's own pushes and every later push to an initialized repository end here, as before,
  // without a request to GitHub.
  if (!plan.init && !plan.settings) {
    writeDecision(plan, tokenPolicy, false);
    console.log("already initialized, nothing to do");
    appendStepSummary(
      env,
      summaryLines(ctx, ["_Already initialized: nothing to do on this push._"]),
    );
    return 0;
  }

  const repository = parseRepository(repositoryFull);
  const branch = parseBranch(env.DEFAULT_BRANCH);
  const apiUrl = resolveApiUrl(env);
  if (!repository || !branch || !apiUrl) {
    writeDecision(NOTHING_TO_DO, tokenPolicy, false);
    return fail(
      "Bootstrap cannot decide",
      "GITHUB_REPOSITORY, DEFAULT_BRANCH or GITHUB_API_URL is missing or not valid, so Bootstrap cannot tell whether the repository is set up. Nothing was changed.",
    );
  }
  const protection = await readBranchProtected(
    { fetch: fetchImpl, apiUrl, token: env.GITHUB_TOKEN ?? "" },
    repository,
    branch,
  );
  if (!protection.ok) {
    writeDecision(NOTHING_TO_DO, tokenPolicy, false);
    return fail(
      "Bootstrap cannot decide",
      `Could not read whether ${branch} is protected (GET /repos/${repository}/branches/${branch} answered ${protection.status === 0 ? "nothing" : `HTTP ${protection.status}`}). Nothing was changed; run Bootstrap again.`,
    );
  }
  ctx.branchProtected = protection.protected;
  if (protection.protected) {
    writeDecision(NOTHING_TO_DO, "ok", false);
    console.log(ALREADY_SET_UP_MESSAGE);
    const notes = [`_${ALREADY_SET_UP_MESSAGE}_`];
    if (!initialized) {
      console.log(
        `::warning title=Template files on a set-up repository::${TEMPLATE_FILES_ON_PROTECTED_BRANCH_WARNING}`,
      );
      notes.push(`_${TEMPLATE_FILES_ON_PROTECTED_BRANCH_WARNING}_`);
    }
    appendStepSummary(env, summaryLines(ctx, notes));
    return 0;
  }

  const execute = shouldExecuteBootstrap({ plan, tokenPolicy });
  if (tokenPolicy === "fail") {
    writeDecision(plan, tokenPolicy, false);
    console.error(
      "BOOTSTRAP_TOKEN is required for didi-build repositories but was not configured.",
    );
    appendStepSummary(env, summaryLines(ctx, ["_Skipped (token policy)._"]));
    return 1;
  }
  if (tokenPolicy === "warn-skip") {
    writeDecision(plan, tokenPolicy, false);
    console.log(
      `::warning title=Bootstrap skipped::${MANUAL_BOOTSTRAP_FALLBACK.replaceAll("\n", "%0A")}`,
    );
    console.warn(MANUAL_BOOTSTRAP_FALLBACK);
    appendStepSummary(env, summaryLines(ctx, ["_Skipped (token policy)._"]));
    return 0;
  }

  /** @type {Record<string, string>} */
  const initOutputs = {};
  if (plan.init) {
    const resolved = resolveBootstrapRepositoryDescription(
      env.LAUNCHPAD_REPO_DESCRIPTION,
    );
    if (!resolved.ok) {
      return fail(
        "Repository description required",
        MISSING_REPOSITORY_DESCRIPTION_MESSAGE,
      );
    }
    const args = deriveInitArgs({
      repoName,
      description: resolved.purpose,
      repositoryOwnerLogin: env.GITHUB_REPOSITORY_OWNER?.trim() || owner,
    });
    initOutputs.slug = args.slug;
    initOutputs.display_name = args.displayName;
    initOutputs.purpose = args.purpose;
    initOutputs.owner = args.owner;
    initOutputs.personal_data = String(
      bootstrapCollectsPersonalData(env.LAUNCHPAD_COLLECTS_PERSONAL_DATA),
    );
  }

  const sha = checkedOutCommit(cwd, env);
  if (!sha) {
    writeDecision(NOTHING_TO_DO, tokenPolicy, false);
    return fail(
      "Bootstrap cannot decide",
      "Could not read the checked-out commit of the default branch. Nothing was changed.",
    );
  }

  writeDecision(plan, tokenPolicy, execute);
  appendGithubOutput(env, { sha, ...initOutputs });
  appendStepSummary(env, summaryLines(ctx, []));
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await runPlan(process.env, process.cwd(), globalThis.fetch);
}
