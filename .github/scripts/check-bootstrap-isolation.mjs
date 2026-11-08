// The bootstrap isolation check (D-358 lock 1, O-113). It is kept in .github/ and run directly
// (`node .github/scripts/check-bootstrap-isolation.mjs`, from .github/workflows/bootstrap-isolation.yml),
// so both the check and the call to it are protected. It fails when:
// - a workflow other than bootstrap.yml names BOOTSTRAP_TOKEN;
// - the token is given anywhere but a step's env (the job or the workflow, an action's inputs);
// - a step that receives the token runs anything but `node .github/scripts/...`, git or gh;
// - the token job runs anything else: npm or npx, an action other than checkout and
//   download-artifact pinned by commit (so no actions/setup-node cache step), a checkout that
//   persists credentials or reads another commit than the one decided, a download into the
//   workspace, a shell or directory override, or NODE_OPTIONS, NODE_PATH or GIT_* settings;
// - a script under .github/scripts/ that bootstrap.yml runs imports anything but a `node:`
//   built-in or a relative file under .github/scripts/ (checked through every import), loads
//   code another way (node:vm, node:module, node:worker_threads, node:cluster, a computed
//   import), or starts a program other than git or gh.
// Node built-ins only. It reads bootstrap.yml with its own YAML reader, which refuses what it
// cannot read, so an unreadable file fails the check.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isMain } from "./bootstrap-common.mjs";
import { parseWorkflowYaml } from "./workflow-yaml.mjs";

const SECRET_NAME = "BOOTSTRAP_TOKEN";
const WORKFLOWS_DIR = ".github/workflows";
const BOOTSTRAP_WORKFLOW = "bootstrap.yml";
const SCRIPTS_DIR = ".github/scripts";

