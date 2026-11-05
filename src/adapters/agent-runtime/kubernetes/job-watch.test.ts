import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createNetServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { KubernetesApiError } from "./client.ts";
import { startFakeKubernetesApi, type FakeKubernetesApi } from "./fake-api-server.ts";
import {
  RUN_JOB_SELECTOR,
  createRunJobsApi,
  jobKey,
  parseAgentNamespaces,
  parseApiServer,
  runJobStop,
  serviceAccountCredentials,
  watchRunJobs,
  type JobWatchEvent,
  type RunJobEvents,
  type RunJobStop,
  type RunJobsApi,
} from "./job-watch.ts";
import { runLabels, runNames, type Component, type JobRole } from "./names.ts";
import type { JobStatus } from "./objects.ts";

// Unit and integration: the run watcher's view of the cluster (D-330, O-102). Which Jobs count as
// a run's stop is plain data; the list, the watch and the loop run over HTTPS against a local fake
// API server with a certificate made for the test (./fake-api-server.ts). No cluster, no network.

const NS = "agents-rehearsal";
const RUN = "0f8e7d6c-5b4a-4321-9876-0123456789ab";

type Condition = { type: string; status: string; reason?: string };
const COMPLETE: Condition[] = [
  { type: "SuccessCriteriaMet", status: "True" },
  { type: "Complete", status: "True" },
];
const FAILED: Condition[] = [
  { type: "FailureTarget", status: "True", reason: "BackoffLimitExceeded" },
  { type: "Failed", status: "True", reason: "BackoffLimitExceeded" },
];
const DEADLINE: Condition[] = [
  { type: "FailureTarget", status: "True", reason: "DeadlineExceeded" },
  { type: "Failed", status: "True", reason: "DeadlineExceeded" },
];

/** A run's Job as the runtime labels and names it (./manifests.ts), with the given conditions. */
function runJob(
  runId: string,
  component: Component,
  conditions: Condition[] = [],
  options: { role?: JobRole; name?: string; namespace?: string } = {},
): JobStatus {
  const names = runNames(runId);
  const fixed: Partial<Record<Component, string>> = {
    agent: names.agentJob,
    proxy: names.proxyJob,
    fetch: names.fetchJob,
    "fetch-proxy": names.fetchProxyJob,
    "repo-map": `map-${runId}`,
  };
  return {
    metadata: {
      name: options.name ?? fixed[component] ?? "",
      namespace: options.namespace ?? NS,
      labels: runLabels(
        { runId, projectSlug: "rehearsal", role: options.role ?? "developer" },
        component,
      ),
      uid: `uid-${runId}-${component}`,
    },
    status: { conditions },
  };
}

