#!/usr/bin/env node
// Test helper: stands in for the pinned Claude Code CLI. It records the argument list and the
// environment it was given in fake-claude-call.json in its working folder, then prints a
// `--output-format json` result chosen by `scenario=<name>` in the prompt (the last argument).
// It never calls a model and never uses the network.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
writeFileSync(
  join(process.cwd(), "fake-claude-call.json"),
  JSON.stringify({ args, env: process.env, cwd: process.cwd() }),
);
const prompt = args.at(-1) ?? "";
const scenario = /scenario=([a-z_-]+)/.exec(prompt)?.[1] ?? "success";
const usage = {
  input_tokens: 12,
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 4500,
  output_tokens: 80,
};
const base = {
  type: "result",
  duration_ms: 1000,
  duration_api_ms: 900,
  num_turns: 3,
  total_cost_usd: 0.0207,
  usage,
  session_id: "fake",
  permission_denials: [],
};
const results = {
  success: { ...base, subtype: "success", is_error: false, result: "Done." },
  max_turns: {
    ...base,
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 10,
    errors: [],
  },
  max_budget: {
    ...base,
    subtype: "error_max_budget_usd",
    is_error: true,
    total_cost_usd: 5.01,
    errors: [],
  },
  rate_limit: {
    ...base,
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    result:
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
  },
  overloaded: {
    ...base,
    subtype: "success",
    is_error: true,
    api_error_status: 529,
    result:
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  },
  billing: {
    ...base,
    subtype: "success",
    is_error: true,
    api_error_status: 402,
    result:
      'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"}}',
  },
  "echo-secrets": {
    ...base,
    subtype: "success",
    is_error: false,
    result: `state ${process.env.FOREMAN_STATE_API_TOKEN} github ${process.env.GITHUB_TOKEN} key ${process.env.ANTHROPIC_API_KEY}`,
  },
};
if (scenario === "no-output") process.exit(2);
process.stdout.write(`${JSON.stringify(results[scenario] ?? results.success)}\n`);
process.exit(results[scenario]?.is_error ? 1 : 0);
