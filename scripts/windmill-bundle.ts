// The Windmill deploy's bundle job (D-371, O-121, O-123). Run from the repository root, with no
// secret and no network:
//
//   node scripts/windmill-bundle.ts --commit <full commit id> --out <empty folder>
//
// It reads flows/windmill.yaml and bundles each script entry with esbuild as O-121's interface
// says (CommonJS for Node 22, `pg-native` left out, and the files in `bundle_files` embedded with
// `bundleFilesDefine`), into <out>/bundles/<name>.js. It then writes <out>/manifest.json, the one
// file the deploy job's protected script reads (.github/scripts/windmill-deploy.sh):
//
//   - `scripts`: each entry's Windmill path, its TypeScript source (Windmill reads `main`'s
//     arguments from it), its `job_token_scopes`, and its bundle's sha256 and size;
//   - `schedules`: each scheduled entry's cron, time zone and script, as the yaml gives them;
//   - `values`: the plain values the deploy writes, by name (D-371: exact names, never a secret).
//
// The plain values and where each comes from (every source is committed and reviewed):
//
//   spec_version                 the commit given (`--commit`), the one the bundles are built from
//   github_developer_app_login   `platform.receiver` in infra/kubernetes/settings/production.json,
//   github_designer_app_login      the names the receiver uses (step 13)
//   github_runner_app_slug
//   agent_images                 `agentImages` in infra/kubernetes/settings/agent-runs.json
//   agent_run_settings           `runSettings` in the same file, with `proxyImage` from the
//                                platform's `images.egressProxy` (the same digest, runbook step 7),
//                                `stateApi` from `stateApiRunSettings()` and `clusterDns` from the
//                                platform settings, so neither is kept twice
//
// A value whose images are still empty there is left out and named in the summary, so nothing
// half made reaches Windmill; anything else that is wrong stops the job, naming the setting. The
// approval flow (`trigger: approval_resume`) is not deployed: its `ask` step is not built (M4.1)
// and the deploy token has no flows scope (D-371). The summary, printed on stdout in Markdown,
// lists each script with its bundle's sha256 and size, each schedule, and each value by name with
// the sha256 of its text. The same checkout always gives the same bundles and manifest.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { build } from "esbuild";
import { parse as parseYaml } from "yaml";

import {
  checkSettings,
  type KubernetesRunSettings,
} from "../src/adapters/agent-runtime/kubernetes/manifests.ts";
import { bundleFilesDefine } from "../src/adapters/bundle-files/embed.ts";
import { readBotFiles } from "../src/adapters/contracts-file/bot-files.ts";
import {
  stateApiRunSettings,
  type PlatformSettings,
} from "../infra/kubernetes/platform.ts";

export const DESCRIPTION_FILE = "flows/windmill.yaml";
export const PLATFORM_SETTINGS_FILE = "infra/kubernetes/settings/production.json";
export const AGENT_RUNS_FILE = "infra/kubernetes/settings/agent-runs.json";
export const WINDMILL_FOLDER = "f/foreman";

/** The esbuild options of O-121's interface; the define is added per checkout. */
export const BUNDLE_OPTIONS = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["pg-native"],
  logLevel: "silent",
} as const;

/** The plain values the deploy writes, in the order it writes them (D-371). */
export const DEPLOYED_VALUES = [
  "spec_version",
  "github_developer_app_login",
  "github_designer_app_login",
  "github_runner_app_slug",
  "agent_run_settings",
  "agent_images",
] as const;
type ValueName = (typeof DEPLOYED_VALUES)[number];

const TRIGGERS = ["schedule", "called", "approval_resume"] as const;
const NAME = /^[a-z_]+$/;
const ENTRY = /^flows\/[a-z-]+\.ts$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PINNED_IMAGE = /^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$/;
const APP_LOGIN = /^[a-z0-9][a-z0-9-]*\[bot\]$/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const QUANTITY = /^[0-9]+(m|Ki|Mi|Gi)?$/;
const TYPESCRIPT_PACKAGE = /(^|\/)node_modules\/typescript\//;

export interface ManifestScript {
  path: string;
  content: string;
  job_token_scopes: string[];
  sha256: string;
  size: number;
}
export interface ManifestSchedule {
  path: string;
  schedule: string;
  timezone: string;
  script_path: string;
}
export interface ManifestValue {
  name: ValueName;
  value: string;
}
export interface Manifest {
  version: 1;
  commit: string;
  scripts: ManifestScript[];
  schedules: ManifestSchedule[];
  values: ManifestValue[];
}

