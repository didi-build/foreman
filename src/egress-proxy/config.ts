// The egress proxy's settings, only from the environment (ADR 0111, D-195). Problems name the setting,
// never its value. Each provider's credential is read by its secret path (D-143).
import { port, readConfig, secret, type Setting } from "../service-kit/config.ts";
import { parseAllowedHosts } from "./hosts.ts";
import { parseProviders, type Provider } from "./providers.ts";
import { parseStateApiUpstream, type StateApiUpstream } from "./state-api.ts";

export interface ProxyConfig {
  port: number;
  runId: string;
  allowedHosts: ReadonlySet<string>;
  providers: Provider[];
  maxModelRequests: number;
  /** The state API route's one upstream (D-195), or undefined when the route is off. */
  stateApi: StateApiUpstream | undefined;
  /** Credential values by provider name. Never logged. */
  credentials: ReadonlyMap<string, string>;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

const settings = {
  port: port("PORT", "8080"),
  runId: {
    env: "RUN_ID",
    parse: (raw: string) => {
      if (!RUN_ID.test(raw))
        throw new Error("must be 1 to 128 letters, digits, - or _");
      return raw;
    },
  } satisfies Setting<string>,
  /** Comma-separated host names a CONNECT may reach, on port 443 only. */
  allowedHosts: { env: "ALLOWED_HOSTS", parse: parseAllowedHosts },
  /** JSON list of providers: name, upstream, credential (x-api-key, bearer or none), secretPath. */
  providers: { env: "MODEL_PROVIDERS", parse: parseProviders },
  /** The most model requests this run may make: twice the run's turn limit (ADR 0106 section 6). */
  maxModelRequests: {
    env: "MAX_MODEL_REQUESTS",
    parse: (raw: string) => {
      const value = Number(raw);
      if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
        throw new Error("must be a positive whole number");
      }
      return value;
    },
  } satisfies Setting<number>,
  /**
   * The in-cluster state API address for the `/state-api` route (D-195), as `http://host:port`.
   * Unset or empty turns the route off, as for the QA fetch step's proxy.
   */
  stateApi: {
    env: "STATE_API_UPSTREAM",
    fallback: "",
    parse: parseStateApiUpstream,
  } satisfies Setting<StateApiUpstream | undefined>,
};

export function readProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const base = readConfig(settings, env);
  const secretSettings: Record<string, Setting<string>> = {};
  for (const provider of base.providers) {
    if (provider.secretPath)
      secretSettings[provider.name] = secret(provider.secretPath);
  }
  const credentials = readConfig(secretSettings, env);
  return { ...base, credentials: new Map(Object.entries(credentials)) };
}
