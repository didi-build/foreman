// Integration: the Windmill start client over real sockets on localhost (O-101). The client goes
// through the real egress proxy (src/egress-proxy/), configured as the shared Windmill proxy is
// (D-328): Windmill's host only, no provider, no state API route, no credential. Behind it a local
// https server with a certificate made for this test stands in for Windmill. No real DNS and no
// network: the proxy's resolver is a fake and its connect seam maps the vetted public address to
// the local server. No real Windmill token: a random test value, never logged or asserted on.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAllowedHosts } from "../../egress-proxy/hosts.ts";
import { createEgressProxy } from "../../egress-proxy/proxy.ts";
import { ConfigError, readConfig } from "../../service-kit/config.ts";
import { createLogger } from "../../service-kit/logger.ts";
import { startService, type RunningService } from "../../service-kit/server.ts";
import {
  NotBuiltError,
  RUN_BY_PATH_ENDPOINT,
  WindmillStartError,
  runByPath,
  runScope,
  startErrorFields,
  windmillScripts,
  windmillSettings,
  windmillTargetOf,
  type WindmillTarget,
} from "./client.ts";
import {
  PLAN_APPROVAL_FLOW_PATH,
  windmillPlanApprovalFlow,
} from "./plan-approval-flow.ts";
import {
  DEPLOY_STAGING_FLOW_PATH,
  INGEST_DELIVERY_FLOW_PATH,
  RECEIVER_FLOW_PATHS,
  REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH,
  windmillReceiverFlows,
} from "./receiver-flows.ts";
import {
  RECORD_RUN_END_FLOW_PATH,
  RUN_WATCHER_FLOW_PATHS,
  windmillRunEndFlow,
} from "./run-watcher-flows.ts";

const WINDMILL_HOST = "windmill.example.com";
/** The public address the proxy's fake resolver gives Windmill's host. */
const WINDMILL_ADDRESS = "34.120.0.20";
const WORKSPACE = "rehearsal";
/** A workspace the fake Windmill refuses, as a token without the scope would be. */
const REFUSED_WORKSPACE = "refused";
/** A workspace the fake Windmill never answers. */
const SILENT_WORKSPACE = "silent";
const TOKEN = randomBytes(24).toString("base64url");
const BODY_MARKER = "job-body-must-never-be-read";

interface Seen {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  servername: string | false | null | undefined;
  body: unknown;
}

let certDir: string;
let cert: string;
let windmill: Server;
let windmillPort: number;
const seen: Seen[] = [];
let proxyService: RunningService;
let proxyUrl: URL;
const proxyLogs: string[] = [];
const connected: string[] = [];

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "windmill-client-test-"));
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
      `/CN=${WINDMILL_HOST}`,
      "-addext",
      `subjectAltName=DNS:${WINDMILL_HOST}`,
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(certDir, "cert.pem"), "utf8");
  const key = readFileSync(join(certDir, "key.pem"), "utf8");

  windmill = createHttpsServer({ cert, key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        servername: (request.socket as TLSSocket).servername,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      if (request.url?.startsWith(`/api/w/${SILENT_WORKSPACE}/`)) return;
      if (request.url?.startsWith(`/api/w/${REFUSED_WORKSPACE}/`)) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end(`${BODY_MARKER} ${TOKEN}`);
        return;
      }
      // Windmill answers a start with the new job's id.
      response.writeHead(201, { "content-type": "text/plain" });
      response.end(BODY_MARKER);
    });
  });
  await new Promise<void>((resolve) => windmill.listen(0, "127.0.0.1", resolve));
  windmillPort = (windmill.address() as AddressInfo).port;

  // The shared Windmill proxy's configuration (infra/kubernetes/platform.ts).
  const logger = createLogger("egress-proxy", (line) => proxyLogs.push(line));
  const proxy = createEgressProxy({
    runId: "windmill-proxy",
    allowedHosts: parseAllowedHosts(WINDMILL_HOST),
    providers: [],
    credentials: new Map(),
    maxModelRequests: 1,
    maxRejectedModelRequests: 1,
    logger,
    resolve: async (host) => {
      if (host === WINDMILL_HOST) return [WINDMILL_ADDRESS];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    },
    connect: (address, port) => {
      connected.push(`${address}:${port}`);
      if (address !== WINDMILL_ADDRESS) throw new Error("unexpected connect");
      return netConnect(windmillPort, "127.0.0.1");
    },
  });
  proxyService = await startService({
    name: "egress-proxy",
    port: 0,
    logger,
    handle: proxy.handle,
    onConnect: proxy.onConnect,
  });
  proxyUrl = new URL(`http://127.0.0.1:${proxyService.port}`);
});

