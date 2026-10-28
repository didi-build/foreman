// The reference service for ADR 0111: the smallest process that follows every container convention.
// Copy this folder to start a new service.
import { ConfigError, port, readConfig } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";

const NAME = "sample-service";
const logger = createLogger(NAME);

let config;
try {
  config = readConfig({ port: port("PORT", "8080") });
} catch (error) {
  logger.error("invalid configuration", {
    problems:
      error instanceof ConfigError ? error.problems : ["unreadable configuration"],
  });
  process.exit(1);
}

const service = await startService({ name: NAME, port: config.port, logger });
logger.info("listening", { port: service.port });
exitOnSignals(service, logger);
