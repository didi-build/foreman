// The per-run egress proxy (ADR 0106 sections 2, 5 and 6, D-195). Three jobs:
// 1. CONNECT tunnels to allow-listed hosts on port 443. The proxy resolves the name itself,
//    refuses blocked addresses, and connects to the address it checked, so a second DNS answer
//    (rebinding) cannot change where the tunnel goes. TLS inside the tunnel is not decrypted.
// 2. Model traffic: each provider is served at `/<name>` over plain HTTP inside the namespace and
//    forwarded over TLS to its upstream, at an address checked the same way as a tunnel's. The
//    body passes byte for byte; only the credential header changes. Requests past the run's
//    ceiling get 403, not 429: model clients retry a 429 as a rate limit, and the runner must
//    record this run as budget_exceeded, not usage_exhausted. A request the upstream answered
//    with 429 was not served and is not billed, so it does not count against that ceiling; it
//    counts against a small ceiling of its own instead, so a runtime that retries without end is
//    stopped with 403 too (ADR 0114 section 9).
// 3. The state API route (D-195): `/state-api/...` goes over plain HTTP to the one in-cluster
//    address in its settings, the only private address the proxy ever reaches. The agent's own
//    Authorization header (its per-run state API token) passes through unchanged.
// 4. The documentation lookup route (ADR 0119 slice 4a, D-460, ./lookup.ts): `GET /lookup/<host>
//    <path>` makes the proxy itself read one page from a host on the run's trusted list, over TLS
//    to the vetted address with the certificate checked against the host's name. It is never a
//    tunnel. No agent header reaches the site, only a few response headers come back, the body is
//    cut at 2 MiB, each lookup has 8 seconds, and the run has a ceiling of lookups. GET only.
// It also counts the tier the provider says it served each model request (D-423, O-151): it
// reads `service_tier` from a copy of each served model response, after each chunk is passed on
// (./tier-reader.ts), and logs the run's tally as one fixed line (./served-tiers.ts) that the
// runtime adapter reads at the run's end. GitHub, state API and lookup traffic is never read.
// Logs carry the run id, host names, durations, outcomes, byte counts and served tier counts.
// Never a payload, path, query, header value or credential.
import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
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
import {
  DEFAULT_MAX_LOOKUP_REQUESTS,
  hasRequestBody,
  LOOKUP_BODY_LIMIT,
  LOOKUP_PORT,
  LOOKUP_REFUSALS,
  LOOKUP_TIMEOUT_MS,
  lookupRequestHeaders,
  lookupResponseHeaders,
  lookupTarget,
  type LookupRefusal,
  type LookupTarget,
} from "./lookup.ts";
import { routeToProvider, type Provider, type ProviderRoute } from "./providers.ts";
import {
  emptyTally,
  SERVED_TIERS_MESSAGE,
  servedTiersFields,
  type RequestTier,
} from "./served-tiers.ts";
import { stateApiPath, type StateApiUpstream } from "./state-api.ts";
import { MAX_CONCURRENT_TIER_READS, readServedTier } from "./tier-reader.ts";

export const CEILING_MESSAGE = "This run has reached its model request ceiling.";
/** The 403 past the ceiling on requests the upstream rejected with 429 (ADR 0114 section 9). */
export const REJECTED_CEILING_MESSAGE =
  "This run has reached its ceiling on rejected model requests.";
/** The status a provider rejects a request with when it is busy or rate limited. */
const REJECTED_STATUS = 429;
const CONNECT_TIMEOUT_MS = 10_000;

