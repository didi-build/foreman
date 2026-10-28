import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dependabotAutomergeLabel } from "./lib/dependabot-label.mjs";

/**
 * GitHub's `gh pr view --json author` uses logins like `app/dependabot` for bots;
 * webhook payloads and other APIs often use `dependabot[bot]`.
 *
 * @param {{ login: string; is_bot?: boolean }} author
 */
export function isDependabotAuthor({ login, is_bot }) {
  if (login === "dependabot[bot]" || login === "app/dependabot") {
    return true;
  }
  return login === "dependabot" && is_bot === true;
}

/**
 * @param {string | string[] | null | undefined} prNumbers
 * @returns {{ ok: true; number: number } | { ok: false; reason: string }}
 */
export function pickPrNumber(prNumbers) {
  const parts =
    typeof prNumbers === "string"
      ? prNumbers.trim().split(/\s+/).filter(Boolean)
      : Array.isArray(prNumbers)
        ? prNumbers.map(String).filter(Boolean)
        : [];

  if (parts.length === 0) {
    return {
      ok: false,
      reason: "No pull request associated with this workflow run; skipping.",
    };
  }
  if (parts.length > 1) {
    return {
      ok: false,
      reason: `Expected exactly one PR for this workflow run (got ${parts.length}: ${parts.join(", ")}); skipping.`,
    };
  }
  const number = Number(parts[0]);
  if (!Number.isInteger(number) || number <= 0) {
    return {
      ok: false,
      reason: `Invalid PR number "${parts[0]}"; skipping.`,
    };
  }
  return { ok: true, number };
}

/**
 * @param {{ author: { login: string; is_bot?: boolean }; headRef: string; labels: string[] }} input
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
export function isEligible({ author, headRef, labels }) {
  if (!isDependabotAuthor(author)) {
    return {
      ok: false,
      reason: `PR author is ${JSON.stringify(author)}; only Dependabot PRs auto-merge.`,
    };
  }
  if (!headRef.startsWith("dependabot/")) {
    return {
      ok: false,
      reason: `Head ref ${headRef} is not a dependabot/* branch; skipping.`,
    };
  }
  if (!labels.includes(dependabotAutomergeLabel)) {
    return {
      ok: false,
      reason: `Not qualified for auto-merge (missing ${dependabotAutomergeLabel} label).`,
    };
  }
  return { ok: true };
}

/**
 * @param {string} rawJsonString `gh pr view --json author,headRefName,labels` output
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
export function evaluatePrJson(rawJsonString) {
  const pr = JSON.parse(rawJsonString);
  const labels = pr.labels.map((l) => l.name);
  return isEligible({
    author: pr.author,
    headRef: pr.headRefName,
    labels,
  });
}

/** @param {string | null | undefined} stderr */
export function isCleanStatusError(stderr) {
  return /clean status/i.test(stderr ?? "");
}

function formatGhFailure(command, result) {
  const detail = result.stderr || result.stdout || `exit ${result.status}`;
  return `Command failed: ${command}\n${detail}`;
}

function tryRunGh(ghArgs) {
  const command = `gh ${ghArgs.join(" ")}`;
  const result = spawnSync("gh", ghArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return {
    command,
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function runGh(ghArgs) {
  const result = tryRunGh(ghArgs);
  if (!result.ok) {
    console.error(formatGhFailure(result.command, result));
    process.exit(1);
  }
  return result.stdout;
}

function mergeDependabotPr(prNumber, repo) {
  const autoResult = tryRunGh([
    "pr",
    "merge",
    String(prNumber),
    "--repo",
    repo,
    "--auto",
    "--squash",
    "--delete-branch",
  ]);
  if (autoResult.ok) {
    return;
  }
  if (isCleanStatusError(autoResult.stderr)) {
    console.log(
      "Auto-merge unavailable (PR already in clean/mergeable status); merging with squash.",
    );
    runGh([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      repo,
      "--squash",
      "--delete-branch",
    ]);
    return;
  }
  console.error(formatGhFailure(autoResult.command, autoResult));
  process.exit(1);
}

function main() {
  const repo = process.env.REPOSITORY ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("Set REPOSITORY or GITHUB_REPOSITORY");
    process.exit(1);
  }

  const picked = pickPrNumber(process.env.PR_NUMBERS);
  if (!picked.ok) {
    console.log(picked.reason);
    process.exit(0);
  }

  const prNumber = picked.number;
  const raw = runGh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "author,headRefName,labels",
  ]);
  const pr = JSON.parse(raw);
  const eligibility = evaluatePrJson(raw);

  if (!eligibility.ok) {
    console.log(`PR #${prNumber}: ${eligibility.reason}`);
    process.exit(0);
  }

  console.log(
    `Enabling auto-merge for Dependabot PR #${prNumber} (${pr.headRefName}) after successful CI.`,
  );
  mergeDependabotPr(prNumber, repo);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
