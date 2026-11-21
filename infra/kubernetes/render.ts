// Print the cluster's standing objects as one Kubernetes List. Nothing here talks to a cluster.
//
//   node infra/kubernetes/render.ts <settings.json> <projects checkout>
//
// The Platform workflow (.github/workflows/platform.yml, D-339, O-105) renders the reviewed
// settings file infra/kubernetes/settings/production.json this way, in a job with no secret, with
// a placeholder for `platform.kubernetesApi` that the jobs holding the cluster credential replace
// with the address they read from the cluster (D-349), and applies the result once Didi
// approves. The project list is not in that file: it is the settings repository
// `didi-build/foreman-projects` (D-377, D-442, ADR 0118 appendix A), which the workflow checks
// out at one resolved commit and names as the second argument. Every project file is read with
// the rules of src/core/project-entry.ts, and one bad file stops the render. Neither holds a
// secret: images, app logins, ports, quotas, project slugs and names. Secrets are created
// separately by name, by the workflow's cluster Secrets job (docs/runbooks/first-hosting.md).
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  agentNamespaceObjects,
  evalNamespaceObjects,
  runnerNamespaceObjects,
  type AgentQuota,
} from "../../src/adapters/agent-runtime/kubernetes/namespace.ts";
import type { NamespaceObject } from "../../src/adapters/agent-runtime/kubernetes/objects.ts";
import {
  PROJECTS_FOLDER,
  PROJECTS_MARKER_FILE,
  PROJECTS_REPOSITORY,
  isProjectsMarker,
  parseProjectEntry,
  parseProjectQuota,
  type ProjectEntry,
} from "../../src/core/project-entry.ts";
import {
  platformObjects,
  type PlatformObject,
  type PlatformSettings,
} from "./platform.ts";

/** The settings the objects are made from: the platform, one entry per project, the weekly test. */
export interface ClusterSettings {
  platform: PlatformSettings;
  /** From the settings repository's project files, sorted by slug. */
  projects: { slug: string; quota: AgentQuota }[];
  /**
   * The weekly model test's own namespace and its quota (D-433, O-156). Not a project: it has no
   * repository, no staging site and no watched Jobs, so it is kept out of `projects`, which the
   * infrastructure stack, the register-project form and the run watcher read.
   */
  eval?: { quota: AgentQuota };
}

/**
 * The platform settings file as committed (infra/kubernetes/settings/production.json). It holds
 * no project list: `projectStandardQuota` is the one size every new project gets (D-436), which
 * the New project form will write into each project's file (ADR 0118 appendix A).
 */
export interface PlatformSettingsFile {
  platform: PlatformSettings;
  projectStandardQuota: AgentQuota;
  eval?: { quota: AgentQuota };
}

/** A refusal of the settings or of the settings repository's checkout. Fixed text, plus a name. */
export class ProjectsCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectsCheckoutError";
  }
}

/** A file name shown as it is only when it is plain: anything else could break the summary. */
const shown = (name: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)
    ? `${PROJECTS_FOLDER}/${name}`
    : `a file in ${PROJECTS_FOLDER}/`;

/**
 * Every project in a checkout of the settings repository, sorted by slug, so the run watcher's
 * `AGENT_NAMESPACES` keeps a stable order. The marker must be there (a folder that is not this
 * repository's checkout is refused, never read as an empty list), `projects/` must be a folder,
 * and each entry in it must be a regular `.json` file that passes the entry rules. The first
 * problem stops the read, naming the file and the rule.
 */
