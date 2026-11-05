// The run watcher's flow start (D-330, O-102). When a run's agent Job, or QA's fetch Job, stops
// for any reason, the watcher (src/run-watcher/) starts `f/foreman/record_run_end` for that run,
// so the run's end is recorded on the event. The flow is idempotent (`already_recorded`), and the
// reconcile pass stays as the safety net for a start that failed.
//
// The watcher has one Windmill token, read from the secret path below, that can start only the
// flows in `RUN_WATCHER_FLOW_PATHS`: the run-end flow and nothing else. The call goes through the
// shared Windmill egress proxy (D-328, ./client.ts). Until the token exists every start is refused
// with `NotBuiltError`. Tests use ./fake-flow-start.ts.
import {
  entryArgs,
  NotBuiltError,
  windmillScripts,
  type WindmillClientOptions,
  type WindmillTarget,
} from "./client.ts";

/** The secret path of the run watcher's Windmill token (D-330). */
export const RUN_WATCHER_WINDMILL_TOKEN_PATH = "platform/run-watcher/windmill-token";

/** The run-end flow (flows/windmill.yaml, flows/record-run-end.ts). */
export const RECORD_RUN_END_FLOW_PATH = "f/foreman/record_run_end";

/** Every flow the watcher's token may start, and nothing else: one scope per path (D-330). */
export const RUN_WATCHER_FLOW_PATHS: readonly string[] = [RECORD_RUN_END_FLOW_PATH];

/** Starts the run-end flow for one run. Resolves once Windmill accepts the start. */
export interface RunEndFlow {
  start(runId: string): Promise<void>;
}

/**
 * The Windmill binding. `token` is the watcher's token read from its secret path, or null while it
 * does not exist; then every start is refused. `seams` is for tests only.
 */
export function windmillRunEndFlow(
  token: string | null,
  target: WindmillTarget,
  seams: Pick<WindmillClientOptions, "ca" | "timeoutMs"> = {},
): RunEndFlow {
  if (token === null) {
    return {
      start: async () => {
        throw new NotBuiltError(
          "Starting the run-end flow needs the run watcher's Windmill token, created at first hosting (D-330)",
        );
      },
    };
  }
  const scripts = windmillScripts({ target, token, ...seams });
  return {
    start: (runId) => scripts.start(RECORD_RUN_END_FLOW_PATH, entryArgs({ runId })),
  };
}
