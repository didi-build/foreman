// The Kubernetes agent runtime (ADR 0106, ADR 0107). `start` creates a run's objects in order
// and returns at once; `poll` reads the Job and the agent's result, and moves QA from its fetch
// step to its review; `cancel` deletes the run's Jobs with the grace period. Once `poll` sees an
// end it deletes the run's Secrets and every other object but the agent Job, whose pod holds the
// result; `cleanup` removes that too, after the runner has recorded the end. The result is read
// from the run's pod, and a run that left none shows how that pod ended (D-415, ./pod-end.ts).
// When the agent reported no served tier, the tier comes from the tally its egress proxy logged
// (D-423, O-151), read from the proxy's pod before the proxy is deleted. A QA review with a browser
// (ADR 0119 slice 5b, D-476) gets its site Secret at `start` and its browser pod in `startReview`,
// beside the agent stage; the browser goes with the run's other objects, and `cancel` stops it.
//
// Every object is deleted by its fixed name: the runner's Role cannot list Secrets, Services,
// NetworkPolicies or PersistentVolumeClaims, on purpose. Jobs are also found by label.
// Nothing here logs, and no credential value is kept: the handle holds only the run's spec.
import type { ServedTier } from "../../../core/store.ts";
import {
  parseServedTiersLog,
  servedTierOf,
} from "../../../egress-proxy/served-tiers.ts";
import type { AgentRunStatus, AgentRuntime, RunLimits } from "../runtime.ts";
import {
  KubernetesApiError,
  type DeleteOptions,
  type KubernetesClient,
} from "./client.ts";
import {
  agentStage,
  browserStage,
  checkRunSpec,
  checkSettings,
  fetchStage,
  hasFetchStep,
  runSecrets,
  siteSecret,
  taskSecret,
  workspaceClaim,
  type KubernetesRunSettings,
  type KubernetesRunSpec,
  type ProxyStage,
  type RunCredentials,
} from "./manifests.ts";
import { LABEL_COMPONENT, agentNamespace, runNames, runSelector } from "./names.ts";
import type { RunObjectKind } from "./objects.ts";
import { podEnd, runPod, type PodEnd } from "./pod-end.ts";
import {
  jobState,
  mapRunEnd,
  parseAgentResult,
  withProxyServedTier,
  type AgentResult,
} from "./result.ts";
import type { AgentTaskFile } from "./task.ts";

export interface KubernetesAgentTask extends KubernetesRunSpec {
  credentials: RunCredentials;
  /** The run's task file (./task.ts). Written into a per-run Secret, never kept in the handle. */
  task: AgentTaskFile;
  /**
   * A browser run's site: the zip the runner read and checked (ADR 0119 slice 5a). Written into
   * the run's site Secret, never kept in the handle. Required exactly when `browser` is set.
   */
  site?: Uint8Array;
}

/** Plain JSON, safe to store between reconcile passes. No credential values. */
export interface KubernetesRunHandle {
  runtime: "kubernetes";
  runId: string;
  namespace: string;
  spec: KubernetesRunSpec;
  limits: RunLimits;
}

export interface KubernetesRuntime extends AgentRuntime<
  KubernetesAgentTask,
  KubernetesRunHandle
> {
  /** Delete every object of the run, the agent Job included. Safe to call twice. */
  cleanup(handle: KubernetesRunHandle): Promise<void>;
}

/** How much of the agent's log is read for its result. */
const LOG_TAIL_LINES = 50;
const LOG_LIMIT_BYTES = 256 * 1024;
/** The agent pod's one container: the manifests name each container after its component. */
const AGENT_CONTAINER = "agent";
/** The agent's proxy pod's one container, and how much of its log is read for the tally. */
const PROXY_CONTAINER = "proxy";
const PROXY_LOG_TAIL_LINES = 200;
const PROXY_LOG_LIMIT_BYTES = 256 * 1024;

type Owned = [RunObjectKind, string];

