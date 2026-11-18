import { beforeEach, describe, expect, it } from "vitest";

import { CEILING_MESSAGE } from "../../../egress-proxy/proxy.ts";
import { KubernetesApiError } from "./client.ts";
import { createFakeKubernetes, type FakeKubernetes } from "./fake.ts";
import {
  COUNCIL,
  DEVELOPER,
  GITHUB_TOKEN,
  LIMITS,
  MODEL_KEY,
  QA,
  QA_LIMITS,
  SETTINGS,
  STATE_TOKEN,
  credentialsFor,
  taskFor,
} from "./fixtures.ts";
import type { KubernetesRunSpec } from "./manifests.ts";
import { runNames } from "./names.ts";
import type { Job, Secret } from "./objects.ts";
import {
  createKubernetesRuntime,
  type KubernetesRunHandle,
  type KubernetesRuntime,
} from "./runtime.ts";

// Adapter contract: the Kubernetes runtime against the in-memory fake client (ADR 0106,
// ADR 0107). No cluster and no network.

const NS = "agents-rehearsal";
let fake: FakeKubernetes;
let runtime: KubernetesRuntime;

beforeEach(() => {
  fake = createFakeKubernetes();
  runtime = createKubernetesRuntime({ client: fake, settings: SETTINGS });
});

const task = (spec: KubernetesRunSpec) => ({
  ...spec,
  credentials: credentialsFor(spec),
  task: taskFor(spec),
});
const result = (fields: Record<string, unknown>) =>
  `log line\n${JSON.stringify({ foremanResult: 1, ...fields })}\n`;
const created = () => fake.calls.filter((c) => c.startsWith("create "));
const envValue = (job: Job | undefined, name: string) => {
  const entry = job?.spec.template.spec.containers[0]?.env.find((e) => e.name === name);
  return entry && "value" in entry ? entry.value : undefined;
};

async function finished(handle: KubernetesRunHandle) {
  const status = await runtime.poll(handle);
  if (status.state !== "finished") throw new Error("expected the run to have finished");
  return status.result;
}

describe("start (adapter contract: object order, ADR 0106 sections 2 and 5)", () => {
  it("creates Secrets, then policies, then the proxy and its Service, then the agent Job", async () => {
    await runtime.start(task(DEVELOPER), LIMITS);
    const n = runNames(DEVELOPER.runId);
    expect(created()).toEqual([
      `create Secret/${n.stateTokenSecret}`,
      `create Secret/${n.modelSecret}`,
      `create Secret/${n.githubTokenSecret}`,
      `create Secret/${n.taskSecret}`,
      `create NetworkPolicy/${n.agentPolicy}`,
      `create NetworkPolicy/${n.proxyPolicy}`,
      `create Job/${n.proxyJob}`,
      `create Service/${n.proxyService}`,
      `create Job/${n.agentJob}`,
    ]);
  });

  it("points the agent at the proxy Service's IP address", async () => {
    await runtime.start(task(DEVELOPER), LIMITS);
    const agent = fake.get<Job>("Job", NS, runNames(DEVELOPER.runId).agentJob);
    expect(envValue(agent, "HTTPS_PROXY")).toMatch(/^http:\/\/10\.245\.0\.\d+:8080$/);
  });

  it("returns a handle that holds no credential value and survives JSON", async () => {
    const handle = await runtime.start(task(DEVELOPER), LIMITS);
    const text = JSON.stringify(handle);
    for (const secret of [MODEL_KEY, STATE_TOKEN, GITHUB_TOKEN]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text)).toEqual(handle);
  });

  it("creates nothing for a task that breaks the rules", async () => {
    const bad = {
      ...task(DEVELOPER),
      task: { ...taskFor(DEVELOPER), allowedTools: [] },
    };
    await expect(runtime.start(bad, LIMITS)).rejects.toThrow(/allowed tools/);
    expect(fake.calls).toEqual([]);
  });

  it("writes the task file into its own Secret and tells the agent where it is", async () => {
    await runtime.start(task(DEVELOPER), LIMITS);
    const n = runNames(DEVELOPER.runId);
    const secret = fake.get<Secret>("Secret", NS, n.taskSecret);
    expect(JSON.parse(secret?.stringData["task.json"] ?? "")).toEqual(
      taskFor(DEVELOPER),
    );
    const agent = fake.get<Job>("Job", NS, n.agentJob);
    expect(envValue(agent, "FOREMAN_TASK_FILE")).toBe("/task/task.json");
  });

  it("creates nothing for a run that breaks the rules", async () => {
    await expect(
      runtime.start(task({ ...QA, allowedHosts: ["github.com"] }), QA_LIMITS),
    ).rejects.toThrow(/reaches only/);
    expect(fake.calls).toEqual([]);
  });

  it("removes what it made when a create fails, and reports the error", async () => {
    fake.failNextCreate("Service", 403, "Forbidden");
    await expect(runtime.start(task(DEVELOPER), LIMITS)).rejects.toBeInstanceOf(
      KubernetesApiError,
    );
    expect(fake.objects.size).toBe(0);
  });
});

