// The run watcher's view of the cluster (D-330, O-102). It lists, then watches, the run Jobs of
// each agent namespace it is given, and reports each Job that has stopped, so the watcher can
// start the run-end flow on the event. Read only: it uses the watcher's own ServiceAccount token,
// which RBAC lets get, list and watch Jobs in agent namespaces and nothing else
// (RUN_WATCHER_ROLE_RULES in ./namespace.ts). It reads no pod, log or Secret and writes nothing.
// HTTPS to the API server with the cluster's CA, Node built-ins only, as ./client.ts.
//
// Only the two Jobs `poll` reads are reported (./runtime.ts): a run's agent Job and QA's fetch
// Job. A proxy, a repo map read and anything not labelled by the runner are not. The run id is
// the Job's run id label, and must give the Job's own fixed name; the runner wrote both when it
// created the Job, and no agent holds a Kubernetes token, so nothing an agent wrote is read.
// Stopped means a Complete or Failed condition (`jobState`, the reading `poll` uses), so a passed
// `activeDeadlineSeconds` counts; a Job being deleted does not (the runner's cancel records that
// end itself).
//
// The watch resumes from the last resource version it saw. A version too old (410) and a failed
// or dropped call start again from a fresh list, after a short wait for a failure. Errors carry
// the operation, the HTTP status and the Status reason, never a body or the token.
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import {
  KubernetesApiError,
  apiFailure,
  apiRequest,
  checkApiServer,
  checkNamespace,
  statusReason,
} from "./client.ts";
import { jobState } from "./job-state.ts";
import {
  LABEL_COMPONENT,
  LABEL_MANAGED_BY,
  LABEL_RUN_ID,
  MANAGED_BY,
  runNames,
  type Component,
} from "./names.ts";
import type { JobStatus } from "./objects.ts";

/** The run Jobs whose stop the watcher reports: the two `poll` reads (./runtime.ts). */
export const RUN_END_COMPONENTS = [
  "agent",
  "fetch",
] as const satisfies readonly Component[];
export type RunEndComponent = (typeof RUN_END_COMPONENTS)[number];

/** The list and watch selector: the runner's Jobs of those components, and nothing else. */
export const RUN_JOB_SELECTOR = `${LABEL_MANAGED_BY}=${MANAGED_BY},${LABEL_COMPONENT} in (${RUN_END_COMPONENTS.join(",")})`;

/** Each call the watcher makes and the Role verb it needs, for the RBAC test (D-330). */
export const WATCHER_OPERATIONS: readonly {
  operation: keyof RunJobsApi;
  apiGroup: string;
  resource: string;
  verb: string;
}[] = [
  { operation: "list", apiGroup: "batch", resource: "jobs", verb: "list" },
  { operation: "watch", apiGroup: "batch", resource: "jobs", verb: "watch" },
];

/** Where Kubernetes mounts a pod's ServiceAccount token and the cluster's CA. */
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface ApiCredentials {
  token: string;
  ca: string;
}

/**
 * The pod's own ServiceAccount token and the cluster's CA, read again for every call, since the
 * kubelet replaces the token file before it expires. A missing or empty file fails the call with
 * the reason `NoCredentials`, never with the file's content.
 */
export function serviceAccountCredentials(
  dir: string = SERVICE_ACCOUNT_DIR,
): () => ApiCredentials {
  return () => {
    try {
      const token = readFileSync(join(dir, "token"), "utf8").trim();
      const ca = readFileSync(join(dir, "ca.crt"), "utf8");
      if (token !== "" && ca.trim() !== "") return { token, ca };
    } catch {
      // Below: the path and the error's text are never passed on.
    }
    throw new KubernetesApiError("read credentials", 0, "NoCredentials");
  };
}

/** KUBERNETES_API: the API server, `https://host[:port]` and nothing else. */
export function parseApiServer(raw: string): URL {
  try {
    return checkApiServer(raw);
  } catch {
    throw new Error("must be https://<host>[:<port>] with nothing else");
  }
}

