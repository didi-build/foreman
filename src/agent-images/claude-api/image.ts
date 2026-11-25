// The Messages API image's run (QA, Council, Triage; ADR 0106, 0107, 0112): read the settings
// and the task, run the loop against the egress proxy's provider address with a placeholder key,
// and print one result line. QA reads its tree with the read-only file tool and posts its
// verdict through the state API; Council and Triage return structured output only. A QA task
// with images is the visual comparison (D-242): no tools, the images in the first message, and
// structured output only, which the runner checks and records; it posts nothing. A Council task
// with images is its call on a visual approval (D-270): the same, through the structured run.
// A provider without structured outputs (DeepInfra's Anthropic endpoint, O-152) gets the same
// answer through an `answer` tool the model must call (FOREMAN_ANSWER_VIA=tool).
// QA's review and Triage also get the read-only context tools their task file lists (ADR 0119
// slice 3c, ../shared/context-tools.ts): after QA's file tools, and before the answer tool, which
// stays last. When their task lists documentation hosts (slice 4b), the documentation lookup
// (../shared/docs-lookup.ts) comes after the context tools, through the proxy's lookup route
// (FOREMAN_LOOKUP_URL). QA's visual comparison and the Council never get either. When QA's review
// task has the browser (ADR 0119 slice 5c), its browser tools (./browser-tools.ts) come after the
// lookup, through the run's browser pod (FOREMAN_BROWSER_URL), and before the answer tool.
// A Council task with a `discussion` (ADR 0119 slice 6, D-483) runs as one discussion that
// Product chairs (./discussion.ts): each persona of its cast gives a view, then the chair answers.
// Without one, the Council runs as before. The runner sets it on every Council task since slice
// 6e (O-181).
import { waitForProxy } from "../shared/proxy-ready.ts";
import Anthropic from "@anthropic-ai/sdk";

import type { ServiceTier } from "../../core/store.ts";
import { readConfig, type Setting } from "../../service-kit/config.ts";
import { createLogger } from "../../service-kit/logger.ts";
import { parseRunPrice } from "../shared/price.ts";
import {
  readOutOfScopeFindings,
  withinFindingBounds,
} from "../../core/out-of-scope-findings.ts";
import {
  errorResult,
  exitCode,
  printResult,
  redact,
  type AgentResult,
} from "../shared/result.ts";
import {
  ANSWER_VIA,
  PLACEHOLDER_CREDENTIAL,
  baseUrl,
  readImageSettings,
  secretValues,
  type AnswerVia,
  type ImageSettings,
} from "../shared/settings.ts";
import { readTask, type AgentTaskFile } from "../shared/task.ts";
import {
  CONTEXT_TOOL_ERRORS,
  contextToolDefinitions,
  createContextTools,
  type ContextTools,
} from "../shared/context-tools.ts";
import {
  DOCS_LOOKUP_TOOL_NAME,
  createDocsLookup,
  docsLookupTool,
  type DocsLookup,
} from "../shared/docs-lookup.ts";
import { isContextToolName } from "../../adapters/agent-runtime/kubernetes/task.ts";
import type { AgentRole } from "../../adapters/agent-runtime/runtime.ts";
import {
  BROWSER_TOOLS,
  createBrowserTools,
  isBrowserToolName,
  type BrowserTools,
} from "./browser-tools.ts";
import { runDiscussion } from "./discussion.ts";
import { WORKSPACE_TOOLS, createWorkspace, type Workspace } from "./files.ts";
import {
  runLoop,
  type LoopClock,
  type LoopOptions,
  type MessagesClient,
} from "./loop.ts";
import { fencedInput, systemText } from "./prompts.ts";
import { VERDICT_SCHEMA, parseVerdict, postVerdict } from "./verdict.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];

const wholeNumber = (env: string, min: number): Setting<number> => ({
  env,
  parse: (raw) => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
      throw new Error(`is not a whole number of at least ${min}`);
    }
    return value;
  },
});

const optional = <T>(setting: Setting<T>): Setting<T | undefined> => ({
  env: setting.env,
  fallback: "",
  parse: (raw) => (raw === "" ? undefined : setting.parse(raw)),
});

/**
 * The loop's settings from the run's environment. Exported for the weekly test job
 * (src/agent-images/eval/), which reads the output token bound, the effort and the Flex capacity
 * retries with the same names, defaults and checks.
 */