describe("QA (adapter contract: the fetch step first, ADR 0106 section 5)", () => {
  const n = runNames(QA.runId);

  it("starts with its volume and fetch step only, and no QA Job", async () => {
    await runtime.start(task(QA), QA_LIMITS);
    expect(created()).toEqual([
      `create Secret/${n.stateTokenSecret}`,
      `create Secret/${n.modelSecret}`,
      `create Secret/${n.githubTokenSecret}`,
      `create Secret/${n.taskSecret}`,
      `create PersistentVolumeClaim/${n.workspaceClaim}`,
      `create NetworkPolicy/${n.fetchPolicy}`,
      `create NetworkPolicy/${n.fetchProxyPolicy}`,
      `create Job/${n.fetchProxyJob}`,
      `create Service/${n.fetchProxyService}`,
      `create Job/${n.fetchJob}`,
    ]);
    expect(fake.has("Job", NS, n.agentJob)).toBe(false);
  });

  it("waits for the fetch Job, then starts QA and removes the fetch step and its token", async () => {
    const handle = await runtime.start(task(QA), QA_LIMITS);
    expect(await runtime.poll(handle)).toEqual({ state: "running" });
    expect(fake.has("Job", NS, n.agentJob)).toBe(false);

    fake.finishJob(NS, n.fetchJob, { condition: "Complete" });
    expect(await runtime.poll(handle)).toEqual({ state: "running" });
    expect(fake.has("Job", NS, n.agentJob)).toBe(true);
    for (const [kind, name] of [
      ["Job", n.fetchJob],
      ["Job", n.fetchProxyJob],
      ["Service", n.fetchProxyService],
      ["NetworkPolicy", n.fetchPolicy],
      ["NetworkPolicy", n.fetchProxyPolicy],
      ["Secret", n.githubTokenSecret],
    ] as const) {
      expect(fake.has(kind, NS, name), name).toBe(false);
    }
    // The QA proxy allows no CONNECT host; the volume stays for the QA pod.
    expect(envValue(fake.get<Job>("Job", NS, n.proxyJob), "ALLOWED_HOSTS")).toBe("");
    expect(fake.has("PersistentVolumeClaim", NS, n.workspaceClaim)).toBe(true);

    fake.finishJob(NS, n.agentJob, {
      condition: "Complete",
      log: result({ status: "success", structured: { verdict: "pass" } }),
    });
    const end = await finished(handle);
    expect(end).toMatchObject({ outcome: "success", structured: { verdict: "pass" } });
    expect(end.model).toBe("claude-opus-5-5");
    expect(fake.has("PersistentVolumeClaim", NS, n.workspaceClaim)).toBe(false);
  });

  it("fails closed when the fetch step fails, and never starts QA", async () => {
    const handle = await runtime.start(task(QA), QA_LIMITS);
    fake.finishJob(NS, n.fetchJob, {
      condition: "Failed",
      reason: "BackoffLimitExceeded",
    });
    expect(await finished(handle)).toMatchObject({
      outcome: "fail",
      detail: "fetch_failed",
    });
    expect(fake.calls).not.toContain(`create Job/${n.agentJob}`);
    expect([...fake.objects.keys()]).toEqual([]);
  });

  it("reports a fetch step past its deadline as a timeout", async () => {
    const handle = await runtime.start(task(QA), QA_LIMITS);
    fake.finishJob(NS, n.fetchJob, { condition: "Failed", reason: "DeadlineExceeded" });
    expect(await finished(handle)).toMatchObject({
      outcome: "timeout",
      detail: "fetch_deadline_exceeded",
    });
  });

  it("leaves nothing half made if starting the review fails, and tries again next poll", async () => {
    const handle = await runtime.start(task(QA), QA_LIMITS);
    fake.finishJob(NS, n.fetchJob, { condition: "Complete" });
    fake.failNextCreate("Service", 500, "InternalError");
    await expect(runtime.poll(handle)).rejects.toBeInstanceOf(KubernetesApiError);
    expect(fake.has("Job", NS, n.proxyJob)).toBe(false);
    expect(fake.has("NetworkPolicy", NS, n.agentPolicy)).toBe(false);
    expect(fake.has("Job", NS, n.fetchJob)).toBe(true);
    expect(await runtime.poll(handle)).toEqual({ state: "running" });
    expect(fake.has("Job", NS, n.agentJob)).toBe(true);
  });
});

