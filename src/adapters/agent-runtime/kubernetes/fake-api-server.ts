// A fake Kubernetes API server for the run watcher's tests (D-330, O-102): HTTPS on localhost with
// a certificate made for the test, answering the Jobs list and watch of an agent namespace as the
// API server does. Jobs carry a uid and a resource version; a watch from a version gets every
// change after it, then each new one; a version older than an expiry gets the 410 a real server
// gives. The test can cut, end or expire open watches and fail lists. No cluster, no network.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobStatus, Labels } from "./objects.ts";

export interface FakeApiRequest {
  method: string;
  namespace: string;
  query: URLSearchParams;
  authorization: string | undefined;
}

type EventType = "ADDED" | "MODIFIED" | "DELETED";

interface Watch {
  namespace: string;
  selector: string;
  response: ServerResponse;
}

export interface FakeKubernetesApi {
  url: URL;
  /** The test certificate, the only CA the client should trust. */
  ca: string;
  /** The token the fake accepts. Made up for the test. */
  token: string;
  readonly requests: FakeApiRequest[];
  /** Adds or changes a Job (in its own namespace) and tells every open watch that selects it. */
  put(job: JobStatus): JobStatus;
  /** Deletes a Job and tells every open watch that selects it. */
  remove(namespace: string, name: string): void;
  /** Sends a bookmark at the current version to every open watch of the namespace. */
  bookmark(namespace: string): void;
  /**
   * Makes every version so far too old in the namespace. Open watches get the ERROR event with
   * code 410; a watch from an older version is answered the same way, or with HTTP 410 when
   * `asStatus` is set.
   */
  expire(namespace: string, asStatus?: boolean): void;
  /** Cuts every open watch of the namespace in the middle of its stream. */
  drop(namespace: string): void;
  /** Ends every open watch of the namespace cleanly, as at its time limit. */
  end(namespace: string): void;
  /** Answers every list in the namespace with this status while set; null to stop. */
  failLists(namespace: string, status: number | null): void;
  openWatches(namespace: string): number;
  calls(namespace: string, kind: "list" | "watch"): number;
  stop(): Promise<void>;
}

/** Kubernetes label selector semantics for the forms the watcher sends: `k=v` and `k in (a,b)`. */
export function selects(selector: string, labels: Labels): boolean {
  const terms = selector.match(/[^,()]+(?:\([^)]*\))?/g) ?? [];
  return terms.every((raw) => {
    const term = raw.trim();
    const set = /^(\S+) in \(([^)]*)\)$/.exec(term);
    if (set) {
      const values = (set[2] ?? "").split(",").map((v) => v.trim());
      return values.includes(labels[set[1] ?? ""] ?? "\u0000");
    }
    const equal = /^([^=]+)=(.*)$/.exec(term);
    if (equal) return labels[equal[1] ?? ""] === equal[2];
    throw new Error(`the fake API server cannot read the selector term ${term}`);
  });
}