export interface BundleResult {
  manifest: Manifest;
  /** Each script's bundle by its name (`<name>.js` under `bundles/`). */
  bundles: Map<string, Uint8Array>;
  /** The entries not deployed and the values not written, each with why. */
  notDeployed: { path: string; reason: string }[];
  notWritten: { name: ValueName; reason: string }[];
}

interface FlowEntry {
  name: string;
  path: string;
  entry: string;
  trigger: (typeof TRIGGERS)[number];
  job_token_scopes: string[];
  schedule?: { cron: string; timezone: string };
}

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${path} is not readable JSON`);
  }
}

/** The script entries of the yaml, checked: names, paths, entry files, triggers and scopes. */
function readEntries(description: unknown): {
  entries: FlowEntry[];
  bundleFiles: string[];
  valueNames: string[];
} {
  if (!isObject(description)) throw new Error(`${DESCRIPTION_FILE} is not a mapping`);
  if (description.workspace_folder !== WINDMILL_FOLDER) {
    throw new Error(
      `workspace_folder in ${DESCRIPTION_FILE} is not ${WINDMILL_FOLDER}`,
    );
  }
  const bundleFiles = description.bundle_files;
  if (!Array.isArray(bundleFiles) || !bundleFiles.every((f) => typeof f === "string")) {
    throw new Error(`bundle_files in ${DESCRIPTION_FILE} is not a list of paths`);
  }
  const flows = description.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    throw new Error(`flows in ${DESCRIPTION_FILE} is not a list`);
  }
  const entries = flows.map((flow: unknown, i): FlowEntry => {
    const at = `flows[${i}] in ${DESCRIPTION_FILE}`;
    if (!isObject(flow)) throw new Error(`${at} is not a mapping`);
    const { name, path, entry, trigger, job_token_scopes, schedule } = flow;
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new Error(`${at} has no name of lowercase letters and underscores`);
    }
    if (path !== `${WINDMILL_FOLDER}/${name}`) {
      throw new Error(`${name}'s path is not ${WINDMILL_FOLDER}/${name}`);
    }
    if (typeof entry !== "string" || !ENTRY.test(entry)) {
      throw new Error(`${name}'s entry is not a file in flows/`);
    }
    if (!TRIGGERS.includes(trigger as never)) {
      throw new Error(`${name}'s trigger is not one of ${TRIGGERS.join(", ")}`);
    }
    if (
      !Array.isArray(job_token_scopes) ||
      job_token_scopes.length === 0 ||
      !job_token_scopes.every((s) => typeof s === "string")
    ) {
      throw new Error(`${name} has no job_token_scopes`);
    }
    let checked: FlowEntry["schedule"];
    if (trigger === "schedule") {
      if (
        !isObject(schedule) ||
        typeof schedule.cron !== "string" ||
        typeof schedule.timezone !== "string"
      ) {
        throw new Error(`${name} is scheduled but has no cron and time zone`);
      }
      checked = { cron: schedule.cron, timezone: schedule.timezone };
    } else if (schedule !== undefined) {
      throw new Error(`${name} has a schedule but its trigger is ${String(trigger)}`);
    }
    return {
      name,
      path,
      entry,
      trigger: trigger as FlowEntry["trigger"],
      job_token_scopes: job_token_scopes as string[],
      ...(checked ? { schedule: checked } : {}),
    };
  });
  const names = entries.map((e) => e.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${DESCRIPTION_FILE} names a flow twice`);
  }
  const resources = description.resources;
  const values = isObject(resources) ? resources.values : undefined;
  if (!Array.isArray(values))
    throw new Error(`resources.values in ${DESCRIPTION_FILE} is not a list`);
  // The values the deploy writes are those nobody else does: a value with `written_by` is the
  // runner-token job's (D-352) or Didi's, and the deploy never touches it.
  const valueNames = values
    .filter((v) => isObject(v) && v.written_by === undefined)
    .map((v) => String((v as Record<string, unknown>).name));
  return { entries, bundleFiles: bundleFiles as string[], valueNames };
}

/** A string at `at` that `pattern` accepts, or an error naming `at`. */
function matching(value: unknown, pattern: RegExp, at: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${at} is not ${what}`);
  }
  return value;
}

function wholeNumber(value: unknown, at: string, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${at} is not a whole number from ${min} to ${max}`);
  }
  return value;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  at: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${at} is not an object`);
  const found = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (found.join(",") !== wanted.join(",")) {
    throw new Error(`${at} must hold exactly ${wanted.join(", ")}`);
  }
  return value;
}

/** An image reference pinned by digest, or `undefined` while the committed file leaves it empty. */
function pinnedOrEmpty(value: unknown, at: string): string | undefined {
  if (value === "") return undefined;
  return matching(value, PINNED_IMAGE, at, "an image reference pinned by digest");
}

