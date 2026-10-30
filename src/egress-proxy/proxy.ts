// The per-run egress proxy (ADR 0106 sections 2, 5 and 6, D-195). Three jobs:
// 1. CONNECT tunnels to allow-listed hosts on port 443. The proxy resolves the name itself,
//    refuses blocked addresses, and connects to the address it checked, so a second DNS answer
//    (rebinding) cannot change where the tunnel goes. TLS inside the tunnel is not decrypted.
// 2. Model traffic: each provider is served at `/<name>` over plain HTTP inside the namespace and
//    forwarded over TLS to its upstream, at an address checked the same way as a tunnel's. The
//    body passes byte for byte; only the credential header changes. Requests past the run's
//    ceiling get 403, not 429: model clients retry a 429 as a rate limit, and the runner must
//    record this run as budget_exceeded, not usage_exhausted.
// 3. The state API route (D-195): `/state-api/...` goes over plain HTTP to the one in-cluster
//    address in its settings, the only private address the proxy ever reaches. The agent's own
//    Authorization header (its per-run state API token) passes through unchanged.
// Logs carry the run id, host names, durations and outcomes. Never a payload, path or credential.
import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

import type { LogFields, Logger } from "../service-kit/logger.ts";
import { sendJson } from "../service-kit/server.ts";
import { isBlockedAddress } from "./addresses.ts";
import {
  downstreamResponseHeaders,
  stateApiRequestHeaders,
  upstreamRequestHeaders,
} from "./headers.ts";
import { checkConnectTarget, TUNNEL_PORT } from "./hosts.ts";
import { routeToProvider, type Provider, type ProviderRoute } from "./providers.ts";
import { stateApiPath, type StateApiUpstream } from "./state-api.ts";

export const CEILING_MESSAGE = "This run has reached its model request ceiling.";
const CONNECT_TIMEOUT_MS = 10_000;

export interface EgressProxyOptions {
  runId: string;
  allowedHosts: ReadonlySet<string>;
  providers: readonly Provider[];
  /** Credential values by provider name. */
  credentials: ReadonlyMap<string, string>;
  maxModelRequests: number;
  /** The state API route's one upstream (D-195). Undefined turns the route off. */
  stateApi?: StateApiUpstream;
  logger: Logger;
  // Test seams. `main.ts` never sets them, so production resolves with the system resolver,
  // connects to the vetted address and trusts only the system's certificate authorities.
  /** Resolve a host name to its addresses. */
  resolve?: (host: string) => Promise<string[]>;
  /** Open a TCP connection to a vetted public address (tunnels and model upstreams). */
  connect?: (address: string, port: number) => Socket;
  /** Certificate authorities to trust for upstream TLS instead of the system's. */
  upstreamCa?: string;
}

export interface EgressProxy {
  /** Handles plain HTTP requests: model traffic, the state API route, and refusals. */
  handle: (request: IncomingMessage, response: ServerResponse) => boolean;
  /** Handles CONNECT requests. */
  onConnect: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Close every open tunnel, for shutdown. */
  closeTunnels: () => void;
}

/** The system resolver, asked for the absolute name so search domains are never tried. */
async function systemResolve(host: string): Promise<string[]> {
  const results = await lookup(`${host}.`, { all: true, order: "ipv4first" });
  return results.map((result) => result.address);
}

type Vetted =
  | { ok: true; address: string }
  | { ok: false; reason: "dns failure" | "blocked address"; errorType?: string };