export interface EgressProxyOptions {
  runId: string;
  allowedHosts: ReadonlySet<string>;
  providers: readonly Provider[];
  /** Credential values by provider name. */
  credentials: ReadonlyMap<string, string>;
  maxModelRequests: number;
  /** The most model requests the upstream may answer with 429 in this run (ADR 0114 section 9). */
  maxRejectedModelRequests: number;
  /** The state API route's one upstream (D-195). Undefined turns the route off. */
  stateApi?: StateApiUpstream;
  /**
   * The hosts the documentation lookup route may read (ADR 0119 slice 4a). Undefined or empty
   * turns the route off: every `/lookup` request is refused as off the list.
   */
  lookupHosts?: ReadonlySet<string>;
  /** The most lookups this run may forward. Defaults to DEFAULT_MAX_LOOKUP_REQUESTS. */
  maxLookupRequests?: number;
  logger: Logger;
  // Test seams. `main.ts` never sets them, so production resolves with the system resolver,
  // connects to the vetted address, trusts only the system's certificate authorities and gives
  // each lookup LOOKUP_TIMEOUT_MS.
  /** Resolve a host name to its addresses. */
  resolve?: (host: string) => Promise<string[]>;
  /** Open a TCP connection to a vetted public address (tunnels, model upstreams and lookups). */
  connect?: (address: string, port: number) => Socket;
  /** Certificate authorities to trust for upstream TLS instead of the system's. */
  upstreamCa?: string;
  /** How long one lookup may take. */
  lookupTimeoutMs?: number;
}

export interface EgressProxy {
  /** Handles plain HTTP requests: model traffic, the state API and lookup routes, and refusals. */
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
  const {
    runId,
    allowedHosts,
    providers,
    credentials,
    maxModelRequests,
    maxRejectedModelRequests,
    logger,
  } = options;
  const resolve = options.resolve ?? systemResolve;
  const connect =
    options.connect ??
    ((address: string, port: number) => netConnect({ host: address, port }));
  const lookupHosts = options.lookupHosts ?? new Set<string>();
  const maxLookupRequests = options.maxLookupRequests ?? DEFAULT_MAX_LOOKUP_REQUESTS;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const tunnels = new Set<Duplex>();
  // Requests sent upstream and not rejected, those still waiting for an answer included.
  let modelRequests = 0;
  let rejectedRequests = 0;
  // Lookups that passed the route's checks, whatever happened to them after.
  let lookupRequests = 0;
  // Served model requests by the tier the provider named (D-423), and the reads under way.
  const servedTiers = emptyTally();
  let tierReads = 0;

  const info = (message: string, fields: LogFields): void =>
    logger.info(message, { runId, ...fields });
  const warn = (message: string, fields: LogFields): void =>
    logger.warn(message, { runId, ...fields });

  /** Counts one served request and logs the run's whole tally, the line the runtime reads. */
  function countServed(tier: RequestTier): void {
    servedTiers[tier] += 1;
    info(SERVED_TIERS_MESSAGE, servedTiersFields(servedTiers));
  }

