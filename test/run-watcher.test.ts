// In-process end to end: the run watcher (D-330, O-102). The real watch and its HTTPS calls run
// against a local fake Kubernetes API server (src/adapters/agent-runtime/kubernetes/
// fake-api-server.ts), and each stopped run Job goes to the watcher's starts (src/run-watcher/
// starts.ts), with the fake flow start, or with the real Windmill binding pointed at a local fake
// proxy for the token and failure cases. No cluster, no Windmill and no outside network; the
// Windmill token is a made-up test value. The process itself is started once, as its container is.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  startFakeKubernetesApi,
  type FakeKubernetesApi,
} from "../src/adapters/agent-runtime/kubernetes/fake-api-server.ts";
import {
  createRunJobsApi,
  watchRunJobs,
} from "../src/adapters/agent-runtime/kubernetes/job-watch.ts";
import {
  runLabels,
  runNames,
  type Component,
  type JobRole,
} from "../src/adapters/agent-runtime/kubernetes/names.ts";
import type { JobStatus } from "../src/adapters/agent-runtime/kubernetes/objects.ts";
import { createFakeFlowStart } from "../src/adapters/windmill/fake-flow-start.ts";
import {
  RUN_WATCHER_WINDMILL_TOKEN_PATH,
  windmillRunEndFlow,
  type RunEndFlow,
} from "../src/adapters/windmill/run-watcher-flows.ts";
import {
  RUN_END_NOT_STARTED,
  RUN_END_RETRYING,
  RUN_END_STARTED,
  createRunEndStarts,
} from "../src/run-watcher/starts.ts";
import { secretEnvName } from "../src/service-kit/config.ts";
import { createLogger } from "../src/service-kit/logger.ts";

const A = "agents-rehearsal";
const B = "agents-second";
const TOKEN = randomBytes(24).toString("base64url");

type Condition = { type: string; status: string; reason?: string };
const finished: Condition[] = [
  { type: "SuccessCriteriaMet", status: "True" },
  { type: "Complete", status: "True" },
];
/** With `backoffLimit: 0`, a crash, an out of memory kill and a killed pod all fail the Job. */
const failedWith = (reason: string): Condition[] => [
  { type: "FailureTarget", status: "True", reason },
  { type: "Failed", status: "True", reason },
];
const crashed = failedWith("BackoffLimitExceeded");
const pastDeadline = failedWith("DeadlineExceeded");

function runJob(
  namespace: string,
  runId: string,
  component: Component,
  conditions: Condition[] = [],
  role: JobRole = "developer",
): JobStatus {
  const names = runNames(runId);
  const name: Partial<Record<Component, string>> = {
    agent: names.agentJob,
    proxy: names.proxyJob,
    fetch: names.fetchJob,
    "repo-map": `map-${runId}`,
  };
  return {
    metadata: {
      name: name[component] ?? "",
      namespace,
      labels: runLabels(
        { runId, projectSlug: namespace.replace(/^agents-/, ""), role },
        component,
      ),
    },
    status: { conditions },
  };
}

let fake: FakeKubernetesApi;
beforeAll(async () => {
  fake = await startFakeKubernetesApi();
});
afterAll(async () => {
  await fake.stop();
});

/** One watcher process: the real watch, the watcher's starts and a log kept in memory. */
function watcher(flow: RunEndFlow, namespaces = [A, B], retryDelaysMs = [1, 1, 1]) {
  const logs: string[] = [];
  const starts = createRunEndStarts({
    flow,
    logger: createLogger("run-watcher", (line) => logs.push(line)),
    retryDelaysMs,
  });
  const watch = watchRunJobs({
    api: createRunJobsApi({
      server: fake.url,
      credentials: () => ({ token: fake.token, ca: fake.ca }),
    }),
    namespaces,
    events: starts,
    retryDelaysMs: [5, 10],
    resumeDelayMs: 0,
  });
  const stop = async () => {
    await watch.stop();
    await starts.stop();
  };
  return { logs, starts, stop };
}

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((w) => w.stop()));
});
const open = (flow: RunEndFlow, namespaces?: string[], delays?: number[]) => {
  const w = watcher(flow, namespaces, delays);
  running.push(w);
  return w;
};
const watching = (...namespaces: string[]) =>
  vi.waitFor(() => {
    for (const ns of namespaces) expect(fake.openWatches(ns)).toBe(1);
  });

