// The receiver's one start outside CI's path (D-358 lock (2), O-114): once Bootstrap's restarted
// run ends, the repository loses access to `BOOTSTRAP_TOKEN`. It runs after the delivery is
// recorded and after ./flow-starts.ts, and changes neither: ingestion records a `workflow_run`
// for a commit with no pull request as a delivery only, as before.
//
// It starts `f/foreman/remove_bootstrap_access` with the repository when the signed payload is a
// `workflow_run` `completed` for `.github/workflows/bootstrap.yml` (or that path with `@<ref>`),
// started by `workflow_dispatch` (the register form's restart, the run that had the token), in a
// repository of didi-build, whatever its conclusion, and only for a delivery recorded now (never a
// replay or a delivery ingestion rejected) while neither switch holds the runner. A run started by
// a push is left alone: the form's grant can come while Bootstrap's first run, at creation, is
// still running, and removing the access when that run ends would leave the restart without it.
// The GitHub App subscribes to `workflow_run` with the runner App's `actions: read` (D-267), and
// the receiver already handles it (`HANDLED_EVENTS`, src/core/github-ingest.ts).
//
// The receiver's role cannot read projects, so the flow removes the access for any repository of
// the organization; for one that is not a registered project, that is what the reconcile pass's
// backstop does anyway. A failed start, or a switch that cannot be read, is logged with the
// error's type and the client's step and status, never the repository, an id or a token, and the
// backstop removes the access later. Each start uses one Windmill run (D-164): about one per
// registered project.
import type { RemoveBootstrapAccessFlow } from "../adapters/windmill/receiver-flows.ts";
import { startErrorFields } from "../adapters/windmill/client.ts";
import {
  GITHUB_ORGANIZATION,
  isBootstrapWorkflowPath,
  organizationRepositoryName,
  RESTART_EVENT,
} from "../core/bootstrap-access.ts";
import type { IngestResult } from "../core/github-ingest.ts";
import type { Store } from "../core/store.ts";
import type { Logger } from "../service-kit/logger.ts";

export interface BootstrapStartOptions {
  /** Read for the two switches only, which the receiver's role may read (migration 0020). */
  store: Pick<Store, "getSetting">;
  removeBootstrapAccess: RemoveBootstrapAccessFlow;
  logger: Logger;
}

/** One recorded delivery, as the handler read it, with what ingestion made of it. */
export interface BootstrapDelivery {
  event: string;
  payload: unknown;
}

/** Starts what one recorded delivery makes due here. Never throws. */
export type BootstrapStarts = (
  deliveryId: string,
  delivery: BootstrapDelivery,
  result: IngestResult,
) => Promise<void>;

export const BOOTSTRAP_REMOVAL_STARTED = "bootstrap access removal flow started";
export const BOOTSTRAP_REMOVAL_NOT_STARTED =
  "bootstrap access removal flow not started; the reconcile pass removes the access later";

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The repository, `didi-build/<name>`, when the payload is a completed Bootstrap run started by
 * `workflow_dispatch` in the organization; null for anything else.
 */
export function endedBootstrapRestart(event: string, payload: unknown): string | null {
  if (event !== "workflow_run" || field(payload, "action") !== "completed") return null;
  const run = field(payload, "workflow_run");
  if (!isBootstrapWorkflowPath(field(run, "path"))) return null;
  if (field(run, "event") !== RESTART_EVENT) return null;
  if (field(run, "status") !== "completed") return null;
  const name = organizationRepositoryName(
    field(field(payload, "repository"), "full_name"),
  );
  return name === null ? null : `${GITHUB_ORGANIZATION}/${name}`;
}

export function createBootstrapStarts(options: BootstrapStartOptions): BootstrapStarts {
  const { store, removeBootstrapAccess, logger } = options;
  return async (deliveryId, delivery, result) => {
    if (result.outcome === "duplicate" || result.outcome === "rejected") return;
    const repo = endedBootstrapRestart(delivery.event, delivery.payload);
    if (repo === null) return;
    try {
      if ((await store.getSetting("kill_switch"))?.value === true) return;
      if ((await store.getSetting("dry_run"))?.value !== false) return;
      await removeBootstrapAccess.start(repo);
      logger.info(BOOTSTRAP_REMOVAL_STARTED, { deliveryId });
    } catch (error) {
      logger.warn(BOOTSTRAP_REMOVAL_NOT_STARTED, {
        deliveryId,
        ...startErrorFields(error),
      });
    }
  };
}
