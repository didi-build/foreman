// What the run watcher does with each stopped run Job the watch reports (D-330, O-102): it starts
// `f/foreman/record_run_end` for that run, once per Job in this process, however often the watch
// reports the Job again (a later event, or a fresh list after a 410 or a dropped watch). Each start
// is one of the Windmill free plan's 1,000 runs a month (D-164), so a Job is never sent twice by
// one process; the flow itself also records an end only once (`already_recorded`).
//
// A failed start is retried after each wait in `START_RETRY_DELAYS_MS`, then given up and left to
// the reconcile pass. A missing token (`NotBuiltError`) is not retried: nothing is started until
// the token exists and the watcher restarts, which then sends every stopped Job still present. Log
// lines name the namespace, the Job's kind, how it stopped, the attempt and the client's step and
// status, never the run id (a database id), the Job's name (which holds it) or the token.
import {
  sleepUnlessAborted,
  type RunJobEvents,
  type RunJobStop,
} from "../adapters/agent-runtime/kubernetes/job-watch.ts";
import { NotBuiltError, startErrorFields } from "../adapters/windmill/client.ts";
import type { RunEndFlow } from "../adapters/windmill/run-watcher-flows.ts";
import type { Logger } from "../service-kit/logger.ts";

/** The waits before each retry of a failed start: four tries in all, over about 2.5 minutes. */
export const START_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

export const RUN_END_STARTED = "run end flow started";
export const RUN_END_RETRYING = "run end flow start failed; trying again";
export const RUN_END_NOT_STARTED =
  "run end flow not started; the reconcile pass records the end later";
export const WATCH_FAILED = "watching run jobs failed; listing again";

export interface RunEndStartsOptions {
  flow: RunEndFlow;
  logger: Logger;
  retryDelaysMs?: readonly number[];
  /** Test seam. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RunEndStarts extends RunJobEvents {
  /** Resolves once every start taken so far has finished, retries included. */
  settled(): Promise<void>;
  /** Stops waiting to retry, then waits for the starts in progress. */
  stop(): Promise<void>;
}

export function createRunEndStarts(options: RunEndStartsOptions): RunEndStarts {
  const { flow, logger } = options;
  const delays = options.retryDelaysMs ?? START_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepUnlessAborted;
  /** Every Job this process has taken a start for, by `jobKey`. */
  const taken = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const controller = new AbortController();

  async function start(stop: RunJobStop): Promise<void> {
    const fields = { namespace: stop.namespace, job: stop.component, stop: stop.state };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await flow.start(stop.runId);
        logger.info(RUN_END_STARTED, { ...fields, attempt });
        return;
      } catch (error) {
        const failure = { ...fields, attempt, ...startErrorFields(error) };
        const wait = error instanceof NotBuiltError ? undefined : delays[attempt - 1];
        if (wait === undefined || controller.signal.aborted) {
          logger.warn(RUN_END_NOT_STARTED, failure);
          return;
        }
        logger.warn(RUN_END_RETRYING, { ...failure, retryInMs: wait });
        await sleep(wait, controller.signal);
        if (controller.signal.aborted) {
          // Shutting down: the Job is still there, so the next process sends it.
          logger.warn(RUN_END_NOT_STARTED, { ...failure, stopping: true });
          return;
        }
      }
    }
  }

  return {
    stopped(stop) {
      if (taken.has(stop.key) || controller.signal.aborted) return;
      taken.add(stop.key);
      const running = start(stop);
      inFlight.add(running);
      void running.finally(() => inFlight.delete(running));
    },
    deleted(key) {
      // A deleted Job never comes back under the same key, so it need not be kept.
      taken.delete(key);
    },
    failed(failure) {
      logger.warn(WATCH_FAILED, failure);
    },
    settled: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    stop: async () => {
      controller.abort();
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
