import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_NPM_CI_ARGS,
  gitPushArgs,
  gitPushAuthProcessEnv,
} from "./lib/bootstrap-install.mjs";
import { envWithoutBootstrapTokens } from "./lib/bootstrap-token-env.mjs";
import { validateCollectsPersonalDataEnv } from "./lib/collects-personal-data.mjs";
import {
  deriveBootstrapPlan,
  deriveInitArgs,
  isInitialized,
  MANUAL_BOOTSTRAP_FALLBACK,
  MISSING_REPOSITORY_DESCRIPTION_MESSAGE,
  planNeedsToken,
  resolveBootstrapRepositoryDescription,
  resolveTokenPolicy,
  sanitizeToken,
  shouldBootstrapRunNpmCiBeforeInit,
  shouldExecuteBootstrap,
} from "./lib/bootstrap.mjs";

const MALFORMED_BOOTSTRAP_TOKEN_ERROR =
  "BOOTSTRAP_TOKEN is malformed: re-copy the PAT into the org/repo secret with no quotes, newlines, or spaces inside the value.";
const TRIMMED_BOOTSTRAP_TOKEN_WARNING =
  "BOOTSTRAP_TOKEN had leading or trailing whitespace; it was trimmed for this run. Re-save the secret without trailing whitespace.";
const INVALID_AUTH_HEADER_HINT =
  "If you see `invalid header field value` for Authorization, re-save BOOTSTRAP_TOKEN without trailing newlines or spaces, then Re-run jobs.";

const mode = process.argv[2] ?? "run";
const initProjectScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "init-project.mjs",
);

function parseRunAttempt(raw) {
  const n = Number.parseInt(String(raw ?? "1"), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseHasToken(raw) {
  return raw === "true" || raw === "1";
}

function repositoryParts() {
  const full = process.env.GITHUB_REPOSITORY ?? "";
  const slash = full.indexOf("/");
  if (slash === -1) {
    return { owner: "", name: full };
  }
  return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
}

function readPlanContext() {
  const cwd = process.cwd();
  const initialized = isInitialized(cwd);
  const event = process.env.GITHUB_EVENT_NAME ?? "push";
  const runAttempt = parseRunAttempt(process.env.GITHUB_RUN_ATTEMPT);
  const plan = deriveBootstrapPlan({ initialized, event, runAttempt });
  const { owner } = repositoryParts();
  const hasToken = parseHasToken(process.env.HAS_BOOTSTRAP_TOKEN);
  const tokenPolicy = resolveTokenPolicy({
    planNeedsToken: planNeedsToken(plan),
    hasToken,
    repositoryOwner: owner,
  });
  return { cwd, initialized, event, runAttempt, plan, tokenPolicy, owner };
}

function appendGithubOutput(pairs) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) {
    return;
  }
  const lines = Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  appendFileSync(path, `${lines}\n`);
}

function appendStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) {
    return;
  }
  appendFileSync(path, `${lines.join("\n")}\n`);
}

function runInitProject(args) {
  const childEnv = envWithoutBootstrapTokens(process.env);
  const result = spawnSync(process.execPath, [initProjectScript, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.status === 0;
}

function runNpm(args, extraEnv = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...envWithoutBootstrapTokens(process.env), ...extraEnv },
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    ok: result.status === 0,
    output: combined,
  };
}

function invalidAuthHeaderHint(output) {
  if (!output.includes("invalid header field value")) {
    return "";
  }
  return `\n\n_Hint:_ ${INVALID_AUTH_HEADER_HINT}`;
}

/**
 * @param {{ plan: { settings: boolean } }} ctx
 * @returns {{ ghToken: string } | null}
 */
function resolveSanitizedGhToken(ctx) {
  if (!ctx.plan.settings) {
    return null;
  }
  const raw = process.env.GH_TOKEN ?? process.env.BOOTSTRAP_TOKEN ?? "";
  const { token, trimmed, valid } = sanitizeToken(raw);
  if (!valid) {
    console.error(
      `::error title=Malformed BOOTSTRAP_TOKEN::${MALFORMED_BOOTSTRAP_TOKEN_ERROR}`,
    );
    console.error(MALFORMED_BOOTSTRAP_TOKEN_ERROR);
    appendStepSummary(
      planSummaryMarkdown(ctx, {
        skipped: true,
        tokenError: MALFORMED_BOOTSTRAP_TOKEN_ERROR,
      }),
    );
    process.exit(1);
  }
  if (trimmed) {
    console.log(
      `::warning title=BOOTSTRAP_TOKEN trimmed::${TRIMMED_BOOTSTRAP_TOKEN_WARNING.replaceAll("\n", "%0A")}`,
    );
    console.warn(TRIMMED_BOOTSTRAP_TOKEN_WARNING);
  }
  return { ghToken: token };
}

