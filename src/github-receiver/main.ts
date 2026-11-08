// The GitHub webhook receiver (build plan M2.3, ADR 0113). Configuration only from the
// environment (ADR 0111): PORT, DATABASE_URL (a login user in the factory_ingest role), the
// webhook secret by path, the logins of the Developer and Designer Apps and the runner App's slug
// (D-156). For its flow starts (D-291, D-327, O-101, O-104): WINDMILL_HOST, WINDMILL_WORKSPACE,
// HTTPS_PROXY (the shared Windmill egress proxy, D-328) and its Windmill token at
// `platform/github-receiver/windmill-token`; until Didi creates the token at first hosting every
// start is refused and the reconcile pass captures, advances and deploys. It reads the contracts
// in its image and the guards in its code only to decide whether option capture or an advance from
// evidence is due, never to record a move. Apart from CI's path on a PR head, it starts the
// removal of `BOOTSTRAP_TOKEN`'s access once Bootstrap's restarted run ends (O-114) and the staging
// deploy once CI's build on main has finished (O-116).
import { randomUUID } from "node:crypto";
import pg from "pg";

import { loadAllContractFiles } from "../adapters/contracts-file/load.ts";
import { createGitHubClient } from "../adapters/github/client.ts";
import { createPostgresStore } from "../adapters/store-postgres/store.ts";
import { databaseSetting } from "../adapters/store-postgres/tls.ts";
import { windmillSettings, windmillTargetOf } from "../adapters/windmill/client.ts";
import {
  RECEIVER_WINDMILL_TOKEN_PATH,
  windmillReceiverFlows,
} from "../adapters/windmill/receiver-flows.ts";
import { validateContracts } from "../core/contracts.ts";
import { GUARD_NAMES, GUARDS } from "../core/guards/index.ts";
import { ConfigError, port, readConfig, secret, text } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { createBootstrapStarts } from "./bootstrap-starts.ts";
import { createFlowStarts } from "./flow-starts.ts";
import { createReceiverHandler } from "./handler.ts";
import { createStagingStarts } from "./staging-starts.ts";

const NAME = "github-receiver";
const WEBHOOK_SECRET_PATH = "platform/github/runner-webhook-secret";
/** The contracts are read for their states only, so no spec version is recorded anywhere. */
const CONTRACTS_LABEL = "github-receiver-image";
const logger = createLogger(NAME);

let config;
try {
  config = readConfig({
    port: port("PORT", "8080"),
    database: databaseSetting("DATABASE_URL", 5),
    webhookSecret: secret(WEBHOOK_SECRET_PATH),
    developerApp: text("GITHUB_DEVELOPER_APP_LOGIN"),
    designerApp: text("GITHUB_DESIGNER_APP_LOGIN"),
    runnerAppSlug: text("GITHUB_RUNNER_APP_SLUG"),
    ...windmillSettings(RECEIVER_WINDMILL_TOKEN_PATH),
  });
} catch (error) {
  logger.error("invalid configuration", {
    problems:
      error instanceof ConfigError ? error.problems : ["unreadable configuration"],
  });
  process.exit(1);
}

const { contracts, problems } = validateContracts(
  loadAllContractFiles(CONTRACTS_LABEL).raw,
  GUARD_NAMES,
);
if (!contracts) {
  logger.error("invalid contracts", { problems });
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
const ids = { next: () => randomUUID() };
const flows = windmillReceiverFlows(config.windmillToken, windmillTargetOf(config));

const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: createReceiverHandler({
    github: createGitHubClient({ webhookSecret: config.webhookSecret }),
    ingest: {
      store,
      clock,
      ids,
      appLogins: [config.developerApp, config.designerApp],
      runnerAppSlug: config.runnerAppSlug,
    },
    flowStarts: createFlowStarts({
      store,
      contracts,
      guards: GUARDS,
      clock,
      ids,
      ...flows,
      logger,
    }),
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
