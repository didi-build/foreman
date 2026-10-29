// The GitHub webhook receiver (build plan M2.3, ADR 0113). Configuration only from the
// environment (ADR 0111): PORT, DATABASE_URL (a login user in the factory_ingest role), the
// webhook secret by path, and the logins of the Developer and Designer Apps (D-156).
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createGitHubClient } from "../adapters/github/client.ts";
import { createPostgresStore } from "../adapters/store-postgres/store.ts";
import { ConfigError, port, readConfig, secret, text } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { createReceiverHandler } from "./handler.ts";

const NAME = "github-receiver";
const WEBHOOK_SECRET_PATH = "platform/github/runner-webhook-secret";
const logger = createLogger(NAME);

let config;
try {
  config = readConfig({
    port: port("PORT", "8080"),
    databaseUrl: text("DATABASE_URL"),
    webhookSecret: secret(WEBHOOK_SECRET_PATH),
    developerApp: text("GITHUB_DEVELOPER_APP_LOGIN"),
    designerApp: text("GITHUB_DESIGNER_APP_LOGIN"),
  });
} catch (error) {
  logger.error("invalid configuration", {
    problems:
      error instanceof ConfigError ? error.problems : ["unreadable configuration"],
  });
  process.exit(1);
}

// The pool connects on first use, so the service starts (and answers /health) before the
// database is reachable.
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
pool.on("error", (error) =>
  logger.error("database connection error", { errorType: error.name }),
);

const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: createReceiverHandler({
    github: createGitHubClient({ webhookSecret: config.webhookSecret }),
    ingest: {
      store: createPostgresStore(pool),
      clock: { now: () => new Date() },
      ids: { next: () => randomUUID() },
      appLogins: [config.developerApp, config.designerApp],
    },
    logger,
  }),
});
logger.info("listening", { port: service.port });
exitOnSignals(
  { port: service.port, stop: () => service.stop().then(() => pool.end()) },
  logger,
);
