// A Messages API loop with turn and dollar limits enforced inside it (ADR 0106 section 6), for QA,
// Council and Triage. One turn is one model request. Before each request the loop stops at the
// turn limit or once the cost so far has reached the dollar limit, like Claude Code's own caps,
// so a run overshoots by at most one request. The cost is priced from the route's model catalog
// entry, which the runner passes with the run (../shared/price.ts), so any model the catalog
// prices can run here, Claude or not. The egress proxy's request ceiling and the Job's
// deadline are the backstops.
//
// Prompt caching (D-185): tools and the system text never change within a run and are sent in a
// fixed order; the system text carries a cache breakpoint, so tools and system are the cached
// prefix. The request also asks for automatic caching, which moves a second breakpoint to the
// end of the conversation each turn. The history is only ever appended to.
//
// Service tiers (ADR 0114 sections 8 and 9). The request carries `service_tier` only for a route
// that asked for Flex or Priority; a Standard request is sent as before, byte for byte. The tier
// each response reports is read, and the run reports one served tier. Every provider error ends
// the run at once (the SDK's own retries are off), with one exception: a Flex capacity rejection
// (a 429 with an overload error on a Flex route) is retried inside the run, at most
// `flexCapacityRetries` times, after a wait of 30 seconds that doubles each time, at most 5
// minutes. The waits count against the run's minute limit: a wait that would reach it is not
// started, and the run ends on the rejection, so the runner records `usage_exhausted` with cause
// `capacity` instead of a deadline.
//
// The answer (O-152). By default the final answer follows its schema through structured outputs
// (`output_config.format`). A provider whose endpoint has none (DeepInfra) gets an `answer` tool
// instead, whose input schema is the answer's schema: it is the last tool, so the cached prefix
// stays fixed, and `tool_choice: any` makes every turn a tool call, so the run ends through it.
// Its input, as JSON, is the run's final text. A provider that takes `prompt_cache_key` gets the
// run's id on every request. Neither changes a default request, which is sent byte for byte as
// before.
import Anthropic from "@anthropic-ai/sdk";

import type { RunTokens } from "../../core/runs.ts";
import type { ServiceTier } from "../../core/store.ts";
import type { AnswerVia } from "../shared/settings.ts";
import {
  isFlexCapacityRejection,
  providerErrorFromHttp,
} from "../shared/provider-error.ts";
import { requestCostUsd, type RunPrice } from "../shared/price.ts";
import type { AgentResult } from "../shared/result.ts";
import { reportedTier, servedTier } from "../shared/tiers.ts";
import { NO_TOKENS, addTokens, tokensFromUsage } from "../shared/tokens.ts";
import type { ToolOutput } from "./files.ts";

