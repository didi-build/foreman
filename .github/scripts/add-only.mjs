// The add-only rule (D-378, D-444, ADR 0118 appendix B, O-158): whether a Platform or Infra plan
// only adds standard-size projects, so that its apply may run in an environment with no reviewer.
// Anything else, and any doubt, waits for Didi's approval as before (D-339).
//
// It lives under .github/, a privileged path Didi reviews, and imports Node's built-ins only, so
// the jobs that hold the admin credentials run it without any of the repository's other code, and
// no pull request changes the rule without Didi. It reads kinds, names, plan addresses and
// actions, never a value from a secret, and prints only fixed text and project slugs.
//
//   node .github/scripts/add-only.mjs candidates <platform settings JSON> <projects checkout>
//     Prints {"schema":1,"candidates":[...]}: the projects whose file has the standard size
//     (`projectStandardQuota`, field by field, D-436) and the Cloudflare target.
//   node .github/scripts/add-only.mjs platform-lists <manifests> <candidates> <work folder>
//     Reads <work>/new.txt, the namespaces the cluster lacks (platform-add-only.sh), checks them
//     and writes <work>/base.json (the render without them, and the run watcher's namespace list
//     without them) and <work>/rest.json (the render without them) for kubectl diff.
//   node .github/scripts/add-only.mjs platform-verdict <work folder>
//     Reads <work>/new.txt and the two diffs, base-diff.txt and rest-diff.txt (platform-diff.sh's
//     lines).
//   node .github/scripts/add-only.mjs infra <plan changes JSON> <candidates> <plan line>
//     Reads the plan's addresses, modes, types and actions (infra-add-only.sh) and its own
//     "Plan:" line.
//
// Every command but `candidates` prints one line. Exit 0: the plan is add-only, and the line is
// the new projects, comma-separated. Exit 1: it is not, and the line is the reason, fixed text.
// Anything unexpected exits non-zero too, so every caller fails closed.
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** At most this many projects in one add-only run (appendix B): a cap that fails closed. */
export const MAX_NEW_PROJECTS = 3;

/** The project slug rule, PROJECT_ENTRY_SLUG in src/core/project-entry.ts (a test keeps them equal). */
export const SLUG = /^(?=[a-z0-9-]{1,47}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Each project's staging names are under this zone (`project_domain`, infra/stacks/factory/main.tf). */
export const PROJECT_DOMAIN = "didi.build";

/** A project's agent namespace (`agentNamespace`, src/adapters/agent-runtime/kubernetes/names.ts). */
export const AGENT_NAMESPACE_PREFIX = "agents-";
/** The label naming an agent namespace's project (`LABEL_PROJECT`). */
export const PROJECT_LABEL = "foreman/project";
/** The run watcher's Deployment and its namespace list (infra/kubernetes/platform.ts, D-330). */
export const WATCHER = {
  namespace: "foreman-platform",
  name: "run-watcher",
  env: "AGENT_NAMESPACES",
};
/** The one line platform-diff.sh prints for the run watcher's Deployment when it changes. */
export const WATCHER_UPDATE = `update apps.v1.Deployment.${WATCHER.namespace}.${WATCHER.name}`;

/** The fields of a project's quota (`projectStandardQuota`, ADR 0118 appendix A). */
const QUOTA_FIELDS = [
  "cpu",
  "ephemeralStorage",
  "memory",
  "persistentVolumeClaims",
  "pods",
  "storage",
];

/** The settings repository's marker and its project folder (src/core/project-entry.ts). */
const MARKER_FILE = "foreman-projects.json";
const PROJECTS_FOLDER = "projects";

/** Why a plan is not add-only: one fixed line each, quoting nothing from the plan. */
export const REASONS = {
  candidates: "the list of standard-size projects could not be read",
  manifests: "the rendered objects could not be read",
  noProject: "the plan adds no project",
  tooMany: `the plan adds more than ${MAX_NEW_PROJECTS} projects in one run`,
  notCandidate:
    "a project it adds does not have the standard size and the Cloudflare target",
  notLikeExisting:
    "a new namespace's objects are not exactly those of a standard-size project already on the cluster",
  watcher: "the run watcher's namespace list could not be read",
  watcherList:
    "the run watcher's namespace list does not gain exactly the new namespaces",
  diff: "the cluster's diff could not be read",
  drift: "the cluster differs from main outside the new projects",
  otherChange:
    "the plan changes more than the new projects and the run watcher's namespace list",
  plan: "the plan could not be read",
  delete: "the plan deletes or replaces something",
  update: "the plan changes something that already exists",
  otherCreate:
    "the plan creates something other than a project's DNS record and Workers route",
  unpaired: "a project's DNS record and Workers route are not both created",
  outputs: "the plan changes an output",
  count: "the plan's own count is not two creates per project",
};

/** The plan is not add-only, for this fixed reason. */
export class NotAddOnly extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = "NotAddOnly";
  }
}

