import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger } from "../service-kit/logger.ts";
import { startService, type RunningService } from "../service-kit/server.ts";
import { parseAllowedHosts } from "./hosts.ts";
import {
  LOOKUP_BODY_LIMIT,
  LOOKUP_REFUSALS,
  lookupRequestHeaders,
  type LookupRefusal,
} from "./lookup.ts";
import { parseProviders } from "./providers.ts";
import {
  CEILING_MESSAGE,
  createEgressProxy,
  REJECTED_CEILING_MESSAGE,
  type EgressProxy,
} from "./proxy.ts";
import {
  emptyTally,
  parseServedTiersLog,
  SERVED_TIERS_MESSAGE,
  servedTierOf,
} from "./served-tiers.ts";
import { parseStateApiUpstream } from "./state-api.ts";

// Integration: the proxy over real sockets on localhost. No real DNS and no real network: the
// resolver is a fake, the vetted public address is mapped to a local TCP server by the connect
// seam, and the model upstream is a local https server with a certificate made for this test.

const RUN_ID = "run_test_1";
const PROVIDER_KEY = "provider-key-value-0123456789";
const AGENT_KEY = "agent-placeholder-key-987654";
const BODY_MARKER = "BODY-MARKER-must-not-be-logged";
const STATE_TOKEN = "state-api-run-token-0123456789";
const STATE_HOST = "state-api.foreman-platform.svc.cluster.local";
const GITHUB_ADDRESS = "140.82.112.3";
/** The public address the fake DNS gives the model provider's name. */
const MODEL_ADDRESS = "34.120.0.10";
const MODEL_HOST = "models.example.com";
/** A listed documentation host, and the public address the fake DNS gives it (ADR 0119 slice 4a). */
const DOCS_HOST = "docs.example.com";
const DOCS_ADDRESS = "34.120.0.20";
/** Listed hosts the lookup must still refuse or fail: by address, by DNS and by certificate. */
const LOOKUP_HOSTS = [
  DOCS_HOST,
  "private-docs.example.com",
  "mixed-docs.example.com",
  "missing-docs.example.com",
  "wrong-name.example.com",
].join(",");
const PATH_MARKER = "PATH-MARKER-must-not-be-logged";
const QUERY_MARKER = "QUERY-MARKER-must-not-be-logged";
const COOKIE_MARKER = "COOKIE-MARKER-must-not-reach-the-site";

const DNS: Record<string, string[]> = {
  "github.com": [GITHUB_ADDRESS],
  "metadata.example.com": ["169.254.169.254"],
  "mixed.example.com": [GITHUB_ADDRESS, "10.0.0.7"],
  "private6.example.com": ["fd00:ec2::254"],
  "mapped.example.com": ["::ffff:10.0.0.1"],
  [MODEL_HOST]: [MODEL_ADDRESS],
  "private-model.example.com": ["10.0.0.9"],
  [STATE_HOST]: ["127.0.0.1"],
  [DOCS_HOST]: [DOCS_ADDRESS],
  "private-docs.example.com": ["10.0.0.11"],
  "mixed-docs.example.com": [DOCS_ADDRESS, "192.168.1.5"],
  // Resolves to the docs stand-in, whose certificate does not name it.
  "wrong-name.example.com": [DOCS_ADDRESS],
};

let certDir: string;
let cert: string;
let key: string;
let tunnelTarget: Server;
let tunnelTargetPort: number;
let upstream: HttpsServer;
let upstreamPort: number;
let releaseStream: () => void = () => {};

interface Seen {
  /** The method, as the state API's stand-in recorded it. */
  method?: string;
  path?: string;
  headers: IncomingHttpHeaders;
  bodyHash: string;
}
let upstreamSeen: Seen[] = [];

/** One served model response of the fake upstream: its headers and the writes of its body. */
interface ServedCase {
  headers: Record<string, string>;
  writes: Buffer[];
}

/** A chat completion that names a tier, or none. The marker checks no body reaches the logs. */
const completionBody = (tier?: string): Buffer =>
  Buffer.from(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: BODY_MARKER } }],
      ...(tier === undefined ? {} : { service_tier: tier }),
    }),
  );