function runGit(args, extraEnv = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...envWithoutBootstrapTokens(process.env), ...extraEnv },
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result;
}

function runGitPushWithToken(token, repository) {
  return runGit(gitPushArgs(repository), gitPushAuthProcessEnv(token));
}

function planSummaryMarkdown(ctx, extras = {}) {
  const { plan, tokenPolicy, event, runAttempt, initialized } = ctx;
  const lines = [
    "## Bootstrap plan",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Event | \`${event}\` |`,
    `| Run attempt | ${runAttempt} |`,
    `| Initialized | ${initialized} |`,
    `| \`init\` | ${plan.init} |`,
    `| \`settings\` | ${plan.settings} |`,
    `| Token policy | \`${tokenPolicy}\` |`,
  ];
  if (extras.verifyOk !== undefined) {
    lines.push(`| Settings verify | ${extras.verifyOk ? "✅ passed" : "❌ failed"} |`);
  }
  if (extras.ranInit) {
    lines.push("", "- Ran `init-project` and pushed commit to default branch.");
  }
  if (extras.ranSettings) {
    lines.push("- Ran `repo-settings --apply` and `--verify`.");
  }
  if (extras.noop) {
    lines.push("", "_Already initialized — nothing to do on this push._");
  }
  if (extras.skipped) {
    lines.push("", "_Skipped (token policy)._");
  }
  if (extras.tokenError) {
    lines.push("", `_${extras.tokenError}_`);
  }
  if (extras.settingsHint) {
    lines.push("", extras.settingsHint);
  }
  return lines;
}

function failInvalidCollectsPersonalData(ctx, message) {
  console.error(`::error title=Invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA::${message}`);
  console.error(message);
  appendStepSummary([...planSummaryMarkdown(ctx), "", `_${message}_`]);
  process.exit(1);
}

function failMissingRepositoryDescription(ctx) {
  console.error(
    `::error title=Repository description required::${MISSING_REPOSITORY_DESCRIPTION_MESSAGE}`,
  );
  console.error(MISSING_REPOSITORY_DESCRIPTION_MESSAGE);
  appendStepSummary([
    ...planSummaryMarkdown(ctx),
    "",
    `_${MISSING_REPOSITORY_DESCRIPTION_MESSAGE}_`,
  ]);
  process.exit(1);
}

function handlePlanMode() {
  const ctx = readPlanContext();
  const execute = shouldExecuteBootstrap(ctx);

  const collectsValidation = validateCollectsPersonalDataEnv(
    process.env.LAUNCHPAD_COLLECTS_PERSONAL_DATA,
  );
  if (!collectsValidation.ok) {
    failInvalidCollectsPersonalData(ctx, collectsValidation.message);
  }

  if (ctx.plan.init && execute) {
    const resolved = resolveBootstrapRepositoryDescription(
      process.env.LAUNCHPAD_REPO_DESCRIPTION,
    );
    if (!resolved.ok) {
      failMissingRepositoryDescription(ctx);
    }
  }

  appendGithubOutput({
    init: String(ctx.plan.init),
    settings: String(ctx.plan.settings),
    needs_token: String(planNeedsToken(ctx.plan)),
    token_policy: ctx.tokenPolicy,
    execute: String(execute),
  });

  if (!ctx.plan.init && !ctx.plan.settings) {
    console.log("already initialized, nothing to do");
    appendStepSummary(planSummaryMarkdown(ctx, { noop: true }));
    process.exit(0);
  }

  if (ctx.tokenPolicy === "fail") {
    console.error(
      "BOOTSTRAP_TOKEN is required for didi-build repositories but was not configured.",
    );
    appendStepSummary(planSummaryMarkdown(ctx, { skipped: true }));
    process.exit(1);
  }

  if (ctx.tokenPolicy === "warn-skip") {
    console.log(
      `::warning title=Bootstrap skipped::${MANUAL_BOOTSTRAP_FALLBACK.replaceAll("\n", "%0A")}`,
    );
    console.warn(MANUAL_BOOTSTRAP_FALLBACK);
    appendStepSummary(planSummaryMarkdown(ctx, { skipped: true }));
    process.exit(0);
  }

  if (!execute) {
    appendStepSummary(planSummaryMarkdown(ctx));
  }
  process.exit(0);
}