/** AGENT_NAMESPACES: comma-separated `agents-<slug>` names, each once. Empty means none yet. */
export function parseAgentNamespaces(raw: string): string[] {
  if (raw.trim() === "") return [];
  const names = raw.split(",").map((name) => name.trim());
  names.forEach((name, index) => {
    try {
      checkNamespace(name);
    } catch {
      throw new Error(`entry ${index + 1} is not an agents-<slug> namespace`);
    }
  });
  if (new Set(names).size !== names.length) throw new Error("names a namespace twice");
  return names;
}

/** One Job object, whatever later events say about it: the uid is never reused. */
export const jobKey = (namespace: string, job: JobStatus): string =>
  `${namespace}/${job.metadata.name}/${job.metadata.uid ?? ""}`;

/** A run's Job that has stopped. */
export interface RunJobStop {
  /** The Job object (`jobKey`), so one Job is reported to the flow once. */
  key: string;
  namespace: string;
  runId: string;
  component: RunEndComponent;
  state: "complete" | "failed" | "deadline";
}

/**
 * The stop of a run's agent or fetch Job, or null: not the runner's, not one of those two, a run
 * id label that is not a run id or does not give the Job's own name, or not stopped yet.
 */
export function runJobStop(namespace: string, job: JobStatus): RunJobStop | null {
  const labels = job.metadata.labels ?? {};
  if (labels[LABEL_MANAGED_BY] !== MANAGED_BY) return null;
  const component = RUN_END_COMPONENTS.find((c) => c === labels[LABEL_COMPONENT]);
  if (component === undefined) return null;
  const runId = labels[LABEL_RUN_ID] ?? "";
  let fixedName: string;
  try {
    const names = runNames(runId);
    fixedName = component === "agent" ? names.agentJob : names.fetchJob;
  } catch {
    return null;
  }
  if (job.metadata.name !== fixedName) return null;
  if (job.metadata.namespace !== undefined && job.metadata.namespace !== namespace) {
    return null;
  }
  const state = jobState(job);
  if (state !== "complete" && state !== "failed" && state !== "deadline") return null;
  return { key: jobKey(namespace, job), namespace, runId, component, state };
}

export interface JobList {
  resourceVersion: string;
  items: JobStatus[];
}

export interface JobWatchEvent {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK";
  object: JobStatus;
}

/**
 * How a watch ended: the API server closed it at its time limit (`closed`, resume from the last
 * version), the version is too old (`expired`, list again), or the watcher is stopping.
 */
export type WatchEnd = "closed" | "expired" | "stopped";

/** The two calls the watcher makes, in one agent namespace. Each stops when `signal` aborts. */
export interface RunJobsApi {
  list(namespace: string, signal?: AbortSignal): Promise<JobList>;
  watch(
    namespace: string,
    resourceVersion: string,
    onEvent: (event: JobWatchEvent) => void,
    signal: AbortSignal,
  ): Promise<WatchEnd>;
}

export interface RunJobsApiOptions {
  server: URL;
  credentials: () => ApiCredentials;
  /** A list call's bound. */
  timeoutMs?: number;
  /** How long the API server keeps one watch open before it closes it (`timeoutSeconds`). */
  watchSeconds?: number;
  /** A list larger than this is refused. */
  maxResponseBytes?: number;
}

