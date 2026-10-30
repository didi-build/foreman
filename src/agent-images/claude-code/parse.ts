// Claude Code's `--output-format json` result as the image's result line (ADR 0106 section 6).
// The CLI prints one object: `subtype` (`success`, `error_max_turns`, `error_max_budget_usd`,
// `error_during_execution`, ...), `is_error`, `num_turns`, `total_cost_usd`, `usage`, `result`
// (the final text), `errors`, and `api_error_status` when a turn ended on a provider error.
// Checked against Claude Code 2.1.312, the version the image pins.
import { providerErrorFromClaudeCode } from "../shared/provider-error.ts";
import { errorResult, type AgentResult } from "../shared/result.ts";
import { tokensFromUsage, type ProviderUsage } from "../shared/tokens.ts";

const MAX_TEXT = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The last line of stdout that is a JSON object with `type: "result"`, if any. */
function resultObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).trim();
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value) && value.type === "result") return value;
    } catch {
      // Not JSON: keep looking.
    }
  }
  // The whole of stdout may be one pretty-printed object.
  try {
    const value: unknown = JSON.parse(stdout);
    if (isObject(value) && value.type === "result") return value;
  } catch {
    // No result.
  }
  return null;
}

export function parseClaudeCodeResult(
  stdout: string,
  exitCode: number | null,
): AgentResult {
  const parsed = resultObject(stdout);
  if (parsed === null) {
    return errorResult(
      `Claude Code exited with ${exitCode === null ? "a signal" : `code ${exitCode}`} and printed no result`,
    );
  }
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
  const status: AgentResult["status"] =
    subtype === "success" && parsed.is_error !== true
      ? "success"
      : subtype === "error_max_turns"
        ? "max_turns"
        : subtype === "error_max_budget_usd"
          ? "max_budget"
          : "error";
  const finalText =
    typeof parsed.result === "string" ? parsed.result.slice(0, MAX_TEXT) : "";
  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.filter((e): e is string => typeof e === "string").join("\n")
    : "";
  const errorText =
    status === "success"
      ? ""
      : (
          errors ||
          finalText ||
          `Claude Code ended with ${subtype || "no subtype"}`
        ).slice(0, 4096);
  const cost = parsed.total_cost_usd;
  return {
    status,
    finalText,
    turns: count(parsed.num_turns),
    costUsd:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    tokens: isObject(parsed.usage)
      ? tokensFromUsage(parsed.usage as ProviderUsage)
      : null,
    errorText,
    providerError:
      status === "error"
        ? providerErrorFromClaudeCode(count(parsed.api_error_status), errorText)
        : null,
  };
}
