// A run's Kubernetes objects as pure functions (ADR 0106 sections 1 to 6). Same input, same
// objects: no clock, no random names. Every pod follows section 4 (non-root, read-only root,
// no privilege escalation, drop ALL, seccomp RuntimeDefault, no service account token, no host
// access, limits on every container) and runs on the tainted agents pool (D-193).
import { secretEnvName } from "../../../service-kit/config.ts";
import { parseAllowedHosts } from "../../../egress-proxy/hosts.ts";
import { parseProviders } from "../../../egress-proxy/providers.ts";
import {
  STATE_API_PREFIX,
  parseStateApiUpstream,
} from "../../../egress-proxy/state-api.ts";
import type { ServiceTier } from "../../../core/store.ts";
import type { AgentRole, RunLimits } from "../runtime.ts";
import {
  TASK_FILE_KEY,
  TASK_FILE_PATH,
  TASK_MOUNT_PATH,
  taskFileJson,
  type AgentTaskFile,
} from "./task.ts";
import {
  agentNamespace,
  checkRunId,
  componentSelector,
  runLabels,
  runNames,
  type Component,
  type RunNames,
} from "./names.ts";
import type {
  Container,
  EnvVar,
  Job,
  Labels,
  NetworkPolicy,
  NetworkPolicyPeer,
  PersistentVolumeClaim,
  PodSpec,
  Resources,
  Secret,
  Service,
  Toleration,
  Volume,
  VolumeMount,
} from "./objects.ts";

/** The agents pool's node label and taint (D-193). Infrastructure code sets the same pair. */
export const AGENTS_POOL = { key: "foreman/pool", value: "agents" } as const;

/** Cluster-wide settings for every run. They come from platform settings, never from a bot. */
export interface KubernetesRunSettings {
  /** The egress proxy image, pinned by digest. */
  proxyImage: string;
  /** The QA fetch step's image, pinned by digest. */
  fetchImage: string;
  proxyPort: number;
  /** The numeric user and group every pod runs as. Never 0. */
  runAsUser: number;
  resources: { agent: Resources; proxy: Resources; fetch: Resources };
  /** Size limit of each `emptyDir` (the work folder and `/tmp`). */
  scratchSizeLimit: string;
  /** Between SIGTERM and the forced stop (ADR 0106 section 6). */
  terminationGracePeriodSeconds: number;
  /** How long Kubernetes keeps a finished Job (ADR 0106 section 6). */
  ttlSecondsAfterFinished: number;
  /** How much longer a proxy lives than its agent, so it ends by itself (ADR 0106 section 2). */
  proxyDeadlineMarginSeconds: number;
  /** The QA fetch step's deadline. */
  fetchMaxMinutes: number;
  /** QA's per-run volume (ADR 0106 section 5). No storage class means the cluster default. */
  workspace: { size: string; storageClassName?: string };
  /**
   * The state API (D-195): the proxy's route upstream as `http://host:port`, and the namespace,
   * pod labels and container port the proxy's NetworkPolicy lets it reach.
   */
  stateApi: { upstream: string; namespace: string; podLabels: Labels; podPort: number };
  /** Cluster DNS, which only proxy pods may reach (ADR 0106 section 2). */
  clusterDns: { namespace: string; podLabels: Labels };
}

/** One model provider in a run's list, as the proxy reads it, plus the agent's base URL. */
export interface ModelProviderSetting {
  name: string;
  upstream: string;
  credential: "x-api-key" | "bearer" | "none";
  secretPath?: string;
  /** The agent's environment variable for this provider's base URL, e.g. ANTHROPIC_BASE_URL. */
  baseUrlEnv?: string;
}