describe("QA's visual comparison (adapter contract: no fetch step, D-242, N-57)", () => {
  const VISUAL: KubernetesRunSpec = { ...QA, visual: true };
  delete VISUAL.fetchAllowedHosts;
  const n = runNames(VISUAL.runId);
  const visualTask = () => {
    const credentials = credentialsFor(QA);
    delete credentials.githubToken;
    return {
      ...VISUAL,
      credentials,
      task: {
        ...taskFor(QA),
        evidenceIds: [],
        outputSchema: { type: "object" },
        images: [
          {
            label: "Image 1: fixture",
            mediaType: "image/png" as const,
            data: "iVBORw==",
          },
        ],
      },
    };
  };

  it("starts the QA pod at once, with no fetch step, workspace or GitHub token", async () => {
    const handle = await runtime.start(visualTask(), QA_LIMITS);
    expect(created()).not.toContain(`create Secret/${n.githubTokenSecret}`);
    expect(created()).not.toContain(`create PersistentVolumeClaim/${n.workspaceClaim}`);
    expect(created()).not.toContain(`create Job/${n.fetchJob}`);
    const agent = fake.get<Job>("Job", NS, n.agentJob);
    expect(agent).toBeDefined();
    expect(envValue(agent, "FOREMAN_WORKSPACE")).toBeUndefined();
    expect(JSON.stringify(agent)).not.toContain("workspace");
    fake.finishJob(NS, n.agentJob, {
      condition: "Complete",
      log: result({ status: "success", structured: { components: [] } }),
    });
    expect(await finished(handle)).toMatchObject({ outcome: "success" });
  });

  it("refuses a GitHub token, fetch hosts, or images on the wrong kind of run", async () => {
    const withToken = { ...visualTask(), credentials: credentialsFor(QA) };
    await expect(runtime.start(withToken, QA_LIMITS)).rejects.toThrow(
      "a qa run holds no GitHub token",
    );
    const withHosts = { ...visualTask(), fetchAllowedHosts: QA.fetchAllowedHosts };
    await expect(runtime.start(withHosts, QA_LIMITS)).rejects.toThrow(
      "a visual comparison run has no fetch step",
    );
    const reviewWithImages = { ...task(QA), task: visualTask().task };
    await expect(runtime.start(reviewWithImages, QA_LIMITS)).rejects.toThrow(
      "only a visual comparison or Council run carries images",
    );
    expect(created()).toEqual([]);
  });
});

