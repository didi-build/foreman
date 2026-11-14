// How a finished agent run is handed to `runs.recordEnd`: a field copy from the runtime's result
// (ADR 0107: the outcome already uses the `runs.outcome` values). The agent's own text is not
// stored here, so no credential it may echo reaches the store (ADR 0106 section 5). The runtime's
// cost figure is kept as `reportedCostUsd` (ADR 0114 section 2). `cost_usd` is not passed: the
// core works it out from the tokens and the run's recorded price (src/core/run-cost.ts).
import type { RunFailure } from "../../src/adapters/agent-runtime/run-failure.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import type { RunReport } from "../../src/core/runs.ts";

export function runReport(result: AgentRunResult): RunReport {
  return {
    outcome: result.outcome,
    turns: result.turns,
    minutes: result.minutes,
    tokens: result.tokens,
    usageExhaustedCause: result.usageExhaustedCause ?? null,
    retryAfterSeconds: result.retryAfterSeconds ?? null,
    serviceTierServed: result.serviceTierServed ?? null,
    capacityRetries: result.capacityRetries ?? null,
    capacityWaitSeconds: result.capacityWaitSeconds ?? null,
    firstTokenMs: result.firstTokenMs ?? null,
    reportedCostUsd: result.costUsd,
  };
}

/** What the run-end flow's result shows of a run that did not succeed (D-385). */
export interface RunEndFailure extends RunFailure {
  outcome: RunReport["outcome"];
  /** The runtime's fixed reason code, for example `agent_error` or `bad_output`. */
  detail: string;
}

/**
 * For a run that did not succeed, `failure`: its outcome, the runtime's fixed reason code, and
 * what the runtime kept of the cause (src/adapters/agent-runtime/run-failure.ts); for a success,
 * nothing. Shown in the run-end flow's result only; nothing of it is stored (D-385).
 */
export function failureOf(result: AgentRunResult): { failure?: RunEndFailure } {
  if (result.outcome === "success") return {};
  const { outcome, detail } = result;
  return { failure: { outcome, detail, ...(result.failure ?? {}) } };
}