/** A streamed completion whose chunks name these tiers (undefined: a chunk without the field). */
const eventsBody = (...tiers: (string | undefined)[]): Buffer =>
  Buffer.from(
    tiers
      .map(
        (tier) =>
          `data: ${JSON.stringify({
            object: "chat.completion.chunk",
            choices: [{ delta: { content: `${BODY_MARKER} é` } }],
            ...(tier === undefined ? {} : { service_tier: tier }),
          })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
  );
/** A body in three writes, so the proxy and its reader see it in pieces. */
const inThree = (body: Buffer): Buffer[] => {
  const third = Math.ceil(body.length / 3);
  return [
    body.subarray(0, third),
    body.subarray(third, 2 * third),
    body.subarray(2 * third),
  ];
};
const JSON_HEADERS = { "content-type": "application/json" };
const EVENT_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};
const SERVED_CASES: Record<string, ServedCase> = {
  "json-default": { headers: JSON_HEADERS, writes: inThree(completionBody("default")) },
  "json-flex": { headers: JSON_HEADERS, writes: inThree(completionBody("flex")) },
  "json-unknown-value": { headers: JSON_HEADERS, writes: [completionBody("scale")] },
  "json-no-field": { headers: JSON_HEADERS, writes: [completionBody()] },
  "events-flex": {
    headers: EVENT_HEADERS,
    writes: inThree(eventsBody("flex", "flex")),
  },
  "events-default-last": {
    headers: EVENT_HEADERS,
    writes: inThree(eventsBody(undefined, undefined, "default")),
  },
  "events-disagree": {
    headers: EVENT_HEADERS,
    writes: inThree(eventsBody("flex", "default")),
  },
  "events-no-field": { headers: EVENT_HEADERS, writes: inThree(eventsBody(undefined)) },
  "gzip-json-flex": {
    headers: { ...JSON_HEADERS, "content-encoding": "gzip" },
    writes: inThree(gzipSync(completionBody("flex"))),
  },
  "deflate-json-default": {
    headers: { ...JSON_HEADERS, "content-encoding": "deflate" },
    writes: inThree(deflateSync(completionBody("default"))),
  },
  "br-events-flex": {
    headers: { ...EVENT_HEADERS, "content-encoding": "br" },
    writes: inThree(brotliCompressSync(eventsBody(undefined, "flex"))),
  },
  "gzip-events-unknown-value": {
    headers: { ...EVENT_HEADERS, "content-encoding": "gzip" },
    writes: inThree(gzipSync(eventsBody("auto"))),
  },
  "corrupt-gzip": {
    headers: { ...JSON_HEADERS, "content-encoding": "gzip" },
    writes: [Buffer.from(`not gzip ${BODY_MARKER}`)],
  },
  zstd: {
    headers: { ...JSON_HEADERS, "content-encoding": "zstd" },
    writes: [randomBytes(64)],
  },
};
/** What the fake upstream sent for each served response, in order. */
let servedSent: Buffer[] = [];
/** How to end each held stream the fake upstream is holding open. */
let heldReleases: (() => void)[] = [];

// Stand in for the in-cluster state API, and for a second private service the route must never
// reach.
let stateApi: HttpServer;
let stateApiPort: number;
let stateApiSeen: Seen[] = [];
let otherService: HttpServer;
let otherServicePort: number;
let otherServiceSeen: Seen[] = [];

// Stands in for a documentation site behind the lookup route (ADR 0119 slice 4a).
let docs: HttpsServer;
let docsPort: number;
let docsSeen: Seen[] = [];
/** What the docs stand-in sent as the body of each answer, in order. */
let docsSent: Buffer[] = [];
/** How to end each answer the docs stand-in is holding. */
let docsHeld: (() => void)[] = [];
/** A page body the size of the lookup's limit plus one MiB, to be cut. */
const BIG_PAGE = randomBytes(LOOKUP_BODY_LIMIT + 1024 * 1024);
const PAGE = `<html><body><main>${BODY_MARKER}</main></body></html>`;

function docsServer(): HttpsServer {
  return createHttpsServer({ cert, key }, (request, response) => {
    request.resume();
    request.on("end", () => {
      docsSeen.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        bodyHash: "",
      });
      const page = (request.url ?? "").split("?")[0];
      const send = (
        status: number,
        headers: Record<string, string | string[]>,
        body: Buffer,
      ): void => {
        docsSent.push(body);
        response.writeHead(status, headers);
        response.end(body);
      };
      if (page === "/big" || page === "/big-chunked" || page === "/exact") {
        const body =
          page === "/exact" ? BIG_PAGE.subarray(0, LOOKUP_BODY_LIMIT) : BIG_PAGE;
        docsSent.push(body);
        response.writeHead(200, {
          "content-type": "text/html",
          ...(page === "/big-chunked" ? {} : { "content-length": String(body.length) }),
        });
        // In pieces, so the cut falls inside a write.
        let offset = 0;
        const next = (): void => {
          if (offset >= body.length) {
            response.end();
            return;
          }
          const piece = body.subarray(offset, offset + 300_000);
          offset += piece.length;
          response.write(piece, next);
        };
        next();
        return;
      }
      if (page === "/slow") {
        // Never answers until released.
        docsHeld.push(() => response.end());
        return;
      }
      if (page === "/stall") {
        // Answers, sends part of the body, then holds.
        response.writeHead(200, { "content-type": "text/html" });
        response.write("<html><body>part");
        docsHeld.push(() => response.end("</body></html>"));
        return;
      }
      if (page === "/redirect") {
        send(
          302,
          { location: "/guide/next", "set-cookie": "visited=1", "content-length": "0" },
          Buffer.alloc(0),
        );
        return;
      }
      if (page === "/gzip") {
        send(
          200,
          { "content-type": "text/html", "content-encoding": "gzip" },
          gzipSync(PAGE),
        );
        return;
      }
      if (page === "/missing") {
        send(404, { "content-type": "text/plain" }, Buffer.from("no such page"));
        return;
      }
      const body = Buffer.from(PAGE);
      send(
        200,
        {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(body.length),
          "set-cookie": [`session=${COOKIE_MARKER}; Secure; HttpOnly`, "theme=dark"],
          "cache-control": "max-age=60",
          "x-powered-by": "docs-stand-in",
          "access-control-allow-origin": "*",
        },
        body,
      );
    });
  });
}

function recordingServer(seen: () => Seen[]): HttpServer {
  return createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen().push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        bodyHash: sha256(body),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, echoed: body.length }));
    });
  });
}

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "egress-proxy-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      `subjectAltName=DNS:${MODEL_HOST},DNS:${DOCS_HOST},IP:127.0.0.1`,
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(certDir, "cert.pem"), "utf8");
  key = readFileSync(join(certDir, "key.pem"), "utf8");

  // Stands in for github.com:443. It echoes, so the test sees bytes cross the tunnel both ways.
  tunnelTarget = createNetServer((socket) => {
    socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => tunnelTarget.listen(0, "127.0.0.1", resolve));
  tunnelTargetPort = (tunnelTarget.address() as AddressInfo).port;

  // Stands in for a model provider.
  upstream = createHttpsServer({ cert, key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      upstreamSeen.push({
        path: request.url,
        headers: request.headers,
        bodyHash: sha256(body),
      });
      if (request.url === "/v1/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: first\ndata: 1\n\n");
        releaseStream = () => response.end("event: last\ndata: 2\n\n");
        return;
      }
      const served = /^\/v1\/served\?case=([a-z0-9-]+)$/.exec(request.url ?? "")?.[1];
      const servedCase = served === undefined ? undefined : SERVED_CASES[served];
      if (servedCase !== undefined) {
        const { headers, writes } = servedCase;
        servedSent.push(Buffer.concat(writes));
        response.writeHead(200, headers);
        let i = 0;
        const next = (): void => {
          const write = writes[i];
          i += 1;
          if (write === undefined) response.end();
          else response.write(write, () => setTimeout(next, 5));
        };
        next();
        return;
      }
      if (request.url === "/v1/served-held") {
        // A stream held open after its first event, which names Flex.
        const whole = eventsBody("flex");
        const first = whole.subarray(0, whole.indexOf("data: [DONE]"));
        servedSent.push(first);
        response.writeHead(200, EVENT_HEADERS);
        response.write(first);
        heldReleases.push(() => response.end("data: [DONE]\n\n"));
        return;
      }
      if (request.url === "/v1/busy") {
        // A provider that is busy: not served, not billed.
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "busy" },
          }),
        );
        return;
      }
      if (request.url?.startsWith("/v1/echo")) {
        // The body goes back, so the response is checked byte for byte too.
        response.writeHead(201, { "content-type": "application/octet-stream" });
        response.end(body);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;

  stateApi = recordingServer(() => stateApiSeen);
  await new Promise<void>((resolve) => stateApi.listen(0, "127.0.0.1", resolve));
  stateApiPort = (stateApi.address() as AddressInfo).port;
  otherService = recordingServer(() => otherServiceSeen);
  await new Promise<void>((resolve) => otherService.listen(0, "127.0.0.1", resolve));
  otherServicePort = (otherService.address() as AddressInfo).port;
  docs = docsServer();
  await new Promise<void>((resolve) => docs.listen(0, "127.0.0.1", resolve));
  docsPort = (docs.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => tunnelTarget.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => stateApi.close(resolve));
  await new Promise((resolve) => otherService.close(resolve));
  docs.closeAllConnections();
  await new Promise((resolve) => docs.close(resolve));
  rmSync(certDir, { recursive: true, force: true });
});

interface Harness {
  service: RunningService;
  proxy: EgressProxy;
  logs: string[];
  resolved: string[];
  connected: string[];
}
let harness: Harness | undefined;

afterEach(async () => {
  if (!harness) return;
  harness.proxy.closeTunnels();
  await harness.service.stop();
  harness = undefined;
  upstreamSeen = [];
  stateApiSeen = [];
  otherServiceSeen = [];
  servedSent = [];
  for (const release of heldReleases) release();
  heldReleases = [];
  docsSeen = [];
  docsSent = [];
  for (const release of docsHeld) release();
  docsHeld = [];
});

async function start(
  overrides: {
    maxModelRequests?: number;
    maxRejectedModelRequests?: number;
    trustTestCa?: boolean;
    dns?: Record<string, string[]>[];
    stateApi?: boolean;
    /** The lookup route's hosts, comma-separated. Empty turns the route off. */
    lookupHosts?: string;
    maxLookupRequests?: number;
    lookupTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const logs: string[] = [];
  const resolved: string[] = [];
  const connected: string[] = [];
  const logger = createLogger("egress-proxy", (line) => logs.push(line));
  // Each lookup of a name takes the next answer, so a test can make DNS change its mind.
  const answers = overrides.dns ?? [DNS];
  const lookups = new Map<string, number>();
  const proxy = createEgressProxy({
    runId: RUN_ID,
    allowedHosts: parseAllowedHosts(
      `github.com,metadata.example.com,mixed.example.com,private6.example.com,mapped.example.com,missing.example.com,rebind.example.com,${STATE_HOST}`,
    ),
    providers: parseProviders(
      JSON.stringify([
        {
          name: "anthropic",
          upstream: `https://${MODEL_HOST}:${upstreamPort}`,
          credential: "x-api-key",
          secretPath: "projects/test/models/anthropic",
        },
        {
          name: "openai",
          upstream: `https://${MODEL_HOST}:${upstreamPort}/v1`,
          credential: "bearer",
          secretPath: "projects/test/models/openai",
        },
        {
          // Shaped like the Messages API bots' DeepInfra entry (O-152).
          name: "deepinfra",
          upstream: `https://${MODEL_HOST}:${upstreamPort}/anthropic`,
          credential: "x-api-key",
          secretPath: "projects/test/models/deepinfra",
        },
        {
          name: "private",
          upstream: `https://private-model.example.com:${upstreamPort}`,
          credential: "none",
        },
        {
          name: "literal",
          upstream: `https://127.0.0.1:${stateApiPort}`,
          credential: "none",
        },
      ]),
    ),
    credentials: new Map([
      ["anthropic", PROVIDER_KEY],
      ["openai", PROVIDER_KEY],
      ["deepinfra", PROVIDER_KEY],
    ]),
    maxModelRequests: overrides.maxModelRequests ?? 100,
    maxRejectedModelRequests: overrides.maxRejectedModelRequests ?? 5,
    stateApi:
      overrides.stateApi === false
        ? undefined
        : parseStateApiUpstream(`http://127.0.0.1:${stateApiPort}`),
    lookupHosts: parseAllowedHosts(overrides.lookupHosts ?? LOOKUP_HOSTS),
    maxLookupRequests: overrides.maxLookupRequests,
    lookupTimeoutMs: overrides.lookupTimeoutMs,
    logger,
    resolve: async (host) => {
      resolved.push(host);
      const count = lookups.get(host) ?? 0;
      lookups.set(host, count + 1);
      const table = answers[Math.min(count, answers.length - 1)] ?? {};
      const addresses = table[host];
      if (!addresses)
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return addresses;
    },
    connect: (address, port) => {
      connected.push(`${address}:${port}`);
      if (address === MODEL_ADDRESS) return netConnect(upstreamPort, "127.0.0.1");
      if (address === DOCS_ADDRESS) return netConnect(docsPort, "127.0.0.1");
      if (address !== GITHUB_ADDRESS)
        throw new Error(`unexpected connect to ${address}`);
      return netConnect(tunnelTargetPort, "127.0.0.1");
    },
    upstreamCa: overrides.trustTestCa === false ? undefined : cert,
  });
  const service = await startService({
    name: "egress-proxy",
    port: 0,
    logger,
    handle: proxy.handle,
    onConnect: proxy.onConnect,
  });
  harness = { service, proxy, logs, resolved, connected };
  return harness;
}