/** @param {string} reason @returns {never} */
const refuse = (reason) => {
  throw new NotAddOnly(reason);
};

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {string} JSON with every object's keys sorted, to compare. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} text @param {string} reason */
function parsed(text, reason) {
  try {
    return JSON.parse(text);
  } catch {
    return refuse(reason);
  }
}

/** A quota in full, with exactly the six fields: whole counts and plain quantities. */
function isQuota(value) {
  return (
    isObject(value) &&
    canonical(Object.keys(value).sort()) === canonical(QUOTA_FIELDS) &&
    Number.isSafeInteger(value.pods) &&
    Number.isSafeInteger(value.persistentVolumeClaims) &&
    ["cpu", "memory", "ephemeralStorage", "storage"].every(
      (field) => typeof value[field] === "string",
    )
  );
}

/** Field by field, exactly: `6` and `6.0`, or `5Gi` and `5120Mi`, are not the same here. */
const sameQuota = (a, b) =>
  isQuota(a) && isQuota(b) && QUOTA_FIELDS.every((field) => a[field] === b[field]);

/**
 * The candidates (appendix B, Platform step 1): every project file with the standard size, field
 * by field, and the Cloudflare target. A candidate is not yet new: the plan jobs find which ones
 * the cluster or the DNS lacks. Anything off in the checkout throws, so the caller has no
 * candidates and the run waits for Didi.
 *
 * @param {unknown} settings the platform settings file, parsed
 * @param {{ marker: string, files: { name: string, text: string }[] }} checkout
 */
export function candidatesOf(settings, checkout) {
  const standard = isObject(settings) ? settings.projectStandardQuota : undefined;
  if (!isQuota(standard)) refuse(REASONS.candidates);
  const marker = parsed(checkout.marker, REASONS.candidates);
  if (canonical(marker) !== canonical({ schema: 1 })) refuse(REASONS.candidates);
  const slugs = [];
  for (const { name, text } of checkout.files) {
    if (!name.endsWith(".json")) refuse(REASONS.candidates);
    const file = parsed(text, REASONS.candidates);
    const slug = name.slice(0, -".json".length);
    if (
      isObject(file) &&
      file.schema === 1 &&
      file.slug === slug &&
      SLUG.test(slug) &&
      file.deployTarget === "cloudflare" &&
      sameQuota(file.quota, standard)
    ) {
      slugs.push(slug);
    }
  }
  return { schema: 1, candidates: slugs.sort() };
}

/** The checkout's marker and project files, read as they are. Throws on anything else. */
export function readCheckout(dir) {
  const folder = join(dir, PROJECTS_FOLDER);
  if (!lstatSync(folder).isDirectory()) refuse(REASONS.candidates);
  return {
    marker: readFileSync(join(dir, MARKER_FILE), "utf8"),
    files: readdirSync(folder)
      .sort()
      .map((name) => {
        if (!lstatSync(join(folder, name)).isFile()) refuse(REASONS.candidates);
        return { name, text: readFileSync(join(folder, name), "utf8") };
      }),
  };
}

/** The render job's candidates file, checked. */
function candidateSlugs(value) {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every((slug) => typeof slug === "string" && SLUG.test(slug)) ||
    new Set(value.candidates).size !== value.candidates.length
  ) {
    refuse(REASONS.candidates);
  }
  return new Set(value.candidates);
}

/**
 * The new projects: one to three, each a slug and, when `candidates` is given, a candidate.
 *
 * @param {string[]} slugs
 * @param {Set<string> | null} candidates
 */
function checkProjects(slugs, candidates) {
  if (slugs.length === 0) refuse(REASONS.noProject);
  if (slugs.length > MAX_NEW_PROJECTS) refuse(REASONS.tooMany);
  for (const slug of slugs) {
    if (!SLUG.test(slug) || (candidates !== null && !candidates.has(slug))) {
      refuse(REASONS.notCandidate);
    }
  }
  return [...slugs].sort();
}