describe("which Jobs are a run's stop (unit: D-330)", () => {
  it("reports a run's agent Job once it is Complete or Failed, a passed deadline included", () => {
    expect(runJobStop(NS, runJob(RUN, "agent", COMPLETE))).toEqual({
      key: `${NS}/run-${RUN}-agent/uid-${RUN}-agent`,
      namespace: NS,
      runId: RUN,
      component: "agent",
      state: "complete",
    });
    expect(runJobStop(NS, runJob(RUN, "agent", FAILED))?.state).toBe("failed");
    expect(runJobStop(NS, runJob(RUN, "agent", DEADLINE))?.state).toBe("deadline");
  });

  it("reports QA's fetch Job too: `poll` reads it first, and its end moves or ends the run", () => {
    const stop = runJobStop(NS, runJob(RUN, "fetch", FAILED, { role: "qa" }));
    expect(stop).toMatchObject({ runId: RUN, component: "fetch", state: "failed" });
  });

  it("reports nothing while the Job runs, or is still stopping its pods, or is being deleted", () => {
    expect(runJobStop(NS, runJob(RUN, "agent"))).toBeNull();
    expect(
      runJobStop(
        NS,
        runJob(RUN, "agent", [{ type: "SuccessCriteriaMet", status: "True" }]),
      ),
    ).toBeNull();
    expect(
      runJobStop(
        NS,
        runJob(RUN, "agent", [
          { type: "FailureTarget", status: "True", reason: "DeadlineExceeded" },
        ]),
      ),
    ).toBeNull();
    expect(
      runJobStop(NS, runJob(RUN, "agent", [{ type: "Complete", status: "False" }])),
    ).toBeNull();
    const deleting = runJob(RUN, "agent", COMPLETE);
    deleting.metadata.deletionTimestamp = "2026-11-05T10:00:00Z";
    expect(runJobStop(NS, deleting)).toBeNull();
  });

  it("reports no proxy, no repo map read and nothing the runner did not label", () => {
    for (const component of ["proxy", "fetch-proxy"] as const) {
      expect(runJobStop(NS, runJob(RUN, component, COMPLETE))).toBeNull();
    }
    expect(
      runJobStop(NS, runJob(RUN, "repo-map", COMPLETE, { role: "repo-map" })),
    ).toBeNull();
    const other = runJob(RUN, "agent", COMPLETE);
    other.metadata.labels = {
      ...other.metadata.labels,
      "app.kubernetes.io/managed-by": "someone-else",
    };
    expect(runJobStop(NS, other)).toBeNull();
    const unlabelled = runJob(RUN, "agent", COMPLETE);
    delete unlabelled.metadata.labels;
    expect(runJobStop(NS, unlabelled)).toBeNull();
  });

  it("takes the run id from the runner's label only when it gives the Job's own fixed name", () => {
    // A Job named for another run, a run id that is not one, and a Job from another namespace.
    expect(
      runJobStop(NS, runJob(RUN, "agent", COMPLETE, { name: "run-another-agent" })),
    ).toBeNull();
    const bad = runJob(RUN, "agent", COMPLETE);
    bad.metadata.labels = { ...bad.metadata.labels, "foreman/run-id": "Not A Run" };
    expect(runJobStop(NS, bad)).toBeNull();
    expect(
      runJobStop(NS, runJob(RUN, "agent", COMPLETE, { namespace: "agents-other" })),
    ).toBeNull();
  });

  it("keys a Job by its namespace, its name and its uid, so a new Job of the same name is new", () => {
    const job = runJob(RUN, "agent", COMPLETE);
    expect(jobKey(NS, job)).toBe(`${NS}/run-${RUN}-agent/uid-${RUN}-agent`);
    expect(
      jobKey(NS, { ...job, metadata: { ...job.metadata, uid: "uid-2" } }),
    ).not.toBe(jobKey(NS, job));
  });

  it("selects only the runner's agent and fetch Jobs on the server", () => {
    expect(RUN_JOB_SELECTOR).toBe(
      "app.kubernetes.io/managed-by=foreman-runner,foreman/component in (agent,fetch)",
    );
  });
});

