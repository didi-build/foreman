// The weekly model test's Job on Kubernetes (src/core/model-eval.ts `EvalJobs`; ADR 0117, D-432,
// D-433, O-155, O-156), as the repo map Job does it (./repo-maps.ts), in the weekly test's own
// namespace, `foreman-eval`, with the agent namespaces' Role and no new right:
//
// 1. `start` creates the key Secret (each provider's key, read by the flow from its Windmill path
//    `eval/models/<provider>`, D-433), the two NetworkPolicies, the egress proxy with the plan's
//    providers and the test Job (src/agent-images/eval/, O-155). The proxy's providers are the bot
//    files' entries for those providers, as a run's are (./manifests.ts), each with its eval key
//    path; it reaches nothing else (no CONNECT host, no state API). Its request ceiling, 429
//    allowance and the Job's deadline cover the whole week (src/core/model-eval.ts `evalSizing`).
//    The keys go only into the Secret the proxy reads, never into the Job's environment.
// 2. `collect` reads the Job without waiting: the weekly flow fires once a day and reads the
//    Job's result the day after it starts, so no Windmill run waits on it (O-156). Once the Job
//    has ended, or is still running past its bound, its key Secret and its proxy go first. Then
//    it reads the result line from the pod's log, at most `EVAL_RESULT_LOG_BYTES`, with
//    `parseAgentResult`, and checks it (src/core/model-eval-result.ts).
// 3. `remove` deletes every object of the Job, whatever is left, Jobs first. The flow calls it
//    once it has stored what `collect` read, so a failed write reads the Job again the next day.
//
// A finished Job is kept three days, not the run settings' three hours, so the next daily fire
// still finds it and its log. Nothing here logs, and errors name a step, never a key or a value
// from the Job.
import { secretEnvName } from "../../../service-kit/config.ts";
import { parseProviders } from "../../../egress-proxy/providers.ts";
import {
  EVAL_RESULT_LOG_BYTES,
  EvalJobResultError,
  readEvalJobResult,
} from "../../../core/model-eval-result.ts";
import {
  jobPlan,
  type EvalJobCollect,
  type EvalJobs,
  type EvalJobSpec,
} from "../../../core/model-eval.ts";
import type { BotFiles } from "../../contracts-file/bot-files.ts";
import { KubernetesApiError, type KubernetesClient } from "./client.ts";
import {
  checkSettings,
  job,
  modelSecretEnv,
  plainEnv,
  proxyEnvFor,
  proxyProvidersJson,
  proxyStage,
  type KubernetesRunSettings,
  type ModelProviderSetting,
  type ProxyStage,
} from "./manifests.ts";
import {
  EVAL_NAMESPACE,
  LABEL_COMPONENT,
  checkRunId,
  evalNames,
  runLabels,
  runSelector,
} from "./names.ts";
import type { RunObjectKind, Secret } from "./objects.ts";
import { jobState, parseAgentResult } from "./result.ts";

/** The cluster client and the run settings, built on first use (flows/lib/compose.ts). */
export interface EvalCluster {
  client: KubernetesClient;
  settings: KubernetesRunSettings;
}

export interface KubernetesEvalJobsOptions {
  /** Called only when the cluster is needed, so a day with nothing to do reads no token. */
  cluster: () => Promise<EvalCluster>;
  /** The bot files: each provider's entry, as a run's proxy takes it. */
  bots: BotFiles;
  /** Milliseconds now, for the wait's bound. */
  now?: () => number;
}

/** A start the runner refused before it made anything. The message names the step only. */
export class EvalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalJobError";
  }
}

/** How long Kubernetes keeps a finished test Job: three days, so a daily read finds it. */
export const EVAL_TTL_SECONDS = 3 * 86_400;
/** The result is the last line; a few lines before it are allowed for. */
const LOG_TAIL_LINES = 5;
/** At most this much of the image's own error text is kept. */
const ERROR_TEXT_CHARS = 200;

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

/** The image's error text as plain words only, cut short: it came from the Job. */
const plainError = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9 .,:;()_/-]+/g, " ")
    .trim()
    .slice(0, ERROR_TEXT_CHARS);

const OWNER = (jobId: string) => ({ runId: jobId, role: "eval" as const });

const isWhole = (n: number, min: number): boolean => Number.isInteger(n) && n >= min;

function checkSpec(spec: EvalJobSpec): void {
  checkRunId(spec.jobId);
  if (spec.entries.length === 0) throw new EvalJobError("the plan has no model");
  if (spec.caseIds.length === 0) throw new EvalJobError("the plan has no case");
  const { maxModelRequests, maxRejectedModelRequests, deadlineMinutes } = spec.sizing;
  if (
    !isWhole(maxModelRequests, 1) ||
    !isWhole(maxRejectedModelRequests, 1) ||
    !isWhole(deadlineMinutes, 1) ||
    !isWhole(spec.flexCapacityRetries, 0)
  ) {
    throw new EvalJobError("the Job's sizes must be whole numbers");
  }
  if (!(spec.capUsd > 0) || !(spec.spentBeforeUsd >= 0)) {
    throw new EvalJobError("the cap must be above 0 and the spend at least 0");
  }
}