/** The slugs of the namespaces the cluster lacks: each must be an agent namespace, `agents-<slug>`. */
function slugsOfNamespaces(namespaces) {
  if (
    !Array.isArray(namespaces) ||
    !namespaces.every((ns) => typeof ns === "string") ||
    new Set(namespaces).size !== namespaces.length
  ) {
    refuse(REASONS.diff);
  }
  return namespaces.map((ns) =>
    ns.startsWith(AGENT_NAMESPACE_PREFIX)
      ? ns.slice(AGENT_NAMESPACE_PREFIX.length)
      : refuse(REASONS.notCandidate),
  );
}

/** One rendered object, checked as far as the rule reads it. */
function isListedObject(item) {
  return (
    isObject(item) &&
    typeof item.kind === "string" &&
    isObject(item.metadata) &&
    typeof item.metadata.name === "string" &&
    (item.metadata.namespace === undefined ||
      typeof item.metadata.namespace === "string")
  );
}

/** The namespace `ns` and every object in it. */
const objectsOf = (items, ns) =>
  items.filter(
    (o) =>
      (o.kind === "Namespace" && o.metadata.name === ns) || o.metadata.namespace === ns,
  );

/** The objects as one comparable text, in a fixed order. */
const listText = (objects) => objects.map(canonical).sort().join("\n");

/**
 * An existing project's objects as they would be for another project: its namespace's name, each
 * object's namespace and the project label, and nothing else.
 */
function asProject(objects, fromSlug, toSlug) {
  const to = `${AGENT_NAMESPACE_PREFIX}${toSlug}`;
  return objects.map((object) => {
    const copy = structuredClone(object);
    if (copy.kind === "Namespace") copy.metadata.name = to;
    else copy.metadata.namespace = to;
    if (
      isObject(copy.metadata.labels) &&
      copy.metadata.labels[PROJECT_LABEL] === fromSlug
    ) {
      copy.metadata.labels[PROJECT_LABEL] = toSlug;
    }
    return copy;
  });
}

/** The run watcher's one AGENT_NAMESPACES entry, or a refusal. */
function watcherEntry(items) {
  const watchers = items.filter(
    (o) =>
      o.kind === "Deployment" &&
      o.metadata.namespace === WATCHER.namespace &&
      o.metadata.name === WATCHER.name,
  );
  if (watchers.length !== 1) refuse(REASONS.watcher);
  const containers = watchers[0].spec?.template?.spec?.containers;
  if (!Array.isArray(containers)) refuse(REASONS.watcher);
  const entries = containers.flatMap((c) =>
    isObject(c) && Array.isArray(c.env)
      ? c.env.filter((e) => isObject(e) && e.name === WATCHER.env)
      : [],
  );
  if (
    entries.length !== 1 ||
    typeof entries[0].value !== "string" ||
    Object.keys(entries[0]).sort().join(",") !== "name,value"
  ) {
    refuse(REASONS.watcher);
  }
  return { watcher: watchers[0], entry: entries[0] };
}

/**
 * Appendix B, Platform steps 2 and 3, before the diffs: each new namespace is a candidate's, one
 * to three of them, and holds exactly the objects of a standard-size project already rendered and
 * not new, with only the namespace and the project label changed. That project's objects are in
 * the base list, which must then match the cluster exactly, so the new namespace looks exactly
 * like one Didi's apply, or an earlier add-only apply checked the same way, put there. The run
 * watcher's namespace list holds each new namespace once. The base list is the render without the
 * new namespaces' objects and with the watcher's list as it was before them; the rest list is the
 * render without the new namespaces' objects.
 *
 * @param {unknown} manifests the rendered objects, with the API server's address put in
 * @param {unknown} candidatesFile the render job's candidates
 * @param {string[]} newNamespaces the namespaces the cluster lacks
 */