/** Everything about a run except its credential values. Safe to keep in the run handle. */
export interface KubernetesRunSpec {
  runId: string;
  role: AgentRole;
  projectSlug: string;
  /** The agent image, pinned by digest. */
  image: string;
  model: string;
  /** `owner/name`. Required for the Developer, Designer and QA. */
  repository?: string;
  /** QA only: the commit the runner set (ADR 0107). */
  headSha?: string;
  /** QA only. */
  prNumber?: number;
  /** CONNECT hosts for the agent's proxy. Empty for QA, Council and Triage (ADR 0106 section 3). */
  allowedHosts: string[];
  /** QA only: the GitHub hosts its fetch step may reach. */
  fetchAllowedHosts?: string[];
  providers: ModelProviderSetting[];
  /** The tier the run's route asked for (ADR 0114 section 8). */
  serviceTier: ServiceTier;
  /** How many Flex capacity rejections the agent retries (`flex_capacity_retries`, ADR 0114 section 9). */
  flexCapacityRetries: number;
  /** How many 429 answers the agent's proxy lets through (`max_rejected_model_requests`). */
  maxRejectedModelRequests: number;
}

/** Credential values for one run. Passed to `start` only, never kept, never logged. */
export interface RunCredentials {
  stateApiToken: string;
  /** Developer and Designer: the agent pod. QA: the fetch pod only. Council and Triage: none. */
  githubToken?: string;
  /** Model credential values by provider secret path. Mounted into the proxy pod only. */
  models: Record<string, string>;
}

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const RESERVED_ENV =
  /^(?:FOREMAN_|SECRET_)|^(?:HTTPS?_PROXY|NO_PROXY|HOME|TMPDIR|GITHUB_TOKEN)$/i;

/** Addresses the proxy pod may never reach directly: private, loopback, link-local (metadata). */
export const NON_PUBLIC_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const NO_CONNECT_HOSTS: readonly AgentRole[] = ["qa", "council", "triage"];
const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];
const NEEDS_REPOSITORY: readonly AgentRole[] = ["developer", "designer", "qa"];

/**
 * Checks a run before anything is built. It reuses the proxy's own parsers, so the runner never
 * starts a proxy that would refuse its settings. Errors name the problem, never a value.
 */
export function checkRunSpec(spec: KubernetesRunSpec, limits: RunLimits): void {
  checkRunId(spec.runId);
  agentNamespace(spec.projectSlug);
  if (!DIGEST_PINNED.test(spec.image))
    throw new Error("agent image must be pinned by digest");
  if (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1) {
    throw new Error("maxTurns must be a positive whole number");
  }
  if (!Number.isInteger(limits.maxMinutes) || limits.maxMinutes < 1) {
    throw new Error("maxMinutes must be a positive whole number");
  }
  if (!Number.isFinite(limits.maxUsd) || limits.maxUsd <= 0) {
    throw new Error("maxUsd must be above 0");
  }
  if (!TIERS.includes(spec.serviceTier)) {
    throw new Error("serviceTier must be standard, flex or priority");
  }
  if (!Number.isInteger(spec.flexCapacityRetries) || spec.flexCapacityRetries < 0) {
    throw new Error("flexCapacityRetries must be a whole number of at least 0");
  }
  if (
    !Number.isInteger(spec.maxRejectedModelRequests) ||
    spec.maxRejectedModelRequests < 1
  ) {
    throw new Error("maxRejectedModelRequests must be a positive whole number");
  }
  if (NO_CONNECT_HOSTS.includes(spec.role) && spec.allowedHosts.length > 0) {
    throw new Error(
      `a ${spec.role} run reaches only its model providers and the state API`,
    );
  }
  parseAllowedHosts(spec.allowedHosts.join(","));
  if (NEEDS_REPOSITORY.includes(spec.role) && !REPOSITORY.test(spec.repository ?? "")) {
    throw new Error(`a ${spec.role} run needs its repository as owner/name`);
  }
  if (spec.role === "qa") {
    if (!SHA.test(spec.headSha ?? ""))
      throw new Error("a QA run needs its head commit");
    if (!Number.isInteger(spec.prNumber) || (spec.prNumber ?? 0) < 1) {
      throw new Error("a QA run needs its pull request number");
    }
    if (!spec.fetchAllowedHosts || spec.fetchAllowedHosts.length === 0) {
      throw new Error("a QA run needs its fetch step's GitHub hosts");
    }
    parseAllowedHosts(spec.fetchAllowedHosts.join(","));
  } else if (spec.fetchAllowedHosts !== undefined) {
    throw new Error("only a QA run has a fetch step");
  }
  if (spec.providers.length === 0)
    throw new Error("a run needs at least one model provider");
  parseProviders(proxyProvidersJson(spec));
  for (const provider of spec.providers) {
    if (
      provider.baseUrlEnv !== undefined &&
      (!ENV_NAME.test(provider.baseUrlEnv) || RESERVED_ENV.test(provider.baseUrlEnv))
    ) {
      throw new Error(`provider ${provider.name} has an invalid base URL variable`);
    }
  }
}

