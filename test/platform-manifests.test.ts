import { describe, expect, it } from "vitest";

import {
  DEVELOPER,
  LIMITS,
  SETTINGS,
} from "../src/adapters/agent-runtime/kubernetes/fixtures.ts";
import {
  AGENTS_POOL,
  NON_PUBLIC_IPV4,
  agentStage,
} from "../src/adapters/agent-runtime/kubernetes/manifests.ts";
import {
  RUN_WATCHER_SERVICE_ACCOUNT,
  agentNamespaceObjects,
} from "../src/adapters/agent-runtime/kubernetes/namespace.ts";
import type {
  Labels,
  LabelSelector,
  NetworkPolicy,
  NetworkPolicyPeer,
  Resources,
} from "../src/adapters/agent-runtime/kubernetes/objects.ts";
import { readProxyConfig } from "../src/egress-proxy/config.ts";
import { parseStateApiUpstream } from "../src/egress-proxy/state-api.ts";
import {
  CLOUDFLARED,
  PLATFORM_NAMESPACE,
  PLATFORM_POOL,
  PLATFORM_SECRETS,
  DEFAULT_DATABASE_PORT,
  RECEIVER,
  RUN_WATCHER,
  STATE_API,
  STATE_API_PUBLIC,
  TUNNEL_EDGE_PORT,
  WINDMILL_PROXY,
  platformObjects,
  serviceUrl,
  stateApiRunSettings,
  type Deployment,
  type PlatformObject,
  type PlatformSettings,
} from "../infra/kubernetes/platform.ts";
import { clusterObjects } from "../infra/kubernetes/render.ts";
import { PLANNING_TOKEN_SHA256_PATH } from "../src/api/auth.ts";
import { windmillSettings, windmillTargetOf } from "../src/adapters/windmill/client.ts";
import { WINDMILL_PLAN_APPROVAL_TOKEN_PATH } from "../src/adapters/windmill/plan-approval-flow.ts";
import { RECEIVER_WINDMILL_TOKEN_PATH } from "../src/adapters/windmill/receiver-flows.ts";
import { RUN_WATCHER_WINDMILL_TOKEN_PATH } from "../src/adapters/windmill/run-watcher-flows.ts";
import { runWatcherSettings } from "../src/run-watcher/settings.ts";
import { readConfig, secretEnvName } from "../src/service-kit/config.ts";

// Unit: the platform namespace's objects as data (ADR 0106 sections 1 and 4, D-193, D-195).
// Nothing here talks to a cluster. Policies are checked by evaluating their selectors against the
// labels the other side really carries, so a widening shows up as a reachable pair.

const digest = (n: string): string => `@sha256:${n.repeat(64)}`;
const resources: Resources = {
  requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "64Mi" },
  limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "256Mi" },
};
const PLATFORM: PlatformSettings = {
  images: {
    stateApi: `registry.example.com/foreman/state-api${digest("d")}`,
    receiver: `registry.example.com/foreman/github-receiver${digest("e")}`,
    egressProxy: `registry.example.com/foreman/egress-proxy${digest("a")}`,
    runWatcher: `registry.example.com/foreman/run-watcher${digest("b")}`,
  },
  serviceUser: 1000,
  resources: {
    stateApi: resources,
    receiver: resources,
    cloudflared: resources,
    windmillProxy: resources,
    runWatcher: resources,
  },
  windmill: { host: "windmill.example.com", workspace: "rehearsal" },
  receiver: {
    developerAppLogin: "example-developer[bot]",
    designerAppLogin: "example-designer[bot]",
    runnerAppSlug: "example-runner",
  },
  clusterDns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
  // A documentation address (RFC 5737), standing in for the `kubernetes` Service's endpoint.
  kubernetesApi: { addresses: ["192.0.2.10"], port: 443 },
};
const PROJECTS = ["rehearsal", "second"];

const objects = platformObjects(PLATFORM, PROJECTS);
const ofKind = <K extends PlatformObject["kind"]>(kind: K) =>
  objects.filter((o) => o.kind === kind) as Extract<PlatformObject, { kind: K }>[];
const deployments = ofKind("Deployment");
const policies = ofKind("NetworkPolicy");
const deploymentOf = (name: string): Deployment => {
  const found = deployments.find((d) => d.metadata.name === name);
  if (!found) throw new Error(`no Deployment ${name}`);
  return found;
};
const podLabelsOf = (name: string): Labels =>
  deploymentOf(name).spec.template.metadata.labels;

/** Kubernetes label selector semantics for the fields these objects use. */
function selects(
  selector: LabelSelector | Record<string, never>,
  labels: Labels,
): boolean {
  const s = selector as LabelSelector;
  const matchLabels = s.matchLabels ?? {};
  const okLabels = Object.entries(matchLabels).every(([k, v]) => labels[k] === v);
  const okExpressions = (s.matchExpressions ?? []).every(
    (e) => e.operator === "Exists" && e.key in labels,
  );
  return okLabels && okExpressions;
}