export function platformLists(manifests, candidatesFile, newNamespaces) {
  const candidates = candidateSlugs(candidatesFile);
  if (
    !isObject(manifests) ||
    manifests.kind !== "List" ||
    !Array.isArray(manifests.items) ||
    !manifests.items.every(isListedObject)
  ) {
    refuse(REASONS.manifests);
  }
  const items = manifests.items;
  const projects = checkProjects(slugsOfNamespaces(newNamespaces), candidates);
  const isNew = (o) =>
    (o.kind === "Namespace" && newNamespaces.includes(o.metadata.name)) ||
    newNamespaces.includes(o.metadata.namespace);

  const existing = [...candidates].filter(
    (slug) =>
      !projects.includes(slug) &&
      items.some(
        (o) =>
          o.kind === "Namespace" &&
          o.metadata.name === `${AGENT_NAMESPACE_PREFIX}${slug}`,
      ),
  );
  for (const slug of projects) {
    const ns = `${AGENT_NAMESPACE_PREFIX}${slug}`;
    const mine = listText(objectsOf(items, ns));
    const likeOne = existing.some(
      (other) =>
        listText(
          asProject(objectsOf(items, `${AGENT_NAMESPACE_PREFIX}${other}`), other, slug),
        ) === mine,
    );
    if (!likeOne) refuse(REASONS.notLikeExisting);
  }

  const { entry } = watcherEntry(items);
  const watched = entry.value.split(",");
  if (!newNamespaces.every((ns) => watched.filter((w) => w === ns).length === 1)) {
    refuse(REASONS.watcherList);
  }
  const rest = items.filter((o) => !isNew(o));
  const base = rest.map((o) => {
    if (
      o.kind !== "Deployment" ||
      o.metadata.namespace !== WATCHER.namespace ||
      o.metadata.name !== WATCHER.name
    ) {
      return o;
    }
    const copy = structuredClone(o);
    for (const container of copy.spec.template.spec.containers) {
      for (const env of container.env ?? []) {
        if (isObject(env) && env.name === WATCHER.env) {
          env.value = watched.filter((w) => !newNamespaces.includes(w)).join(",");
        }
      }
    }
    return copy;
  });
  return {
    projects,
    base: { ...manifests, items: base },
    rest: { ...manifests, items: rest },
  };
}

/** platform-diff.sh's lines, each `create <file>` or `update <file>`. */
function diffLines(text) {
  const lines = text.split("\n").filter((line) => line !== "");
  if (!lines.every((line) => /^(create|update) [A-Za-z0-9._-]+$/.test(line))) {
    refuse(REASONS.diff);
  }
  return lines;
}

/**
 * Appendix B, Platform steps 3 and 4, from the diffs: the base list changes nothing on the
 * cluster, so the cluster matches main and the existing projects exactly (no pending image, no
 * drift), and the rest of the render changes only the run watcher's Deployment, whose namespace
 * list gains the new namespaces (it restarts). The new namespaces' own objects are all created:
 * the cluster has no such namespace.
 *
 * @param {string[]} newNamespaces
 * @param {string} baseDiff
 * @param {string} restDiff
 */
export function platformVerdict(newNamespaces, baseDiff, restDiff) {
  const projects = checkProjects(slugsOfNamespaces(newNamespaces), null);
  const base = diffLines(baseDiff);
  const rest = diffLines(restDiff);
  if (base.length > 0) refuse(REASONS.drift);
  if (rest.length !== 1 || rest[0] !== WATCHER_UPDATE) refuse(REASONS.otherChange);
  return projects;
}

const PROJECT_ADDRESS =
  /^module\.edge\.(cloudflare_dns_record|cloudflare_workers_route)\.project\["([^"\\]+)"\]$/;

/** One change of the plan as infra-add-only.sh extracts it, checked. */
function isChange(change) {
  return (
    isObject(change) &&
    typeof change.address === "string" &&
    (change.mode === "managed" || change.mode === "data") &&
    typeof change.type === "string" &&
    Array.isArray(change.actions) &&
    change.actions.length > 0 &&
    change.actions.every((a) => typeof a === "string")
  );
}

/**
 * Appendix B, Infra: every change that is not a no-op or a data source's read is a create; each
 * create is a project's DNS record or Workers route, keyed `<slug>.didi.build`; both are created
 * for each such project, which is a candidate in the settings commit; one to three projects; no
 * output changes; and the plan's own line counts exactly two creates per project. The values come
 * from the reviewed module (infra/modules/platform/cloudflare/projects.tf): a change there
 * changes every existing project's record or route, which is an update, so not add-only.
 *
 * @param {unknown} plan { resource_changes: [...], output_changes: [...] }
 * @param {unknown} candidatesFile
 * @param {string} planLine
 */