describe("the watcher's settings (unit: D-330, ADR 0111)", () => {
  it("reads the agent namespaces, each an agents-<slug> name, once; none is allowed", () => {
    expect(parseAgentNamespaces("agents-rehearsal,agents-second")).toEqual([
      "agents-rehearsal",
      "agents-second",
    ]);
    expect(parseAgentNamespaces("")).toEqual([]);
    for (const raw of ["kube-system", "agents-a,default", "agents-A"]) {
      expect(() => parseAgentNamespaces(raw)).toThrow(
        /is not an agents-<slug> namespace/,
      );
    }
    expect(() => parseAgentNamespaces("agents-a,agents-a")).toThrow(/twice/);
    // The error names the entry, never the value.
    expect(() => parseAgentNamespaces("agents-a,secret-value")).toThrow(
      /^entry 2 is not an agents-<slug> namespace$/,
    );
  });

  it("reads the API server as https://host[:port] only", () => {
    expect(parseApiServer("https://kubernetes.default.svc").href).toBe(
      "https://kubernetes.default.svc/",
    );
    for (const raw of [
      "http://kubernetes.default.svc",
      "https://kubernetes.default.svc/api",
      "https://user:pw@kubernetes.default.svc",
      "kubernetes.default.svc",
    ]) {
      expect(() => parseApiServer(raw)).toThrow(/^must be https:\/\/<host>\[:<port>\]/);
    }
  });

  it("reads the pod's token and CA again for every call, and names no file content when one is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "service-account-test-"));
    try {
      const read = serviceAccountCredentials(dir);
      expect(() => read()).toThrow(KubernetesApiError);
      expect(() => read()).toThrow(/read credentials failed with 0 NoCredentials/);
      writeFileSync(join(dir, "token"), "first-token\n");
      writeFileSync(join(dir, "ca.crt"), "-----BEGIN CERTIFICATE-----\n");
      expect(read()).toEqual({
        token: "first-token",
        ca: "-----BEGIN CERTIFICATE-----\n",
      });
      // The kubelet replaces the token before it expires.
      writeFileSync(join(dir, "token"), "second-token");
      expect(read().token).toBe("second-token");
      writeFileSync(join(dir, "token"), "  \n");
      expect(() => read()).toThrow(/NoCredentials/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

let fake: FakeKubernetesApi;
let api: RunJobsApi;
beforeAll(async () => {
  fake = await startFakeKubernetesApi();
  api = createRunJobsApi({
    server: fake.url,
    credentials: () => ({ token: fake.token, ca: fake.ca }),
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("the list and the watch (integration: local TLS fake API server, D-330)", () => {
  const ns = "agents-calls";

  it("lists the runner's agent and fetch Jobs of one namespace with the bearer token, trusting only the given CA", async () => {
    fake.put(runJob(RUN, "agent", COMPLETE, { namespace: ns }));
    fake.put(runJob(RUN, "proxy", [], { namespace: ns }));
    const list = await api.list(ns);
    expect(list.items.map((job) => job.metadata.name)).toEqual([`run-${RUN}-agent`]);
    expect(Number(list.resourceVersion)).toBeGreaterThan(0);
    const request = fake.requests.at(-1);
    expect(request?.authorization).toBe(`Bearer ${fake.token}`);
    expect(request?.query.get("labelSelector")).toBe(RUN_JOB_SELECTOR);
    expect(request?.query.get("watch")).toBeNull();
  });

  it("names the operation, the status and the reason of a refused list, never the token", async () => {
    fake.failLists(ns, 403);
    const error = await api.list(ns).then(
      () => null,
      (e: unknown) => e,
    );
    fake.failLists(ns, null);
    expect(error).toBeInstanceOf(KubernetesApiError);
    expect((error as KubernetesApiError).message).toBe(
      "Kubernetes list Job failed with 403 Forbidden",
    );
    expect(JSON.stringify(error)).not.toContain(fake.token);
  });

  it("refuses an API server whose certificate the CA did not sign, and sends nothing", async () => {
    const other = await startFakeKubernetesApi();
    try {
      const before = other.requests.length;
      const untrusting = createRunJobsApi({
        server: other.url,
        credentials: () => ({ token: other.token, ca: fake.ca }),
      });
      await expect(untrusting.list(ns)).rejects.toBeInstanceOf(KubernetesApiError);
      expect(other.requests.length).toBe(before);
    } finally {
      await other.stop();
    }
  });

  it("refuses a namespace that is not an agent namespace before any request", async () => {
    const before = fake.requests.length;
    await expect(api.list("kube-system")).rejects.toThrow(/agents-<slug>/);
    await expect(
      api.watch("default", "1", () => {}, new AbortController().signal),
    ).rejects.toThrow(/agents-<slug>/);
    expect(fake.requests.length).toBe(before);
  });

  it("watches from a version with bookmarks and a time limit, passes each event, and ends as the server ends it", async () => {
    const list = await api.list(ns);
    const events: JobWatchEvent[] = [];
    const watching = api.watch(
      ns,
      list.resourceVersion,
      (event) => events.push(event),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    const query = fake.requests.at(-1)?.query;
    expect(query?.get("watch")).toBe("true");
    expect(query?.get("resourceVersion")).toBe(list.resourceVersion);
    expect(query?.get("allowWatchBookmarks")).toBe("true");
    expect(query?.get("timeoutSeconds")).toBe("300");
    expect(query?.get("labelSelector")).toBe(RUN_JOB_SELECTOR);
    fake.put(runJob("second-run", "agent", FAILED, { namespace: ns }));
    fake.bookmark(ns);
    fake.remove(ns, "run-second-run-agent");
    await vi.waitFor(() => expect(events).toHaveLength(3));
    fake.end(ns);
    expect(await watching).toBe("closed");
    expect(events.map((e) => [e.type, e.object.metadata.name])).toEqual([
      ["ADDED", "run-second-run-agent"],
      ["BOOKMARK", undefined],
      ["DELETED", "run-second-run-agent"],
    ]);
  });

  it("ends as expired on a 410, as an ERROR event or as the answer's status", async () => {
    const list = await api.list(ns);
    const signal = new AbortController().signal;
    const watching = api.watch(ns, list.resourceVersion, () => {}, signal);
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    fake.expire(ns);
    expect(await watching).toBe("expired");
    expect(await api.watch(ns, list.resourceVersion, () => {}, signal)).toBe("expired");
    fake.expire(ns, true);
    expect(await api.watch(ns, list.resourceVersion, () => {}, signal)).toBe("expired");
  });

  it("fails a watch cut short as dropped, and ends one the watcher stops", async () => {
    const list = await api.list(ns);
    const events: JobWatchEvent[] = [];
    const dropped = api.watch(
      ns,
      list.resourceVersion,
      (event) => events.push(event),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    fake.put(runJob("third-run", "agent", [], { namespace: ns }));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    fake.drop(ns);
    await expect(dropped).rejects.toMatchObject({
      name: "KubernetesApiError",
      status: 200,
      reason: "Dropped",
    });
    const controller = new AbortController();
    const stopped = api.watch(ns, list.resourceVersion, () => {}, controller.signal);
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    controller.abort();
    expect(await stopped).toBe("stopped");
  });
});

describe("the watch loop (integration: local TLS fake API server, D-330)", () => {
  /** What the loop told its caller. */
  function recorder() {
    const stops: RunJobStop[] = [];
    const deleted: string[] = [];
    const failures: Parameters<RunJobEvents["failed"]>[0][] = [];
    const events: RunJobEvents = {
      stopped: (stop) => stops.push(stop),
      deleted: (key) => deleted.push(key),
      failed: (failure) => failures.push(failure),
    };
    return { stops, deleted, failures, events };
  }
  const running: { stop(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((watch) => watch.stop()));
  });
  const start = (namespaces: string[], events: RunJobEvents) => {
    const watch = watchRunJobs({
      api,
      namespaces,
      events,
      retryDelaysMs: [5, 10],
      resumeDelayMs: 0,
    });
    running.push(watch);
    return watch;
  };

  it("lists first, then watches from the list's version, in each namespace it is given", async () => {
    const [a, b] = ["agents-loop-a", "agents-loop-b"];
    fake.put(runJob("run-a", "agent", COMPLETE, { namespace: a }));
    fake.put(runJob("run-b", "agent", [], { namespace: a }));
    fake.put(runJob("run-c", "fetch", DEADLINE, { namespace: b, role: "qa" }));
    const seen = recorder();
    start([a, b], seen.events);
    await vi.waitFor(() => {
      expect(fake.openWatches(a)).toBe(1);
      expect(fake.openWatches(b)).toBe(1);
    });
    expect(seen.stops.map((s) => [s.namespace, s.runId, s.component, s.state])).toEqual(
      expect.arrayContaining([
        [a, "run-a", "agent", "complete"],
        [b, "run-c", "fetch", "deadline"],
      ]),
    );
    expect(seen.stops).toHaveLength(2);
    expect([fake.calls(a, "list"), fake.calls(a, "watch")]).toEqual([1, 1]);
    // The running Job stops while watched.
    fake.put(runJob("run-b", "agent", FAILED, { namespace: a }));
    await vi.waitFor(() => expect(seen.stops).toHaveLength(3));
    expect(seen.stops[2]).toMatchObject({ runId: "run-b", state: "failed" });
  });

  it("resumes from the last version it saw when the server ends a watch, bookmarks included, without a list", async () => {
    const ns = "agents-loop-resume";
    const seen = recorder();
    start([ns], seen.events);
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    fake.put(runJob("run-d", "agent", [], { namespace: ns }));
    fake.bookmark(ns);
    const marked = fake.put(runJob("run-other", "proxy", [], { namespace: ns }));
    fake.bookmark(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "watch")).toBe(1));
    fake.end(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "watch")).toBe(2));
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    expect(fake.calls(ns, "list")).toBe(1);
    // The bookmark after the proxy's change moved the version past it.
    expect(
      Number(
        fake.requests
          .filter((r) => r.namespace === ns)
          .at(-1)
          ?.query.get("resourceVersion"),
      ),
    ).toBeGreaterThanOrEqual(Number(marked.metadata.resourceVersion));
    expect(seen.failures).toEqual([]);
  });

  it("lists again after a 410, and again after a dropped watch, naming only the step and reason", async () => {
    const ns = "agents-loop-relist";
    fake.put(runJob("run-e", "agent", COMPLETE, { namespace: ns }));
    const seen = recorder();
    start([ns], seen.events);
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    fake.expire(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(2));
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    expect(seen.failures).toEqual([]);
    fake.drop(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(3));
    expect(seen.failures).toEqual([
      expect.objectContaining({ namespace: ns, step: "watch" }),
    ]);
    expect(Object.keys(seen.failures[0] ?? {}).sort()).toEqual([
      "namespace",
      "reason",
      "status",
      "step",
    ]);
    // The loop reports the stopped Job on each list: keeping it to one start is the caller's job.
    await vi.waitFor(() => expect(seen.stops).toHaveLength(3));
    expect(new Set(seen.stops.map((s) => s.key)).size).toBe(1);
  });

  it("waits and lists again after a refused list, and tells its caller about deletions", async () => {
    const ns = "agents-loop-refused";
    const job = fake.put(runJob("run-f", "agent", COMPLETE, { namespace: ns }));
    fake.failLists(ns, 403);
    const seen = recorder();
    start([ns], seen.events);
    await vi.waitFor(() => expect(seen.failures.length).toBeGreaterThanOrEqual(2));
    expect(seen.failures[0]).toEqual({
      namespace: ns,
      step: "list",
      status: 403,
      reason: "Forbidden",
    });
    expect(seen.stops).toEqual([]);
    fake.failLists(ns, null);
    await vi.waitFor(() => expect(seen.stops).toHaveLength(1));
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    fake.remove(ns, job.metadata.name);
    await vi.waitFor(() => expect(seen.deleted).toEqual([jobKey(ns, job)]));
  });

  it("stops every namespace's watch on stop", async () => {
    const ns = "agents-loop-stop";
    const watch = start([ns], recorder().events);
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(1));
    await watch.stop();
    await vi.waitFor(() => expect(fake.openWatches(ns)).toBe(0));
  });

  it("does not wait for a list the API server never answers when it stops", async () => {
    // A server that accepts the connection and never answers.
    const sockets: Socket[] = [];
    const silent = createNetServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const quiet = createRunJobsApi({
      server: new URL(`https://127.0.0.1:${(silent.address() as AddressInfo).port}`),
      credentials: () => ({ token: fake.token, ca: fake.ca }),
    });
    const seen = recorder();
    const watch = watchRunJobs({ api: quiet, namespaces: [NS], events: seen.events });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const began = Date.now();
    await watch.stop();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(seen.failures).toEqual([]);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });
});
