// The platform namespace on the cluster's platform pool (ADR 0106 section 1, D-193, D-195), as
// data: the state API, the GitHub receiver, the Cloudflare Tunnel connector and the shared
// Windmill egress proxy (D-284, D-328), their Services, and default-deny network policies with
// four narrow openings:
//
// - the agents' egress proxy pods (and nothing else in agent namespaces) reach the state API port;
// - the tunnel connector reaches the receiver port and the state API's public port (which serves
//   only the planning chat's `POST /plans`, D-271, src/api/public.ts), and Cloudflare on 443;
// - the state API and the receiver reach cluster DNS, the database port on public addresses and
//   the Windmill proxy's port, and nothing on 443;
// - the Windmill proxy accepts only those two pods, and reaches DNS and 443 on public addresses.
//   Network policies match addresses, not names, so the proxy is what holds the calls to
//   Windmill's host name: it is the agents' egress proxy image with that one host allowed, no
//   model provider, no state API route and no credential, and it never decrypts the tunnel.
//
// Written as typed objects like the agent namespace objects of slice 3, so the same constants
// (pool labels, Service names, ports) are shared and tested together. `render.ts` prints them for
// Didi to apply with their admin kubeconfig (D-188). No Secret is declared here: Secrets are
// referenced by name only and created by Didi at first hosting.
import {
  AGENTS_POOL,
  NON_PUBLIC_IPV4,
  type KubernetesRunSettings,
} from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import {
  LABEL_COMPONENT,
  LABEL_MANAGED_BY,
  LABEL_PROJECT,
} from "../../src/adapters/agent-runtime/kubernetes/names.ts";
import type {
  EnvVar,
  Labels,
  LabelSelector,
  Namespace,
  NetworkPolicy,
  NetworkPolicyPeer,
  PodSecurityContext,
  Resources,
  SecurityContext,
  Service,
  Volume,
  VolumeMount,
} from "../../src/adapters/agent-runtime/kubernetes/objects.ts";
import { WEBHOOK_PATH } from "../../src/github-receiver/handler.ts";
import { PLANNING_TOKEN_SHA256_PATH } from "../../src/api/auth.ts";
import {
  WINDMILL_ENV,
  parseWindmillHost,
  parseWindmillWorkspace,
} from "../../src/adapters/windmill/client.ts";
import { WINDMILL_PLAN_APPROVAL_TOKEN_PATH } from "../../src/adapters/windmill/plan-approval-flow.ts";
import { RECEIVER_WINDMILL_TOKEN_PATH } from "../../src/adapters/windmill/receiver-flows.ts";
import { secretEnvName } from "../../src/service-kit/config.ts";

export const PLATFORM_NAMESPACE = "foreman-platform";
const MANAGED_BY_INFRA = "foreman-infra";

/** The platform pool's node label (D-193). The DigitalOcean module sets the same pair. */
export const PLATFORM_POOL = { key: AGENTS_POOL.key, value: "platform" } as const;

/** Every platform service listens on PORT 8080 (ADR 0111) and serves GET /health. */
const SERVICE_PORT = 8080;

export const STATE_API = {
  name: "state-api",
  port: SERVICE_PORT,
  podLabels: { app: "state-api" },
} as const;

/**
 * The state API's public port (D-271): its own Service, so the tunnel's route can only ever reach
 * this port, which serves the planning chat's routes and nothing else (src/api/public.ts, D-282).
 */
export const STATE_API_PUBLIC = {
  name: "state-api-public",
  port: 8081,
  podLabels: STATE_API.podLabels,
  /**
   * The tunnel's path pattern for this Service (D-271, D-282): exactly `/plans` and the three
   * planning reads, with the state API's own slug rule (src/api/routes.ts). The tunnel cannot
   * match the method; the public port checks it.
   */
  tunnelPath:
    "^/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$",
} as const;

export const RECEIVER = {
  name: "github-receiver",
  port: SERVICE_PORT,
  podLabels: { app: "github-receiver" },
  webhookPath: WEBHOOK_PATH,
} as const;

