// The bot files (docs/bot-files.md, ADR 0107, ADR 0106 sections 3, 5 and 6, ADR 0114 section 1):
// one YAML file per agent role in contracts/bots/, loaded at the spec version like the contracts
// (ADR 0105). Each run records its bot file's content hash as `runs.bot_version`.
//
// A bot file holds the role's instructions (the cached prefix of every run's task file), its agent
// image, its tools, its hosts, its model providers with each key's secret path (D-142, D-143), its
// per-run limits (D-185), its task types and, for the Council, Triage and QA's visual comparison,
// its output schemas. A task type other than the role's default may have its own instructions
// (`task_instructions`, QA's `qa:visual`, D-242). It never holds a model (each run's route names it, ADR 0114) or a credential value.
//
// The check is strict and collects every problem: an unknown field is refused, and a problem names
// the file and the field, never a value from the file, so a key pasted into the wrong place cannot
// reach a log. The task types are checked by the core with the task types file
// (src/core/task-types.ts); everything else is checked here, reusing the egress proxy's own
// parsers so a bot file the runner accepts is one the proxy accepts. `checkRunSpec` checks the
// built run again before anything starts.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

import { MAGICPATH_TOOL } from "../../agent-images/opencode/permissions.ts";
import {
  MODEL_APIS,
  ROLES_BY_IMAGE,
  type ImageKind,
  type ModelApi,
} from "../../agent-images/shared/settings.ts";
import { outputSchemaProblems, type OutputSchema } from "../../core/output-schema.ts";
import type { BotProfile } from "../../core/reconcile.ts";
import type { RoleRunLimits, RunLimits } from "../../core/runs.ts";
import type { AgentRole } from "../../core/store.ts";
import { canonicalHost } from "../../egress-proxy/hosts.ts";
import { CREDENTIAL_STYLES, parseProviders } from "../../egress-proxy/providers.ts";
import {
  API_PATH,
  type ModelProviderSetting,
} from "../agent-runtime/kubernetes/manifests.ts";
import { TOOL } from "../agent-runtime/kubernetes/task.ts";

export const BOT_FILES_DIR = "contracts/bots";

export const BOT_ROLES: readonly AgentRole[] = [
  "developer",
  "designer",
  "qa",
  "council",
  "triage",
];

/** The placeholder a provider's secret path uses for the run's project slug (D-143). */
export const PROJECT_PLACEHOLDER = "{project}";

/**
 * A secret path, never a value: `platform/...` or `projects/...` in plain lower-case segments,
 * where a segment may be `{project}`. A key pasted here has no such shape and is refused.
 */
const SECRET_PATH_TEMPLATE =
  /^(?:platform|projects)(?:\/(?:\{project\}|[a-z0-9][a-z0-9_-]{0,62})){1,6}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The roles whose runs push a branch, with their minute limit below the GitHub token's hour. */
const PUSHING: readonly AgentRole[] = ["developer", "designer"];
/** The roles with structured output, and the schema names each must give (D-228). */
const SCHEMA_NAMES: Partial<Record<AgentRole, readonly string[]>> = {
  council: ["escalation", "reversal"],
  triage: ["answer"],
  qa: ["visual"],
};
/** Task types whose runs need instructions of their own (D-242). */
const TASK_INSTRUCTIONS: Partial<Record<AgentRole, readonly string[]>> = {
  qa: ["qa:visual"],
};
/** ADR 0106 section 5: an installation token lasts at most an hour. */
const GITHUB_TOKEN_MINUTES = 60;
const MAX_INSTRUCTION_CHARS = 32_000;

const FIELDS = [
  "role",
  "image",
  "instructions",
  "task_types",
  "limits",
  "providers",
  "allowed_hosts",
  "allowed_tools",
  "mcp",
  "fetch_allowed_hosts",
  "output_schemas",
  "task_instructions",
] as const;

