// The run watcher (D-330, O-102): a small service in the platform namespace that records each
// run's end on the event. It lists, then watches, the run Jobs of each agent namespace, and when a
// run's agent Job (or QA's fetch Job) stops for any reason, finished, crashed, out of memory,
// killed or past its deadline, it starts `f/foreman/record_run_end` for that run. The reconcile
// pass stays as the safety net.
//
// Configuration only from the environment (ADR 0111, ./settings.ts). It talks to the Kubernetes API
// with its own ServiceAccount token and the cluster's CA, read from the pod's mounted files for
// each call; RBAC lets that token get, list and watch Jobs in agent namespaces and nothing else.
// It reaches Windmill only through the shared Windmill proxy (D-328), with a token that can start
// only the run-end flow, at `platform/run-watcher/windmill-token`; until Didi creates it at first
// hosting every start is refused. It holds no database access. On a restart it sends every
// stopped run Job still present: the runner deletes a run's Jobs once its end is recorded.
import {
  createRunJobsApi,
  serviceAccountCredentials,
  watchRunJobs,
} from "../adapters/agent-runtime/kubernetes/job-watch.ts";
import { windmillTargetOf } from "../adapters/windmill/client.ts";
import { windmillRunEndFlow } from "../adapters/windmill/run-watcher-flows.ts";
import { ConfigError, readConfig } from "../service-kit/config.ts";
import { createLogger } from "../service-kit/logger.ts";
import { exitOnSignals, startService } from "../service-kit/server.ts";
import { runWatcherSettings } from "./settings.ts";
import { createRunEndStarts } from "./starts.ts";

const NAME = "run-watcher";
const logger = createLogger(NAME);

let config;
try {
  config = readConfig(runWatcherSettings());
} catch (error) {
  logger.error("invalid configuration", {
    problems:
      error instanceof ConfigError ? error.problems : ["unreadable configuration"],
  });
  process.exit(1);
}

const starts = createRunEndStarts({
  flow: windmillRunEndFlow(config.windmillToken, windmillTargetOf(config)),
  logger,
});
const service = await startService({ name: NAME, port: config.port, logger });
logger.info("listening", { port: service.port, namespaces: config.agentNamespaces });
const watch = watchRunJobs({
  api: createRunJobsApi({
    server: config.kubernetesApi,
    credentials: serviceAccountCredentials(),
  }),
  namespaces: config.agentNamespaces,
  events: starts,
});
exitOnSignals(
  {
    port: service.port,
    stop: async () => {
      await watch.stop();
      await starts.stop();
      await service.stop();
    },
  },
  logger,
);
