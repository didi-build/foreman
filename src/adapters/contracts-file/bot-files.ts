// The bot files (docs/bot-files.md, ADR 0107, ADR 0106 sections 3, 5 and 6, ADR 0114 section 1):
// one YAML file per agent role in contracts/bots/, loaded at the spec version like the contracts
// (ADR 0105). Each run records its bot file's version as `runs.bot_version`.
//
// A bot file holds the task's own instructions (the cached prefix of every run's task file), its
// agent image, its tools, its read-only context tools if any (`context_tools`, ADR 0119 slice 3c,
// none declared before slice 3d), its hosts, its model providers with each key's secret path (D-142,
// D-143), its per-run limits (D-185), its task types with each one's persona (`task_personas`,
// D-458) and, for the Council, Triage and QA's visual comparison, its output schemas. A task type
// other than the role's default may have its own instructions (`task_instructions`, QA's
// `qa:visual`, D-242, and the Council's `council:visual`, D-270), and limits of its own
// (`task_limits`: only the Developer's and the Designer's close task type, the close-only run of a
// cancelled item's pull request, D-318, which must have them). It never holds a model (each run's
// route names it, ADR 0114) or a credential value.
//
// A run's instructions (ADR 0119 slice 2) are the shared base, the task type's persona and the
// task's own instructions, composed by the core's `composeInstructions` over the persona files
// (./personas.ts). The Council has no persona until ADR 0119's slice 6, so its runs get the bot
// file's text unchanged. `instructionsFor` gives a run's text; the runner and the weekly model
// test both use it. The version is the file's content hash for the Council, and for a role with
// personas one hash of the file and each composed text (ADR 0119: "one hash of the three").
//
// The check is strict and collects every problem: an unknown field is refused, and a problem names
// the file and the field, never a value from the file, so a key pasted into the wrong place cannot
// reach a log. The task types are checked by the core with the task types file
// (src/core/task-types.ts); everything else is checked here, reusing the egress proxy's own
// parsers so a bot file the runner accepts is one the proxy accepts. `checkRunSpec` checks the
// built run again before anything starts. The files are read through ../bundle-files/files.ts:
// from disk, or from a flow's bundle (O-121).
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

import { MAGICPATH_TOOL } from "../../agent-images/opencode/permissions.ts";
import {
  ANSWER_VIA,
  MODEL_APIS,
  ROLES_BY_IMAGE,
  type AnswerVia,
  type ImageKind,
  type ModelApi,
} from "../../agent-images/shared/settings.ts";
import { outputSchemaProblems, type OutputSchema } from "../../core/output-schema.ts";
import {
  PERSONAS,
  composeInstructions,
  isPersonaId,
  type Personas,
  type TaskPersona,
} from "../../core/personas.ts";
import type { BotProfile } from "../../core/reconcile.ts";
import type { RoleRunLimits, RunLimits } from "../../core/runs.ts";
import type { AgentRole } from "../../core/store.ts";
import {
  CLOSE_TASK_TYPES,
  TASK_TYPE_ID,
  isCloseTaskType,
} from "../../core/task-types.ts";
import { canonicalHost } from "../../egress-proxy/hosts.ts";
import { CREDENTIAL_STYLES, parseProviders } from "../../egress-proxy/providers.ts";
import {
  API_PATH,
  type MessagesApiSetting,
  type ModelProviderSetting,
} from "../agent-runtime/kubernetes/manifests.ts";
import {
  CONTEXT_TOOL_NAMES,
  TOOL,
  isContextToolName,
  type ContextToolName,
} from "../agent-runtime/kubernetes/task.ts";
import { listBundledFolder, readBundledFile } from "../bundle-files/files.ts";
import { PERSONAS_DIR, readPersonas } from "./personas.ts";

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
  council: [
    "escalation",
    "reversal",
    "visual_call",
    "scanner_gone",
    "still_needed",
    "plan",
  ],
  triage: ["answer"],
  qa: ["visual"],
};
/** Task types whose runs need instructions of their own (D-242). */
const TASK_INSTRUCTIONS: Partial<Record<AgentRole, readonly string[]>> = {
  qa: ["qa:visual"],
  council: ["council:visual"],
};
/**
 * Task types whose runs have limits of their own, which they must give: the close runs (D-318).
 * No other task type may set them.
 */
