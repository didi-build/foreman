/** @typedef {{ subcommand: string; envNames: string[]; cloudflareEnv: string | null }} WranglerParseResult */

const WRANGLER_CMD = String.raw`(?:"wrangler(?:@[^"]+)?"|'wrangler(?:@[^']+)?'|(?<![\'"])wrangler(?:@[^\s/]+)?(?=\s|$|[;&|]))`;

const INVOCATION_START_RE = new RegExp(
  String.raw`\b(?:(?:npm\s+exec|npx|bunx)\s+)?${WRANGLER_CMD}`,
  "i",
);

const FLAGS_WITH_VALUE = new Set([
  "-c",
  "--config",
  "--cwd",
  "-e",
  "--env",
  "--name",
  "--worker-name",
  "--compatibility-date",
  "--compatibility-flags",
  "--routes",
  "--triggers",
  "--tsconfig",
  "--minify",
  "--outdir",
  "--outfile",
  "--upload-source-maps",
  "--var",
  "--define",
  "--alias",
  "--jsx-factory",
  "--jsx-fragment",
  "--legacy-env",
  "--log-level",
  "--port",
  "--local-protocol",
  "--persist-to",
  "--inspector-port",
  "--batch-size",
  "--keep-vars",
  "--dispatch-namespace",
]);

const KNOWN_SUBCOMMANDS = new Set([
  "preview",
  "deploy",
  "dev",
  "publish",
  "versions",
  "rollback",
  "secret",
  "secrets",
  "delete",
  "tail",
  "pages",
  "queues",
  "d1",
  "kv",
  "r2",
  "hyperdrive",
  "login",
  "logout",
  "whoami",
  "types",
  "init",
  "docs",
  "complete",
  "cert",
  "mtls-certificate",
  "triggers",
  "check",
  "dispatch-namespace",
  "pipelines",
  "containers",
  "workflows",
  "vectorize",
  "ai",
  "images",
  "streams",
]);

/**
 * @param {string} raw
 * @returns {string}
 */
export function stripWranglerQuotes(raw) {
  if (!raw) {
    return "";
  }
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function shellSplit(text) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function parseCloudflareEnvAssignments(text) {
  const values = [];
  if (!text) {
    return values;
  }
  const re = /(?:^|\s)(?:export\s+)?CLOUDFLARE_ENV=(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi;
  let match = re.exec(text);
  while (match) {
    values.push(stripWranglerQuotes(match[1] ?? match[2] ?? match[3] ?? ""));
    match = re.exec(text);
  }
  const envCmd = /\benv\s+CLOUDFLARE_ENV=(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  match = envCmd.exec(text);
  while (match) {
    values.push(stripWranglerQuotes(match[1] ?? match[2] ?? match[3] ?? ""));
    match = envCmd.exec(text);
  }
  return values;
}

/**
 * @param {string} invocation
 * @returns {WranglerParseResult}
 */
export function parseWranglerInvocation(invocation) {
  const normalized = invocation.replace(/\s+/g, " ").trim();
  const envNames = [];
  let cloudflareEnv = null;
  const prefixValues = parseCloudflareEnvAssignments(normalized);
  if (prefixValues.length > 0) {
    cloudflareEnv = prefixValues[0];
  }

  const startMatch = normalized.match(INVOCATION_START_RE);
  if (!startMatch || startMatch.index === undefined) {
    return { subcommand: "", envNames, cloudflareEnv };
  }

  const afterWrangler = normalized
    .slice(startMatch.index + startMatch[0].length)
    .trim();
  const tokens = shellSplit(afterWrangler);
  let subcommand = "";
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        const flag = token.slice(0, eq);
        const value = stripWranglerQuotes(token.slice(eq + 1));
        if (flag === "-e" || flag === "--env") {
          envNames.push(value);
        }
        i += 1;
        continue;
      }
      if (token === "-e" || token === "--env") {
        envNames.push(stripWranglerQuotes(tokens[i + 1] ?? ""));
        i += 2;
        continue;
      }
      if (FLAGS_WITH_VALUE.has(token)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    const lower = token.toLowerCase();
    if (!subcommand && KNOWN_SUBCOMMANDS.has(lower)) {
      subcommand = lower;
    }
    i += 1;
  }

  return { subcommand, envNames, cloudflareEnv };
}

/**
 * @param {string} commandLine
 * @returns {string[]}
 */
export function extractWranglerInvocations(commandLine) {
  const invocations = [];
  const re = new RegExp(
    String.raw`\b(?:(?:npm\s+exec|npx|bunx)\s+)?${WRANGLER_CMD}[^;\n|&]*`,
    "gi",
  );
  let match = re.exec(commandLine);
  while (match) {
    invocations.push(match[0].trim());
    match = re.exec(commandLine);
  }
  return invocations;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function lineMentionsWrangler(line) {
  return INVOCATION_START_RE.test(line);
}

/**
 * @param {string} script
 * @returns {boolean}
 */
export function scriptRunsWranglerPreview(script) {
  const joined = joinShellContinuationLinesForPreview(script);
  for (const line of joined.split("\n")) {
    if (!lineMentionsWrangler(line)) {
      continue;
    }
    for (const invocation of extractWranglerInvocations(line)) {
      if (parseWranglerInvocation(invocation).subcommand === "preview") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Minimal join for preview detection (avoids circular import from wrangler-config-path).
 *
 * @param {string} script
 * @returns {string}
 */
function joinShellContinuationLinesForPreview(script) {
  if (!script) {
    return "";
  }
  const physical = script.split(/\r?\n/);
  const merged = [];
  let current = "";
  for (const line of physical) {
    if (current) {
      const next = line.replace(/^\s*/, "");
      if (current && !/\s$/.test(current) && next.length > 0) {
        current += " ";
      }
      current += next;
    } else {
      current = line;
    }
    if (current.endsWith("\\")) {
      current = current.slice(0, -1).replace(/\s+$/, "");
      continue;
    }
    merged.push(current);
    current = "";
  }
  if (current) {
    merged.push(current);
  }
  return merged.join("\n");
}