interface Pod {
  namespace: string;
  namespaceLabels: Labels;
  labels: Labels;
}

/** Does a NetworkPolicy peer, written in `policyNamespace`, admit this pod? */
function peerAdmits(
  peer: NetworkPolicyPeer,
  policyNamespace: string,
  pod: Pod,
): boolean {
  if (peer.ipBlock) return false;
  const nsOk = peer.namespaceSelector
    ? selects(peer.namespaceSelector, pod.namespaceLabels)
    : pod.namespace === policyNamespace;
  const podOk = peer.podSelector ? selects(peer.podSelector, pod.labels) : true;
  return nsOk && podOk;
}

const platformNamespaceLabels = ofKind("Namespace")[0]?.metadata.labels ?? {};
const platformPod = (name: string): Pod => ({
  namespace: PLATFORM_NAMESPACE,
  namespaceLabels: {
    ...platformNamespaceLabels,
    "kubernetes.io/metadata.name": PLATFORM_NAMESPACE,
  },
  labels: podLabelsOf(name),
});

/** Ports on which a platform pod accepts traffic from `from`, across every policy that selects it. */
function ingressPorts(target: string, from: Pod): number[] {
  const labels = podLabelsOf(target);
  return policies
    .filter((p) => selects(p.spec.podSelector, labels))
    .flatMap((p) =>
      p.spec.ingress
        .filter((rule) =>
          rule.from.some((peer) => peerAdmits(peer, PLATFORM_NAMESPACE, from)),
        )
        .flatMap((rule) => rule.ports.map((port) => port.port)),
    );
}

const agentNamespace = agentNamespaceObjects("rehearsal", {
  pods: 4,
  cpu: "2",
  memory: "4Gi",
  ephemeralStorage: "8Gi",
  storage: "4Gi",
  persistentVolumeClaims: 2,
})[0];
const agentNamespaceLabels: Labels = {
  ...(agentNamespace?.metadata.labels ?? {}),
  "kubernetes.io/metadata.name": agentNamespace?.metadata.name ?? "",
};

// The real run pods, built by the runtime adapter with the platform's state API settings.
const stage = agentStage(DEVELOPER, LIMITS, {
  ...SETTINGS,
  stateApi: stateApiRunSettings(),
});
const proxyJob = stage.proxyJob;
const agentJob = stage.clientJob("10.0.0.10");
const agentProxyPod: Pod = {
  namespace: proxyJob.metadata.namespace ?? "",
  namespaceLabels: agentNamespaceLabels,
  labels: proxyJob.spec.template.metadata.labels,
};
const agentPod: Pod = {
  ...agentProxyPod,
  labels: agentJob.spec.template.metadata.labels,
};

describe("platform namespace (unit: ADR 0106 section 1)", () => {
  it("is foreman-platform with Pod Security Admission restricted", () => {
    const [namespace] = ofKind("Namespace");
    expect(namespace?.metadata.name).toBe(PLATFORM_NAMESPACE);
    expect(namespace?.metadata.labels).toMatchObject({
      "pod-security.kubernetes.io/enforce": "restricted",
    });
  });

  it("denies all ingress and egress by default", () => {
    const deny = policies.find((p) => p.metadata.name === "default-deny");
    expect(deny?.spec).toEqual({
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    });
  });

  it("gives every pod a policy that names it, so nothing relies on default-deny alone by accident", () => {
    for (const d of deployments) {
      const named = policies.filter(
        (p) =>
          p.metadata.name !== "default-deny" &&
          selects(p.spec.podSelector, podLabelsOf(d.metadata.name)),
      );
      expect(named.map((p) => p.metadata.name)).toEqual([d.metadata.name]);
    }
  });

  it("runs the state API, the receiver, the tunnel connector, the Windmill proxy and the run watcher, each with a ClusterIP Service where called", () => {
    expect(deployments.map((d) => d.metadata.name)).toEqual([
      STATE_API.name,
      RECEIVER.name,
      CLOUDFLARED.name,
      WINDMILL_PROXY.name,
      RUN_WATCHER.name,
    ]);
    const services = ofKind("Service");
    expect(
      services.map((s) => [s.metadata.name, s.spec.type, s.spec.ports[0]?.port]),
    ).toEqual([
      [STATE_API.name, "ClusterIP", STATE_API.port],
      [STATE_API_PUBLIC.name, "ClusterIP", STATE_API_PUBLIC.port],
      [RECEIVER.name, "ClusterIP", RECEIVER.port],
      [WINDMILL_PROXY.name, "ClusterIP", WINDMILL_PROXY.port],
    ]);
    for (const s of services) {
      const target =
        s.metadata.name === STATE_API_PUBLIC.name ? STATE_API.name : s.metadata.name;
      expect(s.spec.selector).toEqual(deploymentOf(target).spec.selector.matchLabels);
      expect(s.spec.ports).toHaveLength(1);
    }
  });

  it("gives the state API's public port (D-271) its own Service and container port, set by PUBLIC_PORT", () => {
    const container = deploymentOf(STATE_API.name).spec.template.spec.containers[0];
    expect(container?.ports.map((p) => [p.name, p.containerPort])).toEqual([
      ["http", STATE_API.port],
      ["public", STATE_API_PUBLIC.port],
    ]);
    expect(container?.env).toContainEqual({
      name: "PUBLIC_PORT",
      value: String(STATE_API_PUBLIC.port),
    });
    expect(serviceUrl(STATE_API_PUBLIC)).toBe(
      "http://state-api-public.foreman-platform.svc.cluster.local:8081",
    );
  });
});

