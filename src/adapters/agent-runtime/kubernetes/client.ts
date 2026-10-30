// A small Kubernetes API client (ADR 0106 section 1): HTTPS to the API server with the runner's
// bearer token and the cluster's CA, Node built-ins only. Its operations are exactly what the
// runner's Role allows, in agent namespaces only: create and delete run objects, get and list
// Jobs, list Pods and read a pod's log. It cannot read a Secret back, list what the Role does not
// let it list, or touch anything cluster-wide. Errors carry the operation and HTTP status, never
// a request body, a response body or the token.
import { request as httpsRequest } from "node:https";

import type {
  Labels,
  JobStatus,
  PodStatus,
  RunObject,
  RunObjectKind,
} from "./objects.ts";

export interface CreateResult {
  name: string;
  /** For a Service: the ClusterIP the API server gave it. The agent's proxy address. */
  clusterIP?: string;
}

export interface DeleteOptions {
  gracePeriodSeconds?: number;
  propagationPolicy?: "Background" | "Foreground";
}

export interface LogOptions {
  container: string;
  tailLines: number;
  limitBytes: number;
}

export interface KubernetesClient {
  /** Create a run object in its namespace. Never returns a Secret's data. */
  create(object: RunObject): Promise<CreateResult>;
  /** Delete by name. Returns false if it was already gone. */
  delete(
    kind: RunObjectKind,
    namespace: string,
    name: string,
    options?: DeleteOptions,
  ): Promise<boolean>;
  /** A Job's metadata and status, or null if it does not exist. */
  getJob(namespace: string, name: string): Promise<JobStatus | null>;
  listJobs(namespace: string, selector: Labels): Promise<JobStatus[]>;
  listPods(namespace: string, selector: Labels): Promise<PodStatus[]>;
  /** The tail of a container's log, or null if the pod is gone. */
  readPodLog(
    namespace: string,
    pod: string,
    options: LogOptions,
  ): Promise<string | null>;
}

/** Each client operation and the Role verb it needs, for the RBAC test (ADR 0106 section 1). */
export const CLIENT_OPERATIONS: readonly {
  operation: keyof KubernetesClient;
  apiGroup: string;
  resource: string;
  verb: string;
}[] = [
  ...(["create", "delete"] as const).flatMap((verb) =>
    (
      [
        ["batch", "jobs"],
        ["", "secrets"],
        ["", "services"],
        ["networking.k8s.io", "networkpolicies"],
        ["", "persistentvolumeclaims"],
      ] as const
    ).map(([apiGroup, resource]) => ({ operation: verb, apiGroup, resource, verb })),
  ),
  { operation: "getJob", apiGroup: "batch", resource: "jobs", verb: "get" },
  { operation: "listJobs", apiGroup: "batch", resource: "jobs", verb: "list" },
  { operation: "listPods", apiGroup: "", resource: "pods", verb: "list" },
  { operation: "readPodLog", apiGroup: "", resource: "pods/log", verb: "get" },
];

export class KubernetesApiError extends Error {
  readonly status: number;
  /** The Status object's reason, such as `AlreadyExists` or `Forbidden`. */
  readonly reason: string;

  constructor(operation: string, status: number, reason: string) {
    super(`Kubernetes ${operation} failed with ${status} ${reason}`);
    this.name = "KubernetesApiError";
    this.status = status;
    this.reason = reason;
  }
}

const AGENT_NAMESPACE = /^agents-[a-z0-9](?:[a-z0-9-]{0,45}[a-z0-9])?$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL_KEY =
  /^(?:[a-z0-9.-]{1,253}\/)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/;

const PATHS: Record<RunObjectKind, { group: string; resource: string }> = {
  Job: { group: "/apis/batch/v1", resource: "jobs" },
  Secret: { group: "/api/v1", resource: "secrets" },
  Service: { group: "/api/v1", resource: "services" },
  NetworkPolicy: { group: "/apis/networking.k8s.io/v1", resource: "networkpolicies" },
  PersistentVolumeClaim: { group: "/api/v1", resource: "persistentvolumeclaims" },
};

/** Refuses anything outside an agent namespace before a request is made. */
export function checkNamespace(namespace: string | undefined): string {
  if (namespace === undefined || !AGENT_NAMESPACE.test(namespace)) {
    throw new Error("the runner works only in agents-<slug> namespaces");
  }
  return namespace;
}

export function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error("not a valid object name");
  return name;
}

export function labelSelector(selector: Labels): string {
  const parts = Object.entries(selector).map(([key, value]) => {
    if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) {
      throw new Error("not a valid label selector");
    }
    return `${key}=${value}`;
  });
  if (parts.length === 0) throw new Error("a label selector needs at least one label");
  return parts.join(",");
}