export function readProjectsCheckout(dir: string): ProjectEntry[] {
  let marker: string;
  try {
    marker = readFileSync(join(dir, PROJECTS_MARKER_FILE), "utf8");
  } catch {
    throw new ProjectsCheckoutError(
      `${PROJECTS_MARKER_FILE} is missing: the folder is not a checkout of ${PROJECTS_REPOSITORY}.`,
    );
  }
  if (!isProjectsMarker(marker)) {
    throw new ProjectsCheckoutError(
      `${PROJECTS_MARKER_FILE}: the marker must be exactly {"schema": 1}.`,
    );
  }
  const folder = join(dir, PROJECTS_FOLDER);
  let names: string[];
  try {
    if (!lstatSync(folder).isDirectory()) throw new Error("not a folder");
    names = readdirSync(folder);
  } catch {
    throw new ProjectsCheckoutError(
      `${PROJECTS_FOLDER}/ is missing from the checkout of ${PROJECTS_REPOSITORY}.`,
    );
  }
  const entries = names.sort().map((name) => {
    if (!name.endsWith(".json") || !lstatSync(join(folder, name)).isFile()) {
      throw new ProjectsCheckoutError(
        `${shown(name)}: only project files, <slug>.json, may be in ${PROJECTS_FOLDER}/.`,
      );
    }
    const result = parseProjectEntry(name, readFileSync(join(folder, name), "utf8"));
    if (!result.ok)
      throw new ProjectsCheckoutError(`${shown(name)}: ${result.message}`);
    return result.entry;
  });
  return entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The render's settings: the platform settings file's `platform` and `eval`, and each project
 * with the quota its own file states (ADR 0118 appendix A). The file must not list projects any
 * more, and its standard size must be a quota in full.
 */
export function clusterSettingsOf(
  file: PlatformSettingsFile,
  projects: readonly ProjectEntry[],
): ClusterSettings {
  if (!isObject(file)) {
    throw new ProjectsCheckoutError(
      "The platform settings file is not one JSON object.",
    );
  }
  if ("projects" in file) {
    throw new ProjectsCheckoutError(
      `The platform settings file still lists projects: the project list is ${PROJECTS_REPOSITORY} (D-377).`,
    );
  }
  if (parseProjectQuota(file.projectStandardQuota) === null) {
    throw new ProjectsCheckoutError(
      "projectStandardQuota in the platform settings file is not a quota in full (D-436).",
    );
  }
  return {
    platform: file.platform,
    projects: projects.map(({ slug, quota }) => ({ slug, quota })),
    ...(file.eval ? { eval: file.eval } : {}),
  };
}

/**
 * The platform namespace, the runner's namespace, one agent namespace per project, then the
 * weekly model test's namespace when the settings give one. The run watcher watches exactly the
 * agent namespaces, and each one binds its Role (D-330).
 */
export function clusterObjects(settings: ClusterSettings): {
  apiVersion: "v1";
  kind: "List";
  items: (PlatformObject | NamespaceObject)[];
} {
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      ...platformObjects(
        settings.platform,
        settings.projects.map((p) => p.slug),
      ),
      ...runnerNamespaceObjects(),
      ...settings.projects.flatMap((p) => agentNamespaceObjects(p.slug, p.quota)),
      ...(settings.eval ? evalNamespaceObjects(settings.eval.quota) : []),
    ],
  };
}

/** A copy of `value` with every empty list left out, at any depth. */
function withoutEmptyLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmptyLists);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => [k, withoutEmptyLists(v)]),
    );
  }
  return value;
}

/**
 * The objects as the Platform workflow hands them to `kubectl apply --server-side`: each
 * NetworkPolicy's spec without its empty lists (a rule list with no rule, an `except` with no
 * range). They mean the same as the field left out, and the API server stores them so, but it
 * counts receiving `[]` for a field it holds as absent as a change and raises the object's
 * generation on every apply, so the plan would list those policies as changed on every run and
 * ask Didi to approve an apply that changes nothing (O-119). Nothing else is touched.
 */
export function forServerSideApply(
  list: ReturnType<typeof clusterObjects>,
): ReturnType<typeof clusterObjects> {
  return {
    ...list,
    items: list.items.map((item) =>
      item.kind === "NetworkPolicy"
        ? ({ ...item, spec: withoutEmptyLists(item.spec) } as typeof item)
        : item,
    ),
  };
}

/** What `node infra/kubernetes/render.ts <settings.json> <projects checkout>` prints. */
export function renderFiles(settingsPath: string, projectsDir: string) {
  const file = JSON.parse(readFileSync(settingsPath, "utf8")) as PlatformSettingsFile;
  return forServerSideApply(
    clusterObjects(clusterSettingsOf(file, readProjectsCheckout(projectsDir))),
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [settingsPath, projectsDir] = process.argv.slice(2);
  if (!settingsPath || !projectsDir) {
    console.error(
      "usage: node infra/kubernetes/render.ts <settings.json> <projects checkout>",
    );
    process.exit(2);
  }
  let rendered: ReturnType<typeof renderFiles>;
  try {
    rendered = renderFiles(settingsPath, projectsDir);
  } catch (error) {
    // The message names the setting or the file at fault, never a value from a secret: there is
    // none in either input.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
}