const RUN_SETTINGS_KEYS = [
  "fetchImage",
  "repoMapImage",
  "proxyPort",
  "runAsUser",
  "resources",
  "scratchSizeLimit",
  "terminationGracePeriodSeconds",
  "ttlSecondsAfterFinished",
  "proxyDeadlineMarginSeconds",
  "fetchMaxMinutes",
  "repoMapMaxMinutes",
  "workspace",
] as const;
const RESOURCE_KINDS = ["agent", "proxy", "fetch", "repoMap"] as const;
const RESOURCE_NAMES = ["cpu", "memory", "ephemeral-storage"] as const;

/**
 * `agent_run_settings` as the runner reads it (KubernetesRunSettings), or why it is not ready.
 * Refuses anything malformed, naming the setting.
 */
function agentRunSettings(
  committed: unknown,
  platform: PlatformSettings,
): { value: string } | { reason: string } {
  const at = `runSettings in ${AGENT_RUNS_FILE}`;
  const s = exactKeys(committed, RUN_SETTINGS_KEYS, at);
  const fetchImage = pinnedOrEmpty(s.fetchImage, `${at}: fetchImage`);
  const repoMapImage = pinnedOrEmpty(s.repoMapImage, `${at}: repoMapImage`);
  const proxyImage = matching(
    platform.images?.egressProxy,
    PINNED_IMAGE,
    `platform.images.egressProxy in ${PLATFORM_SETTINGS_FILE}`,
    "an image reference pinned by digest",
  );
  const resources = exactKeys(s.resources, RESOURCE_KINDS, `${at}: resources`);
  for (const kind of RESOURCE_KINDS) {
    const r = exactKeys(
      resources[kind],
      ["requests", "limits"],
      `${at}: resources.${kind}`,
    );
    for (const side of ["requests", "limits"] as const) {
      const list = exactKeys(
        r[side],
        RESOURCE_NAMES,
        `${at}: resources.${kind}.${side}`,
      );
      for (const name of RESOURCE_NAMES) {
        matching(
          list[name],
          QUANTITY,
          `${at}: resources.${kind}.${side}.${name}`,
          "a quantity",
        );
      }
    }
  }
  matching(s.scratchSizeLimit, QUANTITY, `${at}: scratchSizeLimit`, "a quantity");
  wholeNumber(s.proxyPort, `${at}: proxyPort`, 1, 65535);
  wholeNumber(s.runAsUser, `${at}: runAsUser`, 1, 2147483647);
  for (const key of [
    "terminationGracePeriodSeconds",
    "ttlSecondsAfterFinished",
    "proxyDeadlineMarginSeconds",
    "fetchMaxMinutes",
    "repoMapMaxMinutes",
  ] as const) {
    wholeNumber(s[key], `${at}: ${key}`, 1, 604800);
  }
  if (!isObject(s.workspace)) throw new Error(`${at}: workspace is not an object`);
  matching(s.workspace.size, QUANTITY, `${at}: workspace.size`, "a quantity");
  if (s.workspace.storageClassName !== undefined) {
    matching(
      s.workspace.storageClassName,
      /^[a-z0-9.-]+$/,
      `${at}: workspace.storageClassName`,
      "a storage class name",
    );
  }
  exactKeys(
    s.workspace,
    s.workspace.storageClassName === undefined
      ? ["size"]
      : ["size", "storageClassName"],
    `${at}: workspace`,
  );
  if (fetchImage === undefined)
    return { reason: `fetchImage is empty in ${AGENT_RUNS_FILE}` };
  if (repoMapImage === undefined) {
    return { reason: `repoMapImage is empty in ${AGENT_RUNS_FILE}` };
  }
  // KubernetesRunSettings' own order, so the text is the same for the same settings.
  const settings: KubernetesRunSettings = {
    proxyImage,
    fetchImage,
    repoMapImage,
    proxyPort: s.proxyPort as number,
    runAsUser: s.runAsUser as number,
    resources: s.resources as KubernetesRunSettings["resources"],
    scratchSizeLimit: s.scratchSizeLimit as string,
    terminationGracePeriodSeconds: s.terminationGracePeriodSeconds as number,
    ttlSecondsAfterFinished: s.ttlSecondsAfterFinished as number,
    proxyDeadlineMarginSeconds: s.proxyDeadlineMarginSeconds as number,
    fetchMaxMinutes: s.fetchMaxMinutes as number,
    repoMapMaxMinutes: s.repoMapMaxMinutes as number,
    workspace: s.workspace as KubernetesRunSettings["workspace"],
    stateApi: stateApiRunSettings(),
    clusterDns: platform.clusterDns,
  };
  // The runtime's own check (src/adapters/agent-runtime/kubernetes/manifests.ts).
  checkSettings(settings);
  return { value: JSON.stringify(settings) };
}