describe("platform pods (unit: ADR 0106 section 4, D-193)", () => {
  it.each(deployments.map((d) => [d.metadata.name, d] as const))(
    "%s is restricted, limited and on the platform pool",
    (_name, d) => {
      const pod = d.spec.template.spec;
      expect(pod.nodeSelector).toEqual({ [PLATFORM_POOL.key]: PLATFORM_POOL.value });
      expect(pod.nodeSelector[AGENTS_POOL.key]).not.toBe(AGENTS_POOL.value);
      expect("tolerations" in pod).toBe(false);
      // Only the run watcher mounts a token, and only its own ServiceAccount's (D-330).
      if (d.metadata.name === RUN_WATCHER.name) {
        expect(pod.automountServiceAccountToken).toBe(true);
        expect(pod.serviceAccountName).toBe(RUN_WATCHER_SERVICE_ACCOUNT);
      } else {
        expect(pod.automountServiceAccountToken).toBe(false);
        expect("serviceAccountName" in pod).toBe(false);
      }
      expect([pod.hostNetwork, pod.hostPID, pod.hostIPC]).toEqual([
        false,
        false,
        false,
      ]);
      expect(pod.securityContext.runAsNonRoot).toBe(true);
      expect(pod.securityContext.runAsUser).toBeGreaterThan(0);
      expect(pod.securityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
      for (const c of pod.containers) {
        expect(c.image).toMatch(/@sha256:[0-9a-f]{64}$/);
        expect(c.securityContext).toMatchObject({
          runAsNonRoot: true,
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          privileged: false,
          capabilities: { drop: ["ALL"] },
          seccompProfile: { type: "RuntimeDefault" },
        });
        expect(c.securityContext.runAsUser).toBeGreaterThan(0);
        for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
          expect(c.resources.limits[key]).toBeTruthy();
          expect(c.resources.requests[key]).toBeTruthy();
        }
        expect(c.readinessProbe.httpGet.port).toBe(c.ports[0]?.containerPort);
      }
      for (const v of pod.volumes)
        expect(Object.keys(v).sort()).toEqual(["emptyDir", "name"]);
    },
  );

  it("refuses an image that is not pinned by digest", () => {
    expect(() =>
      platformObjects(
        {
          ...PLATFORM,
          images: { ...PLATFORM.images, stateApi: "state-api:latest" },
        },
        PROJECTS,
      ),
    ).toThrow(/pinned by digest/);
  });

  it("pins the tunnel connector by digest and runs it as the image's non-root user", () => {
    const pod = deploymentOf(CLOUDFLARED.name).spec.template.spec;
    expect(pod.containers[0]?.image).toBe(CLOUDFLARED.image);
    expect(pod.securityContext.runAsUser).toBe(65532);
  });
});