/** One watch event's line larger than this is refused. A Job object is a few KiB. */
const MAX_EVENT_BYTES = 1024 * 1024;
const WATCH_EVENT_TYPES = new Set(["ADDED", "MODIFIED", "DELETED", "BOOKMARK"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jobsPath = (namespace: string): string =>
  `/apis/batch/v1/namespaces/${checkNamespace(namespace)}/jobs`;

export function createRunJobsApi(options: RunJobsApiOptions): RunJobsApi {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const watchSeconds = options.watchSeconds ?? 300;
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;

  return {
    async list(namespace, signal) {
      const path = `${jobsPath(namespace)}?labelSelector=${encodeURIComponent(RUN_JOB_SELECTOR)}`;
      const response = await apiRequest(
        {
          server: options.server,
          ...options.credentials(),
          timeoutMs,
          maxResponseBytes,
        },
        "GET",
        path,
        undefined,
        signal,
      );
      if (response.status !== 200) throw apiFailure("list Job", response);
      let body: unknown;
      try {
        body = JSON.parse(response.body.toString("utf8"));
      } catch {
        throw new KubernetesApiError("list Job", 200, "BadList");
      }
      const version =
        isObject(body) && isObject(body.metadata) && body.metadata.resourceVersion;
      if (
        !isObject(body) ||
        typeof version !== "string" ||
        version === "" ||
        !Array.isArray(body.items)
      ) {
        throw new KubernetesApiError("list Job", 200, "BadList");
      }
      return { resourceVersion: version, items: body.items as JobStatus[] };
    },

    watch(namespace, resourceVersion, onEvent, signal) {
      return new Promise<WatchEnd>((resolve, reject) => {
        if (signal.aborted) {
          resolve("stopped");
          return;
        }
        const query = new URLSearchParams({
          labelSelector: RUN_JOB_SELECTOR,
          watch: "true",
          resourceVersion,
          allowWatchBookmarks: "true",
          timeoutSeconds: String(watchSeconds),
        });
        let credentials: ApiCredentials;
        try {
          credentials = options.credentials();
        } catch (error) {
          reject(error);
          return;
        }
        const failed = (status: number, reason: string) =>
          new KubernetesApiError("watch Job", status, reason);
        const request = httpsRequest({
          hostname: options.server.hostname.replace(/^\[|\]$/g, ""),
          port: options.server.port || 443,
          method: "GET",
          path: `${jobsPath(namespace)}?${query}`,
          ca: credentials.ca,
          rejectUnauthorized: true,
          // No byte for this long, bookmarks included: the watch counts as dropped.
          timeout: (watchSeconds + 30) * 1000,
          headers: {
            authorization: `Bearer ${credentials.token}`,
            accept: "application/json",
          },
        });
        let settled = false;
        /** Once the stream has begun, any socket failure is a dropped watch. */
        let streaming = false;
        const settle = (end: WatchEnd | KubernetesApiError) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          request.destroy();
          if (end instanceof KubernetesApiError) reject(end);
          else resolve(end);
        };
        const onAbort = () => settle("stopped");
        signal.addEventListener("abort", onAbort, { once: true });
        request.on("timeout", () => settle(failed(0, "Timeout")));
        // Errors are listened to with `on`: one after `settle` must not reach the process.
        request.on("error", (error: NodeJS.ErrnoException) =>
          settle(
            streaming ? failed(200, "Dropped") : failed(0, error.code ?? error.name),
          ),
        );

        /** One line of the stream: null to read on, or how the watch ends. */
        const readLine = (line: string): WatchEnd | KubernetesApiError | null => {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return failed(200, "BadEvent");
          }
          if (!isObject(event) || !isObject(event.object))
            return failed(200, "BadEvent");
          if (event.type === "ERROR") {
            const code = typeof event.object.code === "number" ? event.object.code : 0;
            if (code === 410) return "expired";
            return failed(
              code,
              statusReason(Buffer.from(JSON.stringify(event.object))),
            );
          }
          if (
            typeof event.type !== "string" ||
            !WATCH_EVENT_TYPES.has(event.type) ||
            !isObject(event.object.metadata)
          ) {
            return failed(200, "BadEvent");
          }
          onEvent({
            type: event.type as JobWatchEvent["type"],
            object: event.object as unknown as JobStatus,
          });
          return null;
        };

        request.on("response", (response) => {
          const status = response.statusCode ?? 0;
          if (status === 410) {
            response.resume();
            settle("expired");
            return;
          }
          if (status !== 200) {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= 64 * 1024) chunks.push(chunk);
            });
            response.on("end", () =>
              settle(failed(status, statusReason(Buffer.concat(chunks)))),
            );
            response.on("error", () => settle(failed(status, "Unknown")));
            return;
          }
          streaming = true;
          let buffer = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            buffer += chunk;
            let newline = buffer.indexOf("\n");
            while (newline >= 0 && !settled) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (line.trim() !== "") {
                let end: WatchEnd | KubernetesApiError | null;
                try {
                  end = readLine(line);
                } catch {
                  end = failed(200, "EventNotHandled");
                }
                if (end !== null) settle(end);
              }
              newline = buffer.indexOf("\n");
            }
            if (buffer.length > MAX_EVENT_BYTES) settle(failed(200, "EventTooLarge"));
          });
          response.on("error", () => settle(failed(200, "Dropped")));
          // A stream the server finished is a clean close; one cut short is a dropped watch.
          response.on("close", () =>
            settle(response.complete ? "closed" : failed(200, "Dropped")),
          );
        });
        request.end();
      });
    },
  };
}