function handleRunMode() {
  const ctx = readPlanContext();
  if (!shouldExecuteBootstrap(ctx)) {
    console.log("Bootstrap run skipped (nothing to execute).");
    process.exit(0);
  }

  const tokenResolution = resolveSanitizedGhToken(ctx);
  const pushTokenRaw = process.env.BOOTSTRAP_TOKEN ?? process.env.GH_TOKEN ?? "";
  const pushTokenSanitized = sanitizeToken(pushTokenRaw);

  const { owner: repoOwnerLogin, name: repoName } = repositoryParts();
  const repositoryFull =
    process.env.GITHUB_REPOSITORY ?? `${repoOwnerLogin}/${repoName}`;
  const description = process.env.LAUNCHPAD_REPO_DESCRIPTION ?? "";
  const repositoryOwnerLogin =
    process.env.GITHUB_REPOSITORY_OWNER?.trim() || repoOwnerLogin;
  let initArgs;
  if (ctx.plan.init) {
    const resolved = resolveBootstrapRepositoryDescription(description);
    if (!resolved.ok) {
      failMissingRepositoryDescription(ctx);
    }
    initArgs = deriveInitArgs({
      repoName,
      description: resolved.purpose,
      repositoryOwnerLogin,
      allowDefaultPurpose: false,
    });
  } else {
    initArgs = deriveInitArgs({
      repoName,
      description,
      repositoryOwnerLogin,
    });
  }

  const summaryExtras = { ranInit: false, ranSettings: false, verifyOk: undefined };

  if (ctx.plan.init) {
    const collectsValidation = validateCollectsPersonalDataEnv(
      process.env.LAUNCHPAD_COLLECTS_PERSONAL_DATA,
    );
    if (!collectsValidation.ok) {
      failInvalidCollectsPersonalData(ctx, collectsValidation.message);
    }

    if (
      shouldBootstrapRunNpmCiBeforeInit(
        ctx.plan,
        process.env.LAUNCHPAD_COLLECTS_PERSONAL_DATA,
      )
    ) {
      const ci = runNpm(BOOTSTRAP_NPM_CI_ARGS);
      if (!ci.ok) {
        console.error(
          "npm ci --ignore-scripts failed before init-project (required for @didi-build/nodrift init).",
        );
        process.exit(1);
      }
    }

    const ok = runInitProject([
      initArgs.slug,
      initArgs.displayName,
      initArgs.purpose,
      initArgs.owner,
    ]);
    if (!ok) {
      console.error("init-project failed.");
      process.exit(1);
    }

    runGit(["config", "user.name", "github-actions[bot]"]);
    runGit([
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);

    runGit(["add", "-A"]);
    const diff = runGit(["diff", "--cached", "--quiet"]);
    if (diff.status !== 0) {
      const commit = runGit(
        ["commit", "-m", "chore: initialize project from Launchpad template"],
        { HUSKY: "0" },
      );
      if (commit.status !== 0) {
        console.error("git commit failed.");
        process.exit(1);
      }
      if (!pushTokenSanitized.valid) {
        console.error("BOOTSTRAP_TOKEN is required to push the init commit.");
        process.exit(1);
      }
      const push = runGitPushWithToken(pushTokenSanitized.token, repositoryFull);
      if (push.status !== 0) {
        console.error("git push failed.");
        process.exit(1);
      }
    }
    summaryExtras.ranInit = true;
  }

  if (ctx.plan.settings) {
    const ghToken = tokenResolution?.ghToken;
    if (!ghToken) {
      console.error("GH_TOKEN is required for repo-settings.");
      process.exit(1);
    }
    const apply = runNpm(["run", "repo-settings", "--", "--apply"], {
      GH_TOKEN: ghToken,
    });
    summaryExtras.ranSettings = true;
    if (!apply.ok) {
      const hint = invalidAuthHeaderHint(apply.output);
      console.error(
        `repo-settings --apply failed.${hint ? ` ${INVALID_AUTH_HEADER_HINT}` : ""}`,
      );
      appendStepSummary(
        planSummaryMarkdown(ctx, {
          ...summaryExtras,
          settingsHint: hint ? `_Hint:_ ${INVALID_AUTH_HEADER_HINT}` : undefined,
        }),
      );
      process.exit(1);
    }
    const verify = runNpm(["run", "repo-settings", "--", "--verify"], {
      GH_TOKEN: ghToken,
    });
    summaryExtras.verifyOk = verify.ok;
    if (!verify.ok) {
      const hint = invalidAuthHeaderHint(verify.output);
      console.error(
        `repo-settings --verify failed.${hint ? ` ${INVALID_AUTH_HEADER_HINT}` : ""}`,
      );
      appendStepSummary(
        planSummaryMarkdown(ctx, {
          ...summaryExtras,
          settingsHint: hint ? `_Hint:_ ${INVALID_AUTH_HEADER_HINT}` : undefined,
        }),
      );
      process.exit(1);
    }
  }

  appendStepSummary(planSummaryMarkdown(ctx, summaryExtras));
  process.exit(0);
}

if (mode === "plan") {
  handlePlanMode();
} else if (mode === "run") {
  if (!existsSync("package.json")) {
    console.error("package.json not found — run from repository root.");
    process.exit(1);
  }
  handleRunMode();
} else {
  console.error(`Unknown mode: ${mode}. Use "plan" or "run".`);
  process.exit(1);
}
