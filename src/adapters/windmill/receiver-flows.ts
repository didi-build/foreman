// The GitHub receiver's flow starts (D-291, D-327, D-329, O-101). After the receiver records CI's
// end on a design item's PR head, it starts `f/foreman/option_capture` for the item when a capture
// is due (src/github-receiver/flow-starts.ts), so Didi's visual-approval request opens without
// waiting for the reconcile pass, which stays as the safety net with the run-end flow's capture.
//
// The receiver has one Windmill token, read from the secret path below, that can start only the
// flows in `RECEIVER_FLOW_PATHS`. Each later slice adds to that list only the flows its events need
// (D-329), and the token is created again with the new list. The call goes through the shared
// Windmill egress proxy (D-328, ./client.ts). Until the token exists every start is refused with
// `NotBuiltError`. Tests use ./fake-flow-start.ts.
import {
  entryArgs,
  NotBuiltError,
  windmillScripts,
  type WindmillClientOptions,
  type WindmillTarget,
} from "./client.ts";

/** The secret path of the receiver's Windmill token (D-291). */
export const RECEIVER_WINDMILL_TOKEN_PATH = "platform/github-receiver/windmill-token";

/** The option capture flow (flows/windmill.yaml, O-88). */
export const OPTION_CAPTURE_FLOW_PATH = "f/foreman/option_capture";

/** Every flow the receiver's token may start, and nothing else: one scope per path (D-291). */
export const RECEIVER_FLOW_PATHS: readonly string[] = [OPTION_CAPTURE_FLOW_PATH];

/** Starts the option capture flow for one design item. Resolves once Windmill accepts. */
export interface OptionCaptureFlow {
  start(nodeId: string): Promise<void>;
}

/**
 * The Windmill binding. `token` is the receiver's token read from its secret path, or null while
 * it does not exist; then every start is refused. `seams` is for tests only.
 */
export function windmillOptionCaptureFlow(
  token: string | null,
  target: WindmillTarget,
  seams: Pick<WindmillClientOptions, "ca" | "timeoutMs"> = {},
): OptionCaptureFlow {
  if (token === null) {
    return {
      start: async () => {
        throw new NotBuiltError(
          "Starting the option capture flow needs the GitHub receiver's Windmill token, created at first hosting (D-291)",
        );
      },
    };
  }
  const scripts = windmillScripts({ target, token, ...seams });
  return {
    start: (nodeId) => scripts.start(OPTION_CAPTURE_FLOW_PATH, entryArgs({ nodeId })),
  };
}
