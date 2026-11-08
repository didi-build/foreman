// The receiver's start of the staging deploy (D-353, D-356, O-116), outside CI's path on a PR head:
// once CI's build on main has finished, the runner deploys it to the project's staging site. It
// runs after the delivery is recorded and after ./flow-starts.ts, and changes neither: ingestion
// records a `workflow_run` for a commit with no pull request as a delivery only, as before. It is
// built as ./bootstrap-starts.ts is (O-114).
//
// It starts `f/foreman/deploy_staging` with the repository and the run's id when the signed
// payload is a `workflow_run` `completed` with conclusion `success` for exactly
// `.github/workflows/ci.yml`, started by `push` on the repository's default branch
// (`head_branch` equal to `repository.default_branch`), whose head repository is the run's own
// repository, and only for a delivery recorded now (never a replay or a delivery ingestion
// rejected) while neither switch holds the runner. The receiver's role cannot read projects
// (migration 0002), so the flow refuses a repository that is not a registered project, and reads
// the run from GitHub again: it trusts nothing here but the two ids.
//
// A `deployment_status` delivery starts nothing (D-356): the runner records its own deploys.
// A failed start, or a switch that cannot be read, is logged with the error's type and the client's
// step and status, never the repository, an id or a token, and the reconcile pass's staging deploy
// backstop deploys later. Each start uses one Windmill run (D-164): about one per push to main of
// each repository the runner App is installed on.
import type { DeployStagingFlow } from "../adapters/windmill/receiver-flows.ts";
import { startErrorFields } from "../adapters/windmill/client.ts";
import { REPOSITORY } from "../core/github.ts";
import type { IngestResult } from "../core/github-ingest.ts";
import { STAGING_BUILD_EVENT, STAGING_BUILD_WORKFLOW } from "../core/staging-deploy.ts";
import type { Store } from "../core/store.ts";
import type { Logger } from "../service-kit/logger.ts";
import type { BootstrapDelivery } from "./bootstrap-starts.ts";

export interface StagingStartOptions {
  /** Read for the two switches only, which the receiver's role may read (migration 0020). */
  store: Pick<Store, "getSetting">;
  deployStaging: DeployStagingFlow;
  logger: Logger;
}

/** Starts what one recorded delivery makes due here. Never throws. */
export type StagingStarts = (
  deliveryId: string,
  delivery: BootstrapDelivery,
  result: IngestResult,
) => Promise<void>;

export const STAGING_DEPLOY_STARTED = "staging deploy flow started";
export const STAGING_DEPLOY_NOT_STARTED =
  "staging deploy flow not started; the reconcile pass deploys later";

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The repository and run id when the payload is CI's successful run on a push to the default
 * branch of the repository itself; null for anything else.
 */
export function finishedMainBuild(
  event: string,
  payload: unknown,
): { repo: string; runId: number } | null {
  if (event !== "workflow_run" || field(payload, "action") !== "completed") return null;
  const run = field(payload, "workflow_run");
  if (field(run, "path") !== STAGING_BUILD_WORKFLOW) return null;
  if (field(run, "event") !== STAGING_BUILD_EVENT) return null;
  if (field(run, "status") !== "completed" || field(run, "conclusion") !== "success")
    return null;
  const repository = field(payload, "repository");
  const repo = field(repository, "full_name");
  if (typeof repo !== "string" || !REPOSITORY.test(repo)) return null;
  const defaultBranch = field(repository, "default_branch");
  if (typeof defaultBranch !== "string" || defaultBranch === "") return null;
  if (field(run, "head_branch") !== defaultBranch) return null;
  if (field(field(run, "head_repository"), "full_name") !== repo) return null;
  const runId = field(run, "id");
  if (!Number.isSafeInteger(runId) || (runId as number) <= 0) return null;
  return { repo, runId: runId as number };
}

export function createStagingStarts(options: StagingStartOptions): StagingStarts {
  const { store, deployStaging, logger } = options;
  return async (deliveryId, delivery, result) => {
    if (result.outcome === "duplicate" || result.outcome === "rejected") return;
    const build = finishedMainBuild(delivery.event, delivery.payload);
    if (build === null) return;
    try {
      if ((await store.getSetting("kill_switch"))?.value === true) return;
      if ((await store.getSetting("dry_run"))?.value !== false) return;
      await deployStaging.start(build.repo, build.runId);
      logger.info(STAGING_DEPLOY_STARTED, { deliveryId });
    } catch (error) {
      logger.warn(STAGING_DEPLOY_NOT_STARTED, {
        deliveryId,
        ...startErrorFields(error),
      });
    }
  };
}