/** The part of the SDK client the loop uses, so tests can see each request. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

/** The loop's view of time, so tests can run the waits on a fake clock. */
export interface LoopClock {
  /** Milliseconds, from any fixed start. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: LoopClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The first wait after a Flex capacity rejection; each later one doubles, up to the cap. */
export const CAPACITY_FIRST_WAIT_MS = 30_000;
export const CAPACITY_MAX_WAIT_MS = 5 * 60_000;

/** The wait before retry number `retry` (from 0). */
export const capacityWaitMs = (retry: number): number =>
  Math.min(CAPACITY_FIRST_WAIT_MS * 2 ** retry, CAPACITY_MAX_WAIT_MS);

export interface LoopOptions {
  client: MessagesClient;
  model: string;
  maxTurns: number;
  maxUsd: number;
  /**
   * The route's prices from the model catalog, as recorded on the run. Each response is priced at
   * the tier it reports, or at Standard when it reports none (ADR 0114 section 8).
   */
  price: RunPrice;
  /** The run's minute limit, which capacity waits count against. */
  maxMinutes: number;
  /** The tier the run's route asked for. */
  serviceTier: ServiceTier;
  /** How many Flex capacity rejections this run retries (`flex_capacity_retries`). */
  flexCapacityRetries: number;
  /** Real time unless a test passes a fake one. */
  clock?: LoopClock;
  maxOutputTokens: number;
  effort?: Anthropic.OutputConfig["effort"];
  /** Stable for the whole run: the cached prefix. */
  system: string;
  tools: Anthropic.Tool[];
  /** The first user message: this run's input. */
  input: string;
  /**
   * QA's visual comparison (D-242): images sent in the first message after the input, each
   * after its label. Base64 PNGs.
   */
  images?: readonly { label: string; mediaType: "image/png"; data: string }[];
  /** The JSON schema the final answer must follow. */
  outputSchema?: Record<string, unknown>;
  /** How the answer follows its schema (O-152). Structured outputs unless `tool`. */
  answerVia?: AnswerVia;
  /** Sent as `prompt_cache_key` on every request when set: the run's id (O-152). */
  promptCacheKey?: string;
  runTool?: (name: string, input: unknown) => Promise<ToolOutput>;
}

/**
 * The fixed error texts of a run that ended on the model's reply or could not reach the
 * provider. The weekly test job reads them to give each such end its own reason code.
 */
export const LOOP_ERRORS = {
  unreachable: "the model endpoint could not be reached",
  outputLimit: "the model's reply reached the output token limit",
  refused: "the model declined the request",
  unknownStop: "the model stopped for an unknown reason",
} as const;

/** The tool a run in tool mode ends with (O-152). */
export const ANSWER_TOOL = "answer";

/** Whether the answer comes through the answer tool: tool mode, with a schema to give it. */
const answersByTool = (
  options: Pick<LoopOptions, "answerVia" | "outputSchema">,
): options is { answerVia: "tool"; outputSchema: Record<string, unknown> } =>
  options.answerVia === "tool" && options.outputSchema !== undefined;

function answerTool(schema: Record<string, unknown>): Anthropic.Tool {
  return {
    name: ANSWER_TOOL,
    description:
      "Give your final answer by calling this tool once, when you are done. The run ends with this call.",
    input_schema: schema as Anthropic.Tool.InputSchema,
  };
}

/** The stop reasons of a finished reply, whose answer tool call ends the run. */
const ANSWERED: readonly (Anthropic.StopReason | null)[] = [
  "end_turn",
  "stop_sequence",
  "tool_use",
];

/** The input of the reply's answer tool call, as JSON, if it has one. */
function answerOf(message: Anthropic.Message): string | undefined {
  const call = message.content.find(
    (block) => block.type === "tool_use" && block.name === ANSWER_TOOL,
  );
  return call?.type === "tool_use" ? JSON.stringify(call.input) : undefined;
}

/**
 * How the loop ended. `result.finalText` is the model's last text, or in tool mode the answer
 * tool's input as JSON (O-152).
 */
export interface LoopEnd {
  result: AgentResult;
}

const textOf = (message: Anthropic.Message): string =>
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** The input as text, or as text followed by each labelled image (multi-image input). */
export function firstMessage(
  options: Pick<LoopOptions, "input" | "images">,
): string | Anthropic.ContentBlockParam[] {
  if (!options.images || options.images.length === 0) return options.input;
  return [
    { type: "text", text: options.input },
    ...options.images.flatMap((image): Anthropic.ContentBlockParam[] => [
      { type: "text", text: image.label },
      {
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      },
    ]),
  ];
}

export function buildRequest(
  options: LoopOptions,
  messages: Anthropic.MessageParam[],
): Anthropic.MessageCreateParamsNonStreaming {
  const byTool = answersByTool(options);
  const outputConfig: Anthropic.OutputConfig = {
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.outputSchema && !byTool
      ? { format: { type: "json_schema", schema: options.outputSchema } }
      : {}),
  };
  // The SDK's type knows only Anthropic's own values; a Flex route goes to a provider whose
  // Anthropic-compatible endpoint takes `flex` (ADR 0114 section 8).
  const tier =
    options.serviceTier === "standard"
      ? {}
      : ({ service_tier: options.serviceTier } as unknown as Pick<
          Anthropic.MessageCreateParamsNonStreaming,
          "service_tier"
        >);
  // Not in the SDK's type: DeepInfra's endpoint takes it (O-152).
  const cacheKey: object =
    options.promptCacheKey === undefined
      ? {}
      : { prompt_cache_key: options.promptCacheKey };
  // The answer tool goes after the role's own tools, so the order is the same on every turn.
  const tools = byTool
    ? [...options.tools, answerTool(options.outputSchema)]
    : options.tools;
  return {
    model: options.model,
    ...tier,
    ...cacheKey,
    max_tokens: options.maxOutputTokens,
    system: [
      { type: "text", text: options.system, cache_control: { type: "ephemeral" } },
    ],
    ...(tools.length > 0 ? { tools } : {}),
    ...(byTool ? { tool_choice: { type: "any" } } : {}),
    messages,
    cache_control: { type: "ephemeral" },
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

export async function runLoop(options: LoopOptions): Promise<LoopEnd> {
  const clock = options.clock ?? realClock;
  const startedAt = clock.now();
  const minuteLimitMs = options.maxMinutes * 60_000;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: firstMessage(options) },
  ];
  let turns = 0;
  let costUsd = 0;
  let tokens: RunTokens = { ...NO_TOKENS };
  let lastText = "";
  const tiers: (ServiceTier | null)[] = [];
  let capacityRetries = 0;
  let capacityWaitedMs = 0;