/** Send a CONNECT and return the status and the socket. */
function connectThrough(
  port: number,
  target: string,
): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: target,
    });
    request.on("connect", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, socket }),
    );
    request.on("error", reject);
    request.end();
  });
}

function readOnce(socket: Socket): Promise<string> {
  return new Promise((resolve) =>
    socket.once("data", (data) => resolve(data.toString())),
  );
}

const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");
const proxyUrl = (path: string): string =>
  `http://127.0.0.1:${harness?.service.port}${path}`;

describe("egress proxy CONNECT tunnels (integration: localhost fakes, ADR 0106 section 2)", () => {
  it("opens a tunnel to an allowed host on 443, at the address it checked", async () => {
    const { service, connected, resolved } = await start();
    const { status, socket } = await connectThrough(service.port, "github.com:443");
    expect(status).toBe(200);
    socket.write("ping");
    expect(await readOnce(socket)).toBe("echo:ping");
    socket.destroy();
    expect(resolved).toEqual(["github.com"]);
    expect(connected).toEqual([`${GITHUB_ADDRESS}:443`]);
  });

  it("resolves once and never again, so a changed DNS answer cannot redirect the tunnel", async () => {
    const { service, connected, resolved } = await start({
      dns: [
        { "rebind.example.com": [GITHUB_ADDRESS] },
        { "rebind.example.com": ["127.0.0.1"] },
      ],
    });
    const { status, socket } = await connectThrough(
      service.port,
      "rebind.example.com:443",
    );
    expect(status).toBe(200);
    socket.destroy();
    expect(resolved).toEqual(["rebind.example.com"]);
    expect(connected).toEqual([`${GITHUB_ADDRESS}:443`]);
  });

  it.each([
    ["a host off the list", "example.org:443", 403],
    ["a suffix trick", "github.com.evil.com:443", 403],
    ["port 80", "github.com:80", 403],
    ["an IPv4 literal", `${GITHUB_ADDRESS}:443`, 403],
    ["an IPv6 literal", "[2606:4700::1]:443", 403],
    ["the metadata address behind an allowed name", "metadata.example.com:443", 403],
    ["an answer with one private address", "mixed.example.com:443", 403],
    ["a unique-local IPv6 answer", "private6.example.com:443", 403],
    ["an IPv4-mapped private answer", "mapped.example.com:443", 403],
    ["a name that does not resolve", "missing.example.com:443", 502],
  ])("refuses %s", async (_label, target, expected) => {
    const { service, connected } = await start();
    const { status, socket } = await connectThrough(service.port, target);
    socket.destroy();
    expect(status).toBe(expected);
    expect(connected).toEqual([]);
  });

  it("closes open tunnels on shutdown", async () => {
    const { service, proxy } = await start();
    const { socket } = await connectThrough(service.port, "github.com:443");
    const closed = new Promise((resolve) => socket.once("close", resolve));
    proxy.closeTunnels();
    await closed;
    await service.stop();
  });

  it("refuses plain HTTP proxying to any host", async () => {
    const { service } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: service.port,
        path: "http://github.com/",
        headers: { host: "github.com" },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("answers /health and 404 for paths that are not a provider", async () => {
    await start();
    expect((await fetch(proxyUrl("/health"))).status).toBe(200);
    expect((await fetch(proxyUrl("/v1/messages"))).status).toBe(404);
    expect(upstreamSeen).toEqual([]);
  });
});

describe("egress proxy model forwarding (integration: localhost fakes, ADR 0106 sections 5 and 6)", () => {
  it("forwards the body byte for byte and swaps only the credential", async () => {
    await start();
    const body = Buffer.concat([Buffer.from(BODY_MARKER), randomBytes(256 * 1024)]);
    const response = await fetch(proxyUrl("/anthropic/v1/echo?beta=true"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": AGENT_KEY,
        authorization: `Bearer ${AGENT_KEY}`,
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(sha256(Buffer.from(await response.arrayBuffer()))).toBe(sha256(body));

    expect(upstreamSeen).toHaveLength(1);
    const seen = upstreamSeen[0] as Seen;
    expect(seen.path).toBe("/v1/echo?beta=true");
    expect(seen.bodyHash).toBe(sha256(body));
    expect(seen.headers["x-api-key"]).toBe(PROVIDER_KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers.host).toBe(`${MODEL_HOST}:${upstreamPort}`);
    expect(JSON.stringify(seen.headers)).not.toContain(AGENT_KEY);
  });

  it("sets a bearer credential for a bearer provider, under its base path", async () => {
    await start();
    await fetch(proxyUrl("/openai/chat/completions"), {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_KEY}` },
      body: "{}",
    });
    const seen = upstreamSeen[0] as Seen;
    expect(seen.path).toBe("/v1/chat/completions");
    expect(seen.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(seen.headers["x-api-key"]).toBeUndefined();
  });

  it("sets an x-api-key credential under a base path, as for DeepInfra's Anthropic endpoint (O-152)", async () => {
    await start();
    await fetch(proxyUrl("/deepinfra/v1/messages"), {
      method: "POST",
      headers: { "x-api-key": AGENT_KEY, authorization: `Bearer ${AGENT_KEY}` },
      body: "{}",
    });
    const seen = upstreamSeen[0] as Seen;
    expect(seen.path).toBe("/anthropic/v1/messages");
    expect(seen.headers["x-api-key"]).toBe(PROVIDER_KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.host).toBe(`${MODEL_HOST}:${upstreamPort}`);
  });

  it("streams server-sent events as they arrive", async () => {
    await start();
    const response = await fetch(proxyUrl("/anthropic/v1/stream"), {
      method: "POST",
      body: "{}",
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // The first event arrives while the upstream still holds the stream open.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("event: first\ndata: 1\n\n");
    releaseStream();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toBe("event: last\ndata: 2\n\n");
  });

  it("connects to the provider's vetted address and checks the certificate against its name", async () => {
    const { connected, resolved } = await start();
    const response = await fetch(proxyUrl("/anthropic/v1/messages"), {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(resolved).toEqual([MODEL_HOST]);
    expect(connected).toEqual([`${MODEL_ADDRESS}:${upstreamPort}`]);
  });

  it.each([
    ["a name that resolves to a private address", "/private/v1/messages"],
    ["the state API's own address", "/literal/v1/messages"],
  ])("refuses a provider whose upstream is %s", async (_label, path) => {
    const { connected } = await start();
    const response = await fetch(proxyUrl(path), { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    expect(connected).toEqual([]);
    expect(upstreamSeen).toEqual([]);
    expect(stateApiSeen).toEqual([]);
  });

  it("trusts only the system's authorities when no test authority is given", async () => {
    await start({ trustTestCa: false });
    const response = await fetch(proxyUrl("/anthropic/v1/messages"), {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(upstreamSeen).toEqual([]);
  });

  it("refuses model requests past the ceiling with 403, which clients do not retry", async () => {
    const { logs } = await start({ maxModelRequests: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(proxyUrl("/anthropic/v1/messages"), {
        method: "POST",
        body: "{}",
      });
      statuses.push(response.status);
      if (response.status === 403)
        expect(await response.json()).toEqual({ error: CEILING_MESSAGE });
      else await response.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 403]);
    expect(upstreamSeen).toHaveLength(2);
    expect(logs.join("\n")).toContain('"reason":"request ceiling"');
  });

  /** POSTs to a model path through the proxy and returns the status, reading the body. */
  async function post(path: string): Promise<{ status: number; body: string }> {
    const response = await fetch(proxyUrl(path), { method: "POST", body: "{}" });
    return { status: response.status, body: await response.text() };
  }

  it("does not count a request the upstream answered with 429 against the ceiling (ADR 0114 section 9)", async () => {
    await start({ maxModelRequests: 2, maxRejectedModelRequests: 5 });
    const statuses: number[] = [];
    for (const path of [
      "/openai/busy",
      "/openai/busy",
      "/openai/busy",
      "/anthropic/v1/messages",
      "/anthropic/v1/messages",
      "/anthropic/v1/messages",
    ]) {
      statuses.push((await post(path)).status);
    }
    // Three rejections, then the two served requests the ceiling allows, then the ceiling.
    expect(statuses).toEqual([429, 429, 429, 200, 200, 403]);
    expect(upstreamSeen).toHaveLength(5);
  });

  it("passes the 429 to the client unchanged", async () => {
    await start();
    const answer = await post("/openai/busy");
    expect(answer.status).toBe(429);
    expect(JSON.parse(answer.body)).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "busy" },
    });
  });

  it("answers 403 past the rejected-request ceiling, so a runtime that retries without end stops", async () => {
    const { logs } = await start({
      maxModelRequests: 100,
      maxRejectedModelRequests: 2,
    });
    const answers = [];
    for (let i = 0; i < 3; i += 1) answers.push(await post("/openai/busy"));
    expect(answers.map((a) => a.status)).toEqual([429, 429, 403]);
    expect(JSON.parse(answers[2]?.body ?? "")).toEqual({
      error: REJECTED_CEILING_MESSAGE,
    });
    // Served requests are refused too: the run is over.
    expect((await post("/anthropic/v1/messages")).status).toBe(403);
    expect(upstreamSeen).toHaveLength(2);
    expect(logs.join("\n")).toContain('"reason":"rejected request ceiling"');
  });
});

/** A plain HTTP request to the proxy with any request target and headers. */
function rawRequest(
  target: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: harness?.service.port,
      path: target,
      headers,
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("egress proxy state API route (integration: localhost fakes, D-195)", () => {
  it("forwards to the configured state API with the agent's token and body unchanged", async () => {
    await start();
    const body = Buffer.from(`{"note":"${BODY_MARKER}"}`);
    const response = await fetch(proxyUrl("/state-api/v1/runs/abc?view=full"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${STATE_TOKEN}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, echoed: body.length });
    expect(stateApiSeen).toHaveLength(1);
    const seen = stateApiSeen[0] as Seen;
    expect(seen.path).toBe("/v1/runs/abc?view=full");
    expect(seen.headers.authorization).toBe(`Bearer ${STATE_TOKEN}`);
    expect(seen.headers.host).toBe(`127.0.0.1:${stateApiPort}`);
    expect(seen.bodyHash).toBe(sha256(body));
    expect(upstreamSeen).toEqual([]);
  });

  it("forwards a GET with a query string, the method, path, query and token unchanged (ADR 0119 slice 3b)", async () => {
    await start();
    const query =
      "q=CSV%20export&path=src%2Freport%2Fexport.ts&path=src/report/csv/&path=%E2%9C%93";
    const response = await fetch(
      proxyUrl(`/state-api/context/similar-items?${query}`),
      {
        headers: { authorization: `Bearer ${STATE_TOKEN}` },
      },
    );
    expect(response.status).toBe(200);
    const history = await fetch(
      proxyUrl("/state-api/context/decisions?q=d-468+scope"),
      { headers: { authorization: `Bearer ${STATE_TOKEN}` } },
    );
    expect(history.status).toBe(200);
    expect(stateApiSeen.map((seen) => [seen.method, seen.path])).toEqual([
      ["GET", `/context/similar-items?${query}`],
      ["GET", "/context/decisions?q=d-468+scope"],
    ]);
    for (const seen of stateApiSeen) {
      expect(seen.headers.authorization).toBe(`Bearer ${STATE_TOKEN}`);
      expect(seen.headers.host).toBe(`127.0.0.1:${stateApiPort}`);
      expect(seen.bodyHash).toBe(sha256(Buffer.alloc(0)));
    }
    expect(upstreamSeen).toEqual([]);
  });

  it("does not count state API calls against the model request ceiling", async () => {
    await start({ maxModelRequests: 1 });
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(proxyUrl("/state-api/v1/health"));
      expect(response.status).toBe(200);
    }
    const model = await fetch(proxyUrl("/anthropic/v1/messages"), {
      method: "POST",
      body: "{}",
    });
    expect(model.status).toBe(200);
  });

  it("answers 404 when the route is off, and reaches nothing", async () => {
    await start({ stateApi: false });
    expect((await fetch(proxyUrl("/state-api/v1/runs"))).status).toBe(404);
    expect(stateApiSeen).toEqual([]);
  });

  it("cannot be steered to another host or port", async () => {
    await start();
    const other = `127.0.0.1:${otherServicePort}`;
    // The Host header names the other service: ignored.
    expect(await rawRequest("/state-api/v1/runs", { host: other })).toBe(200);
    // An absolute URL is plain proxying: refused.
    expect(await rawRequest(`http://${other}/state-api/v1/runs`, { host: other })).toBe(
      403,
    );
    // Tricks in the path are not the route, or stay on the state API.
    expect(await rawRequest(`/state-api@${other}/v1/runs`)).toBe(404);
    expect(await rawRequest(`/state-api:${otherServicePort}/v1/runs`)).toBe(404);
    expect(await rawRequest(`/state-api//${other}/v1/runs`)).toBe(200);
    expect(otherServiceSeen).toEqual([]);
    expect(stateApiSeen.map((seen) => seen.path)).toEqual([
      "/v1/runs",
      `//${other}/v1/runs`,
    ]);
    expect(
      stateApiSeen.every((seen) => seen.headers.host === `127.0.0.1:${stateApiPort}`),
    ).toBe(true);
  });

  it.each([
    ["its address as an IP literal", () => `127.0.0.1:${stateApiPort}`, 403],
    [
      "its name on 443, which resolves to a private address",
      () => `${STATE_HOST}:443`,
      403,
    ],
    ["its name on its own port", () => `${STATE_HOST}:${stateApiPort}`, 403],
  ])(
    "still refuses a CONNECT to the state API by %s",
    async (_label, target, expected) => {
      const { service, connected } = await start();
      const { status, socket } = await connectThrough(service.port, target());
      socket.destroy();
      expect(status).toBe(expected);
      expect(connected).toEqual([]);
      expect(stateApiSeen).toEqual([]);
    },
  );

  it("logs the call without its path, body or token", async () => {
    const { logs } = await start();
    const response = await fetch(
      proxyUrl(`/state-api/v1/${BODY_MARKER}?t=${STATE_TOKEN}`),
      {
        method: "POST",
        headers: { authorization: `Bearer ${STATE_TOKEN}` },
        body: BODY_MARKER,
      },
    );
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const entries = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: "state api request",
        status: 200,
        runId: RUN_ID,
      }),
    );
    const text = logs.join("\n");
    expect(text).not.toContain(STATE_TOKEN);
    expect(text).not.toContain(BODY_MARKER);
  });
});

describe("egress proxy logs (integration: captured logger, ADR 0106 section 5)", () => {
  it("record run id, host names and outcomes, but no payload or credential", async () => {
    const { service, logs } = await start();
    const tunnel = await connectThrough(service.port, "github.com:443");
    tunnel.socket.write(`secret-in-tunnel ${BODY_MARKER}`);
    await readOnce(tunnel.socket);
    tunnel.socket.destroy();
    (await connectThrough(service.port, "evil.example.net:443")).socket.destroy();
    const response = await fetch(proxyUrl(`/anthropic/v1/messages?key=${AGENT_KEY}`), {
      method: "POST",
      headers: { "x-api-key": AGENT_KEY },
      body: BODY_MARKER,
    });
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = logs.join("\n");
    const entries = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.every((entry) => entry.runId === RUN_ID)).toBe(true);
    expect(entries).toContainEqual(
      expect.objectContaining({ message: "tunnel closed", host: "github.com" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ message: "tunnel refused", host: "evil.example.net" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: "model request",
        provider: "anthropic",
        status: 200,
      }),
    );
    expect(text).not.toContain(BODY_MARKER);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).not.toContain(AGENT_KEY);
  });
});