describe("the run watcher records each run's end on the event (in-process: fake API server, D-330)", () => {
  it("lists, then watches; each way a Job stops starts the run-end flow once, and a running Job starts nothing", async () => {
    fake.put(runJob(A, "run-finished", "agent", finished));
    fake.put(runJob(A, "run-crashed", "agent", crashed));
    // Out of memory: the kernel kills the container, the pod fails, so does the Job.
    fake.put(runJob(A, "run-out-of-memory", "agent", crashed));
    // Killed: the pod is deleted or evicted from outside; with no retries the Job fails.
    fake.put(runJob(A, "run-killed", "agent", failedWith("PodFailurePolicy")));
    fake.put(runJob(B, "run-past-deadline", "agent", pastDeadline, "council"));
    fake.put(runJob(B, "run-fetch-failed", "fetch", crashed, "qa"));
    fake.put(runJob(A, "run-running", "agent"));
    fake.put(runJob(A, "run-running", "proxy", pastDeadline));
    fake.put(runJob(A, "map-read", "repo-map", finished, "repo-map"));
    const flow = createFakeFlowStart();
    const w = open(flow);
    await watching(A, B);
    await w.starts.settled();
    expect([...flow.started].sort()).toEqual(
      [
        "run-crashed",
        "run-fetch-failed",
        "run-finished",
        "run-killed",
        "run-out-of-memory",
        "run-past-deadline",
      ].sort(),
    );

    // The running Job: still stopping its pods starts nothing; its Failed condition starts once,
    // and later changes to the same Job start nothing more.
    fake.put(runJob(A, "run-running", "agent", [crashed[0] as Condition]));
    fake.put(runJob(A, "run-running", "agent", crashed));
    const again = runJob(A, "run-running", "agent", crashed);
    again.metadata.labels = { ...again.metadata.labels, extra: "changed" };
    fake.put(again);
    await vi.waitFor(() => expect(flow.started).toHaveLength(7));
    await w.starts.settled();
    expect(flow.started.filter((id) => id === "run-running")).toEqual(["run-running"]);
    const logs = w.logs.join("\n");
    expect(logs.split(RUN_END_STARTED).length - 1).toBe(7);
    // Logs name the namespace, the Job's kind and how it stopped, never a run id or a Job name.
    for (const id of flow.started) expect(logs).not.toContain(id);
    expect(JSON.parse(w.logs[0] ?? "{}")).toMatchObject({
      service: "run-watcher",
      message: RUN_END_STARTED,
      job: expect.stringMatching(/^(agent|fetch)$/),
      stop: expect.stringMatching(/^(complete|failed|deadline)$/),
      attempt: 1,
    });
  });

  it("a 410 or a dropped watch lists again without starting any Job a second time", async () => {
    const ns = "agents-relist";
    fake.put(runJob(ns, "run-before", "agent", finished));
    const flow = createFakeFlowStart();
    const w = open(flow, [ns]);
    await watching(ns);
    await w.starts.settled();
    expect(flow.started).toEqual(["run-before"]);

    fake.expire(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(2));
    await watching(ns);
    fake.expire(ns, true);
    await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(3));
    await watching(ns);
    fake.drop(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(4));
    await watching(ns);
    // A Job that stopped during the gap is started once, by the list.
    fake.put(runJob(ns, "run-during", "agent", crashed));
    fake.drop(ns);
    await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(5));
    await watching(ns);
    await w.starts.settled();
    expect(flow.started).toEqual(["run-before", "run-during"]);
  });

  it("a restart starts the flow only for the stopped Jobs still present: the runner deleted the recorded ones", async () => {
    const ns = "agents-restart";
    fake.put(runJob(ns, "run-recorded", "agent", finished));
    fake.put(runJob(ns, "run-not-recorded", "agent", crashed));
    fake.put(runJob(ns, "run-busy", "agent"));
    const first = createFakeFlowStart();
    const before = watcher(first, [ns]);
    await watching(ns);
    await before.starts.settled();
    expect([...first.started].sort()).toEqual(["run-not-recorded", "run-recorded"]);
    // The run-end flow recorded one end and cleaned up its Job; the other start never ran.
    fake.remove(ns, runNames("run-recorded").agentJob);
    await before.stop();
    // While no watcher runs, the busy run stops.
    fake.put(runJob(ns, "run-busy", "agent", pastDeadline));

    const watchesBefore = fake.calls(ns, "watch");
    const second = createFakeFlowStart();
    const after = open(second, [ns]);
    // The new process has listed once it watches.
    await vi.waitFor(() => expect(fake.calls(ns, "watch")).toBe(watchesBefore + 1));
    await after.starts.settled();
    expect([...second.started].sort()).toEqual(["run-busy", "run-not-recorded"]);
  });
});

