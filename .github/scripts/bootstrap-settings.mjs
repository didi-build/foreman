// Applies and verifies the recommended repository settings through GitHub's REST API with Node's
// built-in fetch (D-358 lock 1, O-113): the Dependabot auto-merge label, auto-merge, delete head
// branches, squash-only merges, then branch protection last, so a protected default branch means
// the settings were applied (the decide step reads it). Bootstrap's token job runs it with the
// token in GH_TOKEN; `npm run repo-settings` runs it by hand (the manual fallback). Node built-ins
// only (`node .github/scripts/check-bootstrap-isolation.mjs`).
import {
  appendStepSummary,
  githubMessage,
  githubRequest,
  isMain,
  parseBranch,
  parseRepository,
  resolveApiUrl,
  tokenFromEnv,
} from "./bootstrap-common.mjs";

/** @typedef {{ strict: boolean; checks: { context: string }[] }} RequiredStatusChecks */
/** @typedef {{ required_status_checks: RequiredStatusChecks; enforce_admins: boolean; required_pull_request_reviews: { required_approving_review_count: number }; restrictions: null; allow_force_pushes: boolean; allow_deletions: boolean }} BranchProtection */
/** @typedef {{ allow_auto_merge: boolean; delete_branch_on_merge: boolean; allow_squash_merge: boolean; allow_merge_commit: boolean; allow_rebase_merge: boolean }} RepositorySettings */
/** @typedef {import("./bootstrap-common.mjs").GithubClient} GithubClient */

export const defaultBranch = "main";

export const dependabotAutomergeLabel = "launchpad-dependabot-automerge";
export const dependabotAutomergeLabelColor = "1D76DB";
export const dependabotAutomergeLabelDescription =
  "Dependabot minor/patch PR eligible for auto-merge when CI is green";