/** The one way a step may name the token without receiving it: asking whether it is set. */
const PRESENCE_TEST = /^\$\{\{\s*secrets\.BOOTSTRAP_TOKEN\s*!=\s*''\s*\}\}$/;
const NAMES_TOKEN = /BOOTSTRAP_TOKEN/;
const TOKEN_JOB_ACTIONS = new Set(["actions/checkout", "actions/download-artifact"]);
const FROM_A_JOB_OUTPUT =
  /^\$\{\{\s*needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/;
const NODE_SCRIPT = /^\.github\/scripts\/[A-Za-z0-9_-]+\.mjs$/;
const LOADS_CODE = new Set([
  "node:vm",
  "node:module",
  "node:worker_threads",
  "node:cluster",
]);
const PROGRAM_STARTERS = new Set(["spawnSync", "execFileSync"]);

/** @param {unknown} value */
function namesToken(value) {
  return value !== undefined && NAMES_TOKEN.test(JSON.stringify(value) ?? "");
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asMap(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * Each command line of a `run` script, checked against what the token job may run.
 *
 * @param {string} run
 * @param {string} label
 * @param {string[]} out
 * @returns {string[]} the `.github/scripts/` files it runs with node
 */
export function checkCommands(run, label, out) {
  const scripts = [];
  for (const raw of run.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line === "set -euo pipefail") continue;
    if (/[;&|`<>()\\!]/.test(line) || line.includes("${{") || line.includes("$(")) {
      out.push(`${label}: \`${line}\` chains, redirects or substitutes commands`);
      continue;
    }
    const words = line.split(/\s+/);
    const program = words[0];
    if (program === "node") {
      const script = words[1] ?? "";
      if (!NODE_SCRIPT.test(script)) {
        out.push(
          `${label}: \`${line}\` runs node on something other than a file in .github/scripts/`,
        );
        continue;
      }
      scripts.push(script);
    } else if (program === "git" || program === "gh") {
      const option = words.find((word) =>
        /^["']?(-c|--config-env|-C|--exec-path|--git-dir|--work-tree)(=|["']?$)/.test(
          word,
        ),
      );
      if (option) {
        out.push(
          `${label}: \`${line}\` changes git's configuration or directory (${option})`,
        );
      }
    } else {
      out.push(
        `${label}: \`${line}\` runs ${program}; only node .github/scripts/..., git and gh may run`,
      );
    }
  }
  return scripts;
}

/**
 * The module specifiers a script names: static imports and re-exports, and literal dynamic
 * imports. A dynamic import of anything but a string literal is a violation.
 *
 * @param {string} source
 * @param {string} label
 * @param {string[]} out
 * @returns {string[]}
 */
export function moduleSpecifiers(source, label, out) {
  const specifiers = [];
  const staticForms =
    /(?:^|[\s;])(?:import|export)\s+(?:[^"';]*?\s+from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(staticForms)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(/g)) {
    const after = source.slice((match.index ?? 0) + match[0].length);
    const literal = after.match(/^\s*["']([^"']+)["']\s*\)/);
    if (literal) {
      specifiers.push(literal[1]);
    } else {
      out.push(`${label}: imports a computed module name`);
    }
  }
  return specifiers;
}

/**
 * The child_process rule: only spawnSync and execFileSync, each starting git or gh by name.
 *
 * @param {string} source
 * @param {string} label
 * @param {string[]} out
 */
function checkChildProcesses(source, label, out) {
  const imports = [
    ...source.matchAll(
      /(?:^|[\s;])import\s+([^"';]*?)\s+from\s*["']node:child_process["']/g,
    ),
  ];
  for (const [, bindings] of imports) {
    const named = bindings.match(/^\{([^}]*)\}$/);
    if (!named) {
      out.push(`${label}: imports node:child_process other than by name`);
      continue;
    }
    for (const entry of named[1].split(",")) {
      const [imported, local = imported] = entry
        .trim()
        .split(/\s+as\s+/)
        .map((s) => s.trim());
      if (!imported) continue;
      if (!PROGRAM_STARTERS.has(imported)) {
        out.push(
          `${label}: uses ${imported} from node:child_process; only spawnSync and execFileSync may start git or gh`,
        );
        continue;
      }
      const name = local.replaceAll("$", "\\$");
      const calls = [...source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].length;
      const startsGit = [
        ...source.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*["'](?:git|gh)["']`, "g")),
      ].length;
      if (calls !== startsGit) {
        out.push(`${label}: ${local} starts a program other than git or gh`);
      }
    }
  }
}

/**
 * Every file a script loads, followed through relative imports.
 *
 * @param {string} root
 * @param {string[]} entries paths relative to root
 * @param {string[]} out
 * @returns {string[]} the files read, relative to root
 */
export function checkScriptImports(root, entries, out) {
  const scriptsDir = resolve(root, SCRIPTS_DIR);
  const queue = entries.map((entry) => resolve(root, entry));
  const seen = new Set();
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    const label = relative(root, file).split(sep).join("/");
    if (!file.startsWith(`${scriptsDir}${sep}`)) {
      out.push(`${label}: is outside ${SCRIPTS_DIR}/`);
      continue;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      out.push(`${label}: is missing`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(source, label, out)) {
      if (specifier.startsWith("node:")) {
        if (LOADS_CODE.has(specifier)) {
          out.push(`${label}: imports ${specifier}, which loads code another way`);
        }
        continue;
      }
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(`${scriptsDir}${sep}`)) {
          out.push(`${label}: imports ${specifier}, a file outside ${SCRIPTS_DIR}/`);
          continue;
        }
        queue.push(target);
        continue;
      }
      out.push(
        `${label}: imports ${specifier}; only node: built-ins and files under ${SCRIPTS_DIR}/ may be imported`,
      );
    }
    checkChildProcesses(source, label, out);
  }
  return [...seen].map((file) => relative(root, file).split(sep).join("/"));
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} step
 * @param {string[]} out
 */
function checkTokenJobAction(label, step, out) {
  const uses = String(step.uses);
  const [action, ref = ""] = uses.split("@");
  const inputs = asMap(step.with);
  if (action === "actions/setup-node" && inputs.cache !== undefined) {
    out.push(`${label}: has an actions/setup-node cache step`);
  }
  if (!TOKEN_JOB_ACTIONS.has(action)) {
    out.push(
      `${label}: runs ${action}; the token job may run only actions/checkout and actions/download-artifact`,
    );
    return;
  }
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    out.push(`${label}: ${action} is not pinned to a full commit SHA`);
  }
  if (action === "actions/checkout") {
    if (inputs["persist-credentials"] !== "false") {
      out.push(
        `${label}: checkout persists credentials (set persist-credentials: false)`,
      );
    }
    if (!FROM_A_JOB_OUTPUT.test(String(inputs.ref ?? ""))) {
      out.push(
        `${label}: checkout must read the commit the decide job read (ref from a job output)`,
      );
    }
  }
  if (action === "actions/download-artifact") {
    if (!String(inputs.path ?? "").startsWith("${{ runner.temp }}")) {
      out.push(
        `${label}: download-artifact must download into runner.temp, outside the workspace`,
      );
    }
  }
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} job
 * @param {string[]} out
 * @returns {string[]} the `.github/scripts/` files the job runs
 */
function checkTokenJob(label, job, out) {
  const scripts = [];
  if (!/^ubuntu-(latest|\d+\.\d+)$/.test(String(job["runs-on"] ?? ""))) {
    out.push(
      `${label}: must run on a fresh GitHub-hosted runner (runs-on: ubuntu-latest)`,
    );
  }
  if (job.defaults !== undefined) {
    out.push(`${label}: has defaults, which can change a step's shell or directory`);
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  steps.forEach((raw, index) => {
    const step = asMap(raw);
    const stepLabel = `${label} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
    for (const key of Object.keys(asMap(step.env))) {
      if (key === "NODE_OPTIONS" || key === "NODE_PATH" || key.startsWith("GIT_")) {
        out.push(`${stepLabel}: sets ${key}`);
      }
    }
    if (step["working-directory"] !== undefined) {
      out.push(`${stepLabel}: sets working-directory`);
    }
    if (step.shell !== undefined && step.shell !== "bash") {
      out.push(`${stepLabel}: sets shell ${String(step.shell)}`);
    }
    if (step.uses !== undefined) {
      checkTokenJobAction(stepLabel, step, out);
    }
    if (step.run !== undefined) {
      const run = String(step.run);
      if (/\b(npm|npx)\b/.test(run)) {
        out.push(`${stepLabel}: runs npm or npx`);
      }
      scripts.push(...checkCommands(run, stepLabel, out));
    }
  });
  return scripts;
}

/**
 * @param {string} root the repository root
 * @returns {{ violations: string[]; scripts: string[] }}
 */
export function checkBootstrapIsolation(root) {
  const out = [];
  const workflowsDir = join(root, WORKFLOWS_DIR);
  if (!existsSync(workflowsDir)) {
    return { violations: [], scripts: [] };
  }
  for (const name of readdirSync(workflowsDir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    if (name === BOOTSTRAP_WORKFLOW) continue;
    if (readFileSync(join(workflowsDir, name), "utf8").includes(SECRET_NAME)) {
      out.push(
        `${WORKFLOWS_DIR}/${name}: names ${SECRET_NAME}; only ${BOOTSTRAP_WORKFLOW} may`,
      );
    }
  }

  const path = join(workflowsDir, BOOTSTRAP_WORKFLOW);
  if (!existsSync(path)) {
    return { violations: out, scripts: [] };
  }
  const text = readFileSync(path, "utf8");
  const file = `${WORKFLOWS_DIR}/${BOOTSTRAP_WORKFLOW}`;
  let workflow;
  try {
    workflow = asMap(parseWorkflowYaml(text));
  } catch (err) {
    out.push(
      `${file}: ${err instanceof Error ? err.message : String(err)}; the check reads only plain workflow YAML`,
    );
    return { violations: out, scripts: [] };
  }
  if (/secrets:\s*inherit|toJSON\(\s*secrets\s*\)|secrets\s*\[/.test(text)) {
    out.push(
      `${file}: passes every secret at once (secrets: inherit, toJSON(secrets) or secrets[...])`,
    );
  }
  for (const key of Object.keys(workflow)) {
    if (key !== "jobs" && namesToken(workflow[key])) {
      out.push(
        `${file}: names ${SECRET_NAME} in the workflow's ${key}; only a step's env may`,
      );
    }
  }
  if (workflow.defaults !== undefined) {
    out.push(`${file}: has defaults, which can change a step's shell or directory`);
  }

  const scripts = [];
  for (const [id, rawJob] of Object.entries(asMap(workflow.jobs))) {
    const job = asMap(rawJob);
    const label = `${file} job ${id}`;
    for (const key of Object.keys(job)) {
      if (key !== "steps" && namesToken(job[key])) {
        out.push(
          `${label}: names ${SECRET_NAME} in the job's ${key}; only a step's env may`,
        );
      }
    }
    let receives = false;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((raw, index) => {
      const step = asMap(raw);
      const stepLabel = `${label} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      for (const key of Object.keys(step)) {
        if (key !== "env" && namesToken(step[key])) {
          out.push(
            `${stepLabel}: names ${SECRET_NAME} in ${key}; only a step's env may`,
          );
        }
      }
      let stepReceives = false;
      for (const value of Object.values(asMap(step.env))) {
        if (namesToken(value) && !PRESENCE_TEST.test(String(value).trim())) {
          stepReceives = true;
        }
      }
      if (stepReceives) {
        receives = true;
        if (step.uses !== undefined || step.run === undefined) {
          out.push(
            `${stepLabel}: receives the token but does not run node .github/scripts/..., git or gh`,
          );
        }
      }
      if (step.run !== undefined) {
        for (const line of String(step.run).split("\n")) {
          const words = line.trim().split(/\s+/);
          if (words[0] === "node" && NODE_SCRIPT.test(words[1] ?? "")) {
            scripts.push(words[1]);
          }
        }
      }
    });
    if (receives) {
      scripts.push(...checkTokenJob(label, job, out));
    }
  }

  // The check and its reader are protected code too: built-ins only.
  const self = `${SCRIPTS_DIR}/check-bootstrap-isolation.mjs`;
  if (existsSync(join(root, self))) scripts.push(self);
  const read = checkScriptImports(root, [...new Set(scripts)], out);
  return { violations: [...new Set(out)], scripts: read };
}

if (isMain(import.meta.url)) {
  const { violations, scripts } = checkBootstrapIsolation(process.cwd());
  if (violations.length > 0) {
    console.error("Bootstrap isolation check failed (D-358 lock 1, O-113):\n");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Bootstrap isolation check passed: only protected .github code receives ${SECRET_NAME} (${scripts.length} scripts read).`,
    );
  }
}