const TASK_LIMITS: Partial<Record<AgentRole, readonly string[]>> = {
  developer: [CLOSE_TASK_TYPES.developer],
  designer: [CLOSE_TASK_TYPES.designer],
};
/**
 * The roles whose task types have no persona yet, with the reason: every other role must map each
 * task type that runs a model to its persona (`task_personas`, D-458).
 */
const NO_PERSONAS: Partial<Record<AgentRole, string>> = {
  council: "the Council gets its personas in ADR 0119's slice 6",
};
/** The roles whose runs may get the read-only context tools (ADR 0119 slice 3c, D-459). */
const CONTEXT_TOOL_ROLES: readonly AgentRole[] = [
  "qa",
  "triage",
  "developer",
  "designer",
];
/** ADR 0106 section 5: an installation token lasts at most an hour. */
const GITHUB_TOKEN_MINUTES = 60;
/** The most characters a bot file's text, or a run's composed instructions, may have. */
const MAX_INSTRUCTION_CHARS = 32_000;
/**
 * The fixed line before each composed text in a version hash. It names the text's task type, so
 * the hashed bytes say which text belongs to which task type.
 */
const versionSeparator = (taskType: string): string =>
  `\n--- foreman composed instructions: ${taskType} ---\n`;

const FIELDS = [
  "role",
  "image",
  "instructions",
  "task_types",
  "task_personas",
  "limits",
  "providers",
  "allowed_hosts",
  "allowed_tools",
  "context_tools",
  "mcp",
  "fetch_allowed_hosts",
  "output_schemas",
  "task_instructions",
  "task_limits",
] as const;

/** One role's bot file, checked. No credential value is in it. */
export interface BotFile {
  role: AgentRole;
  /**
   * Recorded as `runs.bot_version`. `sha256:` and a SHA-256: of the file's bytes for a role with
   * no `task_personas` (the Council); for a role with personas, of the file's bytes followed by
   * each persona task type's composed text, in task type order, each after a line naming it.
   */
  version: string;
  image: ImageKind;
  /** The task's own instructions, as the file gives them. A run reads `runInstructions`. */
  instructions: string;
  /** `{allowed, default}`, checked by the core's validateTaskTypes. */
  taskTypes: unknown;
  /** Each task type's persona (D-458). Absent for the Council until ADR 0119's slice 6. */
  taskPersonas?: Record<string, TaskPersona>;
  /**
   * The instructions a run of each allowed task type gets, the stable, cached part of its task
   * file: the shared base, the persona and the task's text, or, with no persona, the task's text
   * unchanged. A close task type has the default task type's text. Read it with `instructionsFor`.
   */
  runInstructions: Record<string, string>;
  limits: RunLimits;
  /** Each provider the role may be routed to. `secretPath` may hold `{project}`. */
  providers: ModelProviderSetting[];
  /** CONNECT hosts for the agent's proxy. Empty for QA, Council and Triage. */
  allowedHosts: string[];
  /** Developer and Designer (D-196). */
  allowedTools?: string[];
  /**
   * The read-only context tools the role's runs get (ADR 0119 slice 3c): QA (its review only),
   * Triage, the Developer and the Designer (not their close runs). Each is a bot file change Didi
   * approves (D-196); none is declared before slice 3d.
   */
  contextTools?: ContextToolName[];
  /** Designer: whether MagicPath is on. Always false until D-190's gate. */
  magicPath?: boolean;
  /** QA: the fetch step's GitHub hosts. */
  fetchAllowedHosts?: string[];
  /** Council (by question kind), Triage (`answer`) and QA (`visual`). */
  outputSchemas?: Record<string, OutputSchema>;
  /**
   * Instructions by task type, for a task type that is not the default (QA's `qa:visual`, the
   * Council's `council:visual`).
   */
  taskInstructions?: Record<string, string>;
  /** Limits by task type, for the close task type only (D-318). */
  taskLimits?: Record<string, RunLimits>;
}

