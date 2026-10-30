// The run's model providers (ADR 0106 section 5, D-143). Each one is a settings entry: a name, the
// upstream base address, how the credential is sent and the credential's secret path. The proxy
// serves each provider at `/<name>` and knows nothing else about it.

export const CREDENTIAL_STYLES = ["x-api-key", "bearer", "none"] as const;
export type CredentialStyle = (typeof CREDENTIAL_STYLES)[number];

export interface Provider {
  name: string;
  /** An https base address with no credentials, query or fragment. */
  upstream: URL;
  credential: CredentialStyle;
  /** Where the credential lives in the secret store. Absent when the style is `none`. */
  secretPath?: string;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SECRET_PATH = /^(?:platform|projects)(?:\/[a-z0-9][a-z0-9_-]*)+$/;
// `health` is the service's own endpoint and `state-api` is the state API route (D-195).
const RESERVED_NAMES = new Set(["health", "state-api"]);

/**
 * Parse the JSON provider list. An empty list serves no model traffic, as for the QA fetch step's
 * proxy, which reaches GitHub only (ADR 0106 section 3). Errors name the entry's position and field, never a value, so a
 * secret pasted into the wrong field cannot reach the logs.
 */
export function parseProviders(raw: string): Provider[] {
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("is not valid JSON");
  }
  if (!Array.isArray(entries)) throw new Error("must be a JSON array");
  const names = new Set<string>();
  return entries.map((entry: unknown, index) => {
    const where = `entry ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} is not an object`);
    }
    const { name, upstream, credential, secretPath, ...rest } = entry as Record<
      string,
      unknown
    >;
    if (Object.keys(rest).length > 0) throw new Error(`${where} has an unknown field`);
    if (typeof name !== "string" || !NAME.test(name) || RESERVED_NAMES.has(name)) {
      throw new Error(`${where} has an invalid name`);
    }
    if (names.has(name)) throw new Error(`${where} repeats a provider name`);
    names.add(name);
    const url = parseUpstream(upstream);
    if (url === undefined) {
      throw new Error(
        `${where} has an invalid upstream (an https URL with no credentials, query or fragment)`,
      );
    }
    if (!CREDENTIAL_STYLES.includes(credential as CredentialStyle)) {
      throw new Error(`${where} has an invalid credential style`);
    }
    const style = credential as CredentialStyle;
    if (style === "none") {
      if (secretPath !== undefined) {
        throw new Error(`${where} has a secret path but credential style none`);
      }
      return { name, upstream: url, credential: style };
    }
    if (typeof secretPath !== "string" || !SECRET_PATH.test(secretPath)) {
      throw new Error(`${where} has an invalid secret path`);
    }
    return { name, upstream: url, credential: style, secretPath };
  });
}

function parseUpstream(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const clean =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    !value.includes("?") &&
    !value.includes("#");
  return clean ? url : undefined;
}

export interface ProviderRoute {
  provider: Provider;
  /** The path and query to request upstream: the base path, then the rest of the request URL. */
  upstreamPath: string;
}

/** Find the provider served at the start of a request URL (`/<name>/...`), if any. */
export function routeToProvider(
  url: string | undefined,
  providers: readonly Provider[],
): ProviderRoute | undefined {
  if (url === undefined || !url.startsWith("/")) return undefined;
  for (const provider of providers) {
    const prefix = `/${provider.name}`;
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length);
    if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) continue;
    const basePath = provider.upstream.pathname.replace(/\/+$/, "");
    const upstreamPath = rest.startsWith("/")
      ? basePath + rest
      : (basePath || "/") + rest;
    return { provider, upstreamPath };
  }
  return undefined;
}