describe("the Council's visual call (adapter contract: images, no fetch step, D-270)", () => {
  const images = [
    { label: "Image 1: option a", mediaType: "image/png" as const, data: "iVBORw==" },
  ];

  it("starts a Council run with the option screenshots in its task file", async () => {
    const handle = await runtime.start(
      { ...task(COUNCIL), task: { ...taskFor(COUNCIL), images } },
      LIMITS,
    );
    const n = runNames(COUNCIL.runId);
    expect(created()).not.toContain(`create Job/${n.fetchJob}`);
    expect(created()).not.toContain(`create Secret/${n.githubTokenSecret}`);
    const file = fake.get<Secret>("Secret", NS, n.taskSecret);
    expect(JSON.parse(file?.stringData["task.json"] ?? "{}")).toMatchObject({ images });
    expect(handle.spec.visual).toBeUndefined();
  });

  it("refuses images on a Triage run", async () => {
    const triage: KubernetesRunSpec = { ...COUNCIL, role: "triage" };
    await expect(
      runtime.start(
        {
          ...triage,
          credentials: credentialsFor(triage),
          task: { ...taskFor(triage), images },
        },
        LIMITS,
      ),
    ).rejects.toThrow("only a visual comparison or Council run carries images");
    expect(created()).toEqual([]);
  });
});