export type BotFiles = Record<AgentRole, BotFile>;

/** A bot file as read from disk, before it is checked. */
export interface RawBotFile {
  file: string;
  /** `sha256:` and the SHA-256 of the file's bytes. */
  version: string;
  /** The file's bytes, which a role's version hashes. */
  bytes: Uint8Array;
  data: unknown;
}

/**
 * Reads `<role>.yaml` for every agent role from `dir`. A missing file, a file for no role, or a
 * YAML error throws, naming the file and never its content.
 */
export function loadBotFiles(
  dir: string = BOT_FILES_DIR,
): Record<AgentRole, RawBotFile> {
  const names = listBundledFolder(dir).filter((name) => name.endsWith(".yaml"));
  for (const name of names) {
    if (!BOT_ROLES.some((role) => `${role}.yaml` === name)) {
      throw new Error(`${name} in ${dir} is not the bot file of an agent role`);
    }
  }
  const loaded = {} as Record<AgentRole, RawBotFile>;
  for (const role of BOT_ROLES) {
    const file = `${role}.yaml`;
    if (!names.includes(file)) throw new Error(`${dir}/${file} is missing`);
    const bytes = readBundledFile(join(dir, file));
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
    loaded[role] = { file, version, bytes, data };
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

function checkLimits(
  role: AgentRole,
  raw: unknown,
  add: (p: string) => void,
  field = "limits",
) {
  if (!isRecord(raw)) {
    add(`${field} needs max_turns, max_minutes and max_usd`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!["max_turns", "max_minutes", "max_usd"].includes(key)) {
      add(`${field}: unknown field ${key}`);
    }
  }
  const { max_turns: turns, max_minutes: minutes, max_usd: usd } = raw;
  const whole = (v: unknown): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 1;
  let ok = true;
  if (!whole(turns)) {
    add(`${field}.max_turns must be a whole number above 0`);
    ok = false;
  }
  if (!whole(minutes)) {
    add(`${field}.max_minutes must be a whole number above 0`);
    ok = false;
  } else if (PUSHING.includes(role) && minutes >= GITHUB_TOKEN_MINUTES) {
    add(`${field}.max_minutes must stay below 60, the GitHub token's lifetime`);
    ok = false;
  }
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    add(`${field}.max_usd must be an amount above 0`);
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

/**
 * A provider's `messages_api` (O-152): how the Messages API image asks this provider for a
 * structured answer, and whether it sends the run's id as `prompt_cache_key`. Each key is
 * optional, with Anthropic's way as the default.
 */
function checkMessagesApi(
  raw: unknown,
  fail: (problem: string) => void,
): MessagesApiSetting | undefined {
  if (!isRecord(raw)) {
    fail(".messages_api must be a mapping of answer and prompt_cache_key");
    return undefined;
  }
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (key !== "answer" && key !== "prompt_cache_key") {
      fail(`.messages_api: unknown field ${key}`);
      ok = false;
    }
  }
  const { answer = "schema", prompt_cache_key: promptCacheKey = false } = raw;
  if (!ANSWER_VIA.includes(answer as AnswerVia)) {
    fail(`.messages_api.answer must be ${ANSWER_VIA.join(" or ")}`);
    ok = false;
  }
  if (typeof promptCacheKey !== "boolean") {
    fail(".messages_api.prompt_cache_key must be true or false");
    ok = false;
  }
  return ok
    ? { answer: answer as AnswerVia, promptCacheKey: promptCacheKey as boolean }
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
        "messages_api",
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
      messages_api: messagesApi,
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
    if (messagesApi !== undefined) {
      const checked = checkMessagesApi(messagesApi, fail);
      if (image !== "claude-api") {
        fail(".messages_api is only for the Messages API image (claude-api)");
      } else if (checked) provider.messagesApi = checked;
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

/**
 * The role's context tools (ADR 0119 slice 3c): optional, and when given a non-empty list of known
 * tools, each once, for a role whose runs may have them. Problems name the position, never a value.
 */
function checkContextTools(
  role: AgentRole,
  raw: unknown,
  add: (p: string) => void,
): ContextToolName[] | undefined {
  if (raw === undefined) return undefined;
  if (!CONTEXT_TOOL_ROLES.includes(role)) {
    add(`context_tools: a ${role} run gets no context tools`);
    return undefined;
  }
  if (!isTextList(raw) || raw.length === 0) {
    add(
      `context_tools must be a non-empty list of context tools (${CONTEXT_TOOL_NAMES.join(", ")})`,
    );
    return undefined;
  }
  let ok = true;
  raw.forEach((tool, i) => {
    if (!isContextToolName(tool)) {
      add(`context_tools[${i}] is not a context tool`);
      ok = false;
    } else if (raw.indexOf(tool) !== i) {
      add(`context_tools[${i}] repeats an earlier tool`);
      ok = false;
    }
  });
  return ok ? (raw as ContextToolName[]).slice() : undefined;
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

/** The close task type's own limits (D-318): exactly the role's listed task types, each allowed. */
function checkTaskLimits(
  role: AgentRole,
  raw: unknown,
  taskTypes: unknown,
  add: (p: string) => void,
): Record<string, RunLimits> | undefined {
  const names = TASK_LIMITS[role] ?? [];
  if (names.length === 0) {
    if (raw !== undefined) add(`task_limits: a ${role} run has only its limits`);
    return undefined;
  }
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== [...names].sort().join()) {
    add(`task_limits must give exactly: ${names.join(", ")}`);
    return undefined;
  }
  const allowed =
    isRecord(taskTypes) && Array.isArray(taskTypes.allowed) ? taskTypes.allowed : [];
  const limits: Record<string, RunLimits> = {};
  let ok = true;
  for (const name of names) {
    if (
      !allowed.includes(name) ||
      (isRecord(taskTypes) && taskTypes.default === name)
    ) {
      add(`task_limits.${name} must be an allowed task type other than the default`);
      ok = false;
    }
    const checked = checkLimits(role, raw[name], add, `task_limits.${name}`);
    if (checked) limits[name] = checked;
    else ok = false;
  }
  return ok ? limits : undefined;
}

/**
 * The role's allowed task types as its file lists them, keeping only well-formed ids, so a
 * problem that names one never repeats another value. The core's validateTaskTypes checks the
 * whole list.
 */
const allowedOf = (taskTypes: unknown): string[] =>
  isRecord(taskTypes) && Array.isArray(taskTypes.allowed)
    ? taskTypes.allowed.filter(
        (id): id is string => typeof id === "string" && TASK_TYPE_ID.test(id),
      )
    : [];

/**
 * Each task type's persona (D-458): every allowed task type that runs a model has one, and a close
 * task type, which starts no model (D-318), has none. A role in `NO_PERSONAS` has none yet.
 */
function checkTaskPersonas(
  role: AgentRole,
  raw: unknown,
  taskTypes: unknown,
  add: (p: string) => void,
): Record<string, TaskPersona> | undefined {
  const refused = NO_PERSONAS[role];
  if (refused !== undefined) {
    if (raw !== undefined) add(`task_personas: ${refused}`);
    return undefined;
  }
  if (!isRecord(raw)) {
    add(
      "task_personas must map each task type that runs a model to its persona (D-458)",
    );
    return undefined;
  }
  const allowed = allowedOf(taskTypes);
  const known = PERSONAS.join(", ");
  const checked: Record<string, TaskPersona> = {};
  let ok = true;
  const fail = (problem: string) => {
    add(problem);
    ok = false;
  };
  for (const [taskType, entry] of Object.entries(raw)) {
    const at = `task_personas.${taskType}`;
    if (!TASK_TYPE_ID.test(taskType)) {
      fail("task_personas: a key is not a task type id");
      continue;
    }
    if (!allowed.includes(taskType)) {
      fail(`${at} must be one of the role's allowed task types`);
      continue;
    }
    if (isCloseTaskType(taskType)) {
      fail(`${at}: a close run starts no model (D-318), so it has no persona`);
      continue;
    }
    if (!isRecord(entry)) {
      fail(
        `${at} must be a mapping of persona and, optionally, with_craft_standards_of`,
      );
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "persona" && key !== "with_craft_standards_of") {
        fail(`${at}: unknown field ${key}`);
      }
    }
    const { persona, with_craft_standards_of: other } = entry;
    if (!isPersonaId(persona)) fail(`${at}.persona must be one of: ${known}`);
    if (other !== undefined && (!isPersonaId(other) || other === persona)) {
      fail(
        `${at}.with_craft_standards_of must be one of: ${known}, other than its persona`,
      );
    }
    if (isPersonaId(persona)) {
      checked[taskType] = {
        persona,
        ...(isPersonaId(other) ? { withCraftStandardsOf: other } : {}),
      };
    }
  }
  for (const taskType of allowed) {
    if (!isCloseTaskType(taskType) && !Object.hasOwn(raw, taskType)) {
      fail(
        `task_personas.${taskType} is missing: every task type that runs a model has one`,
      );
    }
  }
  return ok ? checked : undefined;
}

/**
 * The instructions a run of each allowed task type gets (ADR 0119 slice 2): the task's text, with
 * the shared base and its persona before it when it has one, each composed text within the same
 * limit as the file's own. A close task type has the default task type's text: no model reads
 * it, but its task file needs instructions (D-318).
 */
function runInstructionsOf(
  data: Record<string, unknown>,
  taskInstructions: Record<string, string> | undefined,
  taskPersonas: Record<string, TaskPersona> | undefined,
  personas: Personas,
  add: (p: string) => void,
): Record<string, string> {
  const allowed = allowedOf(data.task_types);
  const texts: Record<string, string> = {};
  for (const taskType of allowed.filter((id) => !isCloseTaskType(id))) {
    const task =
      taskInstructions && Object.hasOwn(taskInstructions, taskType)
        ? (taskInstructions[taskType] as string)
        : (data.instructions as string);
    const persona = taskPersonas?.[taskType];
    if (!persona) {
      texts[taskType] = task;
      continue;
    }
    const composed = composeInstructions({ personas, ...persona, task });
    if (composed.length > MAX_INSTRUCTION_CHARS) {
      add(
        `the composed instructions of ${taskType} must be at most ${MAX_INSTRUCTION_CHARS} characters`,
      );
    }
    texts[taskType] = composed;
  }
  const defaultType = isRecord(data.task_types) ? data.task_types.default : undefined;
  for (const taskType of allowed.filter(isCloseTaskType)) {
    if (typeof defaultType === "string" && Object.hasOwn(texts, defaultType)) {
      texts[taskType] = texts[defaultType] as string;
    } else {
      add(
        `task_types.default must be an allowed task type that runs a model, whose instructions ${taskType} uses`,
      );
    }
  }
  return texts;
}

/**
 * The role's `runs.bot_version`. With no persona, the file's content hash, as before ADR 0119.
 * With personas, one hash of the file's bytes and each persona task type's composed text, so a
 * change to the shared base or a persona that reaches a run's text is a new version, and a
 * comment in a persona file is not.
 */
function versionOf(
  raw: RawBotFile,
  runInstructions: Record<string, string>,
  taskPersonas: Record<string, TaskPersona> | undefined,
): string {
  if (!taskPersonas) return raw.version;
  const hash = createHash("sha256").update(raw.bytes);
  for (const taskType of Object.keys(taskPersonas).sort()) {
    hash.update(versionSeparator(taskType)).update(runInstructions[taskType] as string);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Checks one role's parsed bot file. Every problem names the file and the field. */
function checkBotFile(
  role: AgentRole,
  raw: RawBotFile,
  personas: Personas,
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
  const contextTools = checkContextTools(role, data.context_tools, add);
  if (contextTools) bot.contextTools = contextTools;
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
  const taskLimits = checkTaskLimits(role, data.task_limits, data.task_types, add);
  if (taskLimits) bot.taskLimits = taskLimits;
  const taskPersonas = checkTaskPersonas(
    role,
    data.task_personas,
    data.task_types,
    add,
  );
  if (taskPersonas) bot.taskPersonas = taskPersonas;

  if (problems.length > before) return null;
  const runInstructions = runInstructionsOf(
    data,
    taskInstructions,
    taskPersonas,
    personas,
    add,
  );
  if (problems.length > before) return null;
  return {
    role,
    version: versionOf(raw, runInstructions, taskPersonas),
    image,
    instructions: data.instructions as string,
    taskTypes: data.task_types,
    runInstructions,
    limits: limits as RunLimits,
    providers: providers as ModelProviderSetting[],
    allowedHosts: allowedHosts as string[],
    ...bot,
  };
}

/**
 * Checks every role's bot file, collecting every problem at once, and composes each task type's
 * instructions with the checked persona files.
 */
export function validateBotFiles(
  raw: Record<AgentRole, RawBotFile>,
  personas: Personas,
): {
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
    const bot = checkBotFile(role, entry, personas, problems);
    if (bot) bots[role] = bot;
  }
  return problems.length > 0 ? { problems } : { bots, problems };
}

/**
 * The instructions a run of `taskType` gets (ADR 0119 slice 2), for the runner and the weekly
 * model test alike. Throws for a task type the bot does not allow.
 */
export function instructionsFor(bot: BotFile, taskType: string): string {
  if (!Object.hasOwn(bot.runInstructions, taskType)) {
    throw new Error(`the ${bot.role} bot file does not allow task type ${taskType}`);
  }
  return bot.runInstructions[taskType] as string;
}

/** What the core records and reads for each role: runtime, version, Council and QA schemas. */
export function botProfiles(bots: BotFiles): Record<AgentRole, BotProfile> {
  const profiles = {} as Record<AgentRole, BotProfile>;
  for (const role of BOT_ROLES) {
    const bot = bots[role];
    profiles[role] = {
      runtime: bot.image,
      botVersion: bot.version,
      ...((role === "council" || role === "qa" || role === "triage") &&
      bot.outputSchemas
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

/** The limits of the task types that have their own (D-318), by task type. */
export function taskTypeLimits(bots: BotFiles): Record<string, RunLimits> {
  const limits: Record<string, RunLimits> = {};
  for (const role of BOT_ROLES) {
    for (const [taskType, own] of Object.entries(bots[role].taskLimits ?? {})) {
      limits[taskType] = { ...own };
    }
  }
  return limits;
}

/** Each role's task types, for the core's validateTaskTypes. */
export function botTaskTypes(bots: BotFiles): Record<AgentRole, unknown> {
  const roles = {} as Record<AgentRole, unknown>;
  for (const role of BOT_ROLES) roles[role] = bots[role].taskTypes;
  return roles;
}

/**
 * Loads and checks the bot files, with the persona files their runs compose (./personas.ts), or
 * throws with every problem.
 */
export function readBotFiles(
  dir: string = BOT_FILES_DIR,
  personasDir: string = PERSONAS_DIR,
): BotFiles {
  const { bots, problems } = validateBotFiles(
    loadBotFiles(dir),
    readPersonas(personasDir),
  );
  if (!bots) throw new Error(`The bot files are invalid: ${problems.join("; ")}`);
  return bots;
}