/** One role's bot file, checked. No credential value is in it. */
export interface BotFile {
  role: AgentRole;
  /** `sha256:` and the SHA-256 of the file's bytes. Recorded as `runs.bot_version`. */
  version: string;
  image: ImageKind;
  /** The role's instructions: the stable, cached part of each run's task file. */
  instructions: string;
  /** `{allowed, default}`, checked by the core's validateTaskTypes. */
  taskTypes: unknown;
  limits: RunLimits;
  /** Each provider the role may be routed to. `secretPath` may hold `{project}`. */
  providers: ModelProviderSetting[];
  /** CONNECT hosts for the agent's proxy. Empty for QA, Council and Triage. */
  allowedHosts: string[];
  /** Developer and Designer (D-196). */
  allowedTools?: string[];
  /** Designer: whether MagicPath is on. Always false until D-190's gate. */
  magicPath?: boolean;
  /** QA: the fetch step's GitHub hosts. */
  fetchAllowedHosts?: string[];
  /** Council (by question kind), Triage (`answer`) and QA (`visual`). */
  outputSchemas?: Record<string, OutputSchema>;
  /** Instructions by task type, for a task type that is not the default (QA's `qa:visual`). */
  taskInstructions?: Record<string, string>;
}

export type BotFiles = Record<AgentRole, BotFile>;

/** A bot file as read from disk, before it is checked. */
export interface RawBotFile {
  file: string;
  version: string;
  data: unknown;
}

/**
 * Reads `<role>.yaml` for every agent role from `dir`. A missing file, a file for no role, or a
 * YAML error throws, naming the file and never its content.
 */
export function loadBotFiles(
  dir: string = BOT_FILES_DIR,
): Record<AgentRole, RawBotFile> {
  const names = readdirSync(dir).filter((name) => name.endsWith(".yaml"));
  for (const name of names) {
    if (!BOT_ROLES.some((role) => `${role}.yaml` === name)) {
      throw new Error(`${name} in ${dir} is not the bot file of an agent role`);
    }
  }
  const loaded = {} as Record<AgentRole, RawBotFile>;
  for (const role of BOT_ROLES) {
    const file = `${role}.yaml`;
    if (!names.includes(file)) throw new Error(`${dir}/${file} is missing`);
    const bytes = readFileSync(join(dir, file));
    let data: unknown;
    try {
      data = parse(bytes.toString("utf8"));
    } catch (error) {
      const line =
        error instanceof YAMLParseError && error.linePos
          ? ` at line ${error.linePos[0].line}`
          : "";
      throw new Error(`${file} is not valid YAML${line}`);
    }
    const version = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    loaded[role] = { file, version, data };
  }
  return loaded;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** The run's provider secret path: the template with the project's slug in it. */
export function secretPathFor(template: string, projectSlug: string): string {
  return template.split(PROJECT_PLACEHOLDER).join(projectSlug);
}

function checkLimits(role: AgentRole, raw: unknown, add: (p: string) => void) {
  if (!isRecord(raw)) {
    add("limits needs max_turns, max_minutes and max_usd");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!["max_turns", "max_minutes", "max_usd"].includes(key)) {
      add(`limits: unknown field ${key}`);
    }
  }
  const { max_turns: turns, max_minutes: minutes, max_usd: usd } = raw;
  const whole = (v: unknown): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 1;
  let ok = true;
  if (!whole(turns)) {
    add("limits.max_turns must be a whole number above 0");
    ok = false;
  }
  if (!whole(minutes)) {
    add("limits.max_minutes must be a whole number above 0");
    ok = false;
  } else if (PUSHING.includes(role) && minutes >= GITHUB_TOKEN_MINUTES) {
    add("limits.max_minutes must stay below 60, the GitHub token's lifetime");
    ok = false;
  }
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    add("limits.max_usd must be an amount above 0");
    ok = false;
  }
  return ok
    ? {
        maxTurns: turns as number,
        maxMinutes: minutes as number,
        maxUsd: usd as number,
      }
    : undefined;
}