describe("poll (adapter contract: outcome mapping, ADR 0106 section 6)", () => {
  const n = runNames(DEVELOPER.runId);
  let handle: KubernetesRunHandle;
  beforeEach(async () => {
    handle = await runtime.start(task(DEVELOPER), LIMITS);
  });

  it("reports running until the Job ends", async () => {
    expect(await runtime.poll(handle)).toEqual({ state: "running" });
  });

  it("maps success with the result's counts and the Job's minutes", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Complete",
      log: result({
        status: "success",
        finalText: "pushed",
        turns: 7,
        costUsd: 0.4,
        tokens: { uncachedInput: 100, cachedInput: 5000, output: 900 },
      }),
    });
    expect(await finished(handle)).toEqual({
      outcome: "success",
      detail: "success",
      finalText: "pushed",
      turns: 7,
      costUsd: 0.4,
      minutes: 10,
      tokens: { uncachedInput: 100, cachedInput: 5000, output: 900 },
      model: "claude-sonnet-5-5",
    });
  });

  it("maps the deadline to timeout", async () => {
    fake.finishJob(NS, n.agentJob, { condition: "Failed", reason: "DeadlineExceeded" });
    expect(await finished(handle)).toMatchObject({ outcome: "timeout" });
  });

  it("maps the proxy's ceiling message to budget_exceeded", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Failed",
      reason: "BackoffLimitExceeded",
      log: result({ status: "error", errorText: `403 ${CEILING_MESSAGE}` }),
    });
    expect(await finished(handle)).toMatchObject({
      outcome: "budget_exceeded",
      detail: "proxy_ceiling",
    });
  });

  it("maps the runtime's turn cap to budget_exceeded", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Failed",
      reason: "BackoffLimitExceeded",
      log: result({ status: "max_turns", turns: 100 }),
    });
    expect(await finished(handle)).toMatchObject({
      outcome: "budget_exceeded",
      turns: 100,
    });
  });

  it("maps a provider rate limit to usage_exhausted with its cause and retry-after", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Failed",
      reason: "BackoffLimitExceeded",
      log: result({
        status: "error",
        providerError: {
          status: 429,
          type: "rate_limit_error",
          retryAfterSeconds: 120,
        },
      }),
    });
    expect(await finished(handle)).toMatchObject({
      outcome: "usage_exhausted",
      usageExhaustedCause: "rate_limit",
      retryAfterSeconds: 120,
    });
  });

  it("maps bad agent output to fail, and never throws", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Complete",
      log: '{"foremanResult":1,"status":"success"\npanic: oh no',
    });
    expect(await finished(handle)).toMatchObject({
      outcome: "fail",
      detail: "bad_output",
    });
  });

  it("maps a failed pod with no output to fail", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Failed",
      reason: "BackoffLimitExceeded",
    });
    const end = await finished(handle);
    expect(end).toMatchObject({ outcome: "fail", detail: "bad_output" });
    // The pod says only that it failed: no end reason or exit code to show.
    expect(end.failure).toBeUndefined();
  });

  describe("the pod's end beside bad_output (D-415)", () => {
    const MESSAGE = "made-up kubelet message naming node-7";
    const agentEnded = (reason: string, exitCode: number) => ({
      name: "agent",
      state: { terminated: { reason, exitCode, message: MESSAGE } },
    });

    it("shows an out-of-memory kill and its exit code, never the kubelet's message", async () => {
      fake.finishJob(NS, n.agentJob, {
        condition: "Failed",
        reason: "BackoffLimitExceeded",
        pods: [
          {
            status: {
              phase: "Failed",
              containerStatuses: [agentEnded("OOMKilled", 137)],
            },
          },
        ],
      });
      const end = await finished(handle);
      expect(end).toMatchObject({ outcome: "fail", detail: "bad_output" });
      expect(end.failure).toEqual({ podReason: "OOMKilled", exitCode: 137 });
      expect(JSON.stringify(end)).not.toContain("node-7");
      // Polling again reads the same end from the kept Job's pod.
      expect(await finished(handle)).toEqual(end);
    });

    it("shows an eviction by the pod's own reason", async () => {
      fake.finishJob(NS, n.agentJob, {
        condition: "Failed",
        reason: "BackoffLimitExceeded",
        pods: [
          {
            status: {
              phase: "Failed",
              reason: "Evicted",
              containerStatuses: [agentEnded("ContainerStatusUnknown", 137)],
            },
          },
        ],
      });
      expect((await finished(handle)).failure).toEqual({
        podReason: "Evicted",
        exitCode: 137,
      });
    });

    it("gives no detail and no error when the Job's pod is gone", async () => {
      fake.finishJob(NS, n.agentJob, {
        condition: "Failed",
        reason: "BackoffLimitExceeded",
        pods: [],
      });
      const end = await finished(handle);
      expect(end).toMatchObject({ outcome: "fail", detail: "bad_output" });
      expect(end.failure).toBeUndefined();
      expect(fake.calls.filter((c) => c.startsWith("log "))).toEqual([]);
    });

    it("reads the log and the end of the newest pod that ended", async () => {
      fake.finishJob(NS, n.agentJob, {
        condition: "Failed",
        reason: "BackoffLimitExceeded",
        pods: [
          {
            name: "run-x-agent-aaaaa",
            creationTimestamp: "2026-11-18T10:00:00Z",
            status: { phase: "Failed", containerStatuses: [agentEnded("Error", 1)] },
            log: result({
              status: "error",
              errorText: "the model declined the request",
            }),
          },
          {
            name: "run-x-agent-bbbbb",
            creationTimestamp: "2026-11-18T10:05:00Z",
            status: {
              phase: "Failed",
              containerStatuses: [agentEnded("OOMKilled", 137)],
            },
            log: "panic: out of memory",
          },
        ],
      });
      const end = await finished(handle);
      expect(fake.calls).toContain("log Pod/run-x-agent-bbbbb");
      expect(fake.calls).not.toContain("log Pod/run-x-agent-aaaaa");
      expect(end).toMatchObject({ outcome: "fail", detail: "bad_output" });
      expect(end.failure).toEqual({ podReason: "OOMKilled", exitCode: 137 });
    });

    it("adds nothing when the agent's result line was read", async () => {
      fake.finishJob(NS, n.agentJob, {
        condition: "Failed",
        reason: "BackoffLimitExceeded",
        pods: [
          { status: { phase: "Failed", containerStatuses: [agentEnded("Error", 1)] } },
        ],
        log: result({ status: "error", errorText: "the model declined the request" }),
      });
      expect(await finished(handle)).toMatchObject({
        outcome: "fail",
        detail: "job_failed",
        failure: { error: "the model declined the request" },
      });
      expect((await finished(handle)).failure).not.toHaveProperty("podReason");
    });

    it("reads no pod for a run past its deadline", async () => {
      fake.finishJob(NS, n.agentJob, {
        condition: "Failed",
        reason: "DeadlineExceeded",
        pods: [
          {
            status: { phase: "Failed", containerStatuses: [agentEnded("Error", 137)] },
          },
        ],
      });
      const end = await finished(handle);
      expect(end).toMatchObject({ outcome: "timeout", detail: "deadline_exceeded" });
      expect(end.failure).toBeUndefined();
      expect(fake.calls).not.toContain("list Pod");
    });
  });

  it("deletes the Secrets and everything but the agent Job once it sees the end", async () => {
    fake.finishJob(NS, n.agentJob, {
      condition: "Complete",
      log: result({ status: "success" }),
    });
    const first = await finished(handle);
    expect([...fake.objects.keys()]).toEqual([`Job/${NS}/${n.agentJob}`]);
    // Polling again reads the same result from the kept Job.
    expect(await finished(handle)).toEqual(first);
    await runtime.cleanup(handle);
    expect(fake.objects.size).toBe(0);
  });
});