/** A stand-in for the shared Windmill proxy that refuses every tunnel with `status`. */
async function refusingProxy(status: number) {
  const tunnels: string[] = [];
  const heads: string[] = [];
  const server: Server = createServer();
  server.on("connect", (request, socket) => {
    tunnels.push(request.url ?? "");
    heads.push(JSON.stringify(request.headers));
    socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return {
    url,
    tunnels,
    heads,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("the run watcher's Windmill start (in-process: fake API server and proxy, D-330)", () => {
  it("starts nothing while its token is missing, and says so without retrying", async () => {
    const ns = "agents-no-token";
    fake.put(runJob(ns, "run-no-token", "agent", finished));
    const proxy = await refusingProxy(502);
    try {
      const flow = windmillRunEndFlow(null, {
        host: "windmill.example.com",
        workspace: "rehearsal",
        proxy: proxy.url,
      });
      const w = open(flow, [ns]);
      await watching(ns);
      await w.starts.settled();
      expect(proxy.tunnels).toEqual([]);
      const lines = w.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.filter((l) => l.message === RUN_END_NOT_STARTED)).toEqual([
        expect.objectContaining({
          errorType: "NotBuiltError",
          attempt: 1,
          namespace: ns,
        }),
      ]);
      expect(lines.some((l) => l.message === RUN_END_RETRYING)).toBe(false);
      // A fresh list does not try again.
      fake.expire(ns);
      await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(2));
      await w.starts.settled();
      expect(w.logs.filter((l) => l.includes(RUN_END_NOT_STARTED))).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it("tries a failed start again a few times, then gives up and leaves it to the reconcile pass, logging the step and status and never the token", async () => {
    const ns = "agents-refused";
    fake.put(runJob(ns, "run-refused", "agent", crashed));
    const proxy = await refusingProxy(502);
    try {
      const flow = windmillRunEndFlow(TOKEN, {
        host: "windmill.example.com",
        workspace: "rehearsal",
        proxy: proxy.url,
      });
      const w = open(flow, [ns], [1, 2, 3]);
      await watching(ns);
      await w.starts.settled();
      // Four tries in all, each a tunnel to Windmill's host only.
      expect(proxy.tunnels).toEqual(Array(4).fill("windmill.example.com:443"));
      const lines = w.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        lines
          .filter((l) => l.message === RUN_END_RETRYING)
          .map((l) => [l.attempt, l.step, l.status, l.retryInMs]),
      ).toEqual([
        [1, "tunnel", 502, 1],
        [2, "tunnel", 502, 2],
        [3, "tunnel", 502, 3],
      ]);
      expect(lines.filter((l) => l.message === RUN_END_NOT_STARTED)).toEqual([
        expect.objectContaining({
          errorType: "WindmillStartError",
          step: "tunnel",
          status: 502,
          attempt: 4,
          namespace: ns,
          job: "agent",
          stop: "failed",
        }),
      ]);
      const logs = w.logs.join("\n");
      expect(logs).not.toContain(TOKEN);
      expect(logs).not.toContain("run-refused");
      // The proxy never sees the token either: it goes only inside the tunnel.
      expect(proxy.heads.join("\n")).not.toContain(TOKEN);
      // Given up means given up: a fresh list does not start it again in this process.
      fake.expire(ns);
      await vi.waitFor(() => expect(fake.calls(ns, "list")).toBe(2));
      await watching(ns);
      await w.starts.settled();
      expect(proxy.tunnels).toHaveLength(4);
    } finally {
      await proxy.close();
    }
  });

  it("a start that fails once and then is accepted starts the flow once", async () => {
    const ns = "agents-flaky";
    fake.put(runJob(ns, "run-flaky", "agent", finished));
    const started: string[] = [];
    const flow: RunEndFlow = {
      start: async (runId) => {
        started.push(runId);
        if (started.length === 1) throw new Error("Windmill did not answer");
      },
    };
    const w = open(flow, [ns], [1]);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    await w.starts.settled();
    expect(started).toEqual(["run-flaky", "run-flaky"]);
    expect(w.logs.filter((l) => l.includes(RUN_END_RETRYING))).toHaveLength(1);
    expect(w.logs.filter((l) => l.includes(RUN_END_STARTED))).toHaveLength(1);
    expect(w.logs.some((l) => l.includes(RUN_END_NOT_STARTED))).toBe(false);
  });
});

describe("the run watcher holds no database access (unit: D-330)", () => {
  it("installs no package and imports no database driver or store", () => {
    const dockerfile = readFileSync("src/run-watcher/Dockerfile", "utf8");
    expect(dockerfile).not.toMatch(/npm (ci|install)/);
    expect(dockerfile).not.toMatch(/store-postgres|src\/core/);
    for (const file of readdirSync("src/run-watcher").filter((f) =>
      f.endsWith(".ts"),
    )) {
      const source = readFileSync(`src/run-watcher/${file}`, "utf8");
      expect(source, file).not.toMatch(/from "pg"|store-postgres|DATABASE_URL/);
    }
  });
});

describe("the run watcher process (integration: container conventions, ADR 0111)", () => {
  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? "",
    KUBERNETES_API: "https://127.0.0.1:1",
    AGENT_NAMESPACES: "agents-process-check",
    WINDMILL_HOST: "windmill.example.com",
    WINDMILL_WORKSPACE: "process-check",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ...extra,
  });
  function startWatcher(values: Record<string, string>) {
    const child = spawn(process.execPath, ["src/run-watcher/main.ts"], {
      env: values,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    return { child, exited, stdout: () => stdout };
  }
  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it.skipIf(process.platform === "win32")(
    "starts from environment config, serves /health while the API is unreachable, logs JSON without the token and exits 0 on SIGTERM",
    async () => {
      const port = await freePort();
      const watcherProcess = startWatcher(
        env({
          PORT: String(port),
          [secretEnvName(RUN_WATCHER_WINDMILL_TOKEN_PATH)]: TOKEN,
        }),
      );
      await vi.waitFor(() => expect(watcherProcess.stdout()).toContain('"listening"'), {
        timeout: 10_000,
      });
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      expect(JSON.parse(watcherProcess.stdout().split("\n")[0] ?? "")).toMatchObject({
        service: "run-watcher",
        message: "listening",
        namespaces: ["agents-process-check"],
      });
      // With no ServiceAccount files here, each list fails and is logged by step and reason.
      await vi.waitFor(
        () => expect(watcherProcess.stdout()).toContain('"reason":"NoCredentials"'),
        { timeout: 10_000 },
      );
      watcherProcess.child.kill("SIGTERM");
      expect(await watcherProcess.exited).toBe(0);
      for (const line of watcherProcess.stdout().trim().split("\n")) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      expect(watcherProcess.stdout()).not.toContain(TOKEN);
    },
  );

  it("refuses to start with a bad setting, naming it without its value", async () => {
    const watcherProcess = startWatcher(
      env({ AGENT_NAMESPACES: "agents-ok,kube-system", KUBERNETES_API: "http://x" }),
    );
    expect(await watcherProcess.exited).toBe(1);
    expect(watcherProcess.stdout()).toContain(
      "AGENT_NAMESPACES entry 2 is not an agents-<slug> namespace",
    );
    expect(watcherProcess.stdout()).toContain("KUBERNETES_API must be https://");
    expect(watcherProcess.stdout()).not.toContain("kube-system");
    expect(watcherProcess.stdout()).not.toContain("http://x");
  });
});
