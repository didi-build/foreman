// The run's tally as the shared result line (ADR 0106 section 4; the mapping is in
// docs/spikes/opencode-runtime.md, check 1). `success` needs exit code 0, a last step that ended
// with the model's final answer and no error event. The wrapper's own stops are `max_budget` and
// `max_turns`, which the runner records as `budget_exceeded`. A provider error keeps its status,
// type, message and retry-after, so the runner tells a rate limit, a Flex capacity rejection, an
// out-of-credit error and the proxy's ceilings apart.
import type { ServiceTier } from "../../core/store.ts";
import { isFlexCapacityRejection } from "../shared/provider-error.ts";
import type { AgentResult } from "../shared/result.ts";
import { servedTier } from "../shared/tiers.ts";
import type { RunTally } from "./events.ts";
import type { LimitStop } from "./limits.ts";

/**
 * OpenCode 1.19.5 retries a retryable error itself, up to 5 times, and reports only the last
 * one (`session/retry.ts`; the count is fixed in its code). Successful retries emit no event.
 */
export const OPENCODE_RETRIES = 5;

export interface RunEnd {
  exitCode: number | null;
  /** The wrapper's own stop, if it stopped the run at a limit. */
  limit: LimitStop | null;
  /** True when OpenCode was stopped from outside (the pod's SIGTERM) without a limit. */
  stoppedFromOutside: boolean;
}

function endText(end: RunEnd, tally: RunTally): string {
  if (tally.error !== null) return tally.error.text;
  if (end.stoppedFromOutside) return "OpenCode was stopped before it finished";
  if (end.exitCode !== 0) {
    return `OpenCode exited with ${end.exitCode === null ? "a signal" : `code ${end.exitCode}`}${tally.turns === 0 ? " before any model step" : ""}`;
  }
  return tally.turns === 0
    ? "OpenCode printed no model step"
    : `OpenCode ended after a step that was not a final answer (${tally.lastReason ?? "no reason"})`;
}

export function openCodeResult(
  tally: RunTally,
  end: RunEnd,
  requestedTier: ServiceTier,
): AgentResult {
  const succeeded =
    end.limit === null &&
    !end.stoppedFromOutside &&
    end.exitCode === 0 &&
    tally.error === null &&
    tally.lastReason === "stop";
  const status: AgentResult["status"] = succeeded ? "success" : (end.limit ?? "error");
  const providerError =
    status === "error" ? (tally.error?.providerError ?? null) : null;
  const served = servedTier(tally.tiers);
  // Capacity as far as it is known: only a run that ended on a Flex capacity rejection, which
  // OpenCode had already retried, says how many retries it made. Their waits are not reported.
  const capacityRetries =
    providerError !== null &&
    tally.error?.retryable === true &&
    isFlexCapacityRejection(requestedTier, providerError)
      ? OPENCODE_RETRIES
      : undefined;
  return {
    status,
    finalText: tally.finalText,
    turns: tally.turns,
    costUsd: tally.costUsd,
    tokens: tally.tokens,
    errorText:
      status === "success"
        ? ""
        : status === "error"
          ? endText(end, tally)
          : status === "max_budget"
            ? "the run reached its dollar cap; OpenCode was stopped"
            : "the run reached its turn limit; OpenCode was stopped",
    providerError,
    ...(served === null ? {} : { serviceTierServed: served }),
    ...(capacityRetries === undefined ? {} : { capacityRetries }),
  };
}