export function checkSettings(settings: KubernetesRunSettings): void {
  for (const [name, image] of [
    ["proxy", settings.proxyImage],
    ["fetch", settings.fetchImage],
  ] as const) {
    if (!DIGEST_PINNED.test(image))
      throw new Error(`${name} image must be pinned by digest`);
  }
  if (!Number.isInteger(settings.runAsUser) || settings.runAsUser < 1) {
    throw new Error("runAsUser must be a user id above 0");
  }
  if (parseStateApiUpstream(settings.stateApi.upstream) === undefined) {
    throw new Error("the state API upstream is required");
  }
}

/** The run's Secrets: one per pod that needs one (ADR 0106 section 5). */
export function runSecrets(
  spec: KubernetesRunSpec,
  credentials: RunCredentials,
): Secret[] {
  const names = runNames(spec.runId);
  const namespace = agentNamespace(spec.projectSlug);
  const secret = (name: string, stringData: Record<string, string>): Secret => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace, labels: runLabels(spec) },
    type: "Opaque",
    immutable: true,
    stringData,
  });
  const models: Record<string, string> = {};
  for (const provider of spec.providers) {
    if (!provider.secretPath) continue;
    const value = credentials.models[provider.secretPath];
    if (value === undefined || value === "") {
      throw new Error(`the credential for provider ${provider.name} is missing`);
    }
    models[secretEnvName(provider.secretPath)] = value;
  }
  const secrets = [
    secret(names.stateTokenSecret, { token: credentials.stateApiToken }),
  ];
  if (Object.keys(models).length > 0) secrets.push(secret(names.modelSecret, models));
  const needsGitHub = NEEDS_REPOSITORY.includes(spec.role);
  if (needsGitHub !== Boolean(credentials.githubToken)) {
    throw new Error(
      needsGitHub
        ? `a ${spec.role} run needs its GitHub token`
        : `a ${spec.role} run holds no GitHub token`,
    );
  }
  if (credentials.githubToken) {
    secrets.push(secret(names.githubTokenSecret, { token: credentials.githubToken }));
  }
  return secrets;
}

/**
 * The run's task file as a Secret, mounted read-only into the agent pod only (./task.ts). Built
 * apart from `runSecrets` because it holds the run's text, not a credential.
 */
export function taskSecret(spec: KubernetesRunSpec, task: AgentTaskFile): Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: runNames(spec.runId).taskSecret,
      namespace: agentNamespace(spec.projectSlug),
      labels: runLabels(spec, "agent"),
    },
    type: "Opaque",
    immutable: true,
    stringData: { [TASK_FILE_KEY]: taskFileJson(spec.role, task) },
  };
}

/** QA's per-run volume for the fetched tree (ADR 0106 section 5). */
export function workspaceClaim(
  spec: KubernetesRunSpec,
  settings: KubernetesRunSettings,
): PersistentVolumeClaim {
  const { size, storageClassName } = settings.workspace;
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: runNames(spec.runId).workspaceClaim,
      namespace: agentNamespace(spec.projectSlug),
      labels: runLabels(spec, "fetch"),
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: size } },
      ...(storageClassName ? { storageClassName } : {}),
    },
  };
}