export const apiSettings = {
  maxOutputTokens: {
    env: "FOREMAN_MAX_OUTPUT_TOKENS",
    fallback: "16000",
    parse: (raw: string) => {
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || value < 1 || value > 128_000) {
        throw new Error("is not a whole number from 1 to 128000");
      }
      return value;
    },
  },
  effort: optional<Effort>({
    env: "FOREMAN_EFFORT",
    parse: (raw) => {
      if (!EFFORTS.includes(raw as Effort)) throw new Error("is not an effort level");
      return raw as Effort;
    },
  }),
  // The route's tier and the Flex capacity bounds (ADR 0114 sections 8 and 9).
  serviceTier: {
    env: "FOREMAN_SERVICE_TIER",
    parse: (raw: string) => {
      if (!TIERS.includes(raw as ServiceTier)) throw new Error("is not a service tier");
      return raw as ServiceTier;
    },
  } satisfies Setting<ServiceTier>,
  maxMinutes: wholeNumber("FOREMAN_MAX_MINUTES", 1),
  flexCapacityRetries: wholeNumber("FOREMAN_FLEX_CAPACITY_RETRIES", 0),
  // How the route's provider takes the answer and a cache key (O-152, the bot file's
  // `messages_api`). Unset is Anthropic's way: structured outputs and no key.
  answerVia: {
    env: "FOREMAN_ANSWER_VIA",
    fallback: "schema",
    parse: (raw: string) => {
      if (!ANSWER_VIA.includes(raw as AnswerVia))
        throw new Error("is not schema or tool");
      return raw as AnswerVia;
    },
  } satisfies Setting<AnswerVia>,
  promptCacheKey: {
    env: "FOREMAN_PROMPT_CACHE_KEY",
    fallback: "false",
    parse: (raw: string) => {
      if (raw !== "true" && raw !== "false") throw new Error("is not true or false");
      return raw === "true";
    },
  } satisfies Setting<boolean>,
};

type Common = ReturnType<typeof readCommon>;
/**
 * The loop's settings, and the run's price for its dollar limit (../shared/price.ts). The price is
 * checked against the requested tier, so it is read once the tier is known; a missing or unusable
 * price stops the run before any model call. A provider that takes `prompt_cache_key` gets the
 * run's id, so every request of the run shares one key (O-152).
 */
function readCommon(env: NodeJS.ProcessEnv, runId: string) {
  const { promptCacheKey, ...common } = readConfig(apiSettings, env);
  const { price } = readConfig(
    {
      price: {
        env: "FOREMAN_MODEL_PRICE",
        parse: (raw: string) => parseRunPrice(raw, common.serviceTier),
      },
    },
    env,
  );
  return { ...common, price, ...(promptCacheKey ? { promptCacheKey: runId } : {}) };
}

const qaSettings = {
  workspace: {
    env: "FOREMAN_WORKSPACE",
    parse: (raw: string) => {
      if (!raw.startsWith("/")) throw new Error("must be an absolute path");
      return raw;
    },
  },
  headSha: {
    env: "FOREMAN_HEAD_SHA",
    parse: (raw: string) => {
      if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error("is not a commit id");
      return raw;
    },
  },
};

export interface ApiImageDeps {
  /** Builds the SDK client. Tests pass one pointed at a local fake. */
  client?: (settings: ImageSettings) => MessagesClient;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  /** The capacity waits' clock. Tests pass a fake one. */
  clock?: LoopClock;
  /** The wait for the run's egress proxy (O-133). Tests may pass their own. */
  waitForProxy?: (urlOnProxy: string) => Promise<void>;
}

/**
 * The SDK client for one provider's address on the egress proxy, holding only the placeholder
 * credential. Exported for the weekly test job, whose runs reach their providers the same way.
 */
export function proxyClient(baseURL: string): Anthropic {
  return new Anthropic({
    // The egress proxy removes this and adds the real key (ADR 0106 section 5).
    apiKey: PLACEHOLDER_CREDENTIAL,
    baseURL,
    // A rate limit or capacity error ends the run as usage_exhausted; the runner waits and
    // dispatches again (FR-11). Retrying here would spend the proxy's request ceiling. The one
    // exception, a Flex capacity rejection, is retried by the loop itself, bounded (ADR 0114
    // section 9).
    maxRetries: 0,
  });
}

/** The part of a run's loop options its role and task fix: the frame, the tools and the schema. */
export type RunFrame = Pick<
  LoopOptions,
  "system" | "tools" | "input" | "images" | "outputSchema" | "runTool"
>;

/**
 * The context tools a frame offers (ADR 0119 slice 3c): the ones the task lists, which need their
 * source, a real run's state API client or the weekly test's stand-in. The Council and a task
 * with images get none, as the task file check also says.
 */
