import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const INSTRUCTION =
  "Wrap GitHub Actions `if` conditions that use `!` in `${{ ... }}` or quote the value. A bare `if: !cancelled()` is invalid YAML (leading `!` is a tag).";

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isBareNegationIfLine(line) {
  const match = line.match(/^\s*(?:-\s+)?if:\s*(.+?)\s*$/);
  if (!match) {
    return false;
  }
  const value = match[1];
  if (value.startsWith("${{") || value.startsWith('"') || value.startsWith("'")) {
    return false;
  }
  return value.startsWith("!");
}

/**
 * @param {string} text
 * @returns {{ line: number; content: string }[]}
 */
export function findBareNegationIfLines(text) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBareNegationIfLine(line)) {
      hits.push({ line: i + 1, content: line.trimEnd() });
    }
  }
  return hits;
}

/**
 * @param {string} root
 * @returns {{ path: string; hits: { line: number; content: string }[]; parseError?: string }[]}
 */
export function scanWorkflowYaml(root) {
  const workflowsDir = join(root, ".github", "workflows");
  const files = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  const results = [];

  for (const name of files) {
    const path = join(workflowsDir, name);
    const rel = relative(root, path);
    const text = readFileSync(path, "utf8");
    const hits = findBareNegationIfLines(text);
    let parseError;
    try {
      parseYaml(text);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    if (hits.length > 0 || parseError) {
      results.push({ path: rel, hits, parseError });
    }
  }

  return results;
}

/**
 * @param {{ path: string; hits: { line: number; content: string }[]; parseError?: string }[]} issues
 * @returns {string}
 */
export function formatWorkflowYamlReport(issues) {
  const lines = [];
  for (const issue of issues) {
    if (issue.parseError) {
      lines.push(`${issue.path}: YAML parse error: ${issue.parseError}`);
    }
    for (const hit of issue.hits) {
      lines.push(
        `${issue.path}:${hit.line}: invalid bare \`if\` (starts with \`!\`): ${hit.content}`,
      );
    }
  }
  lines.push(INSTRUCTION);
  return lines.join("\n");
}

function runCli() {
  const root = process.cwd();
  const issues = scanWorkflowYaml(root);
  if (issues.length === 0) {
    return;
  }
  console.error(formatWorkflowYamlReport(issues));
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli();
}