export async function startFakeKubernetesApi(): Promise<FakeKubernetesApi> {
  const dir = mkdtempSync(join(tmpdir(), "fake-kubernetes-api-"));
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
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const ca = readFileSync(join(dir, "cert.pem"), "utf8");
  const key = readFileSync(join(dir, "key.pem"), "utf8");
  rmSync(dir, { recursive: true, force: true });

  const token = "fake-watcher-token-not-real-0123456789";
  const requests: FakeApiRequest[] = [];
  let version = 1000;
  let uids = 0;
  const jobs = new Map<string, Map<string, JobStatus>>();
  const history: {
    namespace: string;
    version: number;
    type: EventType;
    object: JobStatus;
  }[] = [];
  const expiredBefore = new Map<string, { version: number; asStatus: boolean }>();
  const failingLists = new Map<string, number>();
  const watches = new Set<Watch>();

  const jobsOf = (namespace: string): Map<string, JobStatus> => {
    let found = jobs.get(namespace);
    if (!found) {
      found = new Map();
      jobs.set(namespace, found);
    }
    return found;
  };
  const labelsOf = (job: JobStatus): Labels => job.metadata.labels ?? {};
  const line = (event: unknown): string => `${JSON.stringify(event)}\n`;

  function send(namespace: string, type: EventType, object: JobStatus): void {
    history.push({ namespace, version, type, object });
    for (const watch of watches) {
      if (watch.namespace === namespace && selects(watch.selector, labelsOf(object))) {
        watch.response.write(line({ type, object }));
      }
    }
  }

  const status = (code: number, reason: string) => ({
    kind: "Status",
    apiVersion: "v1",
    status: "Failure",
    code,
    reason,
    message: `fake ${reason}`,
  });

  const server: Server = createServer({ cert: ca, key }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://127.0.0.1");
    const match = /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs$/.exec(url.pathname);
    const namespace = match?.[1] ?? "";
    const watching = url.searchParams.get("watch") === "true";
    requests.push({
      method: request.method ?? "",
      namespace,
      query: url.searchParams,
      authorization: request.headers.authorization,
    });
    const answer = (code: number, body: unknown) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      answer(401, status(401, "Unauthorized"));
      return;
    }
    if (request.method !== "GET" || !match) {
      answer(404, status(404, "NotFound"));
      return;
    }
    const selector = url.searchParams.get("labelSelector") ?? "";
    if (!watching) {
      const failing = failingLists.get(namespace);
      if (failing !== undefined) {
        answer(failing, status(failing, "Forbidden"));
        return;
      }
      answer(200, {
        kind: "JobList",
        apiVersion: "batch/v1",
        metadata: { resourceVersion: String(version) },
        items: [...jobsOf(namespace).values()].filter((job) =>
          selects(selector, labelsOf(job)),
        ),
      });
      return;
    }
    const from = Number(url.searchParams.get("resourceVersion"));
    const expiry = expiredBefore.get(namespace);
    if (expiry !== undefined && from < expiry.version) {
      if (expiry.asStatus) {
        answer(410, status(410, "Gone"));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(line({ type: "ERROR", object: status(410, "Expired") }));
      return;
    }
    // A real API server sends the answer's head at once, before any event.
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    for (const event of history) {
      if (
        event.namespace === namespace &&
        event.version > from &&
        selects(selector, labelsOf(event.object))
      ) {
        response.write(line({ type: event.type, object: event.object }));
      }
    }
    const watch: Watch = { namespace, selector, response };
    watches.add(watch);
    response.on("close", () => watches.delete(watch));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const openOf = (namespace: string) =>
    [...watches].filter((watch) => watch.namespace === namespace);

  return {
    url: new URL(`https://127.0.0.1:${port}`),
    ca,
    token,
    requests,
    put(job) {
      const namespace = job.metadata.namespace ?? "";
      const known = jobsOf(namespace).get(job.metadata.name);
      version += 1;
      const object: JobStatus = structuredClone({
        ...job,
        metadata: {
          ...job.metadata,
          uid: known?.metadata.uid ?? `uid-${(uids += 1)}`,
          resourceVersion: String(version),
        },
      });
      jobsOf(namespace).set(job.metadata.name, object);
      send(namespace, known ? "MODIFIED" : "ADDED", object);
      return object;
    },
    remove(namespace, name) {
      const known = jobsOf(namespace).get(name);
      if (!known) return;
      jobsOf(namespace).delete(name);
      version += 1;
      send(namespace, "DELETED", {
        ...known,
        metadata: { ...known.metadata, resourceVersion: String(version) },
      });
    },
    bookmark(namespace) {
      for (const watch of openOf(namespace)) {
        watch.response.write(
          line({
            type: "BOOKMARK",
            object: {
              kind: "Job",
              apiVersion: "batch/v1",
              metadata: { resourceVersion: String(version) },
            },
          }),
        );
      }
    },
    expire(namespace, asStatus = false) {
      version += 1;
      expiredBefore.set(namespace, { version, asStatus });
      for (const watch of openOf(namespace)) {
        watch.response.end(line({ type: "ERROR", object: status(410, "Expired") }));
      }
    },
    drop(namespace) {
      for (const watch of openOf(namespace)) watch.response.socket?.destroy();
    },
    end(namespace) {
      for (const watch of openOf(namespace)) watch.response.end();
    },
    failLists(namespace, code) {
      if (code === null) failingLists.delete(namespace);
      else failingLists.set(namespace, code);
    },
    openWatches: (namespace) => openOf(namespace).length,
    calls: (namespace, kind) =>
      requests.filter(
        (r) =>
          r.namespace === namespace &&
          (r.query.get("watch") === "true") === (kind === "watch"),
      ).length,
    stop: async () => {
      for (const watch of watches) watch.response.socket?.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