describe("cancel and cleanup (adapter contract: ADR 0106 section 6)", () => {
  const n = runNames(DEVELOPER.runId);

  it("deletes the run's Jobs with the grace period, and is safe to call twice", async () => {
    const handle = await runtime.start(task(DEVELOPER), LIMITS);
    await runtime.cancel(handle);
    await runtime.cancel(handle);
    expect(fake.calls).toContain(`delete Job/${n.agentJob} grace=30`);
    expect(fake.has("Job", NS, n.agentJob)).toBe(false);
  });

  it("reports running while the pod stops, then cancelled, and then cleans up", async () => {
    const handle = await runtime.start(task(DEVELOPER), LIMITS);
    fake.markDeleting(NS, n.agentJob);
    expect(await runtime.poll(handle)).toEqual({ state: "running" });
    await runtime.cancel(handle);
    expect(await finished(handle)).toMatchObject({
      outcome: "cancelled",
      detail: "job_deleted",
    });
    expect(fake.objects.size).toBe(0);
  });

  it("cancels QA during its fetch step", async () => {
    const handle = await runtime.start(task(QA), QA_LIMITS);
    await runtime.cancel(handle);
    expect(await finished(handle)).toMatchObject({ outcome: "cancelled" });
    expect(fake.objects.size).toBe(0);
  });

  it("finds the run's Jobs by label and leaves other runs alone", async () => {
    const dev = await runtime.start(task(DEVELOPER), LIMITS);
    const council = await runtime.start(task(COUNCIL), LIMITS);
    // A Job with the run's label but a name the runtime did not choose.
    const stray = fake.get<Job>("Job", NS, n.agentJob) as Job;
    await fake.create({ ...stray, metadata: { ...stray.metadata, name: "run-stray" } });
    await runtime.cleanup(dev);
    expect(fake.has("Job", NS, "run-stray")).toBe(false);
    const left = [...fake.objects.values()];
    expect(left.length).toBeGreaterThan(0);
    expect(
      left.every((o) => o.metadata.labels?.["foreman/run-id"] === council.runId),
    ).toBe(true);
  });
});