/**
 * The proxy's providers for the plan: for each provider it uses, the bot files' entry of every
 * role it covers (they must agree), with the provider's eval key path (D-433). Only the fields the
 * proxy reads; the image takes each provider's Messages API settings from its own bot files.
 */
export function evalProviders(
  spec: Pick<EvalJobSpec, "entries" | "keyPaths">,
  bots: BotFiles,
): ModelProviderSetting[] {
  const providers: ModelProviderSetting[] = [];
  for (const entry of spec.entries) {
    for (const role of entry.roles) {
      const own = bots[role].providers.find((p) => p.name === entry.provider);
      if (!own) {
        throw new EvalJobError(
          `the ${role} bot file has no entry for provider ${entry.provider}`,
        );
      }
      const made = providers.find((p) => p.name === own.name);
      if (made) {
        if (made.upstream !== own.upstream || made.credential !== own.credential) {
          throw new EvalJobError(
            `the bot files do not agree on provider ${own.name}'s address or key style`,
          );
        }
        continue;
      }
      const secretPath = spec.keyPaths[own.name];
      if (own.credential !== "none" && secretPath === undefined) {
        throw new EvalJobError(`provider ${own.name} has no key path`);
      }
      providers.push({
        name: own.name,
        upstream: own.upstream,
        credential: own.credential,
        ...(own.credential === "none" ? {} : { secretPath }),
      });
    }
  }
  return providers;
}

/** The Job's one Secret: each provider's key, by its proxy variable. Read by the proxy only. */
export function evalSecret(
  jobId: string,
  providers: readonly ModelProviderSetting[],
  keys: Readonly<Record<string, string>>,
): Secret {
  const stringData: Record<string, string> = {};
  for (const provider of providers) {
    if (!provider.secretPath) continue;
    const value = keys[provider.secretPath];
    if (value === undefined || value === "") {
      throw new EvalJobError(`the key for provider ${provider.name} is missing`);
    }
    stringData[secretEnvName(provider.secretPath)] = value;
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: evalNames(jobId).modelSecret,
      namespace: EVAL_NAMESPACE,
      labels: runLabels(OWNER(jobId), "eval-proxy"),
    },
    type: "Opaque",
    immutable: true,
    stringData,
  };
}

/**
 * The test Job's stage: its proxy, which reaches only the plan's providers, and the Job, which
 * reaches only its proxy and gets the plan, the cap, the spend so far and each provider's address
 * on the proxy (src/agent-images/eval/image.ts), never a key.
 */
export function evalStage(
  spec: EvalJobSpec,
  providers: ModelProviderSetting[],
  settings: KubernetesRunSettings,
): ProxyStage {
  const image = settings.evalImage;
  if (image === undefined || !DIGEST_PINNED.test(image)) {
    throw new EvalJobError("the eval image is not pinned");
  }
  const owner = OWNER(spec.jobId);
  const names = evalNames(spec.jobId);
  const deadline = spec.sizing.deadlineMinutes * 60;
  const port = settings.proxyPort;
  return proxyStage(owner, settings, {
    client: "eval",
    proxy: "eval-proxy",
    clientPolicy: names.policy,
    proxyPolicy: names.proxyPolicy,
    proxyJob: names.proxyJob,
    proxyService: names.proxyService,
    clientDeadlineSeconds: deadline,
    proxyEnv: {
      ALLOWED_HOSTS: "",
      MODEL_PROVIDERS: proxyProvidersJson({ providers }),
      MAX_MODEL_REQUESTS: String(spec.sizing.maxModelRequests),
      MAX_REJECTED_MODEL_REQUESTS: String(spec.sizing.maxRejectedModelRequests),
      STATE_API_UPSTREAM: "",
    },
    proxySecretEnv: modelSecretEnv({ providers }, names.modelSecret),
    clientJob: (proxyAddress) =>
      job(
        owner,
        settings,
        names.job,
        "eval",
        deadline,
        {
          image,
          env: [
            ...plainEnv({
              FOREMAN_RUN_ID: spec.jobId,
              FOREMAN_EVAL_PLAN: JSON.stringify(jobPlan(spec.entries)),
              FOREMAN_EVAL_CASES: spec.caseIds.join(","),
              FOREMAN_EVAL_CAP_USD: String(spec.capUsd),
              FOREMAN_EVAL_SPENT_USD: String(spec.spentBeforeUsd),
              FOREMAN_MODEL_BASE_URLS: JSON.stringify(
                Object.fromEntries(
                  providers.map((p) => [
                    p.name,
                    `http://${proxyAddress}:${port}/${p.name}`,
                  ]),
                ),
              ),
              FOREMAN_FLEX_CAPACITY_RETRIES: String(spec.flexCapacityRetries),
              TMPDIR: "/tmp",
            }),
            ...proxyEnvFor(proxyAddress, port),
          ],
          // An agent's resources: the job runs the Messages API loop, one run at a time.
          resources: settings.resources.agent,
          volumes: [
            { name: "tmp", emptyDir: { sizeLimit: settings.scratchSizeLimit } },
          ],
          volumeMounts: [{ name: "tmp", mountPath: "/tmp", readOnly: false }],
        },
        EVAL_TTL_SECONDS,
      ),
  });
}

