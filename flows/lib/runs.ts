// How a finished agent run is handed to `runs.recordEnd`: a field copy from the runtime's result
// (ADR 0107: the outcome already uses the `runs.outcome` values). The agent's own text is not
// stored here, so no credential it may echo reaches the store (ADR 0106 section 5). The runtime's
// cost figure is kept as `reportedCostUsd` (ADR 0114 section 2). `cost_usd` is not passed: the
// core works it out from the tokens and the run's recorded price (src/core/run-cost.ts).
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
