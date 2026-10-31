#!/usr/bin/env node
// Test helper: stands in for the pinned OpenCode binary. It reads the prompt from stdin, records
// its arguments, environment, working folder, prompt and the config file it was given in
// fake-opencode-call.json in its working folder, then prints `--format json` event lines in the
// shape OpenCode 1.19.5 prints them (docs/spikes/opencode-runtime.md, check 1), chosen by
// `scenario=<name>` in the prompt. It never calls a model and never uses the network.
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
    emit("text", { part: { type: "text", text: "Done." } });
    stepFinish("stop", tokens(12, 80, 20, 5400, 100));
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