afterAll(async () => {
  await proxyService.stop();
  windmill.closeAllConnections();
  await new Promise((resolve) => windmill.close(resolve));
  rmSync(certDir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  connected.length = 0;
});

const target = (extra: Partial<WindmillTarget> = {}): WindmillTarget => ({
  host: WINDMILL_HOST,
  workspace: WORKSPACE,
  proxy: proxyUrl,
  ...extra,
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function failure(start: Promise<void>): Promise<WindmillStartError> {
  const error = await start.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WindmillStartError);
  return error as WindmillStartError;
}

/** Nothing the client reports may carry the token or Windmill's answer. */
function expectNoSecret(error: WindmillStartError): void {
  const text = `${error.message} ${JSON.stringify(error)} ${JSON.stringify(startErrorFields(error))}`;
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(BODY_MARKER);
}

describe("the Windmill start client through the shared proxy (integration: localhost, O-101)", () => {
  it("starts a script by its path: POST to the run endpoint, the bearer token, the entry's input, through a tunnel to Windmill's host only", async () => {
    const scripts = windmillScripts({ target: target(), token: TOKEN, ca: cert });
    await scripts.start("f/foreman/option_capture", { input: { nodeId: "node-1" } });
    expect(seen).toEqual([
      {
        method: "POST",
        path: `/api/w/${WORKSPACE}/jobs/run/p/f/foreman/option_capture`,
        authorization: `Bearer ${TOKEN}`,
        contentType: "application/json",
        // TLS inside the tunnel names Windmill's host, and the certificate is checked for it.
        servername: WINDMILL_HOST,
        body: { input: { nodeId: "node-1" } },
      },
    ]);
    // The proxy resolved the name itself and connected to the address it checked, on 443.
    expect(connected).toEqual([`${WINDMILL_ADDRESS}:443`]);
    // The proxy logs the tunnel's host once it closes, and never the token or the answer: it
    // never decrypts the tunnel.
    await vi.waitFor(() =>
      expect(proxyLogs.some((line) => line.includes("tunnel closed"))).toBe(true),
    );
    const logs = proxyLogs.join("\n");
    expect(logs).toContain(WINDMILL_HOST);
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(BODY_MARKER);
  });

  it("the state API's port starts only the plan-approval flow, with the idea's id", async () => {
    await windmillPlanApprovalFlow(TOKEN, target(), { ca: cert }).start("idea-1");
    expect(seen.map((s) => [s.path, s.body])).toEqual([
      [
        `/api/w/${WORKSPACE}/jobs/run/p/${PLAN_APPROVAL_FLOW_PATH}`,
        { input: { ideaId: "idea-1" } },
      ],
    ]);
  });

  it("the receiver's ports start the ingest flow with the handed-on delivery's identifiers, the staging deploy with the repository and CI run, and the access removal with the repository (O-114, O-116, O-128)", async () => {
    const flows = windmillReceiverFlows(TOKEN, target(), { ca: cert });
    const sha = "a".repeat(40);
    // Anything else the object carried is not sent: the port copies the six fields one by one.
    const handedOn = {
      deliveryId: "delivery-1",
      event: "check_suite" as const,
      action: "completed" as const,
      repo: "didi-build/rehearsal",
      pullRequests: [7, 9],
      headSha: sha,
      branch: "foreman/never-sent",
    };
    await flows.ingestDelivery.start(handedOn);
    await flows.deployStaging.start("didi-build/rehearsal", 4321);
    await flows.removeBootstrapAccess.start("didi-build/rehearsal");
    expect(seen.map((s) => [s.path, s.authorization, s.body])).toEqual([
      [
        `/api/w/${WORKSPACE}/jobs/run/p/${INGEST_DELIVERY_FLOW_PATH}`,
        `Bearer ${TOKEN}`,
        // flows/ingest-delivery.ts reads the handed-on delivery as its input.
        {
          input: {
            deliveryId: "delivery-1",
            event: "check_suite",
            action: "completed",
            repo: "didi-build/rehearsal",
            pullRequests: [7, 9],
            headSha: sha,
          },
        },
      ],
      [
        `/api/w/${WORKSPACE}/jobs/run/p/${DEPLOY_STAGING_FLOW_PATH}`,
        `Bearer ${TOKEN}`,
        // flows/deploy-staging.ts reads `{ repo, runId }` as its input.
        { input: { repo: "didi-build/rehearsal", runId: 4321 } },
      ],
      [
        `/api/w/${WORKSPACE}/jobs/run/p/${REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH}`,
        `Bearer ${TOKEN}`,
        { input: { repo: "didi-build/rehearsal" } },
      ],
    ]);
    expect(JSON.stringify(seen)).not.toContain("never-sent");
  });

  it("the run watcher's port starts only the run-end flow, with the run's id (D-330)", async () => {
    await windmillRunEndFlow(TOKEN, target(), { ca: cert }).start("run-1");
    expect(seen.map((s) => [s.path, s.authorization, s.body])).toEqual([
      [
        `/api/w/${WORKSPACE}/jobs/run/p/${RECORD_RUN_END_FLOW_PATH}`,
        `Bearer ${TOKEN}`,
        // flows/record-run-end.ts reads `{ runId }` as its input.
        { input: { runId: "run-1" } },
      ],
    ]);
    expect(connected).toEqual([`${WINDMILL_ADDRESS}:443`]);
  });

  it("a refused start names the start step and Windmill's status, never the token or the answer", async () => {
    const error = await failure(
      windmillScripts({
        target: target({ workspace: REFUSED_WORKSPACE }),
        token: TOKEN,
        ca: cert,
      }).start(INGEST_DELIVERY_FLOW_PATH, { input: { deliveryId: "delivery-3" } }),
    );
    expect([error.step, error.status]).toEqual(["start", 401]);
    expect(error.message).toBe(
      "Windmill did not accept the start at the start step (status 401)",
    );
    expect(startErrorFields(error)).toEqual({
      errorType: "WindmillStartError",
      step: "start",
      status: 401,
    });
    expectNoSecret(error);
  });

  it("the proxy refuses any host but Windmill's: the tunnel step with the proxy's 403, and nothing reaches Windmill", async () => {
    const error = await failure(
      windmillScripts({
        target: target({ host: "elsewhere.example.com" }),
        token: TOKEN,
        ca: cert,
      }).start(INGEST_DELIVERY_FLOW_PATH, { input: { deliveryId: "delivery-4" } }),
    );
    expect([error.step, error.status]).toEqual(["tunnel", 403]);
    expect(seen).toEqual([]);
    expect(connected).toEqual([]);
    expectNoSecret(error);
  });

  it("a proxy that cannot be reached names the tunnel step with no status", async () => {
    const proxy = new URL(`http://127.0.0.1:${await closedPort()}`);
    const error = await failure(
      windmillScripts({ target: target({ proxy }), token: TOKEN, ca: cert }).start(
        INGEST_DELIVERY_FLOW_PATH,
        { input: { deliveryId: "delivery-5" } },
      ),
    );
    expect([error.step, error.status]).toEqual(["tunnel", null]);
    expectNoSecret(error);
  });

  it("checks Windmill's certificate with the system's authorities: a certificate they do not trust is refused before anything is sent", async () => {
    const error = await failure(
      windmillScripts({ target: target(), token: TOKEN }).start(
        INGEST_DELIVERY_FLOW_PATH,
        { input: { deliveryId: "delivery-6" } },
      ),
    );
    expect([error.step, error.status]).toEqual(["start", null]);
    expect(seen).toEqual([]);
    expectNoSecret(error);
  });

  it("gives up on a Windmill that does not answer in time, at the start step", async () => {
    const error = await failure(
      windmillScripts({
        target: target({ workspace: SILENT_WORKSPACE }),
        token: TOKEN,
        ca: cert,
        timeoutMs: 300,
      }).start(INGEST_DELIVERY_FLOW_PATH, { input: { deliveryId: "delivery-7" } }),
    );
    expect([error.step, error.status]).toEqual(["start", null]);
    expectNoSecret(error);
  });

  it("refuses, with NotBuiltError and no call, while a service's token does not exist", async () => {
    const receiver = windmillReceiverFlows(null, target(), { ca: cert });
    for (const flow of [
      windmillPlanApprovalFlow(null, target(), { ca: cert }),
      receiver.removeBootstrapAccess,
      windmillRunEndFlow(null, target(), { ca: cert }),
    ]) {
      await expect(flow.start("id-1")).rejects.toBeInstanceOf(NotBuiltError);
    }
    await expect(
      receiver.deployStaging.start("didi-build/rehearsal", 4321),
    ).rejects.toBeInstanceOf(NotBuiltError);
    await expect(
      receiver.ingestDelivery.start({
        deliveryId: "delivery-1",
        event: "pull_request",
        action: "closed",
        repo: "didi-build/rehearsal",
        pullRequests: [7],
        headSha: null,
      }),
    ).rejects.toBeInstanceOf(NotBuiltError);
    expect(seen).toEqual([]);
    expect(connected).toEqual([]);
  });
});

describe("the Windmill start's settings and endpoint (unit, O-101)", () => {
  const PATH = "platform/test/windmill-token";
  const env = (extra: Record<string, string> = {}) => ({
    WINDMILL_HOST: WINDMILL_HOST,
    WINDMILL_WORKSPACE: WORKSPACE,
    HTTPS_PROXY: "http://windmill-proxy.foreman-platform.svc.cluster.local:8080",
    ...extra,
  });
  const problems = (values: Record<string, string>): readonly string[] => {
    try {
      readConfig(windmillSettings(PATH), values);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    return [];
  };

  it("reads the plain settings, and the token by its secret path, null while it is unset or empty", () => {
    const config = readConfig(windmillSettings(PATH), env());
    expect(config.windmillToken).toBeNull();
    expect(windmillTargetOf(config)).toEqual({
      host: WINDMILL_HOST,
      workspace: WORKSPACE,
      proxy: new URL("http://windmill-proxy.foreman-platform.svc.cluster.local:8080"),
    });
    expect(
      readConfig(
        windmillSettings(PATH),
        env({ SECRET_PLATFORM_TEST_WINDMILL_TOKEN: " " }),
      ).windmillToken,
    ).toBeNull();
    // A trailing newline from a piped Secret is not part of the token.
    expect(
      readConfig(
        windmillSettings(PATH),
        env({ SECRET_PLATFORM_TEST_WINDMILL_TOKEN: `${TOKEN}\n` }),
      ).windmillToken,
    ).toBe(TOKEN);
  });

  it("refuses a bad setting by its name, never its value", () => {
    const bad = `${TOKEN} two`;
    const found = problems(
      env({
        SECRET_PLATFORM_TEST_WINDMILL_TOKEN: bad,
        WINDMILL_HOST: "https://windmill.example.com/",
        WINDMILL_WORKSPACE: "a/b",
        HTTPS_PROXY: "http://user:secret@proxy:8080/path",
      }),
    );
    expect(found.map((p) => p.split(" ")[0])).toEqual([
      "SECRET_PLATFORM_TEST_WINDMILL_TOKEN",
      "WINDMILL_HOST",
      "WINDMILL_WORKSPACE",
      "HTTPS_PROXY",
    ]);
    expect(found.join(" ")).not.toContain(TOKEN);
    expect(found.join(" ")).not.toContain("secret@");
    expect(problems({})).toEqual([
      "WINDMILL_HOST is not set",
      "WINDMILL_WORKSPACE is not set",
      "HTTPS_PROXY is not set",
    ]);
  });

  it("builds the run endpoint from one constant, and refuses anything that is not a plain path", () => {
    expect(RUN_BY_PATH_ENDPOINT).toBe("/api/w/{workspace}/jobs/run/p/{path}");
    expect(runByPath("rehearsal", "f/foreman/plan_approval")).toBe(
      "/api/w/rehearsal/jobs/run/p/f/foreman/plan_approval",
    );
    for (const [workspace, path] of [
      ["rehearsal", "f/foreman/../admin"],
      ["rehearsal", "f/foreman/x?token=1"],
      ["rehearsal", "f/foreman"],
      ["rehearsal", "/f/foreman/x"],
      ["a/b", "f/foreman/x"],
    ] as const) {
      expect(() => runByPath(workspace, path)).toThrow(/not a Windmill workspace/);
    }
  });

  it("names one run scope per flow each token may start", () => {
    expect(runScope(PLAN_APPROVAL_FLOW_PATH)).toBe(
      "jobs:run:scripts:f/foreman/plan_approval",
    );
    // The receiver's token starts its three flows and nothing else (D-291, O-114, O-116, O-128):
    // `verify_staging` is gone with the `deployment_status` start, and option capture and the
    // advance run inside the ingest flow, so the token no longer starts them.
    expect(RECEIVER_FLOW_PATHS.map(runScope)).toEqual([
      "jobs:run:scripts:f/foreman/ingest_delivery",
      "jobs:run:scripts:f/foreman/deploy_staging",
      "jobs:run:scripts:f/foreman/remove_bootstrap_access",
    ]);
    // The run watcher's token starts the run-end flow and nothing else (D-330).
    expect(RUN_WATCHER_FLOW_PATHS.map(runScope)).toEqual([
      "jobs:run:scripts:f/foreman/record_run_end",
    ]);
  });
});
