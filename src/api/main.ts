// The state API service (build plan M1.4, ADR 0102). Configuration only from the environment
// (ADR 0111): PORT and DATABASE_URL, a connection as a login user in the factory_api role.
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createLibrary } from "../core/library.ts";
import { createPostgresStore } from "../adapters/store-postgres/store.ts";
import { ConfigError, port, readConfig, text } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { ENTRY_CONTRACTS } from "./entry.ts";
import { createApiHandler } from "./routes.ts";

const NAME = "state-api";
const logger = createLogger(NAME);

let config;
try {
  config = readConfig({
    port: port("PORT", "8080"),
    databaseUrl: text("DATABASE_URL"),
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
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on("error", (error) =>
  logger.error("database connection error", { errorType: error.name }),
);

const store = createPostgresStore(pool);
const clock = { now: () => new Date() };
const library = createLibrary({
  store,
  contracts: ENTRY_CONTRACTS,
  guards: {},
  clock,
  ids: { next: () => randomUUID() },
});

const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: createApiHandler({ store, library, clock }),
});
logger.info("listening", { port: service.port });
exitOnSignals(
  { port: service.port, stop: () => service.stop().then(() => pool.end()) },
  logger,
);
