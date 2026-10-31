// The agent runtime interface (ADR 0107). One implementation per runtime; the runner sees only
// this. `start` returns at once, `poll` reports, `cancel` stops. Kubernetes reports and the runner
// decides (ADR 0106, essential 1): nothing here records a run or writes to the store.
import type { RunLimits, RunTokens } from "../../core/runs.ts";
import type {
  AgentRole,
  RunOutcome,
  ServedTier,
  UsageExhaustedCause,
} from "../../core/store.ts";

export interface AgentRuntime<Task, Handle> {
  /** Start a run and return at once. Long runs are never awaited in one call. */
  start(task: Task, limits: RunLimits): Promise<Handle>;
  /** The run's current state. The runner polls it from the reconcile pass. */
  poll(handle: Handle): Promise<AgentRunStatus>;
  /** Stop a run: the kill switch, budgets and a new head commit for QA. Safe to call twice. */
  cancel(handle: Handle): Promise<void>;
}

export type AgentRunStatus =
  { state: "running" } | { state: "finished"; result: AgentRunResult };

/**
 * How a run ended, in the `runs` table's terms (ADR 0107: the outcome uses the `runs.outcome`
 * values), so the runner can pass it to `recordEnd`. `finalText` is the agent's own text: the
 * runner removes every credential value it issued before storing any of it (ADR 0106 section 5).
 */
export interface AgentRunResult {
  outcome: RunOutcome;
  /** A fixed reason code for the outcome, for example `deadline_exceeded` or `bad_output`. */
  detail: string;
  finalText: string;
  /** For example a QA verdict. Unchecked: the caller validates it against its schema. */
  structured?: unknown;
  turns: number | null;
  costUsd: number | null;
  minutes: number | null;
  tokens: RunTokens | null;
  /** The model the runner started the run with, never the agent's own claim. */
  model: string;
  /** Only with `usage_exhausted`. */
  usageExhaustedCause?: UsageExhaustedCause;
  /** Only with `usage_exhausted`, when the provider gave one. */
  retryAfterSeconds?: number;
  // What the runtime measured about the route (ADR 0114 sections 2, 8 and 9), where it could.
  serviceTierServed?: ServedTier;
  capacityRetries?: number;
  capacityWaitSeconds?: number;
  firstTokenMs?: number;
}

export type { AgentRole, RunLimits };
