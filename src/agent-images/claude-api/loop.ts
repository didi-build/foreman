// A Messages API loop with turn and dollar limits enforced inside it (ADR 0106 section 6), for QA,
// Council and Triage. One turn is one model request. Before each request the loop stops at the
// turn limit or once the cost so far has reached the dollar limit, like Claude Code's own caps,
// so a run overshoots by at most one request. The egress proxy's request ceiling and the Job's
// deadline are the backstops.
//
// Prompt caching (D-185): tools and the system text never change within a run and are sent in a
// fixed order; the system text carries a cache breakpoint, so tools and system are the cached
// prefix. The request also asks for automatic caching, which moves a second breakpoint to the
// end of the conversation each turn. The history is only ever appended to.
import Anthropic from "@anthropic-ai/sdk";

import type { RunTokens } from "../../core/runs.ts";
import { providerErrorFromHttp } from "../shared/provider-error.ts";
import type { AgentResult } from "../shared/result.ts";
import { NO_TOKENS, addTokens, tokensFromUsage } from "../shared/tokens.ts";
import type { ToolOutput } from "./files.ts";
import { requestCostUsd } from "./pricing.ts";

/** The part of the SDK client the loop uses, so tests can see each request. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

export interface LoopOptions {
  client: MessagesClient;
  model: string;
  maxTurns: number;
  maxUsd: number;
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
  return {
    model: options.model,
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
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: options.input }];
  let turns = 0;
  let costUsd = 0;
  let tokens: RunTokens = { ...NO_TOKENS };
  let lastText = "";

  const end = (
    status: AgentResult["status"],
    errorText = "",
    providerError: AgentResult["providerError"] = null,
  ): LoopEnd => ({
    result: {
      status,
      finalText: lastText,
      turns,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      tokens,
      errorText,
      providerError,
    },
  });

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
        return end(
          "error",
          `the model provider answered ${error.status}`,
          providerErrorFromHttp(error.status, error.headers, error.error),
        );
      }
      if (error instanceof Anthropic.APIError) {
        return end("error", "the model endpoint could not be reached");
      }
      throw error;
    }
    turns += 1;
    const used = tokensFromUsage(response.usage);
    tokens = addTokens(tokens, used);
    costUsd += requestCostUsd(options.model, used);
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
