// The GitHub webhook receiver (build plan M2.3, ADR 0113). Configuration only from the
// environment (ADR 0111): PORT, DATABASE_URL (a login user in the factory_ingest role) and the
// webhook secret by path. For its flow starts (D-291, D-327, D-381, O-101, O-128): WINDMILL_HOST,
// WINDMILL_WORKSPACE, HTTPS_PROXY (the shared Windmill egress proxy, D-328) and its Windmill token
// at `platform/github-receiver/windmill-token`; until Didi creates the token at first hosting
// every start is refused and the reconcile pass records the evidence, captures, advances and
// deploys. It holds no GitHub token and reads nothing from GitHub (D-381): a delivery that needs
// GitHub is recorded and handed to the ingest flow, which reads GitHub with the runner App's
// narrow tokens, records the evidence and takes the steps CI's end makes due (option capture and
// the advance into In QA review). So it no longer reads the contracts, the guards or the Apps'
// names (the Deployment still sets the three names, which nothing reads now). Apart from CI's
// path on a PR head, it starts the removal of `BOOTSTRAP_TOKEN`'s access once Bootstrap's
// restarted run ends (O-114) and the staging deploy once CI's build on main has finished (O-116),
// each from the signed payload and the two switches.
import pg from "pg";

import { createGitHubClient } from "../adapters/github/client.ts";
import { createPostgresStore } from "../adapters/store-postgres/store.ts";
import { databaseSetting } from "../adapters/store-postgres/tls.ts";
import { windmillSettings, windmillTargetOf } from "../adapters/windmill/client.ts";
import {
  RECEIVER_WINDMILL_TOKEN_PATH,
  windmillReceiverFlows,
} from "../adapters/windmill/receiver-flows.ts";
import { ConfigError, port, readConfig, secret } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { createBootstrapStarts } from "./bootstrap-starts.ts";
import { createReceiverHandler } from "./handler.ts";
import { createIngestStarts } from "./ingest-starts.ts";
import { createStagingStarts } from "./staging-starts.ts";

const NAME = "github-receiver";
const WEBHOOK_SECRET_PATH = "platform/github/runner-webhook-secret";
const logger = createLogger(NAME);

let config;
try {
  config = readConfig({
    port: port("PORT", "8080"),
    database: databaseSetting("DATABASE_URL", 5),
    webhookSecret: secret(WEBHOOK_SECRET_PATH),
    ...windmillSettings(RECEIVER_WINDMILL_TOKEN_PATH),
  });
} catch (error) {
  logger.error("invalid configuration", {
    problems:
      error instanceof ConfigError ? error.problems : ["unreadable configuration"],
  });
  process.exit(1);
}

// The pool connects on first use, so the service starts (and answers /health) before the
// database is reachable. Its config comes from the TLS builder, so every connection is encrypted
// and verified against Supabase's CA and the host name (D-364, O-117).
const pool = new pg.Pool(config.database);
pool.on("error", (error) =>
  logger.error("database connection error", { errorType: error.name }),
);
const store = createPostgresStore(pool);
const clock = { now: () => new Date() };
const flows = windmillReceiverFlows(config.windmillToken, windmillTargetOf(config));

const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: createReceiverHandler({
    github: createGitHubClient({ webhookSecret: config.webhookSecret }),
    ingest: { store, clock },
    ingestStarts: createIngestStarts({ ingestDelivery: flows.ingestDelivery, logger }),
    bootstrapStarts: createBootstrapStarts({
      store,
      removeBootstrapAccess: flows.removeBootstrapAccess,
      logger,
    }),
    stagingStarts: createStagingStarts({
      store,
      deployStaging: flows.deployStaging,
      logger,
    }),
    logger,
  }),
});
logger.info("listening", { port: service.port });
exitOnSignals(
  { port: service.port, stop: () => service.stop().then(() => pool.end()) },
  logger,
);