type Owned = [RunObjectKind, string];

/** Every object of a Job, Jobs first. */
function everything(jobId: string): Owned[] {
  const n = evalNames(jobId);
  return [
    ["Job", n.job],
    ["Job", n.proxyJob],
    ["Service", n.proxyService],
    ["NetworkPolicy", n.policy],
    ["NetworkPolicy", n.proxyPolicy],
    ["Secret", n.modelSecret],
  ];
}

export function createKubernetesEvalJobs(options: KubernetesEvalJobsOptions): EvalJobs {
  const now = options.now ?? (() => Date.now());

  async function removeAll(client: KubernetesClient, owned: readonly Owned[]) {
    let failure: unknown;
    for (const [kind, name] of owned) {
      try {
        await client.delete(kind, EVAL_NAMESPACE, name, {
          propagationPolicy: "Background",
        });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  return {
    async imagePinned() {
      const { settings } = await options.cluster();
      return settings.evalImage !== undefined && DIGEST_PINNED.test(settings.evalImage);
    },

    async start(spec, keys) {
      const { client, settings } = await options.cluster();
      // Checked and built before anything is created, so a bad input creates nothing.
      checkSettings(settings);
      checkSpec(spec);
      const providers = evalProviders(spec, options.bots);
      parseProviders(proxyProvidersJson({ providers }));
      const secret = evalSecret(spec.jobId, providers, keys);
      const stage = evalStage(spec, providers, settings);
      try {
        await client.create(secret);
        for (const policy of stage.policies) await client.create(policy);
        await client.create(stage.proxyJob);
        const service = await client.create(stage.proxyService);
        if (!service.clusterIP) {
          throw new KubernetesApiError(
            `create Service in ${EVAL_NAMESPACE}`,
            0,
            "NoClusterIP",
          );
        }
        await client.create(stage.clientJob(service.clusterIP));
      } catch (error) {
        // Every object goes, Jobs first; the first error is the one reported.
        await removeAll(client, everything(spec.jobId)).catch(() => undefined);
        throw error;
      }
    },

    async collect(jobId, boundAt): Promise<EvalJobCollect> {
      const { client } = await options.cluster();
      const n = evalNames(jobId);
      const state = jobState(await client.getJob(EVAL_NAMESPACE, n.job));
      const keyHolders: Owned[] = [
        ["Secret", n.modelSecret],
        ["Job", n.proxyJob],
      ];
      if (state === "running" || state === "stopping") {
        if (now() < boundAt.getTime()) return { state: "running" };
        // Past its bound: the Job is stopped, and its key and proxy go with it.
        await removeAll(client, [["Job", n.job], ...keyHolders]);
        return { state: "failed", reason: "did_not_end", detail: null };
      }
      // The Job has ended: its key and the proxy that holds it go now, before its log is read.
      await removeAll(client, keyHolders);
      if (state === "gone")
        return { state: "failed", reason: "job_gone", detail: null };
      if (state === "deadline") {
        return { state: "failed", reason: "deadline", detail: null };
      }
      const pods = await client.listPods(EVAL_NAMESPACE, {
        ...runSelector(jobId),
        [LABEL_COMPONENT]: "eval",
      });
      const pod = pods.map((p) => p.metadata.name).sort()[0];
      const log =
        pod === undefined
          ? null
          : await client.readPodLog(EVAL_NAMESPACE, pod, {
              container: "eval",
              tailLines: LOG_TAIL_LINES,
              limitBytes: EVAL_RESULT_LOG_BYTES,
            });
      const result = parseAgentResult(log);
      if (result === null || result.status !== "success" || state !== "complete") {
        const said = plainError(result?.errorText ?? "");
        return {
          state: "failed",
          reason: "job_failed",
          detail: said === "" ? null : said,
        };
      }
      try {
        return { state: "finished", result: readEvalJobResult(result.structured) };
      } catch (error) {
        if (!(error instanceof EvalJobResultError)) throw error;
        // The check names the field only, never a value.
        return {
          state: "failed",
          reason: "bad_result",
          detail: plainError(error.message),
        };
      }
    },

    async remove(jobId) {
      const { client } = await options.cluster();
      await removeAll(client, everything(jobId));
    },
  };
}
