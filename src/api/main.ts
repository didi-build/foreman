// The state API service (build plan M1.4, ADR 0102). Configuration only from the environment
// (ADR 0111): PORT and DATABASE_URL, a connection as a login user in the factory_api role, and,
// once Didi creates the planning chat's credential at first hosting (D-266), the SHA-256 of its
// token at the secret path `platform/state-api/planning-token-sha256`. Until then it is unset and
// no planning token is accepted.
//
// It listens on two ports. PORT (8080) is the internal one the agents' egress proxies call.
// PUBLIC_PORT (8081) is the one the Cloudflare Tunnel connector forwards the planning chat's
// paths to, and serves the planning chat's routes only (`POST /plans` and the three planning
// reads), with a size and a rate limit (D-271, D-282, ./public.ts).
// After each submission the API starts the plan-approval flow with its own narrow Windmill
// credential at `platform/state-api/windmill-plan-approval-token` (D-273 (2)); until Didi creates
// it at first hosting the start is refused and the reconcile pass opens the request.
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createLibrary } from "../core/library.ts";
import { createPostgresStore } from "../adapters/store-postgres/store.ts";
import {
  WINDMILL_PLAN_APPROVAL_TOKEN_PATH,
  windmillPlanApprovalFlow,
} from "../adapters/windmill/plan-approval-flow.ts";
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
import { createPublicHandler } from "./public.ts";
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

/** The state API's Windmill credential: optional until Didi creates it (D-273 (2)). */
const windmillPlanApprovalToken: Setting<string | null> = {
  env: secretEnvName(WINDMILL_PLAN_APPROVAL_TOKEN_PATH),
  fallback: "",
  parse: (raw) => (raw.trim() === "" ? null : raw),
};

let config;
try {
  config = readConfig({
    port: port("PORT", "8080"),
    publicPort: port("PUBLIC_PORT", "8081"),
    databaseUrl: text("DATABASE_URL"),
    planningTokenSha256,
    windmillPlanApprovalToken,
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

const api = createApiHandler({
  store,
  library,
  clock,
  ...(config.planningTokenSha256 === null
    ? {}
    : {
        planning: {
          tokenSha256: config.planningTokenSha256,
          ids,
          store,
          approvalFlow: windmillPlanApprovalFlow(config.windmillPlanApprovalToken),
          logger,
        },
      }),
});
const service = await startService({
  name: NAME,
  port: config.port,
  logger,
  handle: api,
});
const publicService = await startService({
  name: NAME,
  port: config.publicPort,
  logger,
  handle: createPublicHandler({ api, clock, logger }),
});
logger.info("listening", { port: service.port, publicPort: publicService.port });
exitOnSignals(
  {
    port: service.port,
    stop: () =>
      Promise.all([service.stop(), publicService.stop()]).then(() => pool.end()),
  },
  logger,
);