/** A POST through the proxy that reads the raw answer: no decompression, unlike fetch. */
function rawPost(
  path: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: harness?.service.port,
      method: "POST",
      path,
      headers: { "content-type": "application/json", "accept-encoding": "gzip, br" },
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
    request.end("{}");
  });
}

/** The tally lines logged so far, parsed. */
const tallies = (logs: string[]) =>
  logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.message === SERVED_TIERS_MESSAGE);

describe("egress proxy served tier (integration: localhost fakes, D-423)", () => {
  it.each([
    ["json-default", "standard"],
    ["json-flex", "flex"],
    ["json-unknown-value", "unknown"],
    ["json-no-field", "unknown"],
    ["events-flex", "flex"],
    ["events-default-last", "standard"],
    ["events-disagree", "mixed"],
    ["events-no-field", "unknown"],
    ["gzip-json-flex", "flex"],
    ["deflate-json-default", "standard"],
    ["br-events-flex", "flex"],
    ["gzip-events-unknown-value", "unknown"],
    ["corrupt-gzip", "unknown"],
    ["zstd", "unknown"],
  ])("passes %s through byte for byte and counts it as %s", async (name, counted) => {
    const { logs } = await start();
    const answer = await rawPost(`/openai/served?case=${name}`);
    const sent = SERVED_CASES[name] as ServedCase;
    expect(answer.status).toBe(200);
    expect(servedSent).toHaveLength(1);
    expect(sha256(answer.body)).toBe(sha256(servedSent[0] as Buffer));
    for (const [header, value] of Object.entries(sent.headers)) {
      expect(answer.headers[header]).toBe(value);
    }
    await vi.waitFor(() => expect(tallies(logs)).toHaveLength(1));
    expect(tallies(logs)[0]).toMatchObject({
      runId: RUN_ID,
      level: "info",
      servedTiers: { ...emptyTally(), [counted]: 1 },
    });
  });

  it("keeps the run's tally across requests, which the runtime's parser reads as Flex", async () => {
    const { logs } = await start();
    // More requests than the reads allowed at once, one after another: each read ends.
    for (const name of [
      "events-flex",
      "gzip-json-flex",
      "json-no-field",
      "br-events-flex",
      "json-flex",
      "deflate-json-default",
    ]) {
      await rawPost(`/openai/served?case=${name}`);
    }
    await vi.waitFor(() => expect(tallies(logs)).toHaveLength(6));
    const tally = parseServedTiersLog(logs.join("\n"), RUN_ID);
    expect(tally).toEqual({ ...emptyTally(), flex: 4, standard: 1, unknown: 1 });
    expect(servedTierOf(tally ?? emptyTally())).toBe("mixed");
    expect(
      servedTierOf(
        parseServedTiersLog(logs.slice(0, -1).join("\n"), RUN_ID) ?? emptyTally(),
      ),
    ).toBe("flex");
  });

  /** Opens a held stream through the proxy and reads its first event. */
  async function openHeld() {
    const response = await fetch(proxyUrl("/openai/served-held"), {
      method: "POST",
      body: "{}",
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    return { reader, first: Buffer.from(first.value ?? new Uint8Array()) };
  }
  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    while (!(await reader.read()).done);
  };

  it("does not hold a stream back: the first event arrives while the stream is open", async () => {
    const { logs } = await start();
    const { reader, first } = await openHeld();
    expect(first).toEqual(servedSent[0]);
    // Nothing is counted while the stream is open.
    expect(tallies(logs)).toEqual([]);
    for (const release of heldReleases) release();
    await drain(reader);
    await vi.waitFor(() => expect(tallies(logs)).toHaveLength(1));
    expect(tallies(logs)[0]).toMatchObject({ servedTiers: { flex: 1, unknown: 0 } });
  });

  it("reads at most four answers at once and counts any other as unknown at once", async () => {
    const { logs } = await start();
    const held = [];
    for (let i = 0; i < 5; i += 1) held.push(await openHeld());
    // Every stream still passes through; the fifth is counted unknown without being read.
    for (const { first } of held) expect(first).toEqual(servedSent[0]);
    await vi.waitFor(() => expect(tallies(logs)).toHaveLength(1));
    expect(tallies(logs)[0]).toMatchObject({ servedTiers: { flex: 0, unknown: 1 } });
    for (const release of heldReleases) release();
    await Promise.all(held.map(({ reader }) => drain(reader)));
    await vi.waitFor(() => expect(tallies(logs)).toHaveLength(5));
    expect(tallies(logs)[4]).toMatchObject({ servedTiers: { flex: 4, unknown: 1 } });
  });

  it("counts nothing for an answer that was not served, the state API or a tunnel", async () => {
    const { service, logs } = await start();
    const busy = await fetch(proxyUrl("/openai/busy"), { method: "POST", body: "{}" });
    await busy.arrayBuffer();
    expect(busy.status).toBe(429);
    const state = await fetch(proxyUrl("/state-api/v1/runs"));
    await state.arrayBuffer();
    expect(state.status).toBe(200);
    const tunnel = await connectThrough(service.port, "github.com:443");
    tunnel.socket.write('{"service_tier":"flex"}');
    await readOnce(tunnel.socket);
    tunnel.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tallies(logs)).toEqual([]);
  });

  it("logs counts only: no body, header value or credential", async () => {
    const { logs } = await start();
    for (const name of ["json-flex", "events-flex", "gzip-json-flex", "corrupt-gzip"]) {
      await rawPost(`/openai/served?case=${name}`);
    }
    await vi.waitFor(() => expect(tallies(logs)).toHaveLength(4));
    const text = logs.join("\n");
    expect(text).not.toContain(BODY_MARKER);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).not.toContain("chat.completion");
    expect(text).not.toContain("event-stream");
    for (const entry of tallies(logs)) {
      expect(Object.keys(entry).sort()).toEqual([
        "level",
        "message",
        "runId",
        "servedTiers",
        "service",
        "time",
      ]);
    }
  });
});