function listedContextTools(
  role: AgentRole,
  task: AgentTaskFile,
  context: ContextTools | undefined,
) {
  const listed =
    role === "council" || task.images !== undefined ? [] : (task.contextTools ?? []);
  if (listed.length > 0 && context === undefined) {
    throw new Error("a task with context tools needs their source");
  }
  return listed;
}

/**
 * The documentation hosts a frame offers the lookup for (ADR 0119 slice 4b): the ones the task
 * lists, which need their source, a real run's lookup or the weekly test's stand-in. The Council
 * and a task with images get none, as the task file check also says.
 */
function listedDocsHosts(
  role: AgentRole,
  task: AgentTaskFile,
  lookup: DocsLookup | undefined,
): string[] {
  const hosts =
    role === "council" || task.images !== undefined ? [] : (task.docsLookupHosts ?? []);
  if (hosts.length > 0 && lookup === undefined) {
    throw new Error("a task with docs lookup hosts needs their source");
  }
  return hosts;
}

/** The lookup's definition after the other tools, when the task lists hosts. */
const lookupTools = (hosts: readonly string[]) =>
  hosts.length > 0 ? [docsLookupTool(hosts)] : [];

/**
 * Whether QA's review frame offers the browser tools (ADR 0119 slice 5c): when its task has the
 * browser, which needs their source, a real run's browser pod. A task with images never has it,
 * as the task file check also says.
 */
function hasBrowser(task: AgentTaskFile, browser: BrowserTools | undefined): boolean {
  const listed = task.browser === true && task.images === undefined;
  if (listed && browser === undefined) {
    throw new Error("a task with the browser needs its source");
  }
  return listed;
}

/**
 * QA's review: the read-only tools over the tree, then the context tools the task lists, the
 * documentation lookup when it lists hosts and the browser tools when it has the browser, the head
 * commit and the evidence ids after the fenced input, and the verdict's schema. Exported for the
 * weekly test job (ADR 0117), so its QA runs get exactly a real run's frame.
 */
export function qaReviewFrame(
  task: AgentTaskFile,
  headSha: string,
  answerVia: AnswerVia,
  workspace: Workspace,
  context?: ContextTools,
  lookup?: DocsLookup,
  browser?: BrowserTools,
): RunFrame {
  const evidenceIds = task.evidenceIds ?? [];
  const listed = listedContextTools("qa", task, context);
  const hosts = listedDocsHosts("qa", task, lookup);
  const withBrowser = hasBrowser(task, browser);
  return {
    system: systemText(
      "qa",
      task.instructions,
      false,
      answerVia,
      listed,
      hosts.length > 0,
      withBrowser,
    ),
    tools: [
      ...WORKSPACE_TOOLS,
      ...contextToolDefinitions(listed),
      ...lookupTools(hosts),
      ...(withBrowser ? BROWSER_TOOLS : []),
    ],
    input: fencedInput(task.input, [
      `Head commit: ${headSha}`,
      `Evidence ids you may cite: ${evidenceIds.length > 0 ? evidenceIds.join(", ") : "none"}`,
    ]),
    outputSchema: VERDICT_SCHEMA,
    // A context tool's name goes to their source, which refuses one the task does not list.
    runTool: (name, input) =>
      lookup !== undefined && hosts.length > 0 && name === DOCS_LOOKUP_TOOL_NAME
        ? lookup.run(input)
        : browser !== undefined && withBrowser && isBrowserToolName(name)
          ? browser.run(name, input)
          : context !== undefined && listed.length > 0 && isContextToolName(name)
            ? context.run(name, input)
            : workspace.run(name, input),
  };
}

/**
 * A Council or Triage run, or the Council's visual call: no tools but Triage's context tools and
 * documentation lookup when its task lists them (ADR 0107, ADR 0119 slices 3c and 4b), the images
 * after the input when the task has them, and the task's answer schema. Exported for the weekly
 * test job, as `qaReviewFrame` is.
 */
