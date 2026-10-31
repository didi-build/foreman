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
import { agentNamespaceObjects } from "../src/adapters/agent-runtime/kubernetes/namespace.ts";
import type {
  Labels,
  LabelSelector,
  NetworkPolicy,
  NetworkPolicyPeer,
  Resources,
} from "../src/adapters/agent-runtime/kubernetes/objects.ts";
import { parseStateApiUpstream } from "../src/egress-proxy/state-api.ts";
import {
  CLOUDFLARED,
  PLATFORM_NAMESPACE,
  PLATFORM_POOL,
  PLATFORM_SECRETS,
  RECEIVER,
  STATE_API,
  platformObjects,
  stateApiRunSettings,
  type Deployment,
  type PlatformObject,
  type PlatformSettings,
} from "../infra/kubernetes/platform.ts";
import { clusterObjects } from "../infra/kubernetes/render.ts";

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
  },
  serviceUser: 1000,
  resources: { stateApi: resources, receiver: resources, cloudflared: resources },
  receiver: {
    developerAppLogin: "example-developer[bot]",
    designerAppLogin: "example-designer[bot]",
    runnerAppSlug: "example-runner",
  },
  databasePort: 5432,
  clusterDns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
};

const objects = platformObjects(PLATFORM);
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

  it("runs the state API, the receiver and the tunnel connector, each with a ClusterIP Service where called", () => {
    expect(deployments.map((d) => d.metadata.name)).toEqual([
      STATE_API.name,
      RECEIVER.name,
      CLOUDFLARED.name,
    ]);
    const services = ofKind("Service");
    expect(
      services.map((s) => [s.metadata.name, s.spec.type, s.spec.ports[0]?.port]),
    ).toEqual([
      [STATE_API.name, "ClusterIP", STATE_API.port],
      [RECEIVER.name, "ClusterIP", RECEIVER.port],
    ]);
    for (const s of services) {
      expect(s.spec.selector).toEqual(
        deploymentOf(s.metadata.name).spec.selector.matchLabels,
      );
    }
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
      expect(pod.automountServiceAccountToken).toBe(false);
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
      platformObjects({
        ...PLATFORM,
        images: { ...PLATFORM.images, stateApi: "state-api:latest" },
      }),
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

  it("mounts each Secret only into the pod that uses it", () => {
    const used = (name: string) =>
      deploymentOf(name)
        .spec.template.spec.containers.flatMap((c) => c.env)
        .flatMap((e) => ("valueFrom" in e ? [e.valueFrom.secretKeyRef.name] : []));
    expect(used(STATE_API.name)).toEqual([PLATFORM_SECRETS.stateApiDatabase.name]);
    expect(used(CLOUDFLARED.name)).toEqual([PLATFORM_SECRETS.tunnelToken.name]);
    expect(used(RECEIVER.name).sort()).toEqual(
      [
        PLATFORM_SECRETS.receiverDatabase.name,
        PLATFORM_SECRETS.receiverWebhookSecret.name,
      ].sort(),
    );
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
    expect(ingressPorts(STATE_API.name, platformPod(CLOUDFLARED.name))).toEqual([]);
  });

  it("the connector takes no ingress, and reaches only DNS, the receiver and public 443", () => {
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
      { ports: ["TCP/443"], to: ["public:0.0.0.0/0"] },
    ]);
    const publicRule = policy.spec.egress.find((r) => r.to[0]?.ipBlock);
    expect(publicRule?.to[0]?.ipBlock?.except).toEqual([...NON_PUBLIC_IPV4]);
  });

  it("the state API and receiver reach only DNS and the database port on public addresses", () => {
    for (const name of [STATE_API.name, RECEIVER.name]) {
      const ports = policyOf(name).spec.egress.flatMap((r) =>
        r.ports.map((p) => `${p.protocol}/${p.port}`),
      );
      expect(ports).toEqual(["UDP/53", "TCP/53", `TCP/${PLATFORM.databasePort}`]);
      const db = policyOf(name).spec.egress[1];
      expect(db?.to[0]?.ipBlock?.except).toEqual([...NON_PUBLIC_IPV4]);
    }
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