describe("no secret values (unit: AGENTS.md section 5)", () => {
  const everything = clusterObjects({ platform: PLATFORM, projects: [] }).items;

  it("declares no Secret object", () => {
    expect(everything.map((o) => o.kind)).not.toContain("Secret");
  });

  it("reads every credential from a Secret by name, never as a literal value", () => {
    const CREDENTIAL_ENV = /DATABASE_URL|TOKEN|SECRET|PASSWORD|KEY/;
    const refs: string[] = [];
    for (const d of deployments) {
      for (const env of d.spec.template.spec.containers.flatMap((c) => c.env)) {
        if ("value" in env) {
          expect(env.name, env.name).not.toMatch(CREDENTIAL_ENV);
        } else {
          refs.push(
            `${env.valueFrom.secretKeyRef.name}/${env.valueFrom.secretKeyRef.key}`,
          );
        }
      }
    }
    expect(refs.sort()).toEqual(
      Object.values(PLATFORM_SECRETS)
        .map((s) => `${s.name}/${s.key}`)
        .sort(),
    );
  });

  it("gives the state API the planning chat's token hash at its secret path, optional until first hosting (D-266)", () => {
    const env = deploymentOf(STATE_API.name)
      .spec.template.spec.containers.flatMap((c) => c.env)
      .find((e) => e.name === secretEnvName(PLANNING_TOKEN_SHA256_PATH));
    expect(env).toEqual({
      name: "SECRET_PLATFORM_STATE_API_PLANNING_TOKEN_SHA256",
      valueFrom: {
        secretKeyRef: { ...PLATFORM_SECRETS.stateApiPlanningToken, optional: true },
      },
    });
  });

  it("gives the state API its Windmill credential for the plan-approval flow at its secret path, optional until first hosting (D-273)", () => {
    const env = deploymentOf(STATE_API.name)
      .spec.template.spec.containers.flatMap((c) => c.env)
      .find((e) => e.name === secretEnvName(WINDMILL_PLAN_APPROVAL_TOKEN_PATH));
    expect(env).toEqual({
      name: "SECRET_PLATFORM_STATE_API_WINDMILL_PLAN_APPROVAL_TOKEN",
      valueFrom: {
        secretKeyRef: { ...PLATFORM_SECRETS.stateApiWindmillToken, optional: true },
      },
    });
  });

  it("mounts each Secret only into the pod that uses it", () => {
    const used = (name: string) =>
      deploymentOf(name)
        .spec.template.spec.containers.flatMap((c) => c.env)
        .flatMap((e) => ("valueFrom" in e ? [e.valueFrom.secretKeyRef.name] : []));
    expect(used(STATE_API.name)).toEqual([
      PLATFORM_SECRETS.stateApiDatabase.name,
      PLATFORM_SECRETS.stateApiPlanningToken.name,
      PLATFORM_SECRETS.stateApiWindmillToken.name,
    ]);
    expect(used(CLOUDFLARED.name)).toEqual([PLATFORM_SECRETS.tunnelToken.name]);
    expect(used(RECEIVER.name).sort()).toEqual(
      [
        PLATFORM_SECRETS.receiverDatabase.name,
        PLATFORM_SECRETS.receiverWebhookSecret.name,
        PLATFORM_SECRETS.receiverWindmillToken.name,
      ].sort(),
    );
    // The Windmill proxy holds no credential at all (D-328).
    expect(used(WINDMILL_PROXY.name)).toEqual([]);
    // The run watcher holds its Windmill token only: no database URL (D-330).
    expect(used(RUN_WATCHER.name)).toEqual([
      PLATFORM_SECRETS.runWatcherWindmillToken.name,
    ]);
  });

  it("gives the receiver its Windmill token at its secret path, optional until first hosting (D-291)", () => {
    const env = deploymentOf(RECEIVER.name)
      .spec.template.spec.containers.flatMap((c) => c.env)
      .find((e) => e.name === secretEnvName(RECEIVER_WINDMILL_TOKEN_PATH));
    expect(env).toEqual({
      name: "SECRET_PLATFORM_GITHUB_RECEIVER_WINDMILL_TOKEN",
      valueFrom: {
        secretKeyRef: { ...PLATFORM_SECRETS.receiverWindmillToken, optional: true },
      },
    });
  });
});

describe("agent namespaces reach the state API only (unit: D-193, D-195)", () => {
  it("the runner's state API settings point at the platform's Service and pods", () => {
    const run = stateApiRunSettings();
    expect(parseStateApiUpstream(run.upstream)).toEqual({
      host: `${STATE_API.name}.${PLATFORM_NAMESPACE}.svc.cluster.local`,
      port: STATE_API.port,
    });
    expect(selects({ matchLabels: run.podLabels }, podLabelsOf(STATE_API.name))).toBe(
      true,
    );
    // The slice 3 fixture uses the same values, so the adapter's tests cover the real route.
    expect(SETTINGS.stateApi).toEqual(run);
  });

  it("lets an agent's egress proxy pod reach the state API port and nothing else", () => {
    expect(ingressPorts(STATE_API.name, agentProxyPod)).toEqual([STATE_API.port]);
    expect(ingressPorts(RECEIVER.name, agentProxyPod)).toEqual([]);
    expect(ingressPorts(CLOUDFLARED.name, agentProxyPod)).toEqual([]);
  });

  it("matches the proxy's own egress rule to the state API", () => {
    const [, proxyPolicy] = stage.policies;
    const toPlatform = proxyPolicy.spec.egress.filter((rule) =>
      rule.to.some((peer) =>
        peerAdmits(peer, agentProxyPod.namespace, platformPod(STATE_API.name)),
      ),
    );
    expect(toPlatform.flatMap((r) => r.ports.map((p) => p.port))).toEqual([
      STATE_API.port,
    ]);
  });

  it("refuses the agent pod itself, and the QA fetch proxy, everywhere in the platform namespace", () => {
    const fetchProxyPod: Pod = {
      ...agentProxyPod,
      labels: { ...agentProxyPod.labels, "foreman/component": "fetch-proxy" },
    };
    for (const pod of [agentPod, fetchProxyPod]) {
      for (const d of deployments)
        expect(ingressPorts(d.metadata.name, pod)).toEqual([]);
    }
  });

  it("admits nothing else from outside the platform namespace", () => {
    const outside = policies.flatMap((p) =>
      p.spec.ingress.flatMap((r) => r.from).filter((peer) => peer.namespaceSelector),
    );
    expect(outside).toHaveLength(1);
    expect(outside[0]?.podSelector?.matchLabels).toEqual({
      "foreman/component": "proxy",
    });
  });
});