/**
 * The shared Windmill egress proxy (D-284, D-328): one pod that carries the state API's and the
 * receiver's calls to Windmill, from the same image as the agents' egress proxies
 * (src/egress-proxy/). Not a container in each service's pod: a network policy applies to the
 * whole pod, so the service itself could then reach 443 past it. If it is down, both services'
 * starts fail and the reconcile pass opens or captures later. It can run as several replicas
 * behind this one Service when usage grows.
 */
export const WINDMILL_PROXY = {
  name: "windmill-proxy",
  port: SERVICE_PORT,
  podLabels: { app: "windmill-proxy" },
  /**
   * The proxy reads a run id, a provider list and two model request ceilings, which have no
   * meaning here: the id is only its log label, and the rest take the QA fetch proxy's values for
   * a proxy that serves no model traffic, so the proxy's code is unchanged (O-101).
   */
  runId: "windmill-proxy",
} as const;

/** The tunnel connector (D-195). Its metrics port serves /ready for the kubelet only. */
export const CLOUDFLARED = {
  name: "cloudflared",
  podLabels: { app: "cloudflared" },
  metricsPort: 2000,
  /** The official image runs as this non-root user. */
  user: 65532,
  /** cloudflare/cloudflared 2026.10.0, multi-arch index digest read from Docker Hub on 2026-10-31. */
  image:
    "docker.io/cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07",
} as const;

/**
 * Secrets the platform pods read, by name and key. Didi creates each one at first hosting
 * (docs/runbooks/first-hosting.md). Nothing in this repo holds a value.
 */
export const PLATFORM_SECRETS = {
  stateApiDatabase: { name: "state-api-database", key: "url" },
  receiverDatabase: { name: "github-receiver-database", key: "url" },
  receiverWebhookSecret: { name: "github-receiver-webhook-secret", key: "value" },
  tunnelToken: { name: "cloudflared-tunnel-token", key: "token" },
  /**
   * The SHA-256 of the planning chat's token (D-266). Optional: the state API starts without it
   * and then accepts no planning token, until Didi creates the credential at first hosting.
   */
  stateApiPlanningToken: { name: "state-api-planning-token", key: "sha256" },
  /**
   * The state API's Windmill credential that can start only the plan-approval flow (D-273).
   * Optional: without it the start is refused and the reconcile pass opens the request.
   */
  stateApiWindmillToken: {
    name: "state-api-windmill-plan-approval-token",
    key: "token",
  },
  /**
   * The receiver's Windmill token that can start only its flows (D-291, RECEIVER_FLOW_PATHS).
   * Optional: without it the start is refused and the reconcile pass captures.
   */
  receiverWindmillToken: { name: "github-receiver-windmill-token", key: "token" },
} as const;

/** The receiver's webhook secret path (src/github-receiver/main.ts). */
const RECEIVER_WEBHOOK_SECRET_PATH = "platform/github/runner-webhook-secret";

/** The in-cluster address of a platform Service. */
export function serviceUrl(service: { name: string; port: number }): string {
  return `http://${service.name}.${PLATFORM_NAMESPACE}.svc.cluster.local:${service.port}`;
}

/**
 * The state API part of the runner's Kubernetes settings (D-195). The egress proxy's route and its
 * NetworkPolicy must point exactly here, or the state API's ingress policy refuses them.
 */
export function stateApiRunSettings(): KubernetesRunSettings["stateApi"] {
  return {
    upstream: serviceUrl(STATE_API),
    namespace: PLATFORM_NAMESPACE,
    podLabels: { ...STATE_API.podLabels },
    podPort: STATE_API.port,
  };
}

