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

const DNS: Record<string, string[]> = {
  "github.com": [GITHUB_ADDRESS],
  "metadata.example.com": ["169.254.169.254"],
  "mixed.example.com": [GITHUB_ADDRESS, "10.0.0.7"],
  "private6.example.com": ["fd00:ec2::254"],
  "mapped.example.com": ["::ffff:10.0.0.1"],
  [MODEL_HOST]: [MODEL_ADDRESS],
  "private-model.example.com": ["10.0.0.9"],
  [STATE_HOST]: ["127.0.0.1"],
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

function recordingServer(seen: () => Seen[]): HttpServer {
  return createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen().push({
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
      `subjectAltName=DNS:${MODEL_HOST},IP:127.0.0.1`,
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
});

afterAll(async () => {
  await new Promise((resolve) => tunnelTarget.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => stateApi.close(resolve));
  await new Promise((resolve) => otherService.close(resolve));
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
});

async function start(
  overrides: {
    maxModelRequests?: number;
    maxRejectedModelRequests?: number;
    trustTestCa?: boolean;
    dns?: Record<string, string[]>[];
    stateApi?: boolean;
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