describe("tunnel connector and receiver (unit: D-195)", () => {
  const policyOf = (name: string): NetworkPolicy => {
    const found = policies.find((p) => p.metadata.name === name);
    if (!found) throw new Error(`no policy ${name}`);
    return found;
  };

  it("the receiver accepts only the connector, on its port", () => {
    expect(ingressPorts(RECEIVER.name, platformPod(CLOUDFLARED.name))).toEqual([
      RECEIVER.port,
    ]);
    expect(ingressPorts(RECEIVER.name, platformPod(STATE_API.name))).toEqual([]);
  });

  it("the state API accepts the connector on its public port only, never on the agents' port (D-271)", () => {
    expect(ingressPorts(STATE_API.name, platformPod(CLOUDFLARED.name))).toEqual([
      STATE_API_PUBLIC.port,
    ]);
    expect(ingressPorts(STATE_API.name, agentProxyPod)).toEqual([STATE_API.port]);
    expect(ingressPorts(STATE_API.name, platformPod(RECEIVER.name))).toEqual([]);
  });

  it("the connector takes no ingress, and reaches only DNS, the receiver, the state API's public port, public 443 and the tunnel edge", () => {
    const policy = policyOf(CLOUDFLARED.name);
    expect(policy.spec.ingress).toEqual([]);
    const reachable = policy.spec.egress.map((rule) => ({
      ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
      to: rule.to.map((peer) =>
        peer.ipBlock
          ? `public:${peer.ipBlock.cidr}`
          : peer.namespaceSelector
            ? "cluster-dns"
            : `pods:${JSON.stringify(peer.podSelector?.matchLabels)}`,
      ),
    }));
    expect(reachable).toEqual([
      { ports: ["UDP/53", "TCP/53"], to: ["cluster-dns"] },
      {
        ports: [`TCP/${RECEIVER.port}`],
        to: [`pods:${JSON.stringify(RECEIVER.podLabels)}`],
      },
      {
        ports: [`TCP/${STATE_API_PUBLIC.port}`],
        to: [`pods:${JSON.stringify(STATE_API.podLabels)}`],
      },
      { ports: ["TCP/443"], to: ["public:0.0.0.0/0"] },
      { ports: ["TCP/7844", "UDP/7844"], to: ["public:0.0.0.0/0"] },
    ]);
    for (const rule of policy.spec.egress.filter((r) => r.to[0]?.ipBlock)) {
      expect(rule.to[0]?.ipBlock?.except).toEqual([...NON_PUBLIC_IPV4]);
    }
  });

  it("the state API and receiver reach only DNS, the database port on public addresses and the Windmill proxy's pods, never 443 (D-284)", () => {
    for (const name of [STATE_API.name, RECEIVER.name]) {
      const ports = policyOf(name).spec.egress.flatMap((r) =>
        r.ports.map((p) => `${p.protocol}/${p.port}`),
      );
      expect(ports).toEqual([
        "UDP/53",
        "TCP/53",
        "TCP/5432",
        `TCP/${WINDMILL_PROXY.port}`,
      ]);
      expect(ports).not.toContain("TCP/443");
      const db = policyOf(name).spec.egress[1];
      expect(db?.to[0]?.ipBlock?.except).toEqual([...NON_PUBLIC_IPV4]);
      const toProxy = policyOf(name).spec.egress[2];
      expect(toProxy?.to).toEqual([
        { podSelector: { matchLabels: WINDMILL_PROXY.podLabels } },
      ]);
    }
  });
});

