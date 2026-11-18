#!/usr/bin/env node
// Test helper: stands in for the pinned OpenCode binary. It reads the prompt from stdin, records
// its arguments, environment, working folder, prompt and the config file it was given in
// fake-opencode-call.json in its working folder, then prints `--format json` event lines in the
// shape OpenCode 1.19.5 prints them (docs/spikes/opencode-runtime.md, check 1), chosen by
// `scenario=<name>` in the prompt. The success scenario's final message is a short summary and a
// `foreman-report` block (N-44), or the base64 text after `final64=` in the prompt. The
// `block-only` and `split-final` scenarios print parts with every field OpenCode gives them, its
// message ids included, to check how the final message is read (O-148). It never calls a model
// and never uses the network.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = readFileSync(0, "utf8");
const configPath = process.env.OPENCODE_CONFIG ?? "";
let config = null;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  // Recorded as null.
}
let instructions = null;
try {
  instructions = readFileSync(config?.instructions?.[0] ?? "", "utf8");
} catch {
  // Recorded as null.
}
writeFileSync(
  join(process.cwd(), "fake-opencode-call.json"),
  JSON.stringify({
    args: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    input,
    config,
    instructions,
  }),
);

const scenario = /scenario=([a-z0-9_-]+)/.exec(input)?.[1] ?? "success";
const DEFAULT_FINAL = [
  "Done.",
  "",
  "```foreman-report",
  '{"pullRequestTitle": "Add the fixture change", "docsNote": {"impact": "none"}}',
  "```",
].join("\n");
const final64 = /final64=([A-Za-z0-9+/=]+)/.exec(input)?.[1];
const finalText =
  final64 === undefined
    ? DEFAULT_FINAL
    : Buffer.from(final64, "base64").toString("utf8");
const sessionID = "ses_fake";
let clock = 1_790_000_000_000;
const emit = (type, body) => {
  clock += 1;
  process.stdout.write(
    `${JSON.stringify({ type, timestamp: clock, sessionID, ...body })}\n`,
  );
};
const tokens = (input, output, reasoning, read, write) => ({
  total: input + output + reasoning + read + write,
  input,
  output,
  reasoning,
  cache: { write, read },
});
const stepFinish = (reason, t) =>
  emit("step_finish", { part: { type: "step-finish", reason, tokens: t, cost: 0 } });

// Parts with every field OpenCode 1.19.5 gives them (`session/processor.ts`): a part id, the
// assistant message it belongs to (one per model request) and the session. Text parts are
// printed once they have ended, so they carry `time.end`.
let partCount = 0;
const part = (messageID, type, fields) => ({
  id: `prt_fake${String((partCount += 1)).padStart(4, "0")}`,
  messageID,
  sessionID,
  type,
  ...fields,
});
const realText = (messageID, text) =>
  emit("text", {
    part: part(messageID, "text", { text, time: { start: clock, end: clock + 1 } }),
  });
const realStep = (messageID, reason, t) => {
  emit("step_finish", {
    part: part(messageID, "step-finish", {
      reason,
      snapshot: "fake",
      tokens: t,
      cost: 0,
    }),
  });
};
const realStart = (messageID) =>
  emit("step_start", { part: part(messageID, "step-start", { snapshot: "fake" }) });
const realBash = (messageID, command, output) => {
  emit("tool_use", {
    part: part(messageID, "tool", {
      callID: `call_${messageID}`,
      tool: "bash",
      state: {
        status: "completed",
        input: { command, description: "fake" },
        output,
        title: command,
        metadata: { exit: 0 },
        time: { start: clock, end: clock + 1 },
      },
    }),
  });
};
const apiError = (statusCode, body, headers = {}, isRetryable = false, message = "") =>
  emit("error", {
    error: {
      name: "APIError",
      data: {
        message,
        statusCode,
        isRetryable,
        responseHeaders: { "content-type": "application/json", ...headers },
        responseBody: JSON.stringify(body),
        metadata: { url: "http://proxy.invalid/provider/v1" },
      },
    },
  });

