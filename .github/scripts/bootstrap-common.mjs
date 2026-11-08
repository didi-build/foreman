// Shared helpers for Bootstrap's protected scripts (D-358 lock 1, O-113). Node built-ins only,
// and only relative files under .github/scripts/: `node .github/scripts/check-bootstrap-isolation.mjs`
// fails CI otherwise.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Env vars that may hold a GitHub token and must not reach a child process. */
export const BOOTSTRAP_TOKEN_ENV_KEYS = ["GH_TOKEN", "BOOTSTRAP_TOKEN", "GITHUB_TOKEN"];

export const MALFORMED_TOKEN_MESSAGE =
  "BOOTSTRAP_TOKEN is malformed: re-copy the PAT into the org/repo secret with no quotes, newlines, or spaces inside the value.";
export const TRIMMED_TOKEN_WARNING =
  "BOOTSTRAP_TOKEN had leading or trailing whitespace; it was trimmed for this run. Re-save the secret without trailing whitespace.";

/**
 * @param {string} metaUrl `import.meta.url` of the calling module
 * @returns {boolean} whether that module is the script node was started with
 */
export function isMain(metaUrl) {
  return (
    process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href
  );
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithoutBootstrapTokens(env) {
  const out = { ...env };
  for (const key of BOOTSTRAP_TOKEN_ENV_KEYS) {
    delete out[key];
  }
  return out;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function envExposesBootstrapToken(env) {
  for (const key of BOOTSTRAP_TOKEN_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return true;
    }
  }
  return false;
}

/**
 * The env for a git child: no token variables and no inherited git configuration.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function envForGit(env) {
  const out = envWithoutBootstrapTokens(env);
  for (const key of Object.keys(out)) {
    if (
      key === "GIT_CONFIG_COUNT" ||
      key === "GIT_CONFIG_PARAMETERS" ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete out[key];
    }
  }
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
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
 * Reads the token from `GH_TOKEN`, prints the trim warning or the malformed error (fixed text,
 * never the value) and returns the token, or null when it is missing or malformed.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function tokenFromEnv(env) {
  const { token, trimmed, valid } = sanitizeToken(env.GH_TOKEN);
  if (!valid) {
    console.error(
      `::error title=Malformed BOOTSTRAP_TOKEN::${MALFORMED_TOKEN_MESSAGE}`,
    );
    console.error(MALFORMED_TOKEN_MESSAGE);
    return null;
  }
  if (trimmed) {
    console.log(`::warning title=BOOTSTRAP_TOKEN trimmed::${TRIMMED_TOKEN_WARNING}`);
    console.warn(TRIMMED_TOKEN_WARNING);
  }
  return token;
}

/**
 * Replaces each secret (and its basic-auth form) in text before it is printed.
 *
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.replaceAll(secret, "***");
  }
  return out;
}

/**
 * @param {string | undefined} raw `owner/name`
 * @returns {string | null} the repository, or null when it is not a GitHub repository name
 */
export function parseRepository(raw) {
  const value = String(raw ?? "");
  const match = value.match(
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/,
  );
  if (!match || match[2] === "." || match[2] === "..") {
    return null;
  }
  return value;
}

/**
 * @param {string | undefined} raw
 * @returns {string | null} the branch name, or null when it is not a plain branch name
 */
export function parseBranch(raw) {
  const value = String(raw ?? "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    return null;
  }
  return value;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} the REST API's base URL (https only), or null when it is not one
 */
export function resolveApiUrl(env) {
  const raw = String(env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  return /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._/-]*)?$/.test(raw)
    ? raw
    : null;
}

/** @typedef {{ fetch: typeof fetch; apiUrl: string; token: string }} GithubClient */

/**
 * One GitHub REST request. Follows no redirect, gives up after 30 seconds and never throws:
 * no answer is status 0.
 *
 * @param {GithubClient} client
 * @param {string} method
 * @param {string} path starts with `/`
 * @param {unknown} [body]
 * @returns {Promise<{ status: number; json: unknown }>}
 */
export async function githubRequest(client, method, path, body) {
  /** @type {Record<string, string>} */
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "launchpad-bootstrap",
  };
  if (client.token) {
    headers.authorization = `Bearer ${client.token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  let response;
  try {
    response = await client.fetch(`${client.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: 0, json: null };
  }
  let json = null;
  try {
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/**
 * GitHub's own error message from an answer, shortened and on one line, or "".
 *
 * @param {unknown} json
 * @returns {string}
 */
export function githubMessage(json) {
  if (json && typeof json === "object" && "message" in json) {
    const message = /** @type {{ message: unknown }} */ (json).message;
    if (typeof message === "string") {
      return [...message]
        .map((ch) => (ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f ? " " : ch))
        .join("")
        .slice(0, 200);
    }
  }
  return "";
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} lines
 */
export function appendStepSummary(env, lines) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) {
    return;
  }
  appendFileSync(path, `${lines.join("\n")}\n`);
}

/**
 * Writes step outputs; a value with a line break uses GitHub's delimiter form.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} pairs
 */
export function appendGithubOutput(env, pairs) {
  const path = env.GITHUB_OUTPUT;
  if (!path) {
    return;
  }
  let text = "";
  for (const [key, value] of Object.entries(pairs)) {
    if (!/[\r\n]/.test(value)) {
      text += `${key}=${value}\n`;
      continue;
    }
    const delimiter = `ghadelimiter_${randomUUID()}`;
    text += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  appendFileSync(path, text);
}