  /**
   * Reads the tier a served (2xx) model response names, from a copy of its body (D-423). Called
   * once the body is piped to the agent, so each chunk is passed on before it is read, and the
   * reader never throws. Other answers were not served and are not counted.
   */
  function readServed(status: number, upstreamResponse: IncomingMessage): void {
    if (status < 200 || status > 299) return;
    try {
      if (tierReads >= MAX_CONCURRENT_TIER_READS) {
        countServed("unknown");
        return;
      }
      tierReads += 1;
      const reader = readServedTier(upstreamResponse.headers, (tier) => {
        tierReads -= 1;
        countServed(tier);
      });
      upstreamResponse.on("data", (chunk: Buffer) => reader.push(chunk));
      upstreamResponse.once("end", () => reader.finish(true));
      upstreamResponse.once("close", () => reader.finish(false));
    } catch {
      // Counting is best effort: the answer is already on its way to the agent.
    }
  }

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
    const lookup = lookupTarget(url, lookupHosts);
    if (lookup !== undefined) {
      handleLookup(request, response, lookup);
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
    if (rejectedRequests >= maxRejectedModelRequests) {
      warn("model request refused", {
        provider: route.provider.name,
        reason: "rejected request ceiling",
        maxRejectedModelRequests,
      });
      sendJson(response, 403, { error: REJECTED_CEILING_MESSAGE });
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
    const answered = (status: number): void => {
      if (status !== REJECTED_STATUS) return;
      // Not served, not billed: it moves from the request ceiling to the rejected one.
      modelRequests -= 1;
      rejectedRequests += 1;
    };
    forward(request, response, route, modelRequests, answered).catch(
      (error: unknown) => {
        warn("model request failed", { errorType: errorType(error) });
        if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
        else response.destroy();
      },
    );
    return true;
  }

  /**
   * The documentation lookup route's checks, in order: the route is on, the method is GET, there
   * is no body, the host is listed and the address plain, and the run is under its ceiling. A
   * refusal sends a fixed text and logs the host and the reason, never the path or query.
   */
  function handleLookup(
    request: IncomingMessage,
    response: ServerResponse,
    target: LookupTarget,
  ): void {
    // Nothing of the agent's request is sent on, so whatever it sent is read and dropped.
    request.resume();
    const refuse = (refusal: LookupRefusal, reason: string, fields: LogFields = {}) => {
      warn("lookup refused", { host: target.host, reason, ...fields });
      sendLookupRefusal(response, refusal);
    };
    if (lookupHosts.size === 0) {
      refuse(LOOKUP_REFUSALS.unlisted, "lookup route off");
      return;
    }
    if (request.method !== "GET") {
      refuse(LOOKUP_REFUSALS.method, "method not allowed", { method: request.method });
      return;
    }
    if (hasRequestBody(request.headers)) {
      refuse(LOOKUP_REFUSALS.body, "request body");
      return;
    }
    if (!target.ok) {
      refuse(
        target.reason === "invalid path"
          ? LOOKUP_REFUSALS.malformed
          : LOOKUP_REFUSALS.unlisted,
        target.reason,
      );
      return;
    }
    if (lookupRequests >= maxLookupRequests) {
      refuse(LOOKUP_REFUSALS.ceiling, "lookup ceiling", { maxLookupRequests });
      return;
    }
    lookupRequests += 1;
    // forwardLookup answers every failure itself; this is only the last resort.
    forwardLookup(response, target.host, target.path, lookupRequests).catch(() =>
      response.destroy(),
    );
  }

  /**
   * One lookup: the host's vetted address, TLS with the certificate checked against the host's
   * name, a GET with the fixed headers, and the answer passed back with only the lookup's
   * response headers and at most LOOKUP_BODY_LIMIT bytes. The deadline covers all of it.
   */
  async function forwardLookup(
    response: ServerResponse,
    host: string,
    path: string,
    count: number,
  ): Promise<void> {
    const started = Date.now();
    let status: number | undefined;
    let bytes = 0;
    let settled = false;
    let upstreamRequest: ClientRequest | undefined;
    const finish = (outcome: string, fields: LogFields = {}): void => {
      settled = true;
      clearTimeout(timer);
      // No path or query: they can carry what the agent read in the repository (D-472).
      info("lookup request", {
        host,
        status,
        outcome,
        bytes,
        durationMs: Date.now() - started,
        count,
        ...fields,
      });
    };
    /** Ends the lookup early: a fixed text if nothing was sent yet, else the body stops short. */
    const fail = (
      refusal: LookupRefusal,
      outcome: string,
      fields?: LogFields,
    ): void => {
      if (settled) return;
      finish(outcome, fields);
      upstreamRequest?.destroy();
      if (!response.headersSent) sendLookupRefusal(response, refusal);
      else response.destroy();
    };
    // Declared after `finish` and `fail`, which only run once it is set.
    const timer = setTimeout(
      () => fail(LOOKUP_REFUSALS.timeout, "timeout"),
      lookupTimeoutMs,
    );
    response.once("close", () => {
      if (settled || response.writableFinished) return;
      finish("client closed");
      upstreamRequest?.destroy();
    });

    try {
      // Checked like a tunnel's target, so a listed name can never lead to a private address.
      const vetted = await vet(host);
      if (settled) return;
      if (!vetted.ok) {
        fail(
          vetted.reason === "blocked address"
            ? LOOKUP_REFUSALS.blocked
            : LOOKUP_REFUSALS.unreachable,
          vetted.reason,
          { errorType: vetted.errorType },
        );
        return;
      }
      const address = vetted.address;
      upstreamRequest = httpsRequest({
        host,
        port: LOOKUP_PORT,
        defaultPort: LOOKUP_PORT,
        method: "GET",
        path,
        headers: lookupRequestHeaders(),
        createConnection: () =>
          tlsConnect({
            socket: connect(address, LOOKUP_PORT),
            host,
            servername: host,
            ca: options.upstreamCa,
            // Explicit, so a stray NODE_TLS_REJECT_UNAUTHORIZED in the environment cannot turn it off.
            rejectUnauthorized: true,
            ALPNProtocols: ["http/1.1"],
          }),
      });
      upstreamRequest.on("error", (error) =>
        fail(LOOKUP_REFUSALS.unreachable, `upstream error ${errorType(error)}`),
      );
      upstreamRequest.on("response", (upstreamResponse) => {
        upstreamResponse.on("error", () => {});
        try {
          relayLookup(upstreamResponse);
        } catch (error) {
          fail(LOOKUP_REFUSALS.unreachable, `relay error ${errorType(error)}`);
        }
      });
      upstreamRequest.end();
    } catch (error) {
      fail(LOOKUP_REFUSALS.unreachable, `request error ${errorType(error)}`);
    }

    /** Passes the answer back: the status, the lookup's headers and the body up to the cut. */
    function relayLookup(upstreamResponse: IncomingMessage): void {
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      status = upstreamResponse.statusCode ?? 502;
      response.sendDate = false;
      response.writeHead(
        status,
        lookupResponseHeaders(status, upstreamResponse.headers),
      );
      upstreamResponse.on("data", (chunk: Buffer) => {
        if (settled) return;
        const room = LOOKUP_BODY_LIMIT - bytes;
        if (chunk.length > room) {
          // The cut: the body simply ends at the limit.
          bytes += room;
          finish("cut");
          response.end(chunk.subarray(0, room));
          upstreamRequest?.destroy();
          return;
        }
        bytes += chunk.length;
        if (!response.write(chunk)) {
          upstreamResponse.pause();
          response.once("drain", () => upstreamResponse.resume());
        }
      });
      upstreamResponse.once("end", () => {
        if (settled) return;
        finish("ok");
        response.end();
      });
      upstreamResponse.once("close", () => {
        if (settled) return;
        finish("stream closed early");
        response.destroy();
      });
    }
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
    answered: (status: number) => void,
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
        rejectedRequests,
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
    relay(request, response, upstreamRequest, done, "model provider unreachable", {
      answered,
      read: readServed,
    });
  }

  /**
   * Streams the request to the upstream and the answer back, both unchanged. For model traffic,
   * `answered` sees each status and `read` gets each answer once it is piped (D-423).
   */
  function relay(
    request: IncomingMessage,
    response: ServerResponse,
    upstreamRequest: ReturnType<typeof httpRequest>,
    done: (outcome: string, status?: number) => void,
    unreachable: string,
    model: {
      answered?: (status: number) => void;
      read?: (status: number, upstreamResponse: IncomingMessage) => void;
    } = {},
  ): void {
    upstreamRequest.on("response", (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      model.answered?.(status);
      response.writeHead(status, downstreamResponseHeaders(upstreamResponse.headers));
      response.flushHeaders();
      pipeline(upstreamResponse, response, (error) =>
        done(error ? "stream closed early" : "ok", status),
      );
      // After the pipe: its listener writes each chunk to the agent before the reader sees it.
      model.read?.(status, upstreamResponse);
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

/** A lookup refusal: its status and fixed text, as plain text. */
function sendLookupRefusal(response: ServerResponse, refusal: LookupRefusal): void {
  response.sendDate = false;
  response.writeHead(refusal.status, {
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(refusal.text),
    ...(refusal.status === 405 ? { allow: "GET" } : {}),
  });
  response.end(refusal.text);
}

/** The host name of an absolute request URL, for the log. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.slice(0, 253);
  } catch {
    return url.split(/[/:]/)[0]?.slice(0, 253) ?? "";
  }
}