describe("the run watcher (unit: D-330, O-102)", () => {
  const policyOf = (name: string): NetworkPolicy => {
    const found = policies.find((p) => p.metadata.name === name);
    if (!found) throw new Error(`no policy ${name}`);
    return found;
  };
  const watcherEnv = () =>
    deploymentOf(RUN_WATCHER.name).spec.template.spec.containers.flatMap((c) => c.env);
  const plainWatcherEnv = (): Record<string, string> =>
    Object.fromEntries(
      watcherEnv().flatMap((e) => ("value" in e ? [[e.name, e.value]] : [])),
    );

  it("has its own ServiceAccount in the platform namespace, which mounts no token by itself", () => {
    const accounts = ofKind("ServiceAccount");
    expect(accounts).toEqual([
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: {
          name: RUN_WATCHER_SERVICE_ACCOUNT,
          namespace: PLATFORM_NAMESPACE,
          labels: { "app.kubernetes.io/managed-by": "foreman-infra" },
        },
        automountServiceAccountToken: false,
      },
    ]);
  });

  it("has no Service and takes no traffic in: the kubelet's probe comes from the node, as for the connector", () => {
    expect(ofKind("Service").map((s) => s.metadata.name)).not.toContain(
      RUN_WATCHER.name,
    );
    expect(policyOf(RUN_WATCHER.name).spec.ingress).toEqual([]);
    for (const from of [
      platformPod(STATE_API.name),
      platformPod(RECEIVER.name),
      platformPod(CLOUDFLARED.name),
      agentProxyPod,
      agentPod,
    ]) {
      expect(ingressPorts(RUN_WATCHER.name, from)).toEqual([]);
    }
  });

  it("reaches only DNS, the API server's own address and port, and the Windmill proxy's pods", () => {
    const policy = policyOf(RUN_WATCHER.name);
    expect(policy.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
            },
            podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
          },
        ],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
      {
        to: [{ ipBlock: { cidr: "192.0.2.10/32", except: [] } }],
        ports: [{ protocol: "TCP", port: 443 }],
      },
      {
        to: [{ podSelector: { matchLabels: WINDMILL_PROXY.podLabels } }],
        ports: [{ protocol: "TCP", port: WINDMILL_PROXY.port }],
      },
    ]);
    // Never public addresses on 443, so it cannot reach Windmill, or anything else, past the proxy.
    for (const rule of policy.spec.egress) {
      for (const peer of rule.to) expect(peer.ipBlock?.cidr).not.toBe("0.0.0.0/0");
    }
  });

  it("gives every API server address its own /32 on the API server's port, and refuses anything else", () => {
    const two = platformObjects(
      {
        ...PLATFORM,
        kubernetesApi: { addresses: ["192.0.2.10", "192.0.2.11"], port: 6443 },
      },
      PROJECTS,
    ).find(
      (o): o is NetworkPolicy =>
        o.kind === "NetworkPolicy" && o.metadata.name === RUN_WATCHER.name,
    );
    expect(two?.spec.egress[1]).toEqual({
      to: [
        { ipBlock: { cidr: "192.0.2.10/32", except: [] } },
        { ipBlock: { cidr: "192.0.2.11/32", except: [] } },
      ],
      ports: [{ protocol: "TCP", port: 6443 }],
    });
    for (const addresses of [
      [],
      ["0.0.0.0"],
      ["10.0.0.0/8"],
      ["kubernetes.default.svc"],
      ["192.0.2.1", "192.0.2.1"],
    ]) {
      expect(() =>
        platformObjects(
          { ...PLATFORM, kubernetesApi: { addresses, port: 443 } },
          PROJECTS,
        ),
      ).toThrow(/kubernetesApi addresses/);
    }
    // A settings file written before the watcher existed is refused by name.
    const older: Partial<PlatformSettings> = { ...PLATFORM };
    delete older.kubernetesApi;
    expect(() => platformObjects(older as PlatformSettings, PROJECTS)).toThrow(
      /kubernetesApi addresses/,
    );
    for (const port of [0, 53, 70000]) {
      expect(() =>
        platformObjects(
          { ...PLATFORM, kubernetesApi: { addresses: ["192.0.2.10"], port } },
          PROJECTS,
        ),
      ).toThrow(/kubernetesApi port/);
    }
  });

  it("is the Windmill proxy's third caller, and no other pod is (D-328)", () => {
    expect(ingressPorts(WINDMILL_PROXY.name, platformPod(RUN_WATCHER.name))).toEqual([
      WINDMILL_PROXY.port,
    ]);
    const callers = deployments
      .map((d) => d.metadata.name)
      .filter(
        (name) => ingressPorts(WINDMILL_PROXY.name, platformPod(name)).length > 0,
      );
    expect(callers).toEqual([STATE_API.name, RECEIVER.name, RUN_WATCHER.name]);
  });

  it("watches exactly the rendered projects' agent namespaces, read by its own settings reader", () => {
    const config = readConfig(runWatcherSettings(), plainWatcherEnv());
    expect(config.agentNamespaces).toEqual(["agents-rehearsal", "agents-second"]);
    expect(config.kubernetesApi.href).toBe("https://kubernetes.default.svc/");
    expect(config.port).toBe(RUN_WATCHER.port);
    expect(windmillTargetOf(config)).toEqual({
      host: PLATFORM.windmill.host,
      workspace: PLATFORM.windmill.workspace,
      proxy: new URL(serviceUrl(WINDMILL_PROXY)),
    });
    expect(config.windmillToken).toBeNull();
    expect(
      readConfig(
        runWatcherSettings(),
        Object.fromEntries(
          platformObjects(PLATFORM, [])
            .filter((o): o is Deployment => o.kind === "Deployment")
            .find((d) => d.metadata.name === RUN_WATCHER.name)
            ?.spec.template.spec.containers.flatMap((c) => c.env)
            .flatMap((e) => ("value" in e ? [[e.name, e.value]] : [])) ?? [],
        ),
      ).agentNamespaces,
    ).toEqual([]);
  });

  it("gets its Windmill token at its own secret path, optional until first hosting, and no database URL", () => {
    expect(
      watcherEnv().find(
        (e) => e.name === secretEnvName(RUN_WATCHER_WINDMILL_TOKEN_PATH),
      ),
    ).toEqual({
      name: "SECRET_PLATFORM_RUN_WATCHER_WINDMILL_TOKEN",
      valueFrom: {
        secretKeyRef: { ...PLATFORM_SECRETS.runWatcherWindmillToken, optional: true },
      },
    });
    expect(watcherEnv().map((e) => e.name)).not.toContain("DATABASE_URL");
  });

  it("is bound only in agent namespaces, by a Role there: nothing cluster-wide and nothing in the platform or runner namespace", () => {
    const quota = {
      pods: 4,
      cpu: "2",
      memory: "4Gi",
      ephemeralStorage: "8Gi",
      storage: "4Gi",
      persistentVolumeClaims: 2,
    };
    const items = clusterObjects({
      platform: PLATFORM,
      projects: PROJECTS.map((slug) => ({ slug, quota })),
    }).items;
    const kinds = items.map((o) => o.kind as string);
    expect(kinds).not.toContain("ClusterRole");
    expect(kinds).not.toContain("ClusterRoleBinding");
    const watcherBindings = items.filter(
      (o) =>
        o.kind === "RoleBinding" &&
        o.subjects.some((s) => s.name === RUN_WATCHER_SERVICE_ACCOUNT),
    );
    expect(watcherBindings.map((o) => o.metadata.namespace)).toEqual([
      "agents-rehearsal",
      "agents-second",
    ]);
    // The namespaces it watches are exactly the ones its Role is in.
    const watched = readConfig(runWatcherSettings(), plainWatcherEnv()).agentNamespaces;
    expect(watched).toEqual(watcherBindings.map((o) => o.metadata.namespace));
  });
});

