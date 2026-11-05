// The run watcher's settings (D-330, ADR 0111), only from the environment: PORT, the API server's
// address (KUBERNETES_API), the agent namespaces it watches (AGENT_NAMESPACES), and its Windmill
// start (WINDMILL_HOST, WINDMILL_WORKSPACE, HTTPS_PROXY and the token at its secret path). None is
// secret but the token. infra/kubernetes/platform.ts writes them, and its test reads the
// manifest's environment with this same reader.
import {
  parseAgentNamespaces,
  parseApiServer,
} from "../adapters/agent-runtime/kubernetes/job-watch.ts";
import { windmillSettings } from "../adapters/windmill/client.ts";
import { RUN_WATCHER_WINDMILL_TOKEN_PATH } from "../adapters/windmill/run-watcher-flows.ts";
import { port, type Setting } from "../service-kit/config.ts";

export const RUN_WATCHER_ENV = {
  kubernetesApi: "KUBERNETES_API",
  agentNamespaces: "AGENT_NAMESPACES",
} as const;

export function runWatcherSettings() {
  return {
    port: port("PORT", "8080"),
    kubernetesApi: { env: RUN_WATCHER_ENV.kubernetesApi, parse: parseApiServer },
    agentNamespaces: {
      env: RUN_WATCHER_ENV.agentNamespaces,
      parse: parseAgentNamespaces,
    },
    ...windmillSettings(RUN_WATCHER_WINDMILL_TOKEN_PATH),
  } satisfies Record<string, Setting<unknown>>;
}