/** Settings for the platform objects. Not secret; Didi keeps them outside the repo. */
export interface PlatformSettings {
  /**
   * The state API and receiver images, and the egress proxy image the agent runs use (the
   * runner's `proxyImage`), each pinned by digest (ADR 0111).
   */
  images: { stateApi: string; receiver: string; egressProxy: string };
  /** The numeric user of the Node service images (`node` is 1000). Never 0. */
  serviceUser: number;
  resources: {
    stateApi: Resources;
    receiver: Resources;
    cloudflared: Resources;
    windmillProxy: Resources;
  };
  /**
   * Where the state API and the receiver start their flows (D-283, D-291): the Windmill host,
   * the one host the Windmill proxy allows, and the workspace id. Plain settings, not secrets.
   */
  windmill: { host: string; workspace: string };
  receiver: {
    developerAppLogin: string;
    designerAppLogin: string;
    runnerAppSlug: string;
  };
  /**
   * The database's TCP port. Default: Supabase's session pooler on 5432 (session mode, because the
   * store uses transactions and advisory locks; reachable over IPv4, unlike the direct host). Only
   * the state API and the receiver may reach it, on public addresses.
   */
  databasePort?: number;
  /** Cluster DNS, as for the agents' proxies. */
  clusterDns: { namespace: string; podLabels: Labels };
}

export interface ContainerProbe {
  httpGet: { path: string; port: number };
  periodSeconds: number;
}

export interface PlatformContainer {
  name: string;
  image: string;
  imagePullPolicy: "IfNotPresent";
  args?: string[];
  env: EnvVar[];
  ports: { name: string; containerPort: number; protocol: "TCP" }[];
  readinessProbe: ContainerProbe;
  livenessProbe: ContainerProbe;
  resources: Resources;
  securityContext: SecurityContext;
  volumeMounts: VolumeMount[];
}

export interface PlatformPodSpec {
  automountServiceAccountToken: false;
  enableServiceLinks: false;
  hostNetwork: false;
  hostPID: false;
  hostIPC: false;
  terminationGracePeriodSeconds: number;
  nodeSelector: Labels;
  securityContext: PodSecurityContext;
  containers: PlatformContainer[];
  volumes: Volume[];
}

export interface Deployment {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: { name: string; namespace: string; labels: Labels };
  spec: {
    replicas: number;
    selector: LabelSelector;
    template: { metadata: { labels: Labels }; spec: PlatformPodSpec };
  };
}

export type PlatformObject = Namespace | NetworkPolicy | Service | Deployment;

/** Supabase's session pooler (see PlatformSettings.databasePort). */
export const DEFAULT_DATABASE_PORT = 5432;

/** Cloudflare's tunnel edge port, for the cloudflared connector only (D-195). */
export const TUNNEL_EDGE_PORT = 7844;

export function databasePortOf(settings: PlatformSettings): number {
  return settings.databasePort ?? DEFAULT_DATABASE_PORT;
}

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

export function checkPlatformSettings(settings: PlatformSettings): void {
  for (const [name, image] of Object.entries(settings.images)) {
    if (!DIGEST_PINNED.test(image))
      throw new Error(`${name} image must be pinned by digest`);
  }
  if (!Number.isInteger(settings.serviceUser) || settings.serviceUser < 1) {
    throw new Error("serviceUser must be a non-root user id");
  }
  const port = databasePortOf(settings);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === 443 ||
    port === 53
  ) {
    throw new Error("databasePort must be the database's own port");
  }
  for (const [name, value] of Object.entries(settings.receiver)) {
    if (value.trim() === "") throw new Error(`receiver ${name} is empty`);
  }
  try {
    parseWindmillHost(settings.windmill.host);
  } catch (error) {
    throw new Error(`windmill host ${(error as Error).message}`);
  }
  try {
    parseWindmillWorkspace(settings.windmill.workspace);
  } catch (error) {
    throw new Error(`windmill workspace ${(error as Error).message}`);
  }
}

const labels = (): Labels => ({ [LABEL_MANAGED_BY]: MANAGED_BY_INFRA });

/** Every agent namespace (slice 3 labels them), and its egress proxy pods only. */
const AGENT_PROXY_PODS: NetworkPolicyPeer = {
  namespaceSelector: {
    matchLabels: { [LABEL_MANAGED_BY]: MANAGED_BY_INFRA },
    matchExpressions: [{ key: LABEL_PROJECT, operator: "Exists" }],
  },
  podSelector: { matchLabels: { [LABEL_COMPONENT]: "proxy" } },
};

