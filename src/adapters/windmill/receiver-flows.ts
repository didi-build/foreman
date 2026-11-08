// The GitHub receiver's flow starts (D-291, D-327, D-329, O-101, O-104). Each one follows an event
// the receiver has just recorded, and only when the flow's own due check says it is due
// (src/github-receiver/flow-starts.ts), so the work starts on the event while the reconcile pass
// stays as the safety net:
// - after it records CI's end on a design item's PR head, `f/foreman/option_capture` for the item
//   when a capture is due, so Didi's visual-approval request opens at once (O-101);
// - after it records CI's end on an item's PR head, `f/foreman/advance_item` for the item when an
//   advance from evidence is due, so the item moves into In QA review and QA's run starts (O-104);
// - after it records a finished `deployment_status` to `staging`, `f/foreman/verify_staging` with
//   the repository and the commit, when an item of that repository is in Verifying on staging
//   (O-104);
// - after it records a `workflow_run` `completed` for Bootstrap started by `workflow_dispatch`,
//   `f/foreman/remove_bootstrap_access` with the repository, so the repository loses access to
//   `BOOTSTRAP_TOKEN` once its setup run ends (D-358, O-114, ../../github-receiver/bootstrap-starts.ts).
//
// The receiver has one Windmill token, read from the secret path below, that can start only the
// flows in `RECEIVER_FLOW_PATHS`. Each slice added to that list only the flows its events need
// (D-329), and the token is created again with the new list. The call goes through the shared
// Windmill egress proxy (D-328, ./client.ts). Until the token exists every start is refused with
// `NotBuiltError`. Tests use ./fake-flow-start.ts.
import type { Json } from "../../core/store.ts";
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

/** The advance flow (flows/windmill.yaml, flows/advance-item.ts, O-104). */
export const ADVANCE_ITEM_FLOW_PATH = "f/foreman/advance_item";

/** The staging flow (flows/windmill.yaml, flows/verify-staging.ts, O-34). */
export const VERIFY_STAGING_FLOW_PATH = "f/foreman/verify_staging";

/** The removal of `BOOTSTRAP_TOKEN`'s access (flows/windmill.yaml, flows/remove-bootstrap-access.ts, O-114). */
export const REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH = "f/foreman/remove_bootstrap_access";

/** Every flow the receiver's token may start, and nothing else: one scope per path (D-291). */
export const RECEIVER_FLOW_PATHS: readonly string[] = [
  OPTION_CAPTURE_FLOW_PATH,
  ADVANCE_ITEM_FLOW_PATH,
  VERIFY_STAGING_FLOW_PATH,
  REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH,
];

/** Starts the option capture flow for one design item. Resolves once Windmill accepts. */
export interface OptionCaptureFlow {
  start(nodeId: string): Promise<void>;
}

/** Starts the advance flow for one item. Resolves once Windmill accepts. */
export interface AdvanceItemFlow {
  start(nodeId: string): Promise<void>;
}

/** Starts the staging flow for one repository and commit. Resolves once Windmill accepts. */
export interface VerifyStagingFlow {
  start(repo: string, sha: string): Promise<void>;
}

/** Starts the removal of one repository's access to `BOOTSTRAP_TOKEN`. Resolves once Windmill accepts. */
export interface RemoveBootstrapAccessFlow {
  start(repo: string): Promise<void>;
}

/** The receiver's four starts. */
export interface ReceiverFlows {
  optionCapture: OptionCaptureFlow;
  advanceItem: AdvanceItemFlow;
  verifyStaging: VerifyStagingFlow;
  removeBootstrapAccess: RemoveBootstrapAccessFlow;
}

/** One start at `path`, refused with `NotBuiltError` while the token does not exist. */
function starter(
  path: string,
  token: string | null,
  target: WindmillTarget,
  seams: Pick<WindmillClientOptions, "ca" | "timeoutMs">,
): (input: Record<string, Json>) => Promise<void> {
  if (token === null) {
    return async () => {
      throw new NotBuiltError(
        `Starting ${path} needs the GitHub receiver's Windmill token, created at first hosting (D-291)`,
      );
    };
  }
  const scripts = windmillScripts({ target, token, ...seams });
  return (input) => scripts.start(path, entryArgs(input));
}

/**
 * The Windmill bindings. `token` is the receiver's token read from its secret path, or null while
 * it does not exist; then every start is refused. `seams` is for tests only.
 */
export function windmillReceiverFlows(
  token: string | null,
  target: WindmillTarget,
  seams: Pick<WindmillClientOptions, "ca" | "timeoutMs"> = {},
): ReceiverFlows {
  const capture = starter(OPTION_CAPTURE_FLOW_PATH, token, target, seams);
  const advance = starter(ADVANCE_ITEM_FLOW_PATH, token, target, seams);
  const staging = starter(VERIFY_STAGING_FLOW_PATH, token, target, seams);
  const removal = starter(REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH, token, target, seams);
  return {
    optionCapture: { start: (nodeId) => capture({ nodeId }) },
    advanceItem: { start: (nodeId) => advance({ nodeId }) },
    // flows/verify-staging.ts reads `{ repo, sha }` as its input.
    verifyStaging: { start: (repo, sha) => staging({ repo, sha }) },
    // flows/remove-bootstrap-access.ts reads `{ repo }` as its input.
    removeBootstrapAccess: { start: (repo) => removal({ repo }) },
  };
}