export function createKubernetesRuntime(options: {
  client: KubernetesClient;
  settings: KubernetesRunSettings;
}): KubernetesRuntime {
  const { client, settings } = options;
  checkSettings(settings);

  /** Create a stage: its policies, then the proxy and its Service, then the client Job. */
  async function createStage(namespace: string, stage: ProxyStage, made: Owned[]) {
    for (const policy of stage.policies) {
      await client.create(policy);
      made.push(["NetworkPolicy", policy.metadata.name]);
    }
    await client.create(stage.proxyJob);
    made.push(["Job", stage.proxyJob.metadata.name]);
    const service = await client.create(stage.proxyService);
    made.push(["Service", stage.proxyService.metadata.name]);
    if (!service.clusterIP) {
      throw new KubernetesApiError(`create Service in ${namespace}`, 0, "NoClusterIP");
    }
    const clientJob = stage.clientJob(service.clusterIP);
    await client.create(clientJob);
    made.push(["Job", clientJob.metadata.name]);
  }

  /** Delete objects by name, all of them even if one fails, then report the first failure. */
  async function remove(
    namespace: string,
    owned: Owned[],
    deleteOptions: DeleteOptions = { propagationPolicy: "Background" },
  ) {
    let failure: unknown;
    for (const [kind, name] of owned) {
      try {
        await client.delete(kind, namespace, name, deleteOptions);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /** Every object a run can own, Jobs first so no pod outlives its policies or credentials. */
  function ownedObjects(handle: KubernetesRunHandle, keepAgentJob: boolean): Owned[] {
    const n = runNames(handle.runId);
    const owned: Owned[] = [
      ...(keepAgentJob ? [] : ([["Job", n.agentJob]] as Owned[])),
      ["Job", n.fetchJob],
      ["Job", n.proxyJob],
      ["Job", n.fetchProxyJob],
      ["Service", n.proxyService],
      ["Service", n.fetchProxyService],
      ["NetworkPolicy", n.agentPolicy],
      ["NetworkPolicy", n.proxyPolicy],
      ["NetworkPolicy", n.fetchPolicy],
      ["NetworkPolicy", n.fetchProxyPolicy],
      ["Secret", n.stateTokenSecret],
      ["Secret", n.githubTokenSecret],
      ["Secret", n.modelSecret],
      ["Secret", n.taskSecret],
      ["PersistentVolumeClaim", n.workspaceClaim],
    ];
    if (handle.spec.browser === true) {
      // QA's browser (ADR 0119 slice 5b): its Job before its network and its site.
      owned.splice(keepAgentJob ? 0 : 1, 0, ["Job", n.browserJob]);
      owned.push(
        ["Service", n.browserService],
        ["NetworkPolicy", n.browserPolicy],
        ["NetworkPolicy", n.agentBrowserPolicy],
        ["Secret", n.siteSecret],
      );
    }
    return owned;
  }

  async function removeRun(handle: KubernetesRunHandle, keepAgentJob: boolean) {
    const n = runNames(handle.runId);
    const named = ownedObjects(handle, keepAgentJob);
    // Any other Job with the run's label, should one exist.
    const labelled = (
      await client.listJobs(handle.namespace, runSelector(handle.runId))
    )
      .map((job) => job.metadata.name)
      .filter(
        (name) =>
          !named.some(([kind, owned]) => kind === "Job" && owned === name) &&
          !(keepAgentJob && name === n.agentJob),
      )
      .map((name): Owned => ["Job", name]);
    await remove(handle.namespace, [...labelled, ...named]);
  }

  /**
   * The agent's result from its pod's log, and how that pod ended (D-415), from one listing of
   * the run's agent pods. No pod is no result and no end.
   */
  async function readResult(
    handle: KubernetesRunHandle,
  ): Promise<{ result: AgentResult | null; pod: PodEnd | null }> {
    const pods = await client.listPods(handle.namespace, {
      ...runSelector(handle.runId),
      [LABEL_COMPONENT]: "agent",
    });
    const pod = runPod(pods, AGENT_CONTAINER);
    if (pod === null) return { result: null, pod: null };
    const log = await client.readPodLog(handle.namespace, pod.metadata.name, {
      container: AGENT_CONTAINER,
      tailLines: LOG_TAIL_LINES,
      limitBytes: LOG_LIMIT_BYTES,
    });
    return { result: parseAgentResult(log), pod: podEnd(pod, AGENT_CONTAINER) };
  }

  /**
   * The tier the run's egress proxy counted its served model requests at (D-423, O-151), from
   * the newest tally line in the tail of its log: it logs one after each served request, so the
   * newest covers every request once the agent has ended. Null when there is not exactly one
   * proxy pod (its Job never retries, so a second one means the count may be split), when its log
   * is gone or reached the byte limit (it may be cut), when no well-formed tally line is found, or
   * when any read fails: the end is then recorded as before, priced at Standard. Never throws.
   */
  async function proxyServedTier(
    handle: KubernetesRunHandle,
  ): Promise<ServedTier | null> {
    try {
      const pods = await client.listPods(handle.namespace, {
        ...runSelector(handle.runId),
        [LABEL_COMPONENT]: "proxy",
      });
      const name = pods.length === 1 ? pods[0]?.metadata?.name : undefined;
      if (typeof name !== "string") return null;
      const log = await client.readPodLog(handle.namespace, name, {
        container: PROXY_CONTAINER,
        tailLines: PROXY_LOG_TAIL_LINES,
        limitBytes: PROXY_LOG_LIMIT_BYTES,
      });
      if (log === null || Buffer.byteLength(log, "utf8") >= PROXY_LOG_LIMIT_BYTES) {
        return null;
      }
      const tally = parseServedTiersLog(log, handle.runId);
      return tally === null ? null : servedTierOf(tally);
    } catch {
      return null;
    }
  }

  async function finish(
    handle: KubernetesRunHandle,
    result: ReturnType<typeof mapRunEnd>,
  ): Promise<AgentRunStatus> {
    // The end is known: the run's credentials and network go now. The agent Job stays until
    // `cleanup`, so a poll that runs again reads the same result.
    await removeRun(handle, true);
    return { state: "finished", result };
  }

  const cancelled = (handle: KubernetesRunHandle, detail: string) =>
    finish(handle, {
      outcome: "cancelled",
      detail,
      finalText: "",
      turns: null,
      costUsd: null,
      minutes: null,
      tokens: null,
      model: handle.spec.model,
    });

  /**
   * A browser run's browser pod (ADR 0119 slice 5b): its two policies, its Job and its Service.
   * Gives the Service's IP address, which the agent is pointed at.
   */
  async function createBrowser(handle: KubernetesRunHandle, made: Owned[]) {
    const stage = browserStage(handle.spec, handle.limits, settings);
    for (const policy of stage.policies) {
      await client.create(policy);
      made.push(["NetworkPolicy", policy.metadata.name]);
    }
    await client.create(stage.job);
    made.push(["Job", stage.job.metadata.name]);
    const service = await client.create(stage.service);
    made.push(["Service", stage.service.metadata.name]);
    if (!service.clusterIP) {
      throw new KubernetesApiError(
        `create Service in ${handle.namespace}`,
        0,
        "NoClusterIP",
      );
    }
    return service.clusterIP;
  }

  /**
   * QA after its fetch step succeeded: the browser pod for a browser run, the review stage, then
   * the fetch step goes.
   */
  async function startReview(handle: KubernetesRunHandle): Promise<void> {
    const n = runNames(handle.runId);
    const made: Owned[] = [];
    try {
      const browserAddress =
        handle.spec.browser === true ? await createBrowser(handle, made) : undefined;
      await createStage(
        handle.namespace,
        agentStage(handle.spec, handle.limits, settings, browserAddress),
        made,
      );
    } catch (error) {
      // Leave nothing half made, so the next poll tries again from the same place.
      await remove(handle.namespace, made.reverse()).catch(() => {});
      throw error;
    }
    // The fetch step's GitHub token, proxy and policies are no longer needed.
    await remove(handle.namespace, [
      ["Job", n.fetchJob],
      ["Job", n.fetchProxyJob],
      ["Service", n.fetchProxyService],
      ["NetworkPolicy", n.fetchPolicy],
      ["NetworkPolicy", n.fetchProxyPolicy],
      ["Secret", n.githubTokenSecret],
    ]);
  }

  return {
    async start(task, limits) {
      const { credentials, task: taskFile, site, ...spec } = task;
      checkRunSpec(spec, limits);
      if ((spec.browser === true) !== (site !== undefined)) {
        throw new Error(
          spec.browser === true
            ? "a browser run needs its site"
            : "only a browser run carries a site",
        );
      }
      // The visual comparison's images are in its task file, and of QA's runs only it carries
      // them (D-242). A Council run may carry the option screenshots of its visual call (D-270);
      // it has no fetch step either way. No other run carries images.
      if (
        spec.role === "council"
          ? false
          : (spec.visual === true) !== (taskFile.images !== undefined)
      ) {
        throw new Error("only a visual comparison or Council run carries images");
      }
      const namespace = agentNamespace(spec.projectSlug);
      // Build everything first, so a bad input fails before anything is created.
      const secrets = [
        ...runSecrets(spec, credentials),
        taskSecret(spec, taskFile),
        ...(site === undefined ? [] : [siteSecret(spec, site)]),
      ];
      const firstStage = hasFetchStep(spec)
        ? fetchStage(spec, settings)
        : agentStage(spec, limits, settings);
      const handle: KubernetesRunHandle = {
        runtime: "kubernetes",
        runId: spec.runId,
        namespace,
        spec: structuredClone(spec),
        limits: { ...limits },
      };
      const made: Owned[] = [];
      try {
        for (const secret of secrets) {
          await client.create(secret);
          made.push(["Secret", secret.metadata.name]);
        }
        if (hasFetchStep(spec)) {
          const claim = workspaceClaim(spec, settings);
          await client.create(claim);
          made.push(["PersistentVolumeClaim", claim.metadata.name]);
        }
        await createStage(namespace, firstStage, made);
      } catch (error) {
        // Fail closed: remove what was made, newest first, then report the first error.
        await remove(namespace, made.reverse()).catch(() => {});
        throw error;
      }
      return handle;
    },

    async poll(handle) {
      const n = runNames(handle.runId);
      const agentJob = await client.getJob(handle.namespace, n.agentJob);
      if (agentJob === null && hasFetchStep(handle.spec)) {
        const fetchJob = await client.getJob(handle.namespace, n.fetchJob);
        const fetch = jobState(fetchJob);
        if (fetch === "running" || fetch === "stopping") return { state: "running" };
        if (fetch === "gone") return cancelled(handle, "job_deleted");
        if (fetch === "complete") {
          await startReview(handle);
          return { state: "running" };
        }
        // The fetch step failed, for example on a secret-scan hit: fail closed (ADR 0106).
        const result = mapRunEnd(fetch, fetchJob, null, handle.spec.model);
        return finish(handle, {
          ...result,
          detail: fetch === "deadline" ? "fetch_deadline_exceeded" : "fetch_failed",
        });
      }
      const state = jobState(agentJob);
      if (state === "running" || state === "stopping") return { state: "running" };
      // Kubernetes deletes a Job by itself only after ttlSecondsAfterFinished. A Job gone
      // before the runner read it was stopped from outside the run: `cancel`, or by hand.
      if (state === "gone") return cancelled(handle, "job_deleted");
      const read = state === "deadline" ? null : await readResult(handle);
      const end = mapRunEnd(
        state,
        agentJob,
        read?.result ?? null,
        handle.spec.model,
        handle.spec.serviceTier,
        read?.pod ?? null,
      );
      // The proxy's tally is read only for an end that was read and names no tier, and before
      // `finish` deletes the proxy (D-423).
      const proxyTier =
        read === null || end.serviceTierServed !== undefined
          ? null
          : await proxyServedTier(handle);
      return finish(handle, withProxyServedTier(end, proxyTier));
    },

    async cancel(handle) {
      const n = runNames(handle.runId);
      // SIGTERM, then the forced stop after the grace period (ADR 0106 section 6). Foreground:
      // the Job stays, marked as deleting, until its pod has stopped, so `poll` reports
      // `cancelled` only after the stop. Deleting a Job that is already gone is not an error,
      // so this is safe to call twice.
      await remove(
        handle.namespace,
        [
          ["Job", n.agentJob],
          ["Job", n.fetchJob],
          ...(handle.spec.browser === true ? ([["Job", n.browserJob]] as Owned[]) : []),
        ],
        {
          propagationPolicy: "Foreground",
          gracePeriodSeconds: settings.terminationGracePeriodSeconds,
        },
      );
    },

    cleanup: (handle) => removeRun(handle, false),
  };
}