function errorType(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : error.name;
  }
  return typeof error;
}

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const { runId, allowedHosts, providers, credentials, maxModelRequests, logger } =
    options;
  const resolve = options.resolve ?? systemResolve;
  const connect =
    options.connect ??
    ((address: string, port: number) => netConnect({ host: address, port }));
  const tunnels = new Set<Duplex>();
  let modelRequests = 0;

  const info = (message: string, fields: LogFields): void =>
    logger.info(message, { runId, ...fields });
  const warn = (message: string, fields: LogFields): void =>
    logger.warn(message, { runId, ...fields });

  /**
   * The one public address to connect to for a host, or why there is none. Every answer must be
   * public, not only the one used: a mixed answer is a warning sign.
   */
  async function vet(host: string): Promise<Vetted> {
    if (isIP(host) !== 0) {
      return isBlockedAddress(host)
        ? { ok: false, reason: "blocked address" }
        : { ok: true, address: host };
    }
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch (error) {
      return { ok: false, reason: "dns failure", errorType: errorType(error) };
    }
    if (addresses.length === 0) return { ok: false, reason: "dns failure" };
    if (addresses.some(isBlockedAddress))
      return { ok: false, reason: "blocked address" };
    return { ok: true, address: addresses[0] as string };
  }

  function refuseTunnel(client: Duplex, status: string): void {
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function onConnect(request: IncomingMessage, client: Duplex, head: Buffer): void {
    const started = Date.now();
    client.on("error", () => client.destroy());
    const target = checkConnectTarget(request.url, allowedHosts);
    if (!target.ok) {
      refuseTunnel(client, "403 Forbidden");
      warn("tunnel refused", { host: target.host, reason: target.reason });
      return;
    }
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    void openTunnel(target.host, client, head, started);
  }

  async function openTunnel(
    host: string,
    client: Duplex,
    head: Buffer,
    started: number,
  ): Promise<void> {
    const vetted = await vet(host);
    if (!vetted.ok) {
      refuseTunnel(
        client,
        vetted.reason === "blocked address" ? "403 Forbidden" : "502 Bad Gateway",
      );
      warn("tunnel refused", {
        host,
        reason: vetted.reason,
        errorType: vetted.errorType,
      });
      return;
    }
    if (client.destroyed) return;

    // Connect to the address just checked. The name is not resolved again.
    const upstream = connect(vetted.address, TUNNEL_PORT);
    let outcome = "closed";
    let established = false;
    const timer = setTimeout(() => {
      outcome = "connect timeout";
      upstream.destroy();
    }, CONNECT_TIMEOUT_MS);

    upstream.once("connect", () => {
      clearTimeout(timer);
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (error) => {
      if (outcome === "closed") outcome = `upstream error ${errorType(error)}`;
    });
    upstream.once("close", () => {
      clearTimeout(timer);
      if (!established && !client.destroyed) refuseTunnel(client, "502 Bad Gateway");
      else client.destroy();
      info(established ? "tunnel closed" : "tunnel failed", {
        host,
        outcome,
        durationMs: Date.now() - started,
      });
    });
    client.once("close", () => upstream.destroy());
  }

  function handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? "";
    if (!url.startsWith("/")) {
      // An absolute URL asks the proxy to fetch any host over plain HTTP. Never.
      warn("request refused", { host: hostOf(url), reason: "plain http proxying" });
      sendJson(response, 403, { error: "only CONNECT to an allowed host on port 443" });
      return true;
    }
    const statePath = stateApiPath(url);
    if (statePath !== undefined) {
      if (options.stateApi === undefined) {
        warn("request refused", { reason: "state api route off" });
        sendJson(response, 404, { error: "not found" });
        return true;
      }
      forwardToStateApi(request, response, options.stateApi, statePath);
      return true;
    }
    const route = routeToProvider(url, providers);
    if (route === undefined) {
      warn("request refused", {
        method: request.method,
        reason: "not a provider path",
      });
      sendJson(response, 404, { error: "not found" });
      return true;
    }
    if (modelRequests >= maxModelRequests) {
      warn("model request refused", {
        provider: route.provider.name,
        reason: "request ceiling",
        maxModelRequests,
      });
      sendJson(response, 403, { error: CEILING_MESSAGE });
      return true;
    }
    modelRequests += 1;
    forward(request, response, route, modelRequests).catch((error: unknown) => {
      warn("model request failed", { errorType: errorType(error) });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      else response.destroy();
    });
    return true;
  }

  function forwardToStateApi(
    request: IncomingMessage,
    response: ServerResponse,
    upstream: StateApiUpstream,
    path: string,
  ): void {
    const started = Date.now();
    let logged = false;
    const done = (outcome: string, status?: number): void => {
      if (logged) return;
      logged = true;
      // No path: it can name records, and a query can carry a token.
      info("state api request", {
        method: request.method,
        status,
        outcome,
        durationMs: Date.now() - started,
      });
    };
    // The host and port come only from the settings. Nothing in the request can change them.
    const upstreamRequest = httpRequest({
      hostname: upstream.host,
      port: upstream.port,
      method: request.method,
      path,
      headers: stateApiRequestHeaders(request.headers),
    });
    relay(request, response, upstreamRequest, done, "state api unreachable");
  }

  async function forward(
    request: IncomingMessage,
    response: ServerResponse,
    { provider, upstreamPath }: ProviderRoute,
    count: number,
  ): Promise<void> {
    const started = Date.now();
    const host = provider.upstream.hostname.replace(/^\[|\]$/g, "");
    let logged = false;
    const done = (outcome: string, status?: number): void => {
      if (logged) return;
      logged = true;
      info("model request", {
        provider: provider.name,
        host,
        method: request.method,
        status,
        outcome,
        modelRequests: count,
        durationMs: Date.now() - started,
      });
    };

    // The provider's address is checked like a tunnel's, so a provider name can never lead to
    // a private address, the metadata service or the state API.
    const vetted = await vet(host);
    if (!vetted.ok) {
      sendJson(response, 502, { error: "model provider unreachable" });
      done(vetted.reason);
      return;
    }
    const port = Number(provider.upstream.port || 443);
    const upstreamRequest = httpsRequest({
      host,
      port,
      defaultPort: 443,
      method: request.method,
      path: upstreamPath,
      headers: upstreamRequestHeaders(
        request.headers,
        provider.credential,
        credentials.get(provider.name),
      ),
      // TLS to the vetted address. The certificate is checked against the provider's name.
      createConnection: () =>
        tlsConnect({
          socket: connect(vetted.address, port),
          host,
          servername: isIP(host) === 0 ? host : undefined,
          ca: options.upstreamCa,
          // Explicit, so a stray NODE_TLS_REJECT_UNAUTHORIZED in the environment cannot turn it off.
          rejectUnauthorized: true,
          ALPNProtocols: ["http/1.1"],
        }),
    });
    relay(request, response, upstreamRequest, done, "model provider unreachable");
  }

  /** Streams the request to the upstream and the answer back, both unchanged. */
  function relay(
    request: IncomingMessage,
    response: ServerResponse,
    upstreamRequest: ReturnType<typeof httpRequest>,
    done: (outcome: string, status?: number) => void,
    unreachable: string,
  ): void {
    upstreamRequest.on("response", (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      response.writeHead(status, downstreamResponseHeaders(upstreamResponse.headers));
      response.flushHeaders();
      pipeline(upstreamResponse, response, (error) =>
        done(error ? "stream closed early" : "ok", status),
      );
    });
    upstreamRequest.on("error", (error) => {
      if (!response.headersSent) {
        sendJson(response, 502, { error: unreachable });
      } else {
        response.destroy();
      }
      done(`upstream error ${errorType(error)}`);
    });
    // The request body streams to the upstream unchanged.
    pipeline(request, upstreamRequest, (error) => {
      if (error) upstreamRequest.destroy();
    });
    response.once("close", () => {
      if (!response.writableFinished) upstreamRequest.destroy();
    });
  }

  return {
    handle,
    onConnect,
    closeTunnels: () => {
      for (const tunnel of tunnels) tunnel.destroy();
    },
  };
}

/** The host name of an absolute request URL, for the log. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.slice(0, 253);
  } catch {
    return url.split(/[/:]/)[0]?.slice(0, 253) ?? "";
  }
}