const PUBLIC_IPV4: NetworkPolicyPeer = {
  ipBlock: { cidr: "0.0.0.0/0", except: [...NON_PUBLIC_IPV4] },
};

const samePods = (podLabels: Labels): NetworkPolicyPeer => ({
  podSelector: { matchLabels: { ...podLabels } },
});

/** Everything in the platform namespace, in apply order. */
export function platformObjects(settings: PlatformSettings): PlatformObject[] {
  checkPlatformSettings(settings);
  const dns: NetworkPolicy["spec"]["egress"][number] = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": settings.clusterDns.namespace },
        },
        podSelector: { matchLabels: { ...settings.clusterDns.podLabels } },
      },
    ],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  };
  const database: NetworkPolicy["spec"]["egress"][number] = {
    to: [PUBLIC_IPV4],
    ports: [{ protocol: "TCP", port: databasePortOf(settings) }],
  };
  // The state API and the receiver reach Windmill only through the shared proxy (D-284, D-328).
  const windmillProxy: NetworkPolicy["spec"]["egress"][number] = {
    to: [samePods(WINDMILL_PROXY.podLabels)],
    ports: [{ protocol: "TCP", port: WINDMILL_PROXY.port }],
  };

  const namespace: Namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: PLATFORM_NAMESPACE,
      labels: {
        ...labels(),
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  };

  const policy = (
    name: string,
    podLabels: Labels | undefined,
    ingress: NetworkPolicy["spec"]["ingress"],
    egress: NetworkPolicy["spec"]["egress"],
  ): NetworkPolicy => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: PLATFORM_NAMESPACE, labels: labels() },
    spec: {
      podSelector: podLabels ? { matchLabels: { ...podLabels } } : {},
      policyTypes: ["Ingress", "Egress"],
      ingress,
      egress,
    },
  });

  const policies: NetworkPolicy[] = [
    policy("default-deny", undefined, [], []),
    // The state API: only the agents' egress proxies call its port (D-195); the runner does not.
    // The tunnel connector reaches its public port only, which serves `POST /plans` (D-271).
    policy(
      STATE_API.name,
      STATE_API.podLabels,
      [
        {
          from: [AGENT_PROXY_PODS],
          ports: [{ protocol: "TCP", port: STATE_API.port }],
        },
        {
          from: [samePods(CLOUDFLARED.podLabels)],
          ports: [{ protocol: "TCP", port: STATE_API_PUBLIC.port }],
        },
      ],
      [dns, database, windmillProxy],
    ),
    // The receiver: only the tunnel connector delivers webhooks to it.
    policy(
      RECEIVER.name,
      RECEIVER.podLabels,
      [
        {
          from: [samePods(CLOUDFLARED.podLabels)],
          ports: [{ protocol: "TCP", port: RECEIVER.port }],
        },
      ],
      [dns, database, windmillProxy],
    ),
    // The Windmill proxy: only the state API and the receiver call it; it reaches DNS and 443 on
    // public addresses, and its allow-list holds the calls to Windmill's host (D-284, D-328).
    policy(
      WINDMILL_PROXY.name,
      WINDMILL_PROXY.podLabels,
      [
        {
          from: [samePods(STATE_API.podLabels), samePods(RECEIVER.podLabels)],
          ports: [{ protocol: "TCP", port: WINDMILL_PROXY.port }],
        },
      ],
      [dns, { to: [PUBLIC_IPV4], ports: [{ protocol: "TCP", port: 443 }] }],
    ),
    // The connector: no ingress; egress to DNS, the receiver, the state API's public port,
    // Cloudflare's API on 443 and Cloudflare's tunnel edge on 7844 (TCP and UDP). Only this pod
    // gets 7844.
    policy(
      CLOUDFLARED.name,
      CLOUDFLARED.podLabels,
      [],
      [
        dns,
        {
          to: [samePods(RECEIVER.podLabels)],
          ports: [{ protocol: "TCP", port: RECEIVER.port }],
        },
        {
          to: [samePods(STATE_API_PUBLIC.podLabels)],
          ports: [{ protocol: "TCP", port: STATE_API_PUBLIC.port }],
        },
        { to: [PUBLIC_IPV4], ports: [{ protocol: "TCP", port: 443 }] },
        {
          to: [PUBLIC_IPV4],
          ports: [
            { protocol: "TCP", port: TUNNEL_EDGE_PORT },
            { protocol: "UDP", port: TUNNEL_EDGE_PORT },
          ],
        },
      ],
    ),
  ];

  const services = [STATE_API, STATE_API_PUBLIC, RECEIVER, WINDMILL_PROXY].map(
    (svc): Service => ({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: svc.name, namespace: PLATFORM_NAMESPACE, labels: labels() },
      spec: {
        type: "ClusterIP",
        selector: { ...svc.podLabels },
        ports: [
          { name: "http", protocol: "TCP", port: svc.port, targetPort: svc.port },
        ],
      },
    }),
  );

  const health = (port: number, path: string): ContainerProbe => ({
    httpGet: { path, port },
    periodSeconds: 10,
  });
  const secretEnv = (name: string, ref: { name: string; key: string }): EnvVar => ({
    name,
    valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } },
  });
  // Where both services start their flows, through the shared proxy. Plain values, not secrets.
  const windmillEnv: EnvVar[] = [
    { name: WINDMILL_ENV.host, value: settings.windmill.host },
    { name: WINDMILL_ENV.workspace, value: settings.windmill.workspace },
    { name: WINDMILL_ENV.proxy, value: serviceUrl(WINDMILL_PROXY) },
  ];

  const stateApi = deployment(
    STATE_API.name,
    STATE_API.podLabels,
    settings.serviceUser,
    {
      name: STATE_API.name,
      image: settings.images.stateApi,
      env: [
        { name: "PORT", value: String(STATE_API.port) },
        secretEnv("DATABASE_URL", PLATFORM_SECRETS.stateApiDatabase),
        { name: "PUBLIC_PORT", value: String(STATE_API_PUBLIC.port) },
        {
          name: secretEnvName(PLANNING_TOKEN_SHA256_PATH),
          valueFrom: {
            secretKeyRef: { ...PLATFORM_SECRETS.stateApiPlanningToken, optional: true },
          },
        },
        {
          name: secretEnvName(WINDMILL_PLAN_APPROVAL_TOKEN_PATH),
          valueFrom: {
            secretKeyRef: { ...PLATFORM_SECRETS.stateApiWindmillToken, optional: true },
          },
        },
        ...windmillEnv,
      ],
      port: STATE_API.port,
      publicPort: STATE_API_PUBLIC.port,
      probe: health(STATE_API.port, "/health"),
      resources: settings.resources.stateApi,
    },
  );
  const receiver = deployment(RECEIVER.name, RECEIVER.podLabels, settings.serviceUser, {
    name: RECEIVER.name,
    image: settings.images.receiver,
    env: [
      { name: "PORT", value: String(RECEIVER.port) },
      secretEnv("DATABASE_URL", PLATFORM_SECRETS.receiverDatabase),
      secretEnv(
        secretEnvName(RECEIVER_WEBHOOK_SECRET_PATH),
        PLATFORM_SECRETS.receiverWebhookSecret,
      ),
      {
        name: "GITHUB_DEVELOPER_APP_LOGIN",
        value: settings.receiver.developerAppLogin,
      },
      { name: "GITHUB_DESIGNER_APP_LOGIN", value: settings.receiver.designerAppLogin },
      { name: "GITHUB_RUNNER_APP_SLUG", value: settings.receiver.runnerAppSlug },
      {
        name: secretEnvName(RECEIVER_WINDMILL_TOKEN_PATH),
        valueFrom: {
          secretKeyRef: { ...PLATFORM_SECRETS.receiverWindmillToken, optional: true },
        },
      },
      ...windmillEnv,
    ],
    port: RECEIVER.port,
    probe: health(RECEIVER.port, "/health"),
    resources: settings.resources.receiver,
  });
  const connector = deployment(
    CLOUDFLARED.name,
    CLOUDFLARED.podLabels,
    CLOUDFLARED.user,
    {
      name: CLOUDFLARED.name,
      image: CLOUDFLARED.image,
      // The image's entrypoint is `cloudflared --no-autoupdate`. The routing lives in Cloudflare
      // (remotely managed tunnel), so the connector needs only its token, read from TUNNEL_TOKEN.
      args: ["tunnel", "--metrics", `0.0.0.0:${CLOUDFLARED.metricsPort}`, "run"],
      env: [secretEnv("TUNNEL_TOKEN", PLATFORM_SECRETS.tunnelToken)],
      port: CLOUDFLARED.metricsPort,
      probe: health(CLOUDFLARED.metricsPort, "/ready"),
      resources: settings.resources.cloudflared,
    },
  );

  // The agents' egress proxy, configured from the environment with Windmill's host only: no
  // model provider, no state API route and no Secret (D-284, D-328, O-101).
  const proxy = deployment(
    WINDMILL_PROXY.name,
    WINDMILL_PROXY.podLabels,
    settings.serviceUser,
    {
      name: WINDMILL_PROXY.name,
      image: settings.images.egressProxy,
      env: [
        { name: "PORT", value: String(WINDMILL_PROXY.port) },
        { name: "RUN_ID", value: WINDMILL_PROXY.runId },
        { name: "ALLOWED_HOSTS", value: settings.windmill.host },
        { name: "MODEL_PROVIDERS", value: "[]" },
        { name: "MAX_MODEL_REQUESTS", value: "1" },
        { name: "MAX_REJECTED_MODEL_REQUESTS", value: "1" },
        { name: "STATE_API_UPSTREAM", value: "" },
      ],
      port: WINDMILL_PROXY.port,
      probe: health(WINDMILL_PROXY.port, "/health"),
      resources: settings.resources.windmillProxy,
    },
  );

  return [namespace, ...policies, ...services, stateApi, receiver, connector, proxy];
}

