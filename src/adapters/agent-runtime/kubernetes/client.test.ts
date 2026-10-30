import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  KubernetesApiError,
  createKubernetesClient,
  type KubernetesClient,
} from "./client.ts";
import { DEVELOPER, SETTINGS, credentialsFor } from "./fixtures.ts";
import { agentStage, runSecrets } from "./manifests.ts";

// Integration: the HTTPS client against a local TLS server that stands in for the API server. No
// cluster and no outside network. The server answers from a small table and records requests.

const TOKEN = "runner-token-not-real-0123456789";
const NS = "agents-rehearsal";

let dir: string;
let cert: string;
let otherCert: string;
let server: Server;
let port: number;
let seen: { method?: string; url?: string; authorization?: string; body: string }[] =
  [];
let answer: (
  method: string,
  url: string,
) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kube-client-test-"));
  for (const name of ["server", "other"]) {
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
        join(dir, `${name}-key.pem`),
        "-out",
        join(dir, `${name}.pem`),
      ],
      { stdio: "ignore" },
    );
  }
  cert = readFileSync(join(dir, "server.pem"), "utf8");
  otherCert = readFileSync(join(dir, "other.pem"), "utf8");
  const key = readFileSync(join(dir, "server-key.pem"), "utf8");
  server = createServer({ cert, key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const { status, body } = answer(request.method ?? "", request.url ?? "");
      response.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain" : "application/json",
      });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

let client: KubernetesClient;
beforeEach(() => {
  seen = [];
  answer = () => ({ status: 200, body: {} });
  client = createKubernetesClient({
    server: `https://127.0.0.1:${port}`,
    token: TOKEN,
    ca: cert,
  });
});

describe("Kubernetes client (integration: local TLS server, ADR 0106 section 1)", () => {
  it("creates a Service at its namespaced path with the bearer token, and returns its IP", async () => {
    answer = () => ({ status: 201, body: { spec: { clusterIP: "10.245.0.7" } } });
    const { proxyService } = agentStage(
      DEVELOPER,
      { maxTurns: 1, maxMinutes: 1, maxUsd: 1 },
      SETTINGS,
    );
    expect(await client.create(proxyService)).toEqual({
      name: proxyService.metadata.name,
      clusterIP: "10.245.0.7",
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: `/api/v1/namespaces/${NS}/services`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual(proxyService);
  });

  it("never hands back a created Secret's data", async () => {
    const [secret] = runSecrets(DEVELOPER, credentialsFor(DEVELOPER));
    answer = () => ({ status: 201, body: secret });
    const createdSecret = await client.create(secret!);
    expect(createdSecret).toEqual({ name: secret!.metadata.name });
  });

  it("uses each kind's API group", async () => {
    answer = () => ({ status: 201, body: {} });
    const stage = agentStage(
      DEVELOPER,
      { maxTurns: 1, maxMinutes: 1, maxUsd: 1 },
      SETTINGS,
    );
    await client.create(stage.proxyJob);
    await client.create(stage.policies[0]);
    expect(seen.map((s) => s.url)).toEqual([
      `/apis/batch/v1/namespaces/${NS}/jobs`,
      `/apis/networking.k8s.io/v1/namespaces/${NS}/networkpolicies`,
    ]);
  });

  it("deletes with a propagation policy and grace period, and reads 404 as already gone", async () => {
    answer = (method) =>
      method === "DELETE" ? { status: 404, body: {} } : { status: 200, body: {} };
    expect(
      await client.delete("Job", NS, "run-x-agent", {
        propagationPolicy: "Foreground",
        gracePeriodSeconds: 30,
      }),
    ).toBe(false);
    expect(seen[0]?.url).toBe(`/apis/batch/v1/namespaces/${NS}/jobs/run-x-agent`);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
      gracePeriodSeconds: 30,
    });
  });

  it("lists by label selector, reads a Job and a pod log", async () => {
    answer = (_method, url) => {
      if (url.includes("/log?")) return { status: 200, body: "line one\n" };
      if (url.includes("/pods?"))
        return { status: 200, body: { items: [{ metadata: { name: "p" } }] } };
      if (url.endsWith("/jobs/missing")) return { status: 404, body: {} };
      return { status: 200, body: { metadata: { name: "run-x-agent" } } };
    };
    expect(
      await client.listPods(NS, {
        "foreman/run-id": "x",
        "foreman/component": "agent",
      }),
    ).toEqual([{ metadata: { name: "p" } }]);
    expect(seen[0]?.url).toBe(
      `/api/v1/namespaces/${NS}/pods?labelSelector=${encodeURIComponent("foreman/run-id=x,foreman/component=agent")}`,
    );
    expect(await client.getJob(NS, "missing")).toBeNull();
    expect(await client.getJob(NS, "run-x-agent")).toEqual({
      metadata: { name: "run-x-agent" },
    });
    expect(
      await client.readPodLog(NS, "p", {
        container: "agent",
        tailLines: 50,
        limitBytes: 1024,
      }),
    ).toBe("line one\n");
    expect(seen.at(-1)?.url).toBe(
      `/api/v1/namespaces/${NS}/pods/p/log?container=agent&tailLines=50&limitBytes=1024`,
    );
  });

  it("refuses any namespace that is not agents-<slug>, before any request", async () => {
    for (const namespace of [
      "kube-system",
      "foreman-platform",
      "default",
      "agents-",
      "agents-x/../y",
    ]) {
      await expect(client.getJob(namespace, "a")).rejects.toThrow(/agents-<slug>/);
      await expect(client.delete("Secret", namespace, "a")).rejects.toThrow(
        /agents-<slug>/,
      );
    }
    expect(seen).toEqual([]);
  });

  it("refuses names and selectors that could change the path", async () => {
    await expect(client.getJob(NS, "../../secrets/x")).rejects.toThrow(/name/);
    await expect(client.listJobs(NS, { "foreman/run-id": "x,y=z" })).rejects.toThrow(
      /selector/,
    );
    await expect(client.listJobs(NS, {})).rejects.toThrow(/selector/);
    expect(seen).toEqual([]);
  });

  it("reports a failure by status and reason, never the body or the token", async () => {
    answer = () => ({
      status: 403,
      body: {
        kind: "Status",
        reason: "Forbidden",
        message: `token ${TOKEN} cannot do this`,
      },
    });
    const error = await client.getJob(NS, "a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesApiError);
    expect((error as KubernetesApiError).status).toBe(403);
    expect((error as KubernetesApiError).reason).toBe("Forbidden");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("trusts only the given CA", async () => {
    const untrusting = createKubernetesClient({
      server: `https://127.0.0.1:${port}`,
      token: TOKEN,
      ca: otherCert,
    });
    await expect(untrusting.getJob(NS, "a")).rejects.toBeInstanceOf(KubernetesApiError);
    expect(seen).toEqual([]);
  });

  it("refuses an API server address that is not plain https://host[:port]", () => {
    for (const address of [
      "http://127.0.0.1:6443",
      "https://127.0.0.1:6443/api",
      "https://h/?x=1",
    ]) {
      expect(() =>
        createKubernetesClient({ server: address, token: TOKEN, ca: cert }),
      ).toThrow(/https:\/\/host/);
    }
  });
});