function checkProviders(
  image: ImageKind | undefined,
  raw: unknown,
  add: (p: string) => void,
) {
  if (!Array.isArray(raw) || raw.length === 0) {
    add("providers must list at least one model provider");
    return undefined;
  }
  const providers: ModelProviderSetting[] = [];
  let ok = true;
  raw.forEach((entry: unknown, i) => {
    const at = `providers[${i}]`;
    const fail = (problem: string) => {
      add(`${at}${problem}`);
      ok = false;
    };
    if (!isRecord(entry)) return fail(" must be a mapping");
    for (const key of Object.keys(entry)) {
      const known = [
        "name",
        "upstream",
        "credential",
        "secret_path",
        "base_url_env",
        "api",
      ];
      if (!known.includes(key)) fail(`: unknown field ${key}`);
    }
    const {
      name,
      upstream,
      credential,
      secret_path: path,
      base_url_env: env,
      api,
    } = entry;
    const provider: ModelProviderSetting = {
      name: name as string,
      upstream: upstream as string,
      credential: credential as ModelProviderSetting["credential"],
    };
    if (!CREDENTIAL_STYLES.includes(credential as never)) {
      fail(".credential must be x-api-key, bearer or none");
    } else if (credential === "none") {
      if (path !== undefined) fail(".secret_path is set, but the credential is none");
    } else if (typeof path !== "string" || !SECRET_PATH_TEMPLATE.test(path)) {
      // Never echo the value: it may be a key pasted in the wrong place (D-143).
      fail(
        `.secret_path must be a secret path such as projects/${PROJECT_PLACEHOLDER}/models/<provider>, never a key`,
      );
    } else {
      provider.secretPath = path;
    }
    if (env !== undefined) {
      if (typeof env !== "string" || !ENV_NAME.test(env)) {
        fail(".base_url_env must be an environment variable name");
      } else provider.baseUrlEnv = env;
    }
    if (api !== undefined) {
      if (
        !isRecord(api) ||
        Object.keys(api).some((k) => k !== "kind" && k !== "path") ||
        !MODEL_APIS.includes(api.kind as ModelApi) ||
        typeof api.path !== "string" ||
        !API_PATH.test(api.path)
      ) {
        fail(`.api must be a kind (${MODEL_APIS.join(" or ")}) and a plain path`);
      } else provider.api = { kind: api.kind as ModelApi, path: api.path };
    }
    // OpenCode reads the provider's API and address; the Messages API image reads
    // ANTHROPIC_BASE_URL and speaks only Anthropic's API.
    if (image === "opencode" && provider.api === undefined) {
      fail(".api is needed: the OpenCode image reads the provider's API");
    }
    if (image === "claude-api" && (env !== "ANTHROPIC_BASE_URL" || api !== undefined)) {
      fail(
        ".base_url_env must be ANTHROPIC_BASE_URL, with no api, for the Messages API image",
      );
    }
    providers.push(provider);
  });
  if (!ok) return undefined;
  try {
    // The proxy's own parser, with a sample slug, checks names, addresses and styles.
    parseProviders(
      JSON.stringify(
        providers.map((p) => ({
          name: p.name,
          upstream: p.upstream,
          credential: p.credential,
          ...(p.secretPath ? { secretPath: secretPathFor(p.secretPath, "slug") } : {}),
        })),
      ),
    );
  } catch (error) {
    add(`providers: ${(error as Error).message}`);
    return undefined;
  }
  return providers;
}

function checkHosts(field: string, raw: unknown, add: (p: string) => void) {
  if (!isTextList(raw)) {
    add(`${field} must be a list of host names`);
    return undefined;
  }
  const bad = raw.findIndex((host) => canonicalHost(host) === undefined);
  if (bad !== -1) {
    add(
      `${field}[${bad}] is not a plain host name (no IP address, port, wildcard or path)`,
    );
    return undefined;
  }
  return [...raw];
}

function checkTools(
  role: AgentRole,
  raw: unknown,
  magicPath: boolean,
  add: (p: string) => void,
) {
  if (!isTextList(raw) || raw.length === 0) {
    add("allowed_tools must be a non-empty list of tools (D-196)");
    return undefined;
  }
  let ok = true;
  raw.forEach((tool, i) => {
    const pattern = /^Bash\((.*)\)$/s.exec(tool)?.[1];
    if (!TOOL.test(tool)) {
      add(`allowed_tools[${i}] is not a tool name`);
      ok = false;
    } else if (
      tool === "Bash" ||
      (pattern !== undefined && /^[\s*?]*$/.test(pattern))
    ) {
      add(`allowed_tools[${i}] would allow every shell command`);
      ok = false;
    } else if (tool === MAGICPATH_TOOL && !(role === "designer" && magicPath)) {
      add(
        `allowed_tools[${i}] needs MagicPath switched on, for the Designer only (D-190)`,
      );
      ok = false;
    }
  });
  return ok ? [...raw] : undefined;
}