/** What the agent gets back for one lookup, read raw: no decompression, no redirect followed. */
interface LookupAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** True when the body stopped short of its end. */
  aborted: boolean;
}

/** A request through the proxy, on its own connection, with any method, headers and body. */
function lookupRequest(
  path: string,
  {
    method = "GET",
    headers = {},
    body,
  }: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<LookupAnswer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: harness?.service.port,
      method,
      path,
      headers,
      agent: false,
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let ended = false;
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => (ended = true));
      response.on("error", () => {});
      response.on("close", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          aborted: !ended,
        }),
      );
    });
    request.on("error", reject);
    if (body === undefined) request.end();
    else request.end(body);
  });
}

/** Headers Node's server adds for the connection itself, not the answer. */
const FRAMING = new Set(["connection", "keep-alive", "transfer-encoding"]);
const answerHeaders = (answer: LookupAnswer): string[] =>
  Object.keys(answer.headers)
    .filter((name) => !FRAMING.has(name))
    .sort();

function expectRefusal(answer: LookupAnswer, refusal: LookupRefusal): void {
  expect(answer.status).toBe(refusal.status);
  expect(answer.headers["content-type"]).toBe("text/plain");
  expect(answer.body.toString()).toBe(refusal.text);
}

const lookupLines = (logs: string[]) =>
  logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) =>
        entry.message === "lookup request" || entry.message === "lookup refused",
    );

