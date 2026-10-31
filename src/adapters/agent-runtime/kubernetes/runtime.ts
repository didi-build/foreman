// The Kubernetes agent runtime (ADR 0106, ADR 0107). `start` creates a run's objects in order
// and returns at once; `poll` reads the Job and the agent's result, and moves QA from its fetch
// step to its review; `cancel` deletes the run's Jobs with the grace period. Once `poll` sees an
// end it deletes the run's Secrets and every other object but the agent Job, whose pod holds the
// result; `cleanup` removes that too, after the runner has recorded the end.
//
// Every object is deleted by its fixed name: the runner's Role cannot list Secrets, Services,
// NetworkPolicies or PersistentVolumeClaims, on purpose. Jobs are also found by label.
// Nothing here logs, and no credential value is kept: the handle holds only the run's spec.
import type { AgentRunStatus, AgentRuntime, RunLimits } from "../runtime.ts";
import {
  KubernetesApiError,
  type DeleteOptions,
  type KubernetesClient,
} from "./client.ts";
import {
  agentStage,
  checkRunSpec,
  checkSettings,
  fetchStage,
  runSecrets,
  taskSecret,
  workspaceClaim,
  type KubernetesRunSettings,
  type KubernetesRunSpec,
  type ProxyStage,
  type RunCredentials,
} from "./manifests.ts";
import { LABEL_COMPONENT, agentNamespace, runNames, runSelector } from "./names.ts";
import type { RunObjectKind } from "./objects.ts";
import { jobState, mapRunEnd, parseAgentResult } from "./result.ts";
import type { AgentTaskFile } from "./task.ts";

export interface KubernetesAgentTask extends KubernetesRunSpec {
  credentials: RunCredentials;
  /** The run's task file (./task.ts). Written into a per-run Secret, never kept in the handle. */
  task: AgentTaskFile;
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

  async function readResult(handle: KubernetesRunHandle) {
    const pods = await client.listPods(handle.namespace, {
      ...runSelector(handle.runId),
      [LABEL_COMPONENT]: "agent",
    });
    const pod = pods.map((p) => p.metadata.name).sort()[0];
    if (pod === undefined) return null;
    const log = await client.readPodLog(handle.namespace, pod, {
      container: "agent",
      tailLines: LOG_TAIL_LINES,
      limitBytes: LOG_LIMIT_BYTES,
    });
    return parseAgentResult(log);
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

  /** QA after its fetch step succeeded: the review stage, then the fetch step goes. */
  async function startReview(handle: KubernetesRunHandle): Promise<void> {
    const n = runNames(handle.runId);
    const made: Owned[] = [];
    try {
      await createStage(
        handle.namespace,
        agentStage(handle.spec, handle.limits, settings),
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
      const { credentials, task: taskFile, ...spec } = task;
      checkRunSpec(spec, limits);
      const namespace = agentNamespace(spec.projectSlug);
      // Build everything first, so a bad input fails before anything is created.
      const secrets = [...runSecrets(spec, credentials), taskSecret(spec, taskFile)];
      const firstStage =
        spec.role === "qa"
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
        if (spec.role === "qa") {
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
      if (agentJob === null && handle.spec.role === "qa") {
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
      const result = state === "deadline" ? null : await readResult(handle);
      return finish(
        handle,
        mapRunEnd(state, agentJob, result, handle.spec.model, handle.spec.serviceTier),
      );
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
