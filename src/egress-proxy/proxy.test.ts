import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "../service-kit/logger.ts";
import { startService, type RunningService } from "../service-kit/server.ts";
import { parseAllowedHosts } from "./hosts.ts";
import { parseProviders } from "./providers.ts";
import { CEILING_MESSAGE, createEgressProxy, type EgressProxy } from "./proxy.ts";

// Integration: the proxy over real sockets on localhost. No real DNS and no real network: the
// resolver is a fake, the vetted public address is mapped to a local TCP server by the connect
// seam, and the model upstream is a local https server with a certificate made for this test.

const RUN_ID = "run_test_1";
const PROVIDER_KEY = "provider-key-value-0123456789";
const AGENT_KEY = "agent-placeholder-key-987654";
const BODY_MARKER = "BODY-MARKER-must-not-be-logged";
const GITHUB_ADDRESS = "140.82.112.3";

const DNS: Record<string, string[]> = {
  "github.com": [GITHUB_ADDRESS],
  "metadata.example.com": ["169.254.169.254"],
  "mixed.example.com": [GITHUB_ADDRESS, "10.0.0.7"],
  "private6.example.com": ["fd00:ec2::254"],
  "mapped.example.com": ["::ffff:10.0.0.1"],
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
      "subjectAltName=IP:127.0.0.1",
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
});

afterAll(async () => {
  await new Promise((resolve) => tunnelTarget.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
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
});

async function start(
  overrides: {
    maxModelRequests?: number;
    trustTestCa?: boolean;
    dns?: Record<string, string[]>[];
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
      "github.com,metadata.example.com,mixed.example.com,private6.example.com,mapped.example.com,missing.example.com,rebind.example.com",
    ),
    providers: parseProviders(
      JSON.stringify([
        {
          name: "anthropic",
          upstream: `https://127.0.0.1:${upstreamPort}`,
          credential: "x-api-key",
          secretPath: "projects/test/models/anthropic",
        },
        {
          name: "openai",
          upstream: `https://127.0.0.1:${upstreamPort}/v1`,
          credential: "bearer",
          secretPath: "projects/test/models/openai",
        },
      ]),
    ),
    credentials: new Map([
      ["anthropic", PROVIDER_KEY],
      ["openai", PROVIDER_KEY],
    ]),
    maxModelRequests: overrides.maxModelRequests ?? 100,
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
    expect(seen.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
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

  it("trusts only the system's authorities when no test authority is given", async () => {
    await start({ trustTestCa: false });
    const response = await fetch(proxyUrl("/anthropic/v1/messages"), {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(upstreamSeen).toEqual([]);
  });

  it("refuses model requests past the ceiling with 429", async () => {
    const { logs } = await start({ maxModelRequests: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(proxyUrl("/anthropic/v1/messages"), {
        method: "POST",
        body: "{}",
      });
      statuses.push(response.status);
      if (response.status === 429)
        expect(await response.json()).toEqual({ error: CEILING_MESSAGE });
      else await response.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(upstreamSeen).toHaveLength(2);
    expect(logs.join("\n")).toContain('"reason":"request ceiling"');
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
