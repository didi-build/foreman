import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { firstRunPrice } from "../../core/routing-testing.ts";
import { WORKSPACE_TOOLS } from "./files.ts";
import {
  ANSWER_TOOL,
  buildRequest,
  firstMessage,
  runLoop,
  startSpend,
  type LoopOptions,
  type MessagesClient,
} from "./loop.ts";

// Unit: the Messages API loop's requests and how a run ends (O-152), with a fake client that
// records each request and answers from a script. No network. The image-level tests run the same
// loop through the fake egress proxy (claude-api.test.ts).

const RUN_ID = "5e1f0a9b-8c7d-4e6f-a5b4-c3d2e1f0a9b8";
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: { decision: { type: "string" } },
};
const MESSAGES: Anthropic.MessageParam[] = [{ role: "user", content: "The input." }];

const options = (extra: Partial<LoopOptions> = {}): LoopOptions => ({
  client: { messages: { create: () => Promise.reject(new Error("not used")) } },
  model: "claude-sonnet-5-5",
  maxTurns: 10,
  maxUsd: 2,
  price: firstRunPrice("claude-sonnet-5-5"),
  maxMinutes: 20,
  serviceTier: "standard",
  flexCapacityRetries: 3,
  maxOutputTokens: 16000,
  system: "The frame.\n\nThe instructions.",
  tools: WORKSPACE_TOOLS,
  input: "The input.",
  outputSchema: SCHEMA,
  ...extra,
});

function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  } as Anthropic.Message;
}

const toolUse = (name: string, input: unknown, id: string): Anthropic.ContentBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ContentBlock;
const text = (value: string): Anthropic.ContentBlock =>
  ({ type: "text", text: value, citations: null }) as Anthropic.ContentBlock;

/** A client that answers from `replies` in order and keeps each request. */
function fakeClient(replies: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        const next = replies.shift();
        if (!next) throw new Error("no scripted reply");
        return next;
      },
    },
  };
  return { client, requests };
}

const toolNames = (request: Anthropic.MessageCreateParamsNonStreaming) =>
  (request.tools as Anthropic.Tool[] | undefined)?.map((tool) => tool.name);

/** Records each tool the loop runs. */
function toolRecorder() {
  const ran: { name: string; input: unknown }[] = [];
  return {
    ran,
    runTool: async (name: string, input: unknown) => {
      ran.push({ name, input });
      return { content: "1: export const a = 1;", isError: false };
    },
  };
}