/** The proxy, its Service and the two NetworkPolicies that tie a client pod to it. */
export interface ProxyStage {
  policies: [NetworkPolicy, NetworkPolicy];
  proxyJob: Job;
  proxyService: Service;
  /** The client Job (the agent, or QA's fetch step), given the proxy Service's IP address. */
  clientJob: (proxyAddress: string) => Job;
}

/** The agent's stage: its proxy, its policies and the agent Job (ADR 0106 section 2). */
export function agentStage(
  spec: KubernetesRunSpec,
  limits: RunLimits,
  settings: KubernetesRunSettings,
): ProxyStage {
  const names = runNames(spec.runId);
  const deadline = limits.maxMinutes * 60;
  return proxyStage(spec, settings, {
    client: "agent",
    proxy: "proxy",
    clientPolicy: names.agentPolicy,
    proxyPolicy: names.proxyPolicy,
    proxyJob: names.proxyJob,
    proxyService: names.proxyService,
    clientDeadlineSeconds: deadline,
    proxyEnv: {
      ALLOWED_HOSTS: spec.allowedHosts.join(","),
      MODEL_PROVIDERS: proxyProvidersJson(spec),
      MAX_MODEL_REQUESTS: String(limits.maxTurns * 2),
      MAX_REJECTED_MODEL_REQUESTS: String(spec.maxRejectedModelRequests),
      STATE_API_UPSTREAM: settings.stateApi.upstream,
    },
    modelSecret: spec.providers.some((p) => p.secretPath)
      ? names.modelSecret
      : undefined,
    clientJob: (proxyAddress) =>
      job(spec, settings, names.agentJob, "agent", deadline, {
        image: spec.image,
        env: agentEnv(spec, limits, settings, names, proxyAddress),
        resources: settings.resources.agent,
        ...agentVolumes(spec, settings, names),
      }),
  });
}

/** QA's fetch stage: its own proxy that reaches GitHub only, and the fetch Job. */
export function fetchStage(
  spec: KubernetesRunSpec,
  settings: KubernetesRunSettings,
): ProxyStage {
  if (spec.role !== "qa") throw new Error("only a QA run has a fetch step");
  const names = runNames(spec.runId);
  const deadline = settings.fetchMaxMinutes * 60;
  return proxyStage(spec, settings, {
    client: "fetch",
    proxy: "fetch-proxy",
    clientPolicy: names.fetchPolicy,
    proxyPolicy: names.fetchProxyPolicy,
    proxyJob: names.fetchProxyJob,
    proxyService: names.fetchProxyService,
    clientDeadlineSeconds: deadline,
    proxyEnv: {
      ALLOWED_HOSTS: (spec.fetchAllowedHosts ?? []).join(","),
      MODEL_PROVIDERS: "[]",
      MAX_MODEL_REQUESTS: "1",
      MAX_REJECTED_MODEL_REQUESTS: "1",
      STATE_API_UPSTREAM: "",
    },
    modelSecret: undefined,
    clientJob: (proxyAddress) =>
      job(spec, settings, names.fetchJob, "fetch", deadline, {
        image: settings.fetchImage,
        env: [
          ...plainEnv({
            FOREMAN_RUN_ID: spec.runId,
            FOREMAN_REPOSITORY: spec.repository ?? "",
            FOREMAN_HEAD_SHA: spec.headSha ?? "",
            FOREMAN_PR_NUMBER: String(spec.prNumber ?? ""),
            FOREMAN_WORKSPACE: "/workspace",
            HOME: "/work",
            TMPDIR: "/tmp",
          }),
          ...proxyEnvFor(proxyAddress, settings.proxyPort),
          secretEnv("GITHUB_TOKEN", names.githubTokenSecret, "token"),
        ],
        resources: settings.resources.fetch,
        volumes: [
          ...scratchVolumes(settings),
          {
            name: "workspace",
            persistentVolumeClaim: { claimName: names.workspaceClaim, readOnly: false },
          },
        ],
        volumeMounts: [
          ...scratchMounts(),
          { name: "workspace", mountPath: "/workspace", readOnly: false },
        ],
      }),
  });
}

