// The state API service (build plan M1.4, ADR 0102). Configuration only from the environment
// (ADR 0111): PORT and DATABASE_URL, a connection as a login user in the factory_api role, and,
// once Didi creates the planning chat's credential at first hosting (D-266), the SHA-256 of its
// token at the secret path `platform/state-api/planning-token-sha256`. Until then it is unset and
// no planning token is accepted.
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createLibrary } from "../core/library.ts";
import { createPostgresStore } from "../adapters/store-postgres/store.ts";
import {
  ConfigError,
  port,
  readConfig,
  secretEnvName,
  text,
  type Setting,
} from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { PLANNING_TOKEN_SHA256_PATH, SHA256_HEX } from "./auth.ts";
import { ENTRY_CONTRACTS } from "./entry.ts";
import { createApiHandler } from "./routes.ts";

const NAME = "state-api";
const logger = createLogger(NAME);

/** The planning chat's token hash: optional, and a SHA-256 in hex when set (D-266). */
const planningTokenSha256: Setting<string | null> = {
  env: secretEnvName(PLANNING_TOKEN_SHA256_PATH),
  fallback: "",
  parse: (raw) => {
    if (raw === "") return null;
    if (!SHA256_HEX.test(raw)) throw new Error("is not a SHA-256 in lowercase hex");
    return raw;
  },
};

let config;
try {
  config = readConfig({
    port: port("PORT", "8080"),
    databaseUrl: text("DATABASE_URL"),
    planningTokenSha256,
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
const ids = { next: () => randomUUID() };
const library = createLibrary({
  store,
  contracts: ENTRY_CONTRACTS,
  guards: {},
  clock,
  ids,
});

const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: createApiHandler({
    store,
    library,
    clock,
    ...(config.planningTokenSha256 === null
      ? {}
      : { planning: { tokenSha256: config.planningTokenSha256, ids, store } }),
  }),
});
logger.info("listening", { port: service.port });
exitOnSignals(
  { port: service.port, stop: () => service.stop().then(() => pool.end()) },
  logger,
);
