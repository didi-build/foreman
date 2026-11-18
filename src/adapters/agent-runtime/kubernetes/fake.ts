// An in-memory Kubernetes for tests (ADR 0106). It implements the same client interface, keeps
// the same namespace rule, and records every call in order. Jobs never run by themselves: a test
// moves a Job to its end with `finishJob`, which also makes its pod and log, as the Job
// controller and the kubelet would. `startPod` gives a Job that is still running, such as a run's
// egress proxy, its pod and log so far.
import {
  KubernetesApiError,
  checkName,
  checkNamespace,
  labelSelector,
  type KubernetesClient,
} from "./client.ts";
import type {
  JobStatus,
  Labels,
  PodStatus,
  RunObject,
  RunObjectKind,
} from "./objects.ts";

export interface JobEnd {
  /** `Complete`, or `Failed` with a reason such as `DeadlineExceeded` or `BackoffLimitExceeded`. */
  condition: "Complete" | "Failed";
  reason?: string;
  /** The agent container's log. */
  log?: string;
  startTime?: string;
  completionTime?: string;
  /**
   * The Job's pods as the kubelet left them (D-415). Default: one pod named `<job>-abcde` with
   * `log` and the phase of `condition`. `[]` for a Job whose pod is gone.
   */
  pods?: FakePod[];
}

export interface FakePod {
  /** Default `<job>-abcde`. */
  name?: string;
  creationTimestamp?: string;
  /** Default: the phase of the Job's condition. */
  status?: PodStatus["status"];
  /** The container's log. Default: the Job end's `log`. */
  log?: string;
}

export interface FakeKubernetes extends KubernetesClient {
  /** Every call, in order, as `verb Kind/name` (or `verb Kind` for lists). */
  readonly calls: string[];
  /** The objects that exist now, by `Kind/namespace/name`. */
  readonly objects: ReadonlyMap<string, RunObject>;
  has(kind: RunObjectKind, namespace: string, name: string): boolean;
  get<T extends RunObject>(
    kind: T["kind"],
    namespace: string,
    name: string,
  ): T | undefined;
  /** Moves a Job to its end and gives it its pods: by default one, with the given log. */
  finishJob(namespace: string, name: string, end: JobEnd): void;
  /** Gives a running Job a pod (phase `Running` unless given) and its log so far. */
  startPod(namespace: string, name: string, pod?: FakePod): void;
  /** Marks a Job as being deleted, as a Foreground delete does while its pods stop. */
  markDeleting(namespace: string, name: string): void;
  /** Makes the next create of this kind fail with the given status. */
  failNextCreate(kind: RunObjectKind, status: number, reason: string): void;
}

const key = (kind: string, namespace: string, name: string): string =>
  `${kind}/${namespace}/${name}`;

function matches(labels: Labels | undefined, selector: Labels): boolean {
  return Object.entries(selector).every(([k, v]) => labels?.[k] === v);
}