/** The provider list exactly as the proxy reads it (MODEL_PROVIDERS). */
function proxyProvidersJson(spec: KubernetesRunSpec): string {
  return JSON.stringify(
    spec.providers.map(({ name, upstream, credential, secretPath }) =>
      secretPath === undefined
        ? { name, upstream, credential }
        : { name, upstream, credential, secretPath },
    ),
  );
}

interface StageParts {
  client: Component;
  proxy: Component;
  clientPolicy: string;
  proxyPolicy: string;
  proxyJob: string;
  proxyService: string;
  clientDeadlineSeconds: number;
  proxyEnv: Record<string, string>;
  modelSecret: string | undefined;
  clientJob: (proxyAddress: string) => Job;
}

function proxyStage(
  spec: KubernetesRunSpec,
  settings: KubernetesRunSettings,
  parts: StageParts,
): ProxyStage {
  const namespace = agentNamespace(spec.projectSlug);
  const port = settings.proxyPort;
  const clientPods = {
    podSelector: { matchLabels: componentSelector(spec.runId, parts.client) },
  };
  const proxyPods = {
    podSelector: { matchLabels: componentSelector(spec.runId, parts.proxy) },
  };
  const inNamespace = (name: string, labels: Labels): NetworkPolicyPeer => ({
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } },
    podSelector: { matchLabels: labels },
  });
  const policy = (
    name: string,
    component: Component,
    ingress: NetworkPolicy["spec"]["ingress"],
    egress: NetworkPolicy["spec"]["egress"],
  ): NetworkPolicy => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace, labels: runLabels(spec, component) },
    spec: {
      podSelector: { matchLabels: componentSelector(spec.runId, component) },
      policyTypes: ["Ingress", "Egress"],
      ingress,
      egress,
    },
  });

  // The client pod: no ingress, and egress only to its own proxy pod on the proxy port. No DNS.
  const clientPolicy = policy(
    parts.clientPolicy,
    parts.client,
    [],
    [{ to: [proxyPods], ports: [{ protocol: "TCP", port }] }],
  );
  // The proxy pod: ingress only from its client pod; egress to cluster DNS, public addresses on
  // 443 and, for the agent's proxy only, the state API pods (D-195).
  const egress: NetworkPolicy["spec"]["egress"] = [
    {
      to: [inNamespace(settings.clusterDns.namespace, settings.clusterDns.podLabels)],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
    {
      to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [...NON_PUBLIC_IPV4] } }],
      ports: [{ protocol: "TCP", port: 443 }],
    },
  ];
  if (parts.proxyEnv.STATE_API_UPSTREAM !== "") {
    egress.push({
      to: [inNamespace(settings.stateApi.namespace, settings.stateApi.podLabels)],
      ports: [{ protocol: "TCP", port: settings.stateApi.podPort }],
    });
  }
  const proxyPolicy = policy(
    parts.proxyPolicy,
    parts.proxy,
    [{ from: [clientPods], ports: [{ protocol: "TCP", port }] }],
    egress,
  );

  const proxyDeadline =
    parts.clientDeadlineSeconds +
    settings.terminationGracePeriodSeconds +
    settings.proxyDeadlineMarginSeconds;
  const modelSecretEnv: EnvVar[] = [];
  if (parts.modelSecret) {
    for (const provider of spec.providers) {
      if (!provider.secretPath) continue;
      const key = secretEnvName(provider.secretPath);
      modelSecretEnv.push(secretEnv(key, parts.modelSecret, key));
    }
  }
  const proxyJob = job(spec, settings, parts.proxyJob, parts.proxy, proxyDeadline, {
    image: settings.proxyImage,
    env: [
      ...plainEnv({ PORT: String(port), RUN_ID: spec.runId, ...parts.proxyEnv }),
      ...modelSecretEnv,
    ],
    resources: settings.resources.proxy,
    ports: [{ name: "proxy", containerPort: port, protocol: "TCP" }],
    readinessProbe: { httpGet: { path: "/health", port }, periodSeconds: 5 },
    volumes: [{ name: "tmp", emptyDir: { sizeLimit: settings.scratchSizeLimit } }],
    volumeMounts: [{ name: "tmp", mountPath: "/tmp", readOnly: false }],
  });
  const proxyService: Service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: parts.proxyService,
      namespace,
      labels: runLabels(spec, parts.proxy),
    },
    spec: {
      type: "ClusterIP",
      selector: componentSelector(spec.runId, parts.proxy),
      ports: [{ name: "proxy", protocol: "TCP", port, targetPort: port }],
    },
  };
  return {
    policies: [clientPolicy, proxyPolicy],
    proxyJob,
    proxyService,
    clientJob: parts.clientJob,
  };
}