describe("cluster objects (unit: render)", () => {
  it("lists the platform, the runner's namespace and each project's agent namespace", () => {
    const list = clusterObjects({
      platform: PLATFORM,
      projects: [
        {
          slug: "rehearsal",
          quota: {
            pods: 4,
            cpu: "2",
            memory: "4Gi",
            ephemeralStorage: "8Gi",
            storage: "4Gi",
            persistentVolumeClaims: 2,
          },
        },
      ],
    });
    const namespaces = list.items
      .filter((o) => o.kind === "Namespace")
      .map((o) => o.metadata.name);
    expect(namespaces).toEqual([
      PLATFORM_NAMESPACE,
      "foreman-runner",
      "agents-rehearsal",
    ]);
  });
});

describe("special egress ports belong to one kind of pod each (unit: D-195)", () => {
  /** Every port a policy allows out, as protocol/port. */
  const egressPorts = (policy: NetworkPolicy): string[] =>
    policy.spec.egress.flatMap((r) => r.ports.map((p) => `${p.protocol}/${p.port}`));
  const allows = (port: string) =>
    policies.filter((p) => egressPorts(p).includes(port)).map((p) => p.metadata.name);
  const runPolicies = [...stage.policies];

  it("defaults the database port to Supabase's session pooler, 5432", () => {
    expect(DEFAULT_DATABASE_PORT).toBe(5432);
    expect("databasePort" in PLATFORM).toBe(false);
  });

  it("only the tunnel connector may reach 7844, over TCP and UDP", () => {
    expect(allows(`TCP/${TUNNEL_EDGE_PORT}`)).toEqual([CLOUDFLARED.name]);
    expect(allows(`UDP/${TUNNEL_EDGE_PORT}`)).toEqual([CLOUDFLARED.name]);
    for (const p of runPolicies)
      expect(egressPorts(p).join(",")).not.toContain("/7844");
  });

  it("only the state API and the receiver may reach the database port", () => {
    expect(allows("TCP/5432")).toEqual([STATE_API.name, RECEIVER.name]);
    for (const p of runPolicies) expect(egressPorts(p)).not.toContain("TCP/5432");
  });

  it("only the tunnel connector and the Windmill proxy may reach 443 on public addresses (D-284); the run watcher only the API server's address", () => {
    const toPublic443 = policies
      .filter((p) =>
        p.spec.egress.some(
          (r) =>
            r.ports.some((port) => port.protocol === "TCP" && port.port === 443) &&
            r.to.some((peer) => peer.ipBlock?.cidr === "0.0.0.0/0"),
        ),
      )
      .map((p) => p.metadata.name);
    expect(toPublic443.sort()).toEqual([CLOUDFLARED.name, WINDMILL_PROXY.name]);
    // Here the API server's port is 443 too, but the watcher's rule names one address only.
    expect(allows("TCP/443").sort()).toEqual(
      [CLOUDFLARED.name, RUN_WATCHER.name, WINDMILL_PROXY.name].sort(),
    );
    expect(allows("UDP/443")).toEqual([]);
  });
});