export interface KubernetesClientOptions {
  /** The API server's address, `https://host[:port]`. A plain setting (ADR 0106 section 1). */
  server: string;
  /** The runner's token, from `platform/agent-cluster/runner-token`. Never logged. */
  token: string;
  /** The cluster's CA certificate in PEM. Only it is trusted. */
  ca: string;
  timeoutMs?: number;
  /** Responses larger than this are refused. */
  maxResponseBytes?: number;
}

interface Response {
  status: number;
  body: Buffer;
}

export function createKubernetesClient(
  options: KubernetesClientOptions,
): KubernetesClient {
  const server = new URL(options.server);
  if (server.protocol !== "https:" || server.pathname !== "/" || server.search !== "") {
    throw new Error("the API server address must be https://host[:port]");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;

  function call(method: string, path: string, body?: unknown): Promise<Response> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: server.hostname.replace(/^\[|\]$/g, ""),
        port: server.port || 443,
        method,
        path,
        ca: options.ca,
        rejectUnauthorized: true,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : {}),
        },
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
        response.on("error", reject);
      });
      request.on("timeout", () => request.destroy(new Error("request timed out")));
      // Only the error's name or code: a message can name the host but never the token.
      request.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          new KubernetesApiError(`${method} request`, 0, error.code ?? error.name),
        ),
      );
      request.end(payload);
    });
  }

  function failure(operation: string, response: Response): KubernetesApiError {
    let reason = "Unknown";
    try {
      const status = JSON.parse(response.body.toString("utf8")) as { reason?: unknown };
      if (typeof status.reason === "string" && /^[A-Za-z]{1,64}$/.test(status.reason)) {
        reason = status.reason;
      }
    } catch {
      // Not a Status object. The body is never put in the error.
    }
    return new KubernetesApiError(operation, response.status, reason);
  }

  const collection = (kind: RunObjectKind, namespace: string): string => {
    const { group, resource } = PATHS[kind];
    return `${group}/namespaces/${checkNamespace(namespace)}/${resource}`;
  };

  function json<T>(response: Response): T {
    return JSON.parse(response.body.toString("utf8")) as T;
  }

  return {
    async create(object) {
      const operation = `create ${object.kind}`;
      const path = collection(object.kind, object.metadata.namespace ?? "");
      checkName(object.metadata.name);
      const response = await call("POST", path, object);
      if (response.status !== 201 && response.status !== 200) {
        throw failure(operation, response);
      }
      // A created Secret comes back with its data. Read nothing from it but its name.
      if (object.kind !== "Service") return { name: object.metadata.name };
      const created = json<{ spec?: { clusterIP?: unknown } }>(response);
      const clusterIP = created.spec?.clusterIP;
      return {
        name: object.metadata.name,
        ...(typeof clusterIP === "string" ? { clusterIP } : {}),
      };
    },

    async delete(kind, namespace, name, deleteOptions = {}) {
      const path = `${collection(kind, namespace)}/${checkName(name)}`;
      const response = await call("DELETE", path, {
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: deleteOptions.propagationPolicy ?? "Background",
        ...(deleteOptions.gracePeriodSeconds === undefined
          ? {}
          : { gracePeriodSeconds: deleteOptions.gracePeriodSeconds }),
      });
      if (response.status === 404) return false;
      if (response.status !== 200 && response.status !== 202) {
        throw failure(`delete ${kind}`, response);
      }
      return true;
    },

    async getJob(namespace, name) {
      const response = await call(
        "GET",
        `${collection("Job", namespace)}/${checkName(name)}`,
      );
      if (response.status === 404) return null;
      if (response.status !== 200) throw failure("get Job", response);
      return json<JobStatus>(response);
    },

    async listJobs(namespace, selector) {
      const query = encodeURIComponent(labelSelector(selector));
      const response = await call(
        "GET",
        `${collection("Job", namespace)}?labelSelector=${query}`,
      );
      if (response.status !== 200) throw failure("list Job", response);
      return json<{ items?: JobStatus[] }>(response).items ?? [];
    },

    async listPods(namespace, selector) {
      const query = encodeURIComponent(labelSelector(selector));
      const path = `/api/v1/namespaces/${checkNamespace(namespace)}/pods?labelSelector=${query}`;
      const response = await call("GET", path);
      if (response.status !== 200) throw failure("list Pod", response);
      return json<{ items?: PodStatus[] }>(response).items ?? [];
    },

    async readPodLog(namespace, pod, logOptions) {
      const query = new URLSearchParams({
        container: checkName(logOptions.container),
        tailLines: String(logOptions.tailLines),
        limitBytes: String(logOptions.limitBytes),
      });
      const path = `/api/v1/namespaces/${checkNamespace(namespace)}/pods/${checkName(pod)}/log?${query}`;
      const response = await call("GET", path);
      if (response.status === 404) return null;
      if (response.status !== 200) throw failure("read Pod log", response);
      return response.body.toString("utf8");
    },
  };
}
