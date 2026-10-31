// The per-run egress proxy service (ADR 0106 section 2, ADR 0111, D-195). Configuration only from
// the environment: PORT, RUN_ID, ALLOWED_HOSTS, MODEL_PROVIDERS, MAX_MODEL_REQUESTS,
// MAX_REJECTED_MODEL_REQUESTS, STATE_API_UPSTREAM, and each provider's credential by its secret
// path. One port serves CONNECT tunnels, model traffic at `/<provider>`, the state API route at `/state-api` and `GET /health`.
import { ConfigError } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { readProxyConfig } from "./config.ts";
import { createEgressProxy } from "./proxy.ts";

const NAME = "egress-proxy";
const logger = createLogger(NAME);

let config;
try {
  config = readProxyConfig();
} catch (error) {
  logger.error("invalid configuration", {
    problems:
      error instanceof ConfigError ? error.problems : ["unreadable configuration"],
  });
  process.exit(1);
}

const proxy = createEgressProxy({ ...config, logger });
const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: proxy.handle,
  onConnect: proxy.onConnect,
});
logger.info("listening", {
  port: service.port,
  runId: config.runId,
  allowedHosts: [...config.allowedHosts],
  providers: config.providers.map((provider) => provider.name),
  stateApiRoute: config.stateApi !== undefined,
});
exitOnSignals(
  {
    port: service.port,
    stop: () => {
      proxy.closeTunnels();
      return service.stop();
    },
  },
  logger,
);