interface DeploymentParts {
  name: string;
  image: string;
  args?: string[];
  env: EnvVar[];
  port: number;
  /** A second, public port (the state API's, D-271). */
  publicPort?: number;
  probe: ContainerProbe;
  resources: Resources;
}

/** One replica on the platform pool, hardened as ADR 0106 section 4 asks of every pod. */
function deployment(
  name: string,
  podLabels: Labels,
  user: number,
  parts: DeploymentParts,
): Deployment {
  const template = { ...podLabels, ...labels() };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: PLATFORM_NAMESPACE, labels: labels() },
    spec: {
      replicas: 1,
      selector: { matchLabels: { ...podLabels } },
      template: {
        metadata: { labels: template },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          terminationGracePeriodSeconds: 30,
          nodeSelector: { [PLATFORM_POOL.key]: PLATFORM_POOL.value },
          securityContext: {
            runAsNonRoot: true,
            runAsUser: user,
            runAsGroup: user,
            fsGroup: user,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: parts.name,
              image: parts.image,
              imagePullPolicy: "IfNotPresent",
              ...(parts.args ? { args: parts.args } : {}),
              env: parts.env,
              ports: [
                { name: "http", containerPort: parts.port, protocol: "TCP" },
                ...(parts.publicPort === undefined
                  ? []
                  : [
                      {
                        name: "public",
                        containerPort: parts.publicPort,
                        protocol: "TCP" as const,
                      },
                    ]),
              ],
              readinessProbe: parts.probe,
              livenessProbe: { ...parts.probe, periodSeconds: 30 },
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
              volumeMounts: [{ name: "tmp", mountPath: "/tmp", readOnly: false }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: { sizeLimit: "64Mi" } }],
        },
      },
    },
  };
}