export function createFakeKubernetes(): FakeKubernetes {
  const objects = new Map<string, RunObject>();
  const jobStatus = new Map<string, JobStatus["status"]>();
  const deleting = new Set<string>();
  const pods = new Map<string, { pod: PodStatus; log: string }>();
  const failures = new Map<RunObjectKind, { status: number; reason: string }>();
  const calls: string[] = [];
  let nextAddress = 10;

  /** Makes a Job's pods with its template's labels, as the Job controller does. */
  const addPods = (
    namespace: string,
    name: string,
    made: readonly FakePod[],
    phase: string,
    log: string,
  ): void => {
    const job = objects.get(key("Job", namespace, name));
    if (!job || job.kind !== "Job") throw new Error(`fake has no Job ${name}`);
    for (const pod of made) {
      const podName = pod.name ?? `${name}-abcde`;
      pods.set(`${namespace}/${podName}`, {
        pod: {
          metadata: {
            name: podName,
            namespace,
            labels: { ...job.spec.template.metadata.labels, "job-name": name },
            ...(pod.creationTimestamp === undefined
              ? {}
              : { creationTimestamp: pod.creationTimestamp }),
          },
          status: pod.status ?? { phase },
        },
        log: pod.log ?? log,
      });
    }
  };

  const jobView = (namespace: string, name: string): JobStatus | null => {
    const object = objects.get(key("Job", namespace, name));
    if (!object) return null;
    const k = key("Job", namespace, name);
    return structuredClone({
      metadata: {
        ...object.metadata,
        ...(deleting.has(k) ? { deletionTimestamp: "2026-10-30T12:00:00Z" } : {}),
      },
      status: jobStatus.get(k) ?? {},
    });
  };

  return {
    calls,
    objects,

    has: (kind, namespace, name) => objects.has(key(kind, namespace, name)),
    get: <T extends RunObject>(kind: T["kind"], namespace: string, name: string) =>
      objects.get(key(kind, namespace, name)) as T | undefined,

    async create(object) {
      const namespace = checkNamespace(object.metadata.namespace);
      const name = checkName(object.metadata.name);
      calls.push(`create ${object.kind}/${name}`);
      const failure = failures.get(object.kind);
      if (failure) {
        failures.delete(object.kind);
        throw new KubernetesApiError(
          `create ${object.kind}`,
          failure.status,
          failure.reason,
        );
      }
      const k = key(object.kind, namespace, name);
      if (objects.has(k)) {
        throw new KubernetesApiError(`create ${object.kind}`, 409, "AlreadyExists");
      }
      objects.set(k, structuredClone(object));
      if (object.kind === "Service") {
        const clusterIP = `10.245.0.${nextAddress++}`;
        return { name, clusterIP };
      }
      return { name };
    },

    async delete(kind, namespace, name, options) {
      checkNamespace(namespace);
      calls.push(
        `delete ${kind}/${checkName(name)}` +
          (options?.gracePeriodSeconds === undefined
            ? ""
            : ` grace=${options.gracePeriodSeconds}`),
      );
      const k = key(kind, namespace, name);
      if (!objects.has(k)) return false;
      objects.delete(k);
      deleting.delete(k);
      jobStatus.delete(k);
      if (kind === "Job") {
        for (const [podKey, { pod }] of pods) {
          if (pod.metadata.labels?.["job-name"] === name) pods.delete(podKey);
        }
      }
      return true;
    },

    async getJob(namespace, name) {
      checkNamespace(namespace);
      calls.push(`get Job/${checkName(name)}`);
      return jobView(namespace, name);
    },

    async listJobs(namespace, selector) {
      checkNamespace(namespace);
      labelSelector(selector);
      calls.push("list Job");
      return [...objects.values()]
        .filter(
          (o) =>
            o.kind === "Job" &&
            o.metadata.namespace === namespace &&
            matches(o.metadata.labels, selector),
        )
        .map((o) => jobView(namespace, o.metadata.name) as JobStatus);
    },

    async listPods(namespace, selector) {
      checkNamespace(namespace);
      labelSelector(selector);
      calls.push("list Pod");
      return [...pods.values()]
        .filter(
          ({ pod }) =>
            pod.metadata.namespace === namespace &&
            matches(pod.metadata.labels, selector),
        )
        .map(({ pod }) => structuredClone(pod));
    },

    async readPodLog(namespace, pod, options) {
      checkNamespace(namespace);
      calls.push(`log Pod/${checkName(pod)}`);
      const entry = pods.get(`${namespace}/${pod}`);
      if (!entry) return null;
      const lines = entry.log.split("\n");
      const tail = lines.slice(-options.tailLines - (entry.log.endsWith("\n") ? 1 : 0));
      return tail.join("\n").slice(0, options.limitBytes);
    },

    finishJob(namespace, name, end) {
      const k = key("Job", namespace, name);
      const job = objects.get(k);
      if (!job || job.kind !== "Job") throw new Error(`fake has no Job ${name}`);
      jobStatus.set(k, {
        conditions: [{ type: end.condition, status: "True", reason: end.reason }],
        startTime: end.startTime ?? "2026-10-30T12:00:00Z",
        completionTime: end.completionTime ?? "2026-10-30T12:10:00Z",
      });
      const phase = end.condition === "Complete" ? "Succeeded" : "Failed";
      addPods(namespace, name, end.pods ?? [{}], phase, end.log ?? "");
    },

    startPod(namespace, name, pod = {}) {
      addPods(namespace, name, [pod], "Running", "");
    },

    markDeleting(namespace, name) {
      deleting.add(key("Job", namespace, name));
    },

    failNextCreate(kind, status, reason) {
      failures.set(kind, { status, reason });
    },
  };
}
