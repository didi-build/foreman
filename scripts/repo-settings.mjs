import { spawnSync } from "node:child_process";
import { ensureDependabotAutomergeLabel } from "./lib/dependabot-label.mjs";
import {
  branchProtectionReadFailureReason,
  parseGhHttpStatus,
} from "./lib/gh-api-errors.mjs";
import {
  defaultBranch,
  protectionMatches,
  repositorySettingsMatch,
  targetBranchProtection,
  targetRepositorySettings,
} from "./lib/repo-settings-target.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const verify = args.includes("--verify");
const positional = args.filter((a) => !a.startsWith("--"));
const branchName = positional[0] ?? defaultBranch;

function ghJson(ghArgs) {
  const result = runGh(ghArgs);
  if (!result.ok) {
    throw new Error(formatGhFailure("gh", result));
  }
  return JSON.parse(result.stdout);
}

function runGh(ghArgs, input) {
  const result = spawnSync("gh", ghArgs, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function ghApi(method, endpoint, body) {
  const ghArgs = ["api", "-X", method, endpoint];
  if (body !== undefined) {
    ghArgs.push("--input", "-");
  }
  const result = runGh(ghArgs, body !== undefined ? JSON.stringify(body) : undefined);
  if (!result.ok) {
    throw new Error(formatGhFailure(`${method} ${endpoint}`, result));
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function formatGhFailure(label, result) {
  const detail = result.stderr || result.stdout || `exit ${result.status}`;
  return `${label} failed (${result.status}): ${detail}`;
}

function readProtection(endpoint) {
  const result = runGh(["api", "-X", "GET", endpoint]);
  if (result.ok) {
    return {
      readable: true,
      value: result.stdout ? JSON.parse(result.stdout) : null,
    };
  }
  const httpStatus = parseGhHttpStatus(result.stderr);
  return {
    readable: false,
    reason: branchProtectionReadFailureReason(httpStatus, result.stderr),
  };
}

let repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  try {
    repo = ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Could not resolve repository.");
    console.error("Set GITHUB_REPOSITORY or run with `gh` authenticated.");
    process.exit(1);
  }
}

const protection = targetBranchProtection();
const repoSettings = targetRepositorySettings();
const protectionEndpoint = `repos/${repo}/branches/${branchName}/protection`;

console.log(`Repository: ${repo}`);
console.log(`Branch: ${branchName}\n`);

function printDryRunCommand(method, endpoint, body) {
  console.log(`# ${method} ${endpoint}`);
  console.log(`cat <<'LAUNCHPAD_JSON' | gh api -X ${method} ${endpoint} --input -`);
  console.log(JSON.stringify(body, null, 2));
  console.log("LAUNCHPAD_JSON");
  console.log("");
}

function fetchActual() {
  const protectionRead = readProtection(protectionEndpoint);
  const repoActual = ghJson([
    "api",
    `repos/${repo}`,
    "--jq",
    "{allow_auto_merge: .allow_auto_merge, delete_branch_on_merge: .delete_branch_on_merge, allow_squash_merge: .allow_squash_merge, allow_merge_commit: .allow_merge_commit, allow_rebase_merge: .allow_rebase_merge}",
  ]);
  return { protectionRead, repoActual };
}

function reportVerify() {
  const { protectionRead, repoActual } = fetchActual();
  let ok = true;
  if (!protectionRead.readable) {
    ok = false;
    console.error(`❌ Branch protection: ${protectionRead.reason}`);
  } else if (!protectionMatches(protectionRead.value, protection)) {
    ok = false;
    console.error("❌ Branch protection does not match Launchpad defaults.");
    console.error("Expected:", JSON.stringify(protection, null, 2));
    console.error("Actual:", JSON.stringify(protectionRead.value, null, 2));
  } else {
    console.log(
      "✅ Branch protection matches (PR required, check job, zero approvals).",
    );
  }
  if (!repositorySettingsMatch(repoActual, repoSettings)) {
    ok = false;
    console.error("❌ Repository merge settings do not match Launchpad defaults.");
    console.error("Expected:", JSON.stringify(repoSettings, null, 2));
    console.error("Actual:", JSON.stringify(repoActual, null, 2));
  } else {
    console.log(
      "✅ Repository settings match (auto-merge, delete head branches, squash-only merges).",
    );
  }
  process.exit(ok ? 0 : 1);
}

if (verify) {
  reportVerify();
}

if (apply) {
  try {
    ensureDependabotAutomergeLabel(repo);
    ghApi("PUT", protectionEndpoint, protection);
    console.log("Branch protection updated.");
    ghApi("PATCH", `repos/${repo}`, repoSettings);
    console.log(
      "Repository settings updated (auto-merge, delete head branches, squash-only merges).",
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
} else if (!verify) {
  console.log("Dry run — pass --apply to execute or --verify to check:\n");
  printDryRunCommand("PUT", protectionEndpoint, protection);
  printDryRunCommand("PATCH", `repos/${repo}`, repoSettings);
}