function agentEnv(
  spec: KubernetesRunSpec,
  limits: RunLimits,
  settings: KubernetesRunSettings,
  names: RunNames,
  proxyAddress: string,
): EnvVar[] {
  const proxyBase = `http://${proxyAddress}:${settings.proxyPort}`;
  const plain: Record<string, string> = {
    FOREMAN_RUN_ID: spec.runId,
    FOREMAN_ROLE: spec.role,
    FOREMAN_MODEL: spec.model,
    FOREMAN_MAX_TURNS: String(limits.maxTurns),
    FOREMAN_MAX_BUDGET_USD: String(limits.maxUsd),
    // A capacity wait counts against the minute limit (ADR 0114 section 9).
    FOREMAN_MAX_MINUTES: String(limits.maxMinutes),
    FOREMAN_SERVICE_TIER: spec.serviceTier,
    FOREMAN_FLEX_CAPACITY_RETRIES: String(spec.flexCapacityRetries),
    FOREMAN_STATE_API_URL: `${proxyBase}${STATE_API_PREFIX}`,
    FOREMAN_TASK_FILE: TASK_FILE_PATH,
    HOME: "/work",
    TMPDIR: "/tmp",
  };
  if (spec.repository) plain.FOREMAN_REPOSITORY = spec.repository;
  if (spec.role === "qa") {
    plain.FOREMAN_HEAD_SHA = spec.headSha ?? "";
    plain.FOREMAN_PR_NUMBER = String(spec.prNumber ?? "");
    plain.FOREMAN_WORKSPACE = "/workspace";
  }
  for (const provider of spec.providers) {
    if (provider.baseUrlEnv)
      plain[provider.baseUrlEnv] = `${proxyBase}/${provider.name}`;
  }
  const env = [
    ...plainEnv(plain),
    ...proxyEnvFor(proxyAddress, settings.proxyPort),
    secretEnv("FOREMAN_STATE_API_TOKEN", names.stateTokenSecret, "token"),
  ];
  // QA's GitHub token goes to its fetch pod only, never to the QA pod (D-184).
  if (spec.role === "developer" || spec.role === "designer") {
    env.push(secretEnv("GITHUB_TOKEN", names.githubTokenSecret, "token"));
  }
  return env;
}