describe("the default request (unit: structured outputs, byte for byte as before O-152)", () => {
  it("is exactly today's request, in today's key order", () => {
    const expected = {
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: "The frame.\n\nThe instructions.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: WORKSPACE_TOOLS,
      messages: MESSAGES,
      cache_control: { type: "ephemeral" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    };
    const request = buildRequest(options(), MESSAGES);
    expect(request).toEqual(expected);
    expect(JSON.stringify(request)).toBe(JSON.stringify(expected));
    // Saying `schema` is the same as saying nothing.
    expect(
      JSON.stringify(buildRequest(options({ answerVia: "schema" }), MESSAGES)),
    ).toBe(JSON.stringify(expected));
  });

  it("asks for no tools, tool choice or cache key without them", () => {
    const request = buildRequest(options({ tools: [] }), MESSAGES);
    expect(Object.keys(request)).toEqual([
      "model",
      "max_tokens",
      "system",
      "messages",
      "cache_control",
      "output_config",
    ]);
  });
});

describe("tool mode (unit: the answer tool for a provider with no structured outputs, O-152)", () => {
  it("adds the answer tool last, with the schema as its input, asks for a tool call each turn, and sends no format", () => {
    const request = buildRequest(
      options({ answerVia: "tool", effort: "high", promptCacheKey: RUN_ID }),
      MESSAGES,
    );
    expect(toolNames(request)).toEqual([
      "list_files",
      "read_file",
      "search_files",
      ANSWER_TOOL,
    ]);
    expect(request.tools?.at(-1)).toEqual({
      name: "answer",
      description:
        "Give your final answer by calling this tool once, when you are done. The run ends with this call.",
      input_schema: SCHEMA,
    });
    expect(request.tool_choice).toEqual({ type: "any" });
    // The effort stays; the format does not.
    expect(request.output_config).toEqual({ effort: "high" });
    expect((request as unknown as Record<string, unknown>).prompt_cache_key).toBe(
      RUN_ID,
    );
    // The cached prefix is marked as before.
    expect(request.system).toEqual([
      {
        type: "text",
        text: "The frame.\n\nThe instructions.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(request.cache_control).toEqual({ type: "ephemeral" });
  });

  it("gives a run with no tools of its own only the answer tool, and no output_config without an effort", () => {
    const request = buildRequest(options({ answerVia: "tool", tools: [] }), MESSAGES);
    expect(toolNames(request)).toEqual([ANSWER_TOOL]);
    expect(request).not.toHaveProperty("output_config");
    expect(request).not.toHaveProperty("prompt_cache_key");
  });

  it("sends the default request when there is no schema to answer with", () => {
    const plain = options({ outputSchema: undefined });
    expect(
      JSON.stringify(buildRequest({ ...plain, answerVia: "tool" }, MESSAGES)),
    ).toBe(JSON.stringify(buildRequest(plain, MESSAGES)));
  });

  it("sends the cache key alone, in schema mode too", () => {
    const request = buildRequest(options({ promptCacheKey: RUN_ID }), MESSAGES);
    expect((request as unknown as Record<string, unknown>).prompt_cache_key).toBe(
      RUN_ID,
    );
    expect(request.output_config).toEqual({
      format: { type: "json_schema", schema: SCHEMA },
    });
    expect(request).not.toHaveProperty("tool_choice");
  });

  it("ends the run with the answer tool's input as the final text, running no other tool of that reply", async () => {
    const tools = toolRecorder();
    const { client, requests } = fakeClient([
      message(
        [
          text("Done."),
          toolUse("read_file", { path: "src/a.ts" }, "toolu_1"),
          toolUse("answer", { decision: "split" }, "toolu_2"),
        ],
        "tool_use",
      ),
    ]);
    const { result } = await runLoop(
      options({ client, answerVia: "tool", runTool: tools.runTool }),
    );
    expect(result).toMatchObject({
      status: "success",
      finalText: JSON.stringify({ decision: "split" }),
      turns: 1,
    });
    expect(tools.ran).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("lets QA read files first, then ends on its answer, with the same tools and cache key on every request", async () => {
    const tools = toolRecorder();
    const { client, requests } = fakeClient([
      message([toolUse("read_file", { path: "src/a.ts" }, "toolu_1")], "tool_use"),
      message([toolUse("list_files", { path: "." }, "toolu_2")], "tool_use"),
      message([toolUse("answer", { decision: "keep" }, "toolu_3")], "tool_use"),
    ]);
    const { result } = await runLoop(
      options({
        client,
        answerVia: "tool",
        promptCacheKey: RUN_ID,
        runTool: tools.runTool,
      }),
    );
    expect(result).toMatchObject({
      status: "success",
      finalText: '{"decision":"keep"}',
      turns: 3,
    });
    expect(tools.ran).toEqual([
      { name: "read_file", input: { path: "src/a.ts" } },
      { name: "list_files", input: { path: "." } },
    ]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(JSON.stringify(request.tools)).toBe(JSON.stringify(requests[0]?.tools));
      expect(request.tool_choice).toEqual({ type: "any" });
      expect((request as unknown as Record<string, unknown>).prompt_cache_key).toBe(
        RUN_ID,
      );
    }
    // The read's result went back before the next request.
    const last = requests[2]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(JSON.stringify(last?.content)).toContain("toolu_2");
  });

  it("takes the answer from a reply that ends its turn with the call", async () => {
    const { client } = fakeClient([
      message([toolUse("answer", { decision: "x" }, "toolu_1")], "end_turn"),
    ]);
    const { result } = await runLoop(options({ client, answerVia: "tool" }));
    expect(result).toMatchObject({ status: "success", finalText: '{"decision":"x"}' });
  });

  it("keeps today's end when the run ends without the answer tool: the last text goes to the parser", async () => {
    const { client } = fakeClient([message([text("not json")], "end_turn")]);
    const { result } = await runLoop(options({ client, answerVia: "tool" }));
    expect(result).toMatchObject({ status: "success", finalText: "not json" });
  });

  it("ends as before on a reply cut at the output limit, even with an answer call in it", async () => {
    const { client } = fakeClient([
      message([toolUse("answer", { decision: "par" }, "toolu_1")], "max_tokens"),
    ]);
    const { result } = await runLoop(options({ client, answerVia: "tool" }));
    expect(result).toMatchObject({
      status: "error",
      errorText: "the model's reply reached the output token limit",
    });
  });

  it("runs a tool named answer like any other in schema mode, where there is no answer tool", async () => {
    const tools = toolRecorder();
    const { client } = fakeClient([
      message([toolUse("answer", { decision: "x" }, "toolu_1")], "tool_use"),
      message([text('{"decision":"y"}')], "end_turn"),
    ]);
    const { result } = await runLoop(options({ client, runTool: tools.runTool }));
    expect(tools.ran).toEqual([{ name: "answer", input: { decision: "x" } }]);
    expect(result).toMatchObject({ status: "success", finalText: '{"decision":"y"}' });
  });
});

describe("a Council discussion's calls (unit: the turn block and the run's one budget, ADR 0119 slice 6)", () => {
  const IMAGE = {
    label: "Image 1: option a",
    mediaType: "image/png" as const,
    data: "iVBORw0KGgo=",
  };

  it("sends today's first message without a turn, byte for byte", () => {
    expect(firstMessage({ input: "The input." })).toBe("The input.");
    expect(JSON.stringify(firstMessage({ input: "The input.", images: [IMAGE] }))).toBe(
      JSON.stringify([
        { type: "text", text: "The input." },
        { type: "text", text: IMAGE.label },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: IMAGE.data },
        },
      ]),
    );
  });

  it("runs today's requests without a turn or a shared spend, each loop counting its own", async () => {
    const { client, requests } = fakeClient([
      message([text('{"decision":"a"}')], "end_turn"),
      message([text('{"decision":"b"}')], "end_turn"),
    ]);
    const first = await runLoop(options({ client, tools: [] }));
    const second = await runLoop(options({ client, tools: [] }));
    expect(first.result.turns).toBe(1);
    expect(second.result).toMatchObject({ turns: 1, costUsd: 0.0007 });
    const expected = JSON.stringify(
      buildRequest(options({ tools: [] }), [{ role: "user", content: "The input." }]),
    );
    expect(requests.map((request) => JSON.stringify(request))).toEqual([
      expected,
      expected,
    ]);
  });

  it("puts the turn after the input, with the breakpoint on the input's last block", () => {
    expect(firstMessage({ input: "The input.", turn: "Now give a view." })).toEqual([
      { type: "text", text: "The input.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Now give a view." },
    ]);
    expect(
      firstMessage({ input: "The input.", images: [IMAGE], turn: "Now decide." }),
    ).toEqual([
      { type: "text", text: "The input." },
      { type: "text", text: IMAGE.label },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: IMAGE.data },
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "Now decide." },
    ]);
  });

  it("sends the turn in the first message and keeps the system and top-level breakpoints", async () => {
    const { client, requests } = fakeClient([
      message([text('{"decision":"a"}')], "end_turn"),
    ]);
    await runLoop(options({ client, tools: [], turn: "Now give a view." }));
    const [request] = requests;
    expect(request?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "The input.", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Now give a view." },
        ],
      },
    ]);
    expect(request?.system).toEqual([
      {
        type: "text",
        text: "The frame.\n\nThe instructions.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(request?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("holds the turn and dollar limits across loops that share one spend, and reports the run's totals", async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async () => undefined };
    const spend = startSpend(clock);
    now = 5;
    const { client, requests } = fakeClient([
      message([text('{"decision":"a"}')], "end_turn"),
      message([toolUse("read_file", { path: "a.ts" }, "toolu_1")], "tool_use"),
      message([text('{"decision":"b"}')], "end_turn"),
    ]);
    const tools = toolRecorder();
    const first = await runLoop(options({ client, spend, clock, maxTurns: 2 }));
    expect(first.result).toMatchObject({
      status: "success",
      turns: 1,
      costUsd: 0.0007,
    });
    // The second loop starts on the run's count: one request left before the turn limit.
    const second = await runLoop(
      options({ client, spend, clock, maxTurns: 2, runTool: tools.runTool }),
    );
    expect(second.result).toMatchObject({
      status: "max_turns",
      turns: 2,
      costUsd: 0.0014,
      tokens: { uncachedInput: 200, cachedInput: 0, output: 100 },
    });
    expect(requests).toHaveLength(2);
    expect(spend).toMatchObject({ startedAt: 0, turns: 2 });
    // The dollar limit is the run's too.
    const third = await runLoop(options({ client, spend, clock, maxUsd: 0.0014 }));
    expect(third.result).toMatchObject({ status: "max_budget", turns: 2 });
    expect(requests).toHaveLength(2);
  });
});