  const end = (
    status: AgentResult["status"],
    errorText = "",
    providerError: AgentResult["providerError"] = null,
    served = servedTier(tiers),
  ): LoopEnd => ({
    result: {
      status,
      finalText: lastText,
      turns,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      tokens,
      errorText,
      providerError,
      ...(served === null ? {} : { serviceTierServed: served }),
      capacityRetries,
      capacityWaitSeconds: Math.round(capacityWaitedMs / 1000),
    },
  });

  /** Waits before a retry if this rejection may be retried, and says whether it did. */
  async function waitedForCapacity(
    error: AgentResult["providerError"],
  ): Promise<boolean> {
    if (!isFlexCapacityRejection(options.serviceTier, error)) return false;
    if (capacityRetries >= options.flexCapacityRetries) return false;
    const wait = capacityWaitMs(capacityRetries);
    if (clock.now() - startedAt + wait >= minuteLimitMs) return false;
    const before = clock.now();
    await clock.sleep(wait);
    capacityWaitedMs += clock.now() - before;
    capacityRetries += 1;
    return true;
  }

  for (;;) {
    if (turns >= options.maxTurns)
      return end("max_turns", "the run reached its turn limit");
    if (costUsd >= options.maxUsd)
      return end("max_budget", "the run reached its dollar limit");
    let response: Anthropic.Message;
    try {
      response = await options.client.messages.create(buildRequest(options, messages));
    } catch (error) {
      if (error instanceof Anthropic.APIError && typeof error.status === "number") {
        const providerError = providerErrorFromHttp(
          error.status,
          error.headers,
          error.error,
        );
        if (await waitedForCapacity(providerError)) continue;
        return end(
          "error",
          `the model provider answered ${error.status}`,
          providerError,
        );
      }
      if (error instanceof Anthropic.APIError) {
        return end("error", LOOP_ERRORS.unreachable);
      }
      throw error;
    }
    turns += 1;
    const tier = reportedTier(response);
    tiers.push(tier);
    const used = tokensFromUsage(response.usage);
    tokens = addTokens(tokens, used);
    costUsd += requestCostUsd(options.price, tier, used);
    lastText = textOf(response) || lastText;
    // The reply goes back exactly as it came, thinking blocks included.
    messages.push({ role: "assistant", content: response.content });
    // In tool mode the answer tool's call ends the run, and no other tool of that reply is run.
    // A reply cut at the output limit or refused ends as it would without it.
    const answer = answersByTool(options) ? answerOf(response) : undefined;
    if (answer !== undefined && ANSWERED.includes(response.stop_reason)) {
      lastText = answer;
      return end("success");
    }

    switch (response.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return end("success");
      case "pause_turn":
        continue;
      case "max_tokens":
        return end("error", LOOP_ERRORS.outputLimit);
      case "refusal":
        return end("error", LOOP_ERRORS.refused);
      case "tool_use": {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const output = options.runTool
            ? await options.runTool(block.name, block.input)
            : { content: "no tools are available in this run", isError: true };
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output.content,
            ...(output.isError ? { is_error: true } : {}),
          });
        }
        // All results of one turn go back in one message.
        messages.push({ role: "user", content: results });
        continue;
      }
      default:
        return end("error", LOOP_ERRORS.unknownStop);
    }
  }
}
