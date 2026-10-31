// The run's dollar cap and turn limit, enforced by the wrapper (D-223). OpenCode has no dollar cap,
// and its `steps` setting only asks the model to stop (docs/spikes/opencode-runtime.md, check 2),
// so the wrapper checks after every model step and stops OpenCode before the next request.
// The proxy's request ceiling, its rejected-request ceiling and the Job deadline stay as the
// limits outside the agent's reach (ADR 0106 section 6).
import type { RunTally } from "./events.ts";

export interface RunLimits {
  maxTurns: number;
  maxUsd: number;
}

export type LimitStop = "max_turns" | "max_budget";

/**
 * Whether to stop after the latest step. A step that ended with the model's final answer
 * (`stop`) is let through: no further request follows. Otherwise the run stops when it has used
 * its turns, or when its cost plus the latest step's cost reaches the cap, since the next request
 * rereads at least that context. The cap can still be passed by one request.
 */
export function limitStop(tally: RunTally, limits: RunLimits): LimitStop | null {
  if (tally.turns === 0 || tally.lastReason === "stop") return null;
  if (tally.costUsd + tally.lastStepCostUsd >= limits.maxUsd) return "max_budget";
  if (tally.turns >= limits.maxTurns) return "max_turns";
  return null;
}