function agentVolumes(
  spec: KubernetesRunSpec,
  settings: KubernetesRunSettings,
  names: RunNames,
): { volumes: Volume[]; volumeMounts: VolumeMount[] } {
  // The task file: read-only, readable by the pod's group only (fsGroup), never by others.
  const task: Volume = {
    name: "task",
    secret: {
      secretName: names.taskSecret,
      items: [{ key: TASK_FILE_KEY, path: TASK_FILE_KEY }],
      defaultMode: 0o440,
    },
  };
  const taskMount: VolumeMount = {
    name: "task",
    mountPath: TASK_MOUNT_PATH,
    readOnly: true,
  };
  if (spec.role !== "qa") {
    return {
      volumes: [...scratchVolumes(settings), task],
      volumeMounts: [...scratchMounts(), taskMount],
    };
  }
  return {
    volumes: [
      ...scratchVolumes(settings),
      task,
      // QA reads the fetched tree and can never change it.
      {
        name: "workspace",
        persistentVolumeClaim: { claimName: names.workspaceClaim, readOnly: true },
      },
    ],
    volumeMounts: [
      ...scratchMounts(),
      taskMount,
      { name: "workspace", mountPath: "/workspace", readOnly: true },
    ],
  };
}

/** HTTPS through the proxy, by IP address, so the pod needs no DNS (ADR 0106 section 2). */
function proxyEnvFor(proxyAddress: string, port: number): EnvVar[] {
  const url = `http://${proxyAddress}:${port}`;
  return plainEnv({
    HTTPS_PROXY: url,
    https_proxy: url,
    NO_PROXY: proxyAddress,
    no_proxy: proxyAddress,
  });
}

function scratchVolumes(settings: KubernetesRunSettings): Volume[] {
  return [
    { name: "work", emptyDir: { sizeLimit: settings.scratchSizeLimit } },
    { name: "tmp", emptyDir: { sizeLimit: settings.scratchSizeLimit } },
  ];
}

function scratchMounts(): VolumeMount[] {
  return [
    { name: "work", mountPath: "/work", readOnly: false },
    { name: "tmp", mountPath: "/tmp", readOnly: false },
  ];
}

function plainEnv(values: Record<string, string>): EnvVar[] {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

function secretEnv(name: string, secret: string, key: string): EnvVar {
  return { name, valueFrom: { secretKeyRef: { name: secret, key } } };
}

interface ContainerParts {
  image: string;
  env: EnvVar[];
  resources: Resources;
  ports?: Container["ports"];
  readinessProbe?: Container["readinessProbe"];
  volumes: Volume[];
  volumeMounts: VolumeMount[];
}

/** A one-pod Job that Kubernetes never retries (ADR 0106 sections 4 and 6). */
function job(
  spec: KubernetesRunSpec,
  settings: KubernetesRunSettings,
  name: string,
  component: Component,
  deadlineSeconds: number,
  parts: ContainerParts,
): Job {
  const labels = runLabels(spec, component);
  const user = settings.runAsUser;
  const toleration: Toleration = {
    key: AGENTS_POOL.key,
    operator: "Equal",
    value: AGENTS_POOL.value,
    effect: "NoSchedule",
  };
  const container: Container = {
    name: component,
    image: parts.image,
    imagePullPolicy: "IfNotPresent",
    env: parts.env,
    ...(parts.ports ? { ports: parts.ports } : {}),
    ...(parts.readinessProbe ? { readinessProbe: parts.readinessProbe } : {}),
    resources: parts.resources,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: user,
      runAsGroup: user,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    },
    volumeMounts: parts.volumeMounts,
  };
  const pod: PodSpec = {
    restartPolicy: "Never",
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    terminationGracePeriodSeconds: settings.terminationGracePeriodSeconds,
    nodeSelector: { [AGENTS_POOL.key]: AGENTS_POOL.value },
    tolerations: [toleration],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: user,
      runAsGroup: user,
      fsGroup: user,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [container],
    volumes: parts.volumes,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: agentNamespace(spec.projectSlug), labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: deadlineSeconds,
      ttlSecondsAfterFinished: settings.ttlSecondsAfterFinished,
      template: { metadata: { labels }, spec: pod },
    },
  };
}