/** Every agent header the site must never see, with values the logs must never hold. */
const AGENT_HEADERS = {
  authorization: `Bearer ${AGENT_KEY}`,
  cookie: `session=${COOKIE_MARKER}`,
  "x-api-key": AGENT_KEY,
  "proxy-authorization": `Basic ${AGENT_KEY}`,
  "x-forwarded-for": "10.0.0.5",
  forwarded: "for=10.0.0.5",
  "x-real-ip": "10.0.0.5",
  referer: `http://10.0.0.5/${PATH_MARKER}`,
  "user-agent": "agent-user-agent",
  accept: "application/json",
  "accept-encoding": "gzip, br",
};

describe("egress proxy documentation lookup (integration: localhost fakes, ADR 0119 slice 4a)", () => {
  it("forwards a GET with only the fixed headers, at the vetted address, with the path and query unchanged", async () => {
    const { connected, resolved } = await start();
    const answer = await lookupRequest(
      `/lookup/${DOCS_HOST}/guide/csv?q=CSV%20export&x=1&x=%E2%9C%93`,
      { headers: AGENT_HEADERS },
    );
    expect(answer.status).toBe(200);
    expect(answer.body.toString()).toBe(PAGE);
    expect(resolved).toEqual([DOCS_HOST]);
    expect(connected).toEqual([`${DOCS_ADDRESS}:443`]);
    expect(docsSeen).toHaveLength(1);
    const seen = docsSeen[0] as Seen;
    expect(seen.method).toBe("GET");
    expect(seen.path).toBe("/guide/csv?q=CSV%20export&x=1&x=%E2%9C%93");
    // Only the fixed headers, the site's own Host and the client's framing reach the site.
    expect(seen.headers).toEqual({
      ...lookupRequestHeaders(),
      host: DOCS_HOST,
      connection: "close",
    });
    const sent = JSON.stringify(seen.headers);
    expect(sent).not.toContain(AGENT_KEY);
    expect(sent).not.toContain(COOKIE_MARKER);
    expect(sent).not.toContain("10.0.0.5");
    expect(sent).not.toContain("agent-user-agent");
  });

  it("passes back the status and only the type and length: Set-Cookie and the rest are dropped", async () => {
    await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/guide`);
    expect(answer.status).toBe(200);
    expect(answerHeaders(answer)).toEqual(["content-length", "content-type"]);
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(answer.headers["content-length"]).toBe(String(Buffer.byteLength(PAGE)));
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(answer.headers)).not.toContain(COOKIE_MARKER);

    const missing = await lookupRequest(`/lookup/${DOCS_HOST}/missing`);
    expect(missing.status).toBe(404);
    expect(missing.body.toString()).toBe("no such page");
  });

  it("passes a redirect's location back and never follows it", async () => {
    await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/redirect`);
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe("/guide/next");
    expect(answerHeaders(answer)).toEqual(["content-length", "location"]);
    expect(docsSeen.map((seen) => seen.path)).toEqual(["/redirect"]);
  });

  it("passes a content encoding and its bytes unchanged", async () => {
    await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/gzip`);
    expect(answer.headers["content-encoding"]).toBe("gzip");
    expect(sha256(answer.body)).toBe(sha256(docsSent[0] as Buffer));
  });

  it.each(["/big", "/big-chunked"])(
    "cuts %s at 2 MiB: the body simply ends, with no length",
    async (page) => {
      const { logs } = await start();
      const answer = await lookupRequest(`/lookup/${DOCS_HOST}${page}`);
      expect(answer.status).toBe(200);
      expect(answer.aborted).toBe(false);
      expect(answer.headers["content-length"]).toBeUndefined();
      expect(answer.body.length).toBe(LOOKUP_BODY_LIMIT);
      expect(sha256(answer.body)).toBe(sha256(BIG_PAGE.subarray(0, LOOKUP_BODY_LIMIT)));
      await vi.waitFor(() =>
        expect(lookupLines(logs)).toContainEqual(
          expect.objectContaining({ outcome: "cut", bytes: LOOKUP_BODY_LIMIT }),
        ),
      );
    },
  );

  it("passes a body of exactly 2 MiB whole, with its length", async () => {
    const { logs } = await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/exact`);
    expect(answer.headers["content-length"]).toBe(String(LOOKUP_BODY_LIMIT));
    expect(sha256(answer.body)).toBe(sha256(BIG_PAGE.subarray(0, LOOKUP_BODY_LIMIT)));
    await vi.waitFor(() =>
      expect(lookupLines(logs)).toContainEqual(
        expect.objectContaining({ outcome: "ok", bytes: LOOKUP_BODY_LIMIT }),
      ),
    );
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])(
    "refuses %s with 405 and sends nothing",
    async (method) => {
      const { resolved } = await start();
      const answer = await lookupRequest(`/lookup/${DOCS_HOST}/guide`, {
        method,
        headers: { "content-type": "application/json" },
        body: `{"note":"${BODY_MARKER}"}`,
      });
      expectRefusal(answer, LOOKUP_REFUSALS.method);
      expect(answer.headers.allow).toBe("GET");
      expect(resolved).toEqual([]);
      expect(docsSeen).toEqual([]);
    },
  );

  it("refuses HEAD with 405", async () => {
    await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/guide`, {
      method: "HEAD",
    });
    expect(answer.status).toBe(405);
    expect(docsSeen).toEqual([]);
  });

  it.each([
    ["a length", { "content-length": "11" }],
    ["chunks", { "transfer-encoding": "chunked" }],
  ])("refuses a GET with a body sent with %s with 400", async (_label, headers) => {
    const { resolved } = await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/guide`, {
      headers,
      body: BODY_MARKER.slice(0, 11),
    });
    expectRefusal(answer, LOOKUP_REFUSALS.body);
    expect(resolved).toEqual([]);
    expect(docsSeen).toEqual([]);
  });

  it("forwards a GET that says its body is empty", async () => {
    await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/guide`, {
      headers: { "content-length": "0" },
    });
    expect(answer.status).toBe(200);
  });

  it.each([
    ["a host off the list", "/lookup/unlisted.example.com/guide"],
    ["a suffix trick", `/lookup/${DOCS_HOST}.evil.com/guide`],
    ["a subdomain of a listed host", `/lookup/api.${DOCS_HOST}/guide`],
    ["a port", `/lookup/${DOCS_HOST}:443/guide`],
    ["user info", `/lookup/agent@${DOCS_HOST}/guide`],
    ["an IP literal", `/lookup/${DOCS_ADDRESS}/guide`],
    ["no host", "/lookup"],
    ["an empty first segment", `/lookup//${DOCS_HOST}/guide`],
  ])("refuses %s with 403, resolving nothing", async (_label, path) => {
    const { resolved, connected } = await start();
    const answer = await lookupRequest(path);
    expectRefusal(answer, LOOKUP_REFUSALS.unlisted);
    expect(resolved).toEqual([]);
    expect(connected).toEqual([]);
    expect(docsSeen).toEqual([]);
  });

  it("refuses a path past 2,000 characters with 400 (D-472)", async () => {
    const { resolved } = await start();
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/${"a".repeat(2_000)}`);
    expectRefusal(answer, LOOKUP_REFUSALS.malformed);
    expect(resolved).toEqual([]);
  });

  it.each([
    ["a private address", "private-docs.example.com"],
    ["an answer with one private address", "mixed-docs.example.com"],
  ])(
    "refuses a listed host that resolves to %s with 403, connecting nowhere",
    async (_label, host) => {
      const { connected, resolved } = await start();
      const answer = await lookupRequest(`/lookup/${host}/guide`);
      expectRefusal(answer, LOOKUP_REFUSALS.blocked);
      expect(resolved).toEqual([host]);
      expect(connected).toEqual([]);
    },
  );

  it("answers 502 for a listed host that does not resolve", async () => {
    const { connected } = await start();
    const answer = await lookupRequest("/lookup/missing-docs.example.com/guide");
    expectRefusal(answer, LOOKUP_REFUSALS.unreachable);
    expect(connected).toEqual([]);
  });

  it("checks the certificate against the host's name, and trusts only the system's authorities in production", async () => {
    const { connected } = await start();
    const wrongName = await lookupRequest("/lookup/wrong-name.example.com/guide");
    expectRefusal(wrongName, LOOKUP_REFUSALS.unreachable);
    expect(connected).toEqual([`${DOCS_ADDRESS}:443`]);
    expect(docsSeen).toEqual([]);
    await harness?.service.stop();
    harness = undefined;

    await start({ trustTestCa: false });
    const untrusted = await lookupRequest(`/lookup/${DOCS_HOST}/guide`);
    expectRefusal(untrusted, LOOKUP_REFUSALS.unreachable);
    expect(docsSeen).toEqual([]);
  });

  it("answers 504 when the site does not answer in time", async () => {
    const { logs } = await start({ lookupTimeoutMs: 200 });
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/slow`);
    expectRefusal(answer, LOOKUP_REFUSALS.timeout);
    await vi.waitFor(() =>
      expect(lookupLines(logs)).toContainEqual(
        expect.objectContaining({ message: "lookup request", outcome: "timeout" }),
      ),
    );
  });

  it("stops the body short when the site stalls past the deadline", async () => {
    const { logs } = await start({ lookupTimeoutMs: 300 });
    const answer = await lookupRequest(`/lookup/${DOCS_HOST}/stall`);
    expect(answer.status).toBe(200);
    expect(answer.aborted).toBe(true);
    expect(answer.body.toString()).toBe("<html><body>part");
    await vi.waitFor(() =>
      expect(lookupLines(logs)).toContainEqual(
        expect.objectContaining({ outcome: "timeout", status: 200, bytes: 16 }),
      ),
    );
  });

  it("refuses lookups past the run's ceiling with 403, counting every forwarded lookup and no refusal", async () => {
    const { logs } = await start({ maxLookupRequests: 3 });
    // Refused before any lookup is sent: not counted.
    expect((await lookupRequest("/lookup/unlisted.example.com/x")).status).toBe(403);
    expect(
      (await lookupRequest(`/lookup/${DOCS_HOST}/x`, { method: "POST" })).status,
    ).toBe(405);
    // Forwarded, whatever happened next: counted.
    expect((await lookupRequest(`/lookup/${DOCS_HOST}/missing`)).status).toBe(404);
    expect((await lookupRequest("/lookup/private-docs.example.com/x")).status).toBe(
      403,
    );
    expect((await lookupRequest(`/lookup/${DOCS_HOST}/guide`)).status).toBe(200);
    const past = await lookupRequest(`/lookup/${DOCS_HOST}/guide`);
    expectRefusal(past, LOOKUP_REFUSALS.ceiling);
    expect(docsSeen).toHaveLength(2);
    expect(lookupLines(logs)).toContainEqual(
      expect.objectContaining({
        message: "lookup refused",
        reason: "lookup ceiling",
        maxLookupRequests: 3,
      }),
    );
  });

  it("does not share a ceiling with model requests", async () => {
    await start({ maxModelRequests: 1, maxLookupRequests: 1 });
    expect((await lookupRequest(`/lookup/${DOCS_HOST}/guide`)).status).toBe(200);
    const model = await fetch(proxyUrl("/anthropic/v1/messages"), {
      method: "POST",
      body: "{}",
    });
    expect(model.status).toBe(200);
  });

  it("is off when LOOKUP_HOSTS is empty: every lookup gets 403 as off the list, and nothing is resolved", async () => {
    const { resolved, connected, logs } = await start({ lookupHosts: "" });
    expectRefusal(
      await lookupRequest(`/lookup/${DOCS_HOST}/guide`),
      LOOKUP_REFUSALS.unlisted,
    );
    expectRefusal(
      await lookupRequest(`/lookup/${DOCS_HOST}/guide`, { method: "POST", body: "{}" }),
      LOOKUP_REFUSALS.unlisted,
    );
    expectRefusal(await lookupRequest("/lookup"), LOOKUP_REFUSALS.unlisted);
    expect(resolved).toEqual([]);
    expect(connected).toEqual([]);
    expect(docsSeen).toEqual([]);
    expect(lookupLines(logs)).toContainEqual(
      expect.objectContaining({ reason: "lookup route off", host: DOCS_HOST }),
    );
  });

  it("is off when no list is given, as for a proxy started before the route existed", async () => {
    const logs: string[] = [];
    const proxy = createEgressProxy({
      runId: RUN_ID,
      allowedHosts: new Set(),
      providers: [],
      credentials: new Map(),
      maxModelRequests: 1,
      maxRejectedModelRequests: 1,
      logger: createLogger("egress-proxy", (line) => logs.push(line)),
      resolve: () => Promise.reject(new Error("never resolved")),
    });
    const service = await startService({
      name: "egress-proxy",
      port: 0,
      logger: createLogger("egress-proxy", () => {}),
      handle: proxy.handle,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${service.port}/lookup/${DOCS_HOST}/guide`,
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(LOOKUP_REFUSALS.unlisted.text);
      expect(logs.join("\n")).toContain('"reason":"lookup route off"');
    } finally {
      await service.stop();
    }
  });

  it("stops the lookup when the agent goes away", async () => {
    const { logs } = await start();
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: harness?.service.port,
        path: `/lookup/${DOCS_HOST}/slow`,
        agent: false,
      });
      request.on("error", () => resolve());
      request.on("response", () => reject(new Error("answered")));
      request.end();
      void vi
        .waitFor(() => expect(docsSeen).toHaveLength(1))
        .then(() => request.destroy());
    });
    await vi.waitFor(() =>
      expect(lookupLines(logs)).toContainEqual(
        expect.objectContaining({
          message: "lookup request",
          outcome: "client closed",
        }),
      ),
    );
  });

  it("logs the host, status, outcome, bytes, duration and count, and refusals with the host and reason: never a path, query, header value or body", async () => {
    const { logs } = await start();
    const secretPath = `/${PATH_MARKER}/guide?q=${QUERY_MARKER}&token=${AGENT_KEY}`;
    await lookupRequest(`/lookup/${DOCS_HOST}${secretPath}`, {
      headers: AGENT_HEADERS,
    });
    await lookupRequest(`/lookup/unlisted.example.com${secretPath}`, {
      headers: AGENT_HEADERS,
    });
    await lookupRequest(`/lookup/${PATH_MARKER}:443${secretPath}`);
    await lookupRequest(`/lookup/${DOCS_HOST}${secretPath}`, {
      method: "POST",
      headers: AGENT_HEADERS,
      body: BODY_MARKER,
    });
    await lookupRequest(`/lookup/private-docs.example.com${secretPath}`);
    await lookupRequest(`/lookup/${DOCS_HOST}${secretPath}#${PATH_MARKER}`);
    await vi.waitFor(() =>
      expect(
        lookupLines(logs).filter((e) => e.message === "lookup request"),
      ).toHaveLength(2),
    );

    const text = logs.join("\n");
    for (const marker of [
      PATH_MARKER,
      QUERY_MARKER,
      AGENT_KEY,
      COOKIE_MARKER,
      BODY_MARKER,
    ]) {
      expect(text).not.toContain(marker);
    }
    expect(text).not.toContain("guide");
    expect(text).not.toContain("agent-user-agent");
    const lines = lookupLines(logs);
    const served = lines.find((e) => e.outcome === "ok");
    expect(served).toMatchObject({
      message: "lookup request",
      runId: RUN_ID,
      host: DOCS_HOST,
      status: 200,
      bytes: Buffer.byteLength(PAGE),
      count: 1,
    });
    expect(Object.keys(served ?? {}).sort()).toEqual([
      "bytes",
      "count",
      "durationMs",
      "host",
      "level",
      "message",
      "outcome",
      "runId",
      "service",
      "status",
      "time",
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: "lookup refused",
        host: "unlisted.example.com",
        reason: "host not listed",
      }),
    );
    // A malformed host is never logged: only that it was malformed.
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: "lookup refused",
        reason: "invalid host name",
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: "lookup refused",
        host: DOCS_HOST,
        reason: "method not allowed",
        method: "POST",
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: "lookup request",
        host: "private-docs.example.com",
        outcome: "blocked address",
        count: 2,
      }),
    );
  });

  it("leaves the tunnels and the state API route as they were", async () => {
    const { service } = await start();
    const { status, socket } = await connectThrough(service.port, `${DOCS_HOST}:443`);
    socket.destroy();
    // A lookup host is not a CONNECT host.
    expect(status).toBe(403);
    const state = await fetch(proxyUrl("/state-api/v1/runs"));
    expect(state.status).toBe(200);
  });
});