describe("the shared Windmill proxy (unit: D-284, D-328, O-101)", () => {
  const proxyPolicy = policies.find((p) => p.metadata.name === WINDMILL_PROXY.name);
  const plainEnv = (name: string): Record<string, string> =>
    Object.fromEntries(
      deploymentOf(name)
        .spec.template.spec.containers.flatMap((c) => c.env)
        .flatMap((e) => ("value" in e ? [[e.name, e.value]] : [])),
    );

  it("accepts only the state API and the receiver, on its port", () => {
    expect(ingressPorts(WINDMILL_PROXY.name, platformPod(STATE_API.name))).toEqual([
      WINDMILL_PROXY.port,
    ]);
    expect(ingressPorts(WINDMILL_PROXY.name, platformPod(RECEIVER.name))).toEqual([
      WINDMILL_PROXY.port,
    ]);
    expect(ingressPorts(WINDMILL_PROXY.name, platformPod(CLOUDFLARED.name))).toEqual(
      [],
    );
    for (const pod of [agentProxyPod, agentPod]) {
      expect(ingressPorts(WINDMILL_PROXY.name, pod)).toEqual([]);
    }
  });

  it("reaches only DNS and 443 on public addresses: the host check is the proxy's own", () => {
    const reachable = proxyPolicy?.spec.egress.map((rule) => ({
      ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
      to: rule.to.map((peer) =>
        peer.ipBlock ? `public:${peer.ipBlock.cidr}` : "cluster-dns",
      ),
    }));
    expect(reachable).toEqual([
      { ports: ["UDP/53", "TCP/53"], to: ["cluster-dns"] },
      { ports: ["TCP/443"], to: ["public:0.0.0.0/0"] },
    ]);
    expect(proxyPolicy?.spec.egress[1]?.to[0]?.ipBlock?.except).toEqual([
      ...NON_PUBLIC_IPV4,
    ]);
  });

  it("runs the agents' egress proxy image with Windmill's host only: no provider, no state API route, no credential", () => {
    const pod = deploymentOf(WINDMILL_PROXY.name).spec.template.spec;
    expect(pod.containers.map((c) => c.image)).toEqual([PLATFORM.images.egressProxy]);
    // The proxy's own reader, on exactly the manifest's environment.
    const config = readProxyConfig(plainEnv(WINDMILL_PROXY.name));
    expect([...config.allowedHosts]).toEqual([PLATFORM.windmill.host]);
    expect(config.providers).toEqual([]);
    expect(config.stateApi).toBeUndefined();
    expect(config.credentials.size).toBe(0);
    expect(config.port).toBe(WINDMILL_PROXY.port);
  });

  it("is where the state API and the receiver send their starts, at the configured host and workspace", () => {
    for (const name of [STATE_API.name, RECEIVER.name]) {
      // The services' own settings reader, on the manifest's plain environment.
      const config = readConfig(windmillSettings("platform/test/windmill-token"), {
        ...plainEnv(name),
      });
      expect(windmillTargetOf(config)).toEqual({
        host: PLATFORM.windmill.host,
        workspace: PLATFORM.windmill.workspace,
        proxy: new URL(serviceUrl(WINDMILL_PROXY)),
      });
      expect(config.windmillToken).toBeNull();
    }
    expect(serviceUrl(WINDMILL_PROXY)).toBe(
      "http://windmill-proxy.foreman-platform.svc.cluster.local:8080",
    );
  });

  it("refuses a Windmill host that is not a plain name, and a bad workspace id", () => {
    for (const host of ["https://windmill.example.com", "10.0.0.1", "windmill"]) {
      expect(() =>
        platformObjects(
          { ...PLATFORM, windmill: { ...PLATFORM.windmill, host } },
          PROJECTS,
        ),
      ).toThrow(/windmill host/);
    }
    expect(() =>
      platformObjects(
        { ...PLATFORM, windmill: { ...PLATFORM.windmill, workspace: "a/b" } },
        PROJECTS,
      ),
    ).toThrow(/windmill workspace/);
  });
});