/** `agent_images`: one image per kind the bot files name, or why it is not ready. */
function agentImages(committed: unknown): { value: string } | { reason: string } {
  const kinds = [
    ...new Set(Object.values(readBotFiles()).map((bot) => bot.image)),
  ].sort();
  const at = `agentImages in ${AGENT_RUNS_FILE}`;
  const images = exactKeys(committed, kinds, at);
  const pinned = Object.fromEntries(
    kinds.map((kind) => [kind, pinnedOrEmpty(images[kind], `${at}: ${kind}`)]),
  );
  const empty = kinds.find((kind) => pinned[kind] === undefined);
  if (empty !== undefined) return { reason: `${empty} is empty in ${AGENT_RUNS_FILE}` };
  return { value: JSON.stringify(pinned) };
}

function appNames(platform: PlatformSettings): Record<string, string> {
  const receiver: Record<string, unknown> = isObject(platform.receiver)
    ? platform.receiver
    : {};
  const at = (key: string) => `platform.receiver.${key} in ${PLATFORM_SETTINGS_FILE}`;
  return {
    github_developer_app_login: matching(
      receiver.developerAppLogin,
      APP_LOGIN,
      at("developerAppLogin"),
      "an App's login (<slug>[bot])",
    ),
    github_designer_app_login: matching(
      receiver.designerAppLogin,
      APP_LOGIN,
      at("designerAppLogin"),
      "an App's login (<slug>[bot])",
    ),
    github_runner_app_slug: matching(
      receiver.runnerAppSlug,
      APP_SLUG,
      at("runnerAppSlug"),
      "an App's slug",
    ),
  };
}

export interface BundleOptions {
  commit: string;
  /** The repository root; every path above is read from here. */
  root?: string;
  platformSettingsFile?: string;
  agentRunsFile?: string;
}

/** Bundles every script entry and builds the manifest, writing nothing. */
export async function bundleForWindmill(options: BundleOptions): Promise<BundleResult> {
  const root = resolve(options.root ?? ".");
  const commit = matching(options.commit, COMMIT, "--commit", "a full commit id");
  const { entries, bundleFiles, valueNames } = readEntries(
    parseYaml(readFileSync(join(root, DESCRIPTION_FILE), "utf8")),
  );
  const platformFile =
    options.platformSettingsFile ?? join(root, PLATFORM_SETTINGS_FILE);
  const platformSettings = readJson(platformFile);
  if (!isObject(platformSettings) || !isObject(platformSettings.platform)) {
    throw new Error(`${PLATFORM_SETTINGS_FILE} has no platform settings`);
  }
  const platform = platformSettings.platform as unknown as PlatformSettings;
  const agentRuns = exactKeys(
    readJson(options.agentRunsFile ?? join(root, AGENT_RUNS_FILE)),
    ["agentImages", "runSettings"],
    AGENT_RUNS_FILE,
  );

  const scripts = entries.filter((e) => e.trigger !== "approval_resume");
  const notDeployed = entries
    .filter((e) => e.trigger === "approval_resume")
    .map((e) => ({
      path: e.path,
      reason:
        "a Windmill flow whose ask step is not built (M4.1); the deploy token has no flows scope (D-371)",
    }));

  const result = await build({
    ...BUNDLE_OPTIONS,
    external: [...BUNDLE_OPTIONS.external],
    absWorkingDir: root,
    entryPoints: Object.fromEntries(scripts.map((e) => [e.name, `./${e.entry}`])),
    outdir: "windmill-bundles",
    write: false,
    metafile: true,
    define: bundleFilesDefine(bundleFiles, root),
  });
  const bundles = new Map<string, Uint8Array>();
  for (const [out, meta] of Object.entries(result.metafile.outputs)) {
    const entry = scripts.find((e) => meta.entryPoint === e.entry);
    if (entry === undefined) continue;
    // O-121: the TypeScript compiler runs only in the repo map Job's image, never in a flow.
    if (Object.keys(meta.inputs).some((input) => TYPESCRIPT_PACKAGE.test(input))) {
      throw new Error(`${entry.entry}'s bundle includes the TypeScript compiler`);
    }
    const file = result.outputFiles.find((f) => f.path === resolve(root, out));
    if (file === undefined)
      throw new Error(`esbuild wrote no bundle for ${entry.entry}`);
    bundles.set(entry.name, file.contents);
  }
  for (const entry of scripts) {
    if (!bundles.has(entry.name))
      throw new Error(`esbuild wrote no bundle for ${entry.entry}`);
  }

  const sources: Record<ValueName, () => { value: string } | { reason: string }> = {
    spec_version: () => ({ value: commit }),
    ...Object.fromEntries(
      Object.entries(appNames(platform)).map(([name, value]) => [
        name,
        () => ({ value }),
      ]),
    ),
    agent_run_settings: () => agentRunSettings(agentRuns.runSettings, platform),
    agent_images: () => agentImages(agentRuns.agentImages),
  } as Record<ValueName, () => { value: string } | { reason: string }>;
  if ([...valueNames].sort().join(",") !== [...DEPLOYED_VALUES].sort().join(",")) {
    throw new Error(
      `The values ${DESCRIPTION_FILE} leaves to the deploy are not ${DEPLOYED_VALUES.join(", ")}`,
    );
  }
  const values: ManifestValue[] = [];
  const notWritten: BundleResult["notWritten"] = [];
  for (const name of DEPLOYED_VALUES) {
    const got = sources[name]();
    if ("value" in got) values.push({ name, value: got.value });
    else notWritten.push({ name, reason: got.reason });
  }

  const manifest: Manifest = {
    version: 1,
    commit,
    scripts: scripts.map((e) => {
      const bundle = bundles.get(e.name) as Uint8Array;
      return {
        path: e.path,
        content: readFileSync(join(root, e.entry), "utf8"),
        job_token_scopes: e.job_token_scopes,
        sha256: sha256(bundle),
        size: bundle.byteLength,
      };
    }),
    schedules: scripts
      .filter((e) => e.schedule !== undefined)
      .map((e) => ({
        path: e.path,
        schedule: e.schedule?.cron as string,
        timezone: e.schedule?.timezone as string,
        script_path: e.path,
      })),
    values,
  };
  return { manifest, bundles, notDeployed, notWritten };
}