function checkMagicPath(raw: unknown, add: (p: string) => void): boolean | undefined {
  const magicpath = isRecord(raw) ? raw.magicpath : undefined;
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((k) => k !== "magicpath") ||
    !isRecord(magicpath) ||
    Object.keys(magicpath).some((k) => k !== "enabled") ||
    typeof magicpath.enabled !== "boolean"
  ) {
    add("mcp must be magicpath: { enabled: true or false }");
    return undefined;
  }
  if (magicpath.enabled) {
    add("mcp.magicpath stays off until its new-credentials gate (D-190)");
    return undefined;
  }
  return false;
}

function checkSchemas(role: AgentRole, raw: unknown, add: (p: string) => void) {
  const names = SCHEMA_NAMES[role] ?? [];
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== [...names].sort().join()) {
    add(`output_schemas must give exactly: ${names.join(", ")}`);
    return undefined;
  }
  const problems = names.flatMap((name) =>
    outputSchemaProblems(raw[name], `output_schemas.${name}`),
  );
  problems.forEach(add);
  return problems.length === 0 ? (raw as Record<string, OutputSchema>) : undefined;
}

function checkTaskInstructions(
  role: AgentRole,
  raw: unknown,
  taskTypes: unknown,
  add: (p: string) => void,
): Record<string, string> | undefined {
  const names = TASK_INSTRUCTIONS[role] ?? [];
  if (names.length === 0) {
    if (raw !== undefined)
      add(`task_instructions: a ${role} run has only its instructions`);
    return undefined;
  }
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== [...names].sort().join()) {
    add(`task_instructions must give exactly: ${names.join(", ")}`);
    return undefined;
  }
  const allowed =
    isRecord(taskTypes) && Array.isArray(taskTypes.allowed) ? taskTypes.allowed : [];
  let ok = true;
  for (const name of names) {
    const value = raw[name];
    if (
      !allowed.includes(name) ||
      (isRecord(taskTypes) && taskTypes.default === name)
    ) {
      add(
        `task_instructions.${name} must be an allowed task type other than the default`,
      );
      ok = false;
    }
    if (!isText(value)) {
      add(`task_instructions.${name} must be non-empty text`);
      ok = false;
    } else if (value.length > MAX_INSTRUCTION_CHARS) {
      add(
        `task_instructions.${name} must be at most ${MAX_INSTRUCTION_CHARS} characters`,
      );
      ok = false;
    }
  }
  return ok ? { ...(raw as Record<string, string>) } : undefined;
}