/** What the watch tells its caller. Each handler must not throw. */
export interface RunJobEvents {
  /** A run's Job has stopped: from a list or an event, and again on later events and lists. */
  stopped(stop: RunJobStop): void;
  /** A Job the API server has deleted (`jobKey`): it cannot come back. */
  deleted(key: string): void;
  /** A list or a watch failed. Only the namespace, the step, the status and the reason. */
  failed(failure: {
    namespace: string;
    step: "list" | "watch";
    status: number;
    reason: string;
  }): void;
}

export interface RunJobWatchOptions {
  api: RunJobsApi;
  namespaces: readonly string[];
  events: RunJobEvents;
  /** The waits after consecutive failed calls, in order; the last one repeats. */
  retryDelaysMs?: readonly number[];
  /** The wait after a watch ends before the next call, so a server that closes at once is not hammered. */
  resumeDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_WATCH_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000,
];

/** Waits `ms`, or less if the signal aborts first. Never rejects. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Lists then watches each namespace until `stop`. Every stopped run Job seen is passed to
 * `events.stopped`, as often as it is seen: the caller keeps it to once per Job.
 */
export function watchRunJobs(options: RunJobWatchOptions): { stop(): Promise<void> } {
  const { api, events } = options;
  const delays = options.retryDelaysMs ?? DEFAULT_WATCH_RETRY_DELAYS_MS;
  const resumeDelayMs = options.resumeDelayMs ?? 1_000;
  const sleep = options.sleep ?? sleepUnlessAborted;
  const controller = new AbortController();
  const { signal } = controller;

  const seen = (namespace: string, job: JobStatus): void => {
    const stop = runJobStop(namespace, job);
    if (stop !== null) events.stopped(stop);
  };

  async function follow(namespace: string): Promise<void> {
    let version: string | null = null;
    let failures = 0;
    while (!signal.aborted) {
      let step: "list" | "watch" = "list";
      try {
        if (version === null) {
          const list = await api.list(namespace, signal);
          if (signal.aborted) return;
          for (const job of list.items) seen(namespace, job);
          version = list.resourceVersion;
          failures = 0;
        }
        step = "watch";
        const end = await api.watch(
          namespace,
          version,
          (event) => {
            const next = event.object.metadata.resourceVersion;
            if (typeof next === "string" && next !== "") version = next;
            if (event.type === "DELETED")
              events.deleted(jobKey(namespace, event.object));
            else if (event.type !== "BOOKMARK") seen(namespace, event.object);
          },
          signal,
        );
        if (end === "stopped") return;
        if (end === "expired") version = null;
        await sleep(resumeDelayMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        // A failed list, or a watch that failed or dropped: start again from a fresh list.
        version = null;
        const status = error instanceof KubernetesApiError ? error.status : 0;
        const reason =
          error instanceof KubernetesApiError
            ? error.reason
            : error instanceof Error
              ? error.name
              : "Unknown";
        events.failed({ namespace, step, status, reason });
        await sleep(delays[Math.min(failures, delays.length - 1)] ?? 1_000, signal);
        failures += 1;
      }
    }
  }

  const running = options.namespaces.map((namespace) => follow(namespace));
  return {
    stop: async () => {
      controller.abort();
      await Promise.all(running);
    },
  };
}