/** The job summary: what the deploy job uploads once Didi approves it. */
export function summary(result: BundleResult): string {
  const { manifest } = result;
  const lines = [
    "## Windmill deploy: what the approved job uploads",
    "",
    `Built from commit \`${manifest.commit}\`. The \`windmill-deploy\` job uploads exactly these once Didi approves it (D-371). Windmill keeps a script whose bundle and settings are unchanged as it is.`,
    "",
    "### Scripts",
    "",
    "| Path | Bundle sha256 | Bytes | Job token scopes |",
    "| --- | --- | --- | --- |",
    ...manifest.scripts.map(
      (s) =>
        `| \`${s.path}\` | \`${s.sha256}\` | ${s.size} | ${s.job_token_scopes.map((x) => `\`${x}\``).join(", ")} |`,
    ),
    "",
    ...result.notDeployed.map((n) => `Not deployed: \`${n.path}\`, ${n.reason}.`),
    "",
    "### Schedules",
    "",
    "| Path | Cron | Time zone | Runs |",
    "| --- | --- | --- | --- |",
    ...manifest.schedules.map(
      (s) =>
        `| \`${s.path}\` | \`${s.schedule}\` | ${s.timezone} | \`${s.script_path}\` |`,
    ),
    "",
    "### Plain values",
    "",
    "Each is a plain Windmill variable (never a secret one). The text of each is in the artifact's `manifest.json`.",
    "",
    "| Variable | sha256 of the value | Bytes |",
    "| --- | --- | --- |",
    ...manifest.values.map(
      (v) =>
        `| \`${WINDMILL_FOLDER}/${v.name}\` | \`${sha256(v.value)}\` | ${Buffer.byteLength(v.value)} |`,
    ),
    "",
    ...result.notWritten.map(
      (n) => `Not written: \`${WINDMILL_FOLDER}/${n.name}\`, since ${n.reason}.`,
    ),
  ];
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** Writes the bundles and the manifest into `out`, which must be empty or missing. */
export function writeBundleResult(result: BundleResult, out: string): void {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`${out} is not empty`);
  }
  mkdirSync(join(out, "bundles"), { recursive: true });
  for (const [name, bundle] of result.bundles) {
    writeFileSync(join(out, "bundles", `${name}.js`), bundle);
  }
  writeFileSync(
    join(out, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const { values } = parseArgs({
      options: { commit: { type: "string" }, out: { type: "string" } },
      strict: true,
    });
    if (values.out === undefined) throw new Error("--out is required");
    const result = await bundleForWindmill({ commit: values.commit ?? "" });
    writeBundleResult(result, values.out);
    process.stdout.write(summary(result));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
