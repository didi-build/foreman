// The GitHub receiver's flow starts (D-291, D-329, D-381, O-101, O-104, O-114, O-116, O-128). Each
// one follows a delivery the receiver has just recorded, and the reconcile pass stays as the safety
// net:
// - after it records a delivery whose evidence needs a GitHub read (a pull request's new commits
//   or merge, CI's end on a commit that names pull requests), `f/foreman/ingest_delivery` with the
//   identifiers the core names (`HandedOnDelivery`, src/core/github-ingest.ts), so the runner reads
//   GitHub with its own narrow tokens and records the evidence (D-381, O-128,
//   ../../github-receiver/ingest-starts.ts). That flow then takes, in its own run, the steps CI's
//   end makes due, which the receiver used to start as `f/foreman/option_capture` and
//   `f/foreman/advance_item` (O-101, O-104); the receiver starts neither any more;
// - after it records a `workflow_run` `completed` with conclusion `success` for
//   `.github/workflows/ci.yml` started by a push to the repository's default branch from the
//   repository itself, `f/foreman/deploy_staging` with the repository and the run's id, so the
//   runner deploys that build to the project's staging site and records the deploy (D-353, D-356,
//   O-116, ../../github-receiver/staging-starts.ts). A `deployment_status` starts nothing;
// - after it records a `workflow_run` `completed` for Bootstrap started by `workflow_dispatch`,
//   `f/foreman/remove_bootstrap_access` with the repository, so the repository loses access to
//   `BOOTSTRAP_TOKEN` once its setup run ends (D-358, O-114, ../../github-receiver/bootstrap-starts.ts).
//
// The receiver has one Windmill token, read from the secret path below, that can start only the
// flows in `RECEIVER_FLOW_PATHS`. Each slice changed that list only for the flows its events need
// (D-329), and the token is created again with the new list. The call goes through the shared
// Windmill egress proxy (D-328, ./client.ts). Until the token exists every start is refused with
// `NotBuiltError`. Tests use ./fake-flow-start.ts.
import type { HandedOnDelivery } from "../../core/github-ingest.ts";
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

/** The ingest flow (flows/windmill.yaml, flows/ingest-delivery.ts, D-381, O-128). */
export const INGEST_DELIVERY_FLOW_PATH = "f/foreman/ingest_delivery";

/** The staging deploy flow (flows/windmill.yaml, flows/deploy-staging.ts, O-116). */
export const DEPLOY_STAGING_FLOW_PATH = "f/foreman/deploy_staging";

/** The removal of `BOOTSTRAP_TOKEN`'s access (flows/windmill.yaml, flows/remove-bootstrap-access.ts, O-114). */
export const REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH = "f/foreman/remove_bootstrap_access";

/** Every flow the receiver's token may start, and nothing else: one scope per path (D-291). */
export const RECEIVER_FLOW_PATHS: readonly string[] = [
  INGEST_DELIVERY_FLOW_PATH,
  DEPLOY_STAGING_FLOW_PATH,
  REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH,
];

/** Starts the ingest flow for one delivery that needs GitHub. Resolves once Windmill accepts. */
export interface IngestDeliveryFlow {
  start(delivery: HandedOnDelivery): Promise<void>;
}

/** Starts the staging deploy of one CI run of one repository. Resolves once Windmill accepts. */
export interface DeployStagingFlow {
  start(repo: string, runId: number): Promise<void>;
}

/** Starts the removal of one repository's access to `BOOTSTRAP_TOKEN`. Resolves once Windmill accepts. */
export interface RemoveBootstrapAccessFlow {
  start(repo: string): Promise<void>;
}

/** The receiver's three starts. */
export interface ReceiverFlows {
  ingestDelivery: IngestDeliveryFlow;
  deployStaging: DeployStagingFlow;
  removeBootstrapAccess: RemoveBootstrapAccessFlow;
}

/**
 * The ingest flow's input: exactly the six fields of a handed-on delivery, copied one by one, so
 * nothing else the object might carry is sent (ADR 0113 section 8).
 */
export function ingestDeliveryInput(delivery: HandedOnDelivery): Record<string, Json> {
  return {
    deliveryId: delivery.deliveryId,
    event: delivery.event,
    action: delivery.action,
    repo: delivery.repo,
    pullRequests: [...delivery.pullRequests],
    headSha: delivery.headSha,
  };
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
  const ingest = starter(INGEST_DELIVERY_FLOW_PATH, token, target, seams);
  const staging = starter(DEPLOY_STAGING_FLOW_PATH, token, target, seams);
  const removal = starter(REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH, token, target, seams);
  return {
    // flows/ingest-delivery.ts reads the handed-on delivery as its input.
    ingestDelivery: { start: (delivery) => ingest(ingestDeliveryInput(delivery)) },
    // flows/deploy-staging.ts reads `{ repo, runId }` as its input.
    deployStaging: { start: (repo, runId) => staging({ repo, runId }) },
    // flows/remove-bootstrap-access.ts reads `{ repo }` as its input.
    removeBootstrapAccess: { start: (repo) => removal({ repo }) },
  };
}