export function structuredFrame(
  role: AgentRole,
  task: AgentTaskFile,
  answerVia: AnswerVia,
  context?: ContextTools,
  lookup?: DocsLookup,
): RunFrame {
  const listed = listedContextTools(role, task, context);
  const hosts = listedDocsHosts(role, task, lookup);
  const withLookup = lookup !== undefined && hosts.length > 0;
  const withContext = context !== undefined && listed.length > 0;
  return {
    system: systemText(
      role,
      task.instructions,
      task.images !== undefined,
      answerVia,
      listed,
      hosts.length > 0,
    ),
    tools: [...contextToolDefinitions(listed), ...lookupTools(hosts)],
    input: fencedInput(task.input),
    // The Council's visual call (D-270): the option screenshots after the input.
    ...(task.images ? { images: task.images } : {}),
    ...(task.outputSchema ? { outputSchema: task.outputSchema } : {}),
    ...(withContext || withLookup
      ? {
          // The context tools' source refuses a name the task does not list.
          runTool: (name: string, input: unknown) =>
            withLookup && name === DOCS_LOOKUP_TOOL_NAME
              ? lookup.run(input)
              : withContext
                ? context.run(name, input)
                : Promise.resolve({
                    content: CONTEXT_TOOL_ERRORS.notListed,
                    isError: true,
                  }),
        }
      : {}),
  };
}