export function infraVerdict(plan, candidatesFile, planLine) {
  const candidates = candidateSlugs(candidatesFile);
  if (
    !isObject(plan) ||
    !Array.isArray(plan.resource_changes) ||
    !Array.isArray(plan.output_changes) ||
    !plan.resource_changes.every(isChange) ||
    new Set(plan.resource_changes.map((c) => c.address)).size !==
      plan.resource_changes.length ||
    !plan.output_changes.every(
      (o) =>
        isObject(o) &&
        typeof o.name === "string" &&
        Array.isArray(o.actions) &&
        o.actions.every((a) => typeof a === "string"),
    )
  ) {
    refuse(REASONS.plan);
  }
  const kinds = plan.resource_changes.map((change) => {
    const actions = change.actions.join(",");
    if (actions === "no-op") return { skip: true };
    if (actions === "read" && change.mode === "data") return { skip: true };
    if (change.actions.includes("delete")) return { reason: REASONS.delete };
    if (actions === "update") return { reason: REASONS.update };
    if (actions !== "create" || change.mode !== "managed")
      return { reason: REASONS.plan };
    const match = PROJECT_ADDRESS.exec(change.address);
    const host = match?.[2] ?? "";
    const slug = host.endsWith(`.${PROJECT_DOMAIN}`)
      ? host.slice(0, -`.${PROJECT_DOMAIN}`.length)
      : "";
    if (!match || match[1] !== change.type || !SLUG.test(slug)) {
      return { reason: REASONS.otherCreate };
    }
    return { slug, type: change.type };
  });
  for (const reason of [
    REASONS.plan,
    REASONS.delete,
    REASONS.update,
    REASONS.otherCreate,
  ]) {
    if (kinds.some((k) => k.reason === reason)) refuse(reason);
  }
  if (!plan.output_changes.every((o) => o.actions.join(",") === "no-op")) {
    refuse(REASONS.outputs);
  }
  const creates = kinds.filter((k) => k.slug !== undefined);
  const slugs = [...new Set(creates.map((k) => k.slug))].sort();
  for (const slug of slugs) {
    const types = creates
      .filter((k) => k.slug === slug)
      .map((k) => k.type)
      .sort();
    if (types.join(",") !== "cloudflare_dns_record,cloudflare_workers_route") {
      refuse(REASONS.unpaired);
    }
  }
  checkProjects(slugs, candidates);
  if (planLine !== `Plan: ${2 * slugs.length} to add, 0 to change, 0 to destroy.`) {
    refuse(REASONS.count);
  }
  return slugs;
}

/** The namespaces in platform-add-only.sh's new.txt, one per line. */
const namespacesIn = (work) =>
  readFileSync(join(work, "new.txt"), "utf8")
    .split("\n")
    .filter((line) => line !== "");

/** @param {string} path @param {string} reason */
const readJson = (path, reason) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return refuse(reason);
  }
  return parsed(text, reason);
};

/** Runs one command; returns the line to print and the exit status. */
export function runCommand(args) {
  const [command, ...rest] = args;
  try {
    if (command === "candidates" && rest.length === 2) {
      const [settings, checkout] = rest;
      return {
        line: JSON.stringify(
          candidatesOf(readJson(settings, REASONS.candidates), readCheckout(checkout)),
        ),
        status: 0,
      };
    }
    if (command === "platform-lists" && rest.length === 3) {
      const [manifests, candidates, work] = rest;
      const lists = platformLists(
        readJson(manifests, REASONS.manifests),
        readJson(candidates, REASONS.candidates),
        namespacesIn(work),
      );
      writeFileSync(join(work, "base.json"), JSON.stringify(lists.base));
      writeFileSync(join(work, "rest.json"), JSON.stringify(lists.rest));
      return { line: lists.projects.join(","), status: 0 };
    }
    if (command === "platform-verdict" && rest.length === 1) {
      const [work] = rest;
      const read = (name) => readFileSync(join(work, name), "utf8");
      return {
        line: platformVerdict(
          namespacesIn(work),
          read("base-diff.txt"),
          read("rest-diff.txt"),
        ).join(","),
        status: 0,
      };
    }
    if (command === "infra" && rest.length === 3) {
      const [changes, candidates, planLine] = rest;
      return {
        line: infraVerdict(
          readJson(changes, REASONS.plan),
          readJson(candidates, REASONS.candidates),
          planLine,
        ).join(","),
        status: 0,
      };
    }
  } catch (error) {
    // A refusal names its fixed reason; anything else is a doubt, never a pass.
    return {
      line: error instanceof NotAddOnly ? error.message : "the add-only check failed",
      status: 1,
    };
  }
  return {
    line: "usage: add-only.mjs candidates|platform-lists|platform-verdict|infra ...",
    status: 2,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const { line, status } = runCommand(args);
  // `candidates` prints its JSON to stdout, which the caller keeps as a file, and a refusal to
  // stderr; the other commands print their one line to stdout either way.
  (status !== 0 && args[0] === "candidates" ? process.stderr : process.stdout).write(
    `${line}\n`,
  );
  process.exitCode = status;
}