/** @returns {BranchProtection} */
export function targetBranchProtection() {
  return {
    required_status_checks: {
      strict: false,
      checks: [{ context: "check" }],
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

/** @returns {RepositorySettings} */
export function targetRepositorySettings() {
  return {
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  };
}

/**
 * @param {unknown} actual
 * @param {boolean} expected
 */
function flagMatches(actual, expected) {
  if (typeof actual === "boolean") return actual === expected;
  if (actual && typeof actual === "object" && "enabled" in actual) {
    return actual.enabled === expected;
  }
  return false;
}

/**
 * @param {any} actual GitHub's branch protection answer
 * @param {BranchProtection} expected
 * @returns {boolean}
 */
export function protectionMatches(actual, expected) {
  if (!actual) return false;
  /** @type {{ context: string }[]} */
  const checks = actual.required_status_checks?.checks ?? [];
  const contexts = checks.map((c) => c.context).sort();
  const expectedContexts = expected.required_status_checks.checks
    .map((c) => c.context)
    .sort();
  const reviewsOk =
    actual.required_pull_request_reviews?.required_approving_review_count ===
    expected.required_pull_request_reviews.required_approving_review_count;
  return (
    actual.required_status_checks?.strict === expected.required_status_checks.strict &&
    JSON.stringify(contexts) === JSON.stringify(expectedContexts) &&
    reviewsOk &&
    flagMatches(actual.enforce_admins, expected.enforce_admins) &&
    flagMatches(actual.allow_force_pushes, expected.allow_force_pushes) &&
    flagMatches(actual.allow_deletions, expected.allow_deletions)
  );
}

/**
 * @param {any} actual GitHub's repository answer
 * @param {RepositorySettings} expected
 * @returns {boolean}
 */
export function repositorySettingsMatch(actual, expected) {
  return (
    actual?.allow_auto_merge === expected.allow_auto_merge &&
    actual?.delete_branch_on_merge === expected.delete_branch_on_merge &&
    actual?.allow_squash_merge === expected.allow_squash_merge &&
    actual?.allow_merge_commit === expected.allow_merge_commit &&
    actual?.allow_rebase_merge === expected.allow_rebase_merge
  );
}

/**
 * @param {number} status
 * @returns {string}
 */
export function branchProtectionReadFailureReason(status) {
  if (status === 404) {
    return "no branch protection configured (HTTP 404)";
  }
  if (status === 403) {
    return "could not read branch protection (HTTP 403: auth, plan, or token scope)";
  }
  if (status === 0) {
    return "could not read branch protection (no answer)";
  }
  return `could not read branch protection (HTTP ${status})`;
}

/** A refused request, named by method, path and status (never a header or the token). */
export class GithubRequestError extends Error {
  /**
   * @param {string} method
   * @param {string} path
   * @param {number} status
   * @param {unknown} json
   */
  constructor(method, path, status, json) {
    const message = githubMessage(json);
    super(
      `${method} ${path} failed (${status === 0 ? "no answer" : `HTTP ${status}`})${message ? `: ${message}` : ""}`,
    );
    this.status = status;
  }
}

/**
 * @param {GithubClient} client
 * @param {string} method
 * @param {string} path
 * @param {number[]} accepted
 * @param {unknown} [body]
 */
async function expectStatus(client, method, path, accepted, body) {
  const answer = await githubRequest(client, method, path, body);
  if (!accepted.includes(answer.status)) {
    throw new GithubRequestError(method, path, answer.status, answer.json);
  }
  return answer;
}

/**
 * Creates the Dependabot auto-merge label when it is missing.
 *
 * @param {GithubClient} client
 * @param {string} repo
 * @returns {Promise<"exists" | "created">}
 */
export async function ensureDependabotLabel(client, repo) {
  const path = `/repos/${repo}/labels/${encodeURIComponent(dependabotAutomergeLabel)}`;
  const read = await expectStatus(client, "GET", path, [200, 404]);
  if (read.status === 200) {
    return "exists";
  }
  await expectStatus(client, "POST", `/repos/${repo}/labels`, [201], {
    name: dependabotAutomergeLabel,
    color: dependabotAutomergeLabelColor,
    description: dependabotAutomergeLabelDescription,
  });
  return "created";
}

/**
 * The requests `--apply` sends, in order. Branch protection goes last.
 *
 * @param {string} repo
 * @param {string} branch
 */
export function settingsRequests(repo, branch) {
  return [
    { method: "PATCH", path: `/repos/${repo}`, body: targetRepositorySettings() },
    {
      method: "PUT",
      path: `/repos/${repo}/branches/${branch}/protection`,
      body: targetBranchProtection(),
    },
  ];
}

/**
 * @param {GithubClient} client
 * @param {string} repo
 * @param {string} branch
 * @param {(line: string) => void} log
 */
export async function applySettings(client, repo, branch, log) {
  const label = await ensureDependabotLabel(client, repo);
  log(
    label === "created"
      ? `Created the ${dependabotAutomergeLabel} label.`
      : `The ${dependabotAutomergeLabel} label exists.`,
  );
  const [repoSettings, protection] = settingsRequests(repo, branch);
  await expectStatus(
    client,
    repoSettings.method,
    repoSettings.path,
    [200],
    repoSettings.body,
  );
  log(
    "Repository settings updated (auto-merge, delete head branches, squash-only merges).",
  );
  await expectStatus(
    client,
    protection.method,
    protection.path,
    [200],
    protection.body,
  );
  log("Branch protection updated.");
}

/**
 * @param {GithubClient} client
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<{ ok: boolean; lines: string[] }>}
 */
export async function verifySettings(client, repo, branch) {
  const lines = [];
  let ok = true;
  const protection = targetBranchProtection();
  const repoSettings = targetRepositorySettings();

  const protectionRead = await githubRequest(
    client,
    "GET",
    `/repos/${repo}/branches/${branch}/protection`,
  );
  if (protectionRead.status !== 200) {
    ok = false;
    lines.push(
      `FAIL Branch protection: ${branchProtectionReadFailureReason(protectionRead.status)}`,
    );
  } else if (!protectionMatches(protectionRead.json, protection)) {
    ok = false;
    lines.push("FAIL Branch protection does not match Launchpad defaults.");
    lines.push(`Expected: ${JSON.stringify(protection, null, 2)}`);
    lines.push(`Actual: ${JSON.stringify(protectionRead.json, null, 2)}`);
  } else {
    lines.push(
      "OK Branch protection matches (PR required, check job, zero approvals).",
    );
  }

  const repoRead = await githubRequest(client, "GET", `/repos/${repo}`);
  /** @type {Record<string, unknown>} */
  const actual = {};
  if (repoRead.json && typeof repoRead.json === "object") {
    for (const key of Object.keys(repoSettings)) {
      actual[key] = /** @type {Record<string, unknown>} */ (repoRead.json)[key];
    }
  }
  if (repoRead.status !== 200) {
    ok = false;
    lines.push(
      `FAIL Repository settings: could not read the repository (${repoRead.status === 0 ? "no answer" : `HTTP ${repoRead.status}`}).`,
    );
  } else if (!repositorySettingsMatch(actual, repoSettings)) {
    ok = false;
    lines.push("FAIL Repository merge settings do not match Launchpad defaults.");
    lines.push(`Expected: ${JSON.stringify(repoSettings, null, 2)}`);
    lines.push(`Actual: ${JSON.stringify(actual, null, 2)}`);
  } else {
    lines.push(
      "OK Repository settings match (auto-merge, delete head branches, squash-only merges).",
    );
  }
  return { ok, lines };
}

/**
 * What `--apply` would send, as `gh api` commands a person can run by hand.
 *
 * @param {string} repo
 * @param {string} branch
 * @returns {string}
 */
export function dryRunText(repo, branch) {
  const out = ["Dry run: pass --apply to execute or --verify to check:", ""];
  out.push(
    `# The ${dependabotAutomergeLabel} label is created first when it is missing (POST repos/${repo}/labels).`,
    "",
  );
  for (const { method, path, body } of settingsRequests(repo, branch)) {
    const endpoint = path.slice(1);
    out.push(`# ${method} ${endpoint}`);
    out.push(`cat <<'LAUNCHPAD_JSON' | gh api -X ${method} ${endpoint} --input -`);
    out.push(JSON.stringify(body, null, 2));
    out.push("LAUNCHPAD_JSON", "");
  }
  return out.join("\n");
}

/**
 * The CLI. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<number>}
 */
export async function runSettings(argv, env, fetchImpl) {
  const apply = argv.includes("--apply");
  const verify = argv.includes("--verify");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const repo = parseRepository(env.GITHUB_REPOSITORY);
  const branch = parseBranch(positional[0] ?? defaultBranch);
  if (!repo) {
    console.error("Set GITHUB_REPOSITORY to the repository, as <owner>/<repo>.");
    return 1;
  }
  if (!branch) {
    console.error("The branch name is not valid.");
    return 1;
  }
  console.log(`Repository: ${repo}`);
  console.log(`Branch: ${branch}\n`);

  if (!apply && !verify) {
    console.log(dryRunText(repo, branch));
    return 0;
  }

  const token = tokenFromEnv(env);
  if (!token) {
    appendStepSummary(env, ["- Settings refused: the token is malformed."]);
    return 1;
  }
  const apiUrl = resolveApiUrl(env);
  if (!apiUrl) {
    console.error("GITHUB_API_URL must be an https URL.");
    return 1;
  }
  const client = { fetch: fetchImpl, apiUrl, token };

  if (apply) {
    try {
      await applySettings(client, repo, branch, (line) => console.log(line));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`::error title=Repository settings::${message}`);
      appendStepSummary(env, [`- Applying the repository settings failed: ${message}`]);
      return 1;
    }
    appendStepSummary(env, ["- Applied the repository settings."]);
  }

  if (verify) {
    const result = await verifySettings(client, repo, branch);
    for (const line of result.lines) {
      (result.ok ? console.log : console.error)(line);
    }
    appendStepSummary(env, [`- Settings verify: ${result.ok ? "passed" : "failed"}.`]);
    return result.ok ? 0 : 1;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await runSettings(
    process.argv.slice(2),
    process.env,
    globalThis.fetch,
  );
}
