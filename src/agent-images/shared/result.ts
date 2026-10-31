// The one result line an agent image prints last (ADR 0106 section 4). Its shape is version 1 of
// `AgentResult`, which the Kubernetes runtime parses (src/adapters/agent-runtime/kubernetes/
// result.ts). Every credential value is removed before the line is written.
import type {
  AgentResult,
  ProviderError,
} from "../../adapters/agent-runtime/kubernetes/result.ts";
import type { RunTokens } from "../../core/runs.ts";

export type { AgentResult, ProviderError };

const REDACTED = "[redacted]";

/** Replace every secret value in every string, at any depth. Short values are never secrets. */
export function redact<T>(value: T, secrets: readonly string[]): T {
  const values = secrets.filter((s) => s.length >= 8);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return values.reduce((text, secret) => text.split(secret).join(REDACTED), v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.entries(v).map(([k, inner]) => [k, walk(inner)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

/** A result with nothing known yet, for runs that end before any model call. */
export function errorResult(errorText: string): AgentResult {
  return {
    status: "error",
    finalText: "",
    turns: null,
    costUsd: null,
    tokens: null,
    errorText,
    providerError: null,
  };
}

function tokensJson(tokens: RunTokens) {
  return {
    uncachedInput: tokens.uncachedInput,
    cachedInput: tokens.cachedInput,
    ...(tokens.cacheWriteInput === undefined
      ? {}
      : { cacheWriteInput: tokens.cacheWriteInput }),
    output: tokens.output,
  };
}

/** The result as its one JSON line, credential values removed. Null fields are left out. */
export function resultLine(result: AgentResult, secrets: readonly string[]): string {
  const line = {
    foremanResult: 1,
    status: result.status,
    finalText: result.finalText,
    ...(result.structured === undefined ? {} : { structured: result.structured }),
    ...(result.turns === null ? {} : { turns: result.turns }),
    ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
    ...(result.tokens === null ? {} : { tokens: tokensJson(result.tokens) }),
    ...(result.errorText === "" ? {} : { errorText: result.errorText }),
    ...(result.providerError === null
      ? {}
      : {
          providerError: {
            ...(result.providerError.status === null
              ? {}
              : { status: result.providerError.status }),
            type: result.providerError.type,
            message: result.providerError.message,
            ...(result.providerError.retryAfterSeconds === null
              ? {}
              : { retryAfterSeconds: result.providerError.retryAfterSeconds }),
          },
        }),
  };
  return JSON.stringify(redact(line, secrets));
}

/** Writes the result line. Nothing may be written after it. */
export function printResult(
  result: AgentResult,
  secrets: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): void {
  write(resultLine(result, secrets));
}

/** The exit code that goes with a result: 0 only for success. */
export function exitCode(result: AgentResult): number {
  return result.status === "success" ? 0 : 1;
}