async function qaRun(
  settings: ImageSettings,
  task: AgentTaskFile,
  env: NodeJS.ProcessEnv,
  client: MessagesClient,
  deps: ApiImageDeps,
  common: Common,
  secrets: readonly string[],
  context: ContextTools,
  lookup: DocsLookup | undefined,
  browser: BrowserTools | undefined,
): Promise<AgentResult> {
  const qa = readConfig(qaSettings, env);
  const logger = createLogger("agent-qa", deps.write);
  const workspace = createWorkspace(qa.workspace, (entry) =>
    logger.info("file read", { ...entry }),
  );
  const evidenceIds = task.evidenceIds ?? [];
  const { result } = await runLoop({
    client,
    model: settings.model,
    maxTurns: settings.maxTurns,
    maxUsd: settings.maxUsd,
    ...common,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...qaReviewFrame(
      task,
      qa.headSha,
      common.answerVia,
      workspace,
      context,
      lookup,
      browser,
    ),
  });
  if (result.status !== "success") return result;
  const parsed = parseVerdict(result.finalText, evidenceIds);
  if ("problem" in parsed) {
    return {
      ...result,
      status: "error",
      errorText: `the verdict is unusable: ${parsed.problem}`,
    };
  }
  // The bugs QA saw outside the PR go to the state API and the runner without any credential
  // value, cut back to the bounds the API and the runner check (D-244, O-65).
  const { outOfScopeFindings, ...rest } = parsed.verdict;
  const verdict = outOfScopeFindings
    ? {
        ...rest,
        outOfScopeFindings: redact(outOfScopeFindings, secrets).map(
          withinFindingBounds,
        ),
      }
    : rest;
  const posted = await postVerdict({
    stateApiUrl: settings.stateApiUrl,
    token: settings.stateApiToken,
    nodeId: task.nodeId ?? "",
    headSha: qa.headSha,
    verdict,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!posted.ok) {
    return {
      ...result,
      status: "error",
      errorText:
        posted.status === null
          ? "the state API could not be reached to record the verdict"
          : `the state API refused the verdict with status ${posted.status}`,
    };
  }
  return {
    ...result,
    structured: {
      ...verdict,
      commitSha: qa.headSha,
      evidenceId: posted.evidenceId,
    },
  };
}

async function visualRun(
  settings: ImageSettings,
  task: AgentTaskFile,
  client: MessagesClient,
  common: Common,
  deps: ApiImageDeps,
  secrets: readonly string[],
): Promise<AgentResult> {
  if (!task.outputSchema)
    return errorResult("a visual comparison task needs its answer schema");
  const { result } = await runLoop({
    client,
    model: settings.model,
    maxTurns: settings.maxTurns,
    maxUsd: settings.maxUsd,
    ...common,
    ...(deps.clock ? { clock: deps.clock } : {}),
    system: systemText("qa", task.instructions, true, common.answerVia),
    tools: [],
    input: fencedInput(task.input),
    images: task.images ?? [],
    outputSchema: task.outputSchema,
  });
  if (result.status !== "success") return result;
  let answer: unknown;
  try {
    answer = JSON.parse(result.finalText) as unknown;
  } catch {
    return { ...result, status: "error", errorText: "the answer is not JSON" };
  }
  // The runner checks the answer against its schema and rules (src/core/visual-comparison.ts).
  // Here only credential values are removed, and the out-of-scope findings cut back to their
  // bounds afterwards, as for QA's verdict (D-244, O-65).
  const clean = redact(answer, secrets);
  const listed =
    typeof clean === "object" && clean !== null && !Array.isArray(clean)
      ? (clean as Record<string, unknown>).outOfScopeFindings
      : undefined;
  const findings = readOutOfScopeFindings(listed);
  const structured =
    listed !== undefined && "findings" in findings
      ? {
          ...(clean as Record<string, unknown>),
          outOfScopeFindings: findings.findings.map(withinFindingBounds),
        }
      : clean;
  return { ...result, structured };
}

async function structuredRun(
  settings: ImageSettings,
  task: AgentTaskFile,
  client: MessagesClient,
  common: Common,
  deps: ApiImageDeps,
  context: ContextTools,
  lookup: DocsLookup | undefined,
): Promise<AgentResult> {
  const { result } = await runLoop({
    client,
    model: settings.model,
    maxTurns: settings.maxTurns,
    maxUsd: settings.maxUsd,
    ...common,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...structuredFrame(settings.role, task, common.answerVia, context, lookup),
  });
  if (result.status !== "success") return result;
  try {
    // Structured outputs, or the answer tool's input (O-152), make this JSON; the runner
    // validates it against its schema (ADR 0107).
    return { ...result, structured: JSON.parse(result.finalText) as unknown };
  } catch {
    return { ...result, status: "error", errorText: "the answer is not JSON" };
  }
}

/** A Council task with a discussion (ADR 0119 slice 6): every call on the run's one budget. */
function discussionRun(
  settings: ImageSettings,
  task: AgentTaskFile,
  client: MessagesClient,
  common: Common,
  deps: ApiImageDeps,
  secrets: readonly string[],
): Promise<AgentResult> {
  return runDiscussion(
    {
      client,
      model: settings.model,
      maxTurns: settings.maxTurns,
      maxUsd: settings.maxUsd,
      ...common,
      ...(deps.clock ? { clock: deps.clock } : {}),
    },
    task,
    secrets,
  );
}

export async function runClaudeApiImage(
  env: NodeJS.ProcessEnv,
  deps: ApiImageDeps = {},
): Promise<number> {
  let secrets: string[] = [];
  let result: AgentResult;
  try {
    const settings = readImageSettings("claude-api", env);
    secrets = secretValues(settings, env);
    const common = readCommon(env, settings.runId);
    const task = readTask(settings.role, settings.taskFile);
    // The proxy may not answer yet when this pod starts (O-133).
    await (deps.waitForProxy ?? waitForProxy)(settings.modelBaseUrl);
    const client = deps.client?.(settings) ?? proxyClient(settings.modelBaseUrl);
    // The context tools the task lists, through the state API with the run's token (ADR 0119
    // slice 3c). Each call is logged by tool, status and size only.
    const logger = createLogger(`agent-${settings.role}`, deps.write);
    const context = createContextTools({
      stateApiUrl: settings.stateApiUrl,
      token: settings.stateApiToken,
      allowed: task.contextTools ?? [],
      secrets,
      log: (entry) => logger.info("context tool call", { ...entry }),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    // The documentation lookup, only when the task lists hosts (ADR 0119 slice 4b): through the
    // proxy's lookup route, which the runtime names only for such a run. Each request is logged
    // by host, status and size only.
    const hosts = task.docsLookupHosts ?? [];
    const lookup =
      hosts.length > 0
        ? createDocsLookup({
            lookupUrl: readConfig({ url: baseUrl("FOREMAN_LOOKUP_URL") }, env).url,
            hosts,
            secrets,
            log: (entry) => logger.info("docs lookup call", { ...entry }),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          })
        : undefined;
    // QA's browser, only when its review task has it (ADR 0119 slice 5c): through the run's
    // browser pod, whose address the runtime gives only such a run. Each call is logged by tool,
    // status, size and time only.
    const browser =
      task.browser === true
        ? createBrowserTools({
            browserUrl: readConfig({ url: baseUrl("FOREMAN_BROWSER_URL") }, env).url,
            secrets,
            log: (entry) => logger.info("browser tool call", { ...entry }),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          })
        : undefined;
    result =
      settings.role === "qa" && task.images !== undefined
        ? await visualRun(settings, task, client, common, deps, secrets)
        : settings.role === "qa"
          ? await qaRun(
              settings,
              task,
              env,
              client,
              deps,
              common,
              secrets,
              context,
              lookup,
              browser,
            )
          : settings.role === "council" && task.discussion !== undefined
            ? await discussionRun(settings, task, client, common, deps, secrets)
            : await structuredRun(
                settings,
                task,
                client,
                common,
                deps,
                context,
                lookup,
              );
  } catch (error) {
    // Setting and task errors name the problem, never a value.
    result = errorResult(error instanceof Error ? error.message : "the run failed");
  }
  printResult(result, secrets, deps.write);
  return exitCode(result);
}
