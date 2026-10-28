import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKFLOWS_DIR = ".github/workflows";
const ALLOWED_FILE = "bootstrap.yml";
const SECRET_NAME = "BOOTSTRAP_TOKEN";

/**
 * @param {string} workflowsDir
 * @returns {string[]}
 */
export function findBootstrapTokenViolations(workflowsDir) {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  const entries = readdirSync(workflowsDir, { withFileTypes: true });
  const violations = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    if (name === ALLOWED_FILE) continue;
    const text = readFileSync(join(workflowsDir, name), "utf8");
    if (text.includes(SECRET_NAME)) {
      violations.push(name);
    }
  }
  return violations.sort();
}

function runCli() {
  const violations = findBootstrapTokenViolations(WORKFLOWS_DIR);
  if (violations.length > 0) {
    console.error(
      `${SECRET_NAME} must only appear in .github/workflows/${ALLOWED_FILE}. Offenders:\n`,
    );
    for (const file of violations) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli();
}