/** Checks one role's parsed bot file. Every problem names the file and the field. */
function checkBotFile(
  role: AgentRole,
  raw: RawBotFile,
  problems: string[],
): BotFile | null {
  const before = problems.length;
  const add = (problem: string) => problems.push(`${raw.file}: ${problem}`);
  const data = raw.data;
  if (!isRecord(data)) {
    add("must be a mapping");
    return null;
  }
  for (const key of Object.keys(data)) {
    if (key === "model") {
      add("model is not a bot file field: each run's route names the model (ADR 0114)");
    } else if (!(FIELDS as readonly string[]).includes(key)) {
      add(`unknown field ${key}`);
    }
  }
  if (data.role !== role) add(`role must be ${role}, the file's own role`);

  const image = data.image as ImageKind;
  const imageOk =
    Object.hasOwn(ROLES_BY_IMAGE, image) && ROLES_BY_IMAGE[image].includes(role);
  if (!imageOk) add(`image must be an agent image that runs the ${role}`);

  if (!isText(data.instructions)) add("instructions must be non-empty text");
  else if (data.instructions.length > MAX_INSTRUCTION_CHARS) {
    add(`instructions must be at most ${MAX_INSTRUCTION_CHARS} characters`);
  }
  if (!isRecord(data.task_types)) add("task_types needs allowed and default");

  const limits = checkLimits(role, data.limits, add);
  const providers = checkProviders(imageOk ? image : undefined, data.providers, add);
  const allowedHosts = checkHosts("allowed_hosts", data.allowed_hosts, add);
  if (allowedHosts && allowedHosts.length > 0 && !PUSHING.includes(role)) {
    add(
      `allowed_hosts must be empty: a ${role} run reaches only its model provider and the state API`,
    );
  }

  const bot: Partial<BotFile> = {};
  if (PUSHING.includes(role)) {
    let magicPath = false;
    if (role === "designer" && data.mcp !== undefined) {
      magicPath = checkMagicPath(data.mcp, add) ?? false;
      bot.magicPath = magicPath;
    } else if (data.mcp !== undefined) add("mcp is only for the Designer (D-196)");
    const tools = checkTools(role, data.allowed_tools, magicPath, add);
    if (tools) bot.allowedTools = tools;
  } else {
    if (data.allowed_tools !== undefined)
      add(`allowed_tools: a ${role} run has no tools`);
    if (data.mcp !== undefined) add("mcp is only for the Designer (D-196)");
  }
  if (role === "qa") {
    const hosts = checkHosts("fetch_allowed_hosts", data.fetch_allowed_hosts, add);
    if (hosts && hosts.length === 0)
      add("fetch_allowed_hosts must name the GitHub hosts");
    if (hosts) bot.fetchAllowedHosts = hosts;
  } else if (data.fetch_allowed_hosts !== undefined) {
    add("fetch_allowed_hosts is only for QA's fetch step");
  }
  if (SCHEMA_NAMES[role]) {
    const schemas = checkSchemas(role, data.output_schemas, add);
    if (schemas) bot.outputSchemas = schemas;
  } else if (data.output_schemas !== undefined) {
    add(`output_schemas: a ${role} run has no structured answer here`);
  }
  const taskInstructions = checkTaskInstructions(
    role,
    data.task_instructions,
    data.task_types,
    add,
  );
  if (taskInstructions) bot.taskInstructions = taskInstructions;

  if (problems.length > before) return null;
  return {
    role,
    version: raw.version,
    image,
    instructions: data.instructions as string,
    taskTypes: data.task_types,
    limits: limits as RunLimits,
    providers: providers as ModelProviderSetting[],
    allowedHosts: allowedHosts as string[],
    ...bot,
  };
}

/** Checks every role's bot file, collecting every problem at once. */
export function validateBotFiles(raw: Record<AgentRole, RawBotFile>): {
  bots?: BotFiles;
  problems: string[];
} {
  const problems: string[] = [];
  const bots = {} as BotFiles;
  for (const role of BOT_ROLES) {
    const entry = raw[role] as RawBotFile | undefined;
    if (!entry) {
      problems.push(`${role}.yaml is missing`);
      continue;
    }
    const bot = checkBotFile(role, entry, problems);
    if (bot) bots[role] = bot;
  }
  return problems.length > 0 ? { problems } : { bots, problems };
}

/** What the core records and reads for each role: runtime, version, Council and QA schemas. */
export function botProfiles(bots: BotFiles): Record<AgentRole, BotProfile> {
  const profiles = {} as Record<AgentRole, BotProfile>;
  for (const role of BOT_ROLES) {
    const bot = bots[role];
    profiles[role] = {
      runtime: bot.image,
      botVersion: bot.version,
      ...((role === "council" || role === "qa") && bot.outputSchemas
        ? { outputSchemas: bot.outputSchemas }
        : {}),
    };
  }
  return profiles;
}

/** Each role's per-run limits (D-185, ADR 0106 section 6). */
export function runLimits(bots: BotFiles): RoleRunLimits {
  const limits = {} as RoleRunLimits;
  for (const role of BOT_ROLES) limits[role] = { ...bots[role].limits };
  return limits;
}

/** Each role's task types, for the core's validateTaskTypes. */
export function botTaskTypes(bots: BotFiles): Record<AgentRole, unknown> {
  const roles = {} as Record<AgentRole, unknown>;
  for (const role of BOT_ROLES) roles[role] = bots[role].taskTypes;
  return roles;
}

/** Loads and checks the bot files, or throws with every problem. */
export function readBotFiles(dir: string = BOT_FILES_DIR): BotFiles {
  const { bots, problems } = validateBotFiles(loadBotFiles(dir));
  if (!bots) throw new Error(`The bot files are invalid: ${problems.join("; ")}`);
  return bots;
}
