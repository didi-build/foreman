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
import Anthropic from "@anthropic-ai/sdk";

import type { RunTokens } from "../../core/runs.ts";
import type { ServiceTier } from "../../core/store.ts";
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

const realClock: LoopClock = {
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
  /** The JSON schema the final answer must follow (structured outputs). */
  outputSchema?: Record<string, unknown>;
  runTool?: (name: string, input: unknown) => Promise<ToolOutput>;
}

/** How the loop ended. `result.finalText` is the model's last text. */
export interface LoopEnd {
  result: AgentResult;
}

const textOf = (message: Anthropic.Message): string =>
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

export function buildRequest(
  options: LoopOptions,
  messages: Anthropic.MessageParam[],
): Anthropic.MessageCreateParamsNonStreaming {
  const outputConfig: Anthropic.OutputConfig = {
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.outputSchema
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
  return {
    model: options.model,
    ...tier,
    max_tokens: options.maxOutputTokens,
    system: [
      { type: "text", text: options.system, cache_control: { type: "ephemeral" } },
    ],
    ...(options.tools.length > 0 ? { tools: options.tools } : {}),
    messages,
    cache_control: { type: "ephemeral" },
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

export async function runLoop(options: LoopOptions): Promise<LoopEnd> {
  const clock = options.clock ?? realClock;
  const startedAt = clock.now();
  const minuteLimitMs = options.maxMinutes * 60_000;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: options.input }];
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
        return end("error", "the model endpoint could not be reached");
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

    switch (response.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return end("success");
      case "pause_turn":
        continue;
      case "max_tokens":
        return end("error", "the model's reply reached the output token limit");
      case "refusal":
        return end("error", "the model declined the request");
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
        return end("error", "the model stopped for an unknown reason");
    }
  }
}
