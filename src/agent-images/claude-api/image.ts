// The Messages API image's run (QA, Council, Triage; ADR 0106, 0107, 0112): read the settings
// and the task, run the loop against the egress proxy's provider address with a placeholder key,
// and print one result line. QA reads its tree with the read-only file tool and posts its
// verdict through the state API; Council and Triage return structured output only.
import Anthropic from "@anthropic-ai/sdk";

import { readConfig, type Setting } from "../../service-kit/config.ts";
import { createLogger } from "../../service-kit/logger.ts";
import {
  errorResult,
  exitCode,
  printResult,
  type AgentResult,
} from "../shared/result.ts";
import {
  PLACEHOLDER_CREDENTIAL,
  readImageSettings,
  secretValues,
  type ImageSettings,
} from "../shared/settings.ts";
import { readTask, type AgentTaskFile } from "../shared/task.ts";
import { WORKSPACE_TOOLS, createWorkspace } from "./files.ts";
import { runLoop, type MessagesClient } from "./loop.ts";
import { hasPrice } from "./pricing.ts";
import { fencedInput, systemText } from "./prompts.ts";
import { VERDICT_SCHEMA, parseVerdict, postVerdict } from "./verdict.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

const optional = <T>(setting: Setting<T>): Setting<T | undefined> => ({
  env: setting.env,
  fallback: "",
  parse: (raw) => (raw === "" ? undefined : setting.parse(raw)),
});

const apiSettings = {
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
};

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
}

function sdkClient(settings: ImageSettings): MessagesClient {
  return new Anthropic({
    // The egress proxy removes this and adds the real key (ADR 0106 section 5).
    apiKey: PLACEHOLDER_CREDENTIAL,
    baseURL: settings.modelBaseUrl,
    // A rate limit or capacity error ends the run as usage_exhausted; the runner waits and
    // dispatches again (FR-11). Retrying here would spend the proxy's request ceiling.
    maxRetries: 0,
  });
}

async function qaRun(
  settings: ImageSettings,
  task: AgentTaskFile,
  env: NodeJS.ProcessEnv,
  client: MessagesClient,
  deps: ApiImageDeps,
  common: { maxOutputTokens: number; effort: Effort | undefined },
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
    system: systemText("qa", task.instructions),
    tools: WORKSPACE_TOOLS,
    input: fencedInput(task.input, [
      `Head commit: ${qa.headSha}`,
      `Evidence ids you may cite: ${evidenceIds.length > 0 ? evidenceIds.join(", ") : "none"}`,
    ]),
    outputSchema: VERDICT_SCHEMA,
    runTool: (name, input) => workspace.run(name, input),
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
  const posted = await postVerdict({
    stateApiUrl: settings.stateApiUrl,
    token: settings.stateApiToken,
    nodeId: task.nodeId ?? "",
    headSha: qa.headSha,
    verdict: parsed.verdict,
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
      ...parsed.verdict,
      commitSha: qa.headSha,
      evidenceId: posted.evidenceId,
    },
  };
}

async function structuredRun(
  settings: ImageSettings,
  task: AgentTaskFile,
  client: MessagesClient,
  common: { maxOutputTokens: number; effort: Effort | undefined },
): Promise<AgentResult> {
  const { result } = await runLoop({
    client,
    model: settings.model,
    maxTurns: settings.maxTurns,
    maxUsd: settings.maxUsd,
    ...common,
    system: systemText(settings.role, task.instructions),
    // ADR 0107 gives Council and Triage no tools.
    tools: [],
    input: fencedInput(task.input),
    ...(task.outputSchema ? { outputSchema: task.outputSchema } : {}),
  });
  if (result.status !== "success") return result;
  try {
    // Structured outputs make this JSON; the runner validates it against its schema (ADR 0107).
    return { ...result, structured: JSON.parse(result.finalText) as unknown };
  } catch {
    return { ...result, status: "error", errorText: "the answer is not JSON" };
  }
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
    const common = readConfig(apiSettings, env);
    if (!hasPrice(settings.model)) {
      throw new Error(
        "FOREMAN_MODEL has no price, so its dollar limit cannot be enforced",
      );
    }
    const task = readTask(settings.role, settings.taskFile);
    const client = (deps.client ?? sdkClient)(settings);
    result =
      settings.role === "qa"
        ? await qaRun(settings, task, env, client, deps, common)
        : await structuredRun(settings, task, client, common);
  } catch (error) {
    // Setting and task errors name the problem, never a value.
    result = errorResult(error instanceof Error ? error.message : "the run failed");
  }
  printResult(result, secrets, deps.write);
  return exitCode(result);
}