const scenarios = {
  success: () => {
    emit("step_start", { part: { type: "step-start" } });
    emit("tool_use", {
      part: {
        type: "tool",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "X.md" },
          output: "Wrote file.",
        },
      },
    });
    stepFinish("tool-calls", tokens(1000, 40, 0, 0, 5000));
    emit("step_start", { part: { type: "step-start" } });
    emit("text", { part: { type: "text", text: finalText } });
    stepFinish("stop", tokens(12, 80, 20, 5400, 100));
    return 0;
  },
  // The first Developer run on DeepInfra (didi-build/rehearsal#7, O-148), as an OpenAI-compatible
  // route prints it: one text part at most per message. Its prose came with a tool call in an
  // earlier message, and its final message is the report block alone (or `final64`'s text).
  "block-only": () => {
    realStart("msg_fake1");
    realBash(
      "msg_fake1",
      "git commit -m 'Add the helper'",
      "[branch abc1234] Add the helper",
    );
    realStep("msg_fake1", "tool-calls", tokens(900, 30, 0, 4000, 0));
    realStart("msg_fake2");
    realText("msg_fake2", "Now I will push the branch.");
    realBash("msg_fake2", "git push", "branch pushed");
    realStep("msg_fake2", "tool-calls", tokens(50, 20, 0, 4900, 0));
    realStart("msg_fake3");
    realText(
      "msg_fake3",
      final64 === undefined ? DEFAULT_FINAL.split("\n").slice(2).join("\n") : finalText,
    );
    realStep("msg_fake3", "stop", tokens(40, 45, 0, 4950, 0));
    return 0;
  },
  // A final message in two text parts, as Anthropic's text blocks give it, with an empty part
  // after them and the same part printed twice: the summary is the first part, the block the
  // second (O-148).
  "split-final": () => {
    realStart("msg_fake1");
    realBash("msg_fake1", "git push", "branch pushed");
    realStep("msg_fake1", "tool-calls", tokens(900, 30, 0, 4000, 0));
    realStart("msg_fake2");
    realText("msg_fake2", "Done: the helper and its tests, pushed.");
    const block = DEFAULT_FINAL.split("\n").slice(2).join("\n");
    const blockPart = part("msg_fake2", "text", {
      text: block,
      time: { start: clock, end: clock + 1 },
    });
    emit("text", { part: blockPart });
    emit("text", { part: blockPart });
    realText("msg_fake2", "");
    realStep("msg_fake2", "stop", tokens(40, 45, 0, 4950, 0));
    return 0;
  },
  "not-final": () => {
    stepFinish("tool-calls", tokens(10, 10, 0, 0, 0));
    return 0;
  },
  "flex-overloaded": () => {
    stepFinish("tool-calls", tokens(10, 10, 0, 0, 0));
    apiError(
      429,
      {
        error: {
          type: "engine_overloaded",
          message: "Model is overloaded, please try again later",
        },
      },
      { "retry-after": "7" },
      true,
      "Model is overloaded, please try again later",
    );
    return 1;
  },
  "anthropic-overloaded": () => {
    apiError(
      429,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      { "Retry-After": "1" },
      true,
      "Overloaded",
    );
    return 1;
  },
  "rate-limit": () => {
    apiError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
      { "retry-after": "30" },
      true,
      "Rate limited",
    );
    return 1;
  },
  billing: () => {
    apiError(
      402,
      {
        type: "error",
        error: { type: "billing_error", message: "Your credit balance is too low" },
      },
      {},
      false,
      "Your credit balance is too low",
    );
    return 1;
  },
  "proxy-ceiling": () => {
    apiError(
      403,
      { error: "This run has reached its model request ceiling." },
      {},
      false,
      "Forbidden",
    );
    return 1;
  },
  "rejected-ceiling": () => {
    apiError(
      403,
      { error: "This run has reached its ceiling on rejected model requests." },
      {},
      false,
      "Forbidden",
    );
    return 1;
  },
  generic: () => {
    emit("error", {
      error: { name: "UnknownError", data: { message: "Something broke" } },
    });
    return 1;
  },
  "echo-secrets": () => {
    const key = config?.provider?.foreman?.options?.apiKey ?? "";
    emit("text", {
      part: {
        type: "text",
        text: `state ${process.env.FOREMAN_STATE_API_TOKEN} github ${process.env.GITHUB_TOKEN} key ${key}`,
      },
    });
    stepFinish("stop", tokens(1, 1, 0, 0, 0));
    return 0;
  },
  "no-output": () => 2,
};

// A model that calls a tool forever, as in the spike's cap runs. It stops only when killed.
if (scenario === "forever" || scenario === "forever-ignore-term") {
  if (scenario === "forever-ignore-term") process.on("SIGTERM", () => {});
  setInterval(() => {
    emit("step_start", { part: { type: "step-start" } });
    stepFinish("tool-calls", tokens(100, 10, 0, 1000, 0));
  }, 2);
} else {
  process.exitCode = (scenarios[scenario] ?? scenarios.success)();
}
