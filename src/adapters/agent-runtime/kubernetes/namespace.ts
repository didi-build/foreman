// The objects around the runs, as data (ADR 0106 sections 1, 2 and 4): each project's agent
// namespace with Pod Security Admission `restricted`, a default-deny NetworkPolicy and a
// ResourceQuota, the runner's ServiceAccount in its own namespace, and the namespaced Role and
// RoleBinding that are its only rights. Infrastructure code applies them, never the runner
// (ADR 0110, D-188); they are written and tested here, next to the code that relies on them.
// The runner's token is a new-credentials gate at first hosting and is not declared here.
import { LABEL_MANAGED_BY, LABEL_PROJECT, agentNamespace } from "./names.ts";
import type {
  Namespace,
  NamespaceObject,
  NetworkPolicy,
  PolicyRule,
  ResourceQuota,
  Role,
  RoleBinding,
  ServiceAccount,
} from "./objects.ts";

export const RUNNER_NAMESPACE = "foreman-runner";
export const RUNNER_SERVICE_ACCOUNT = "foreman-runner";
const MANAGED_BY_INFRA = "foreman-infra";

/**
 * The runner's rights in an agent namespace, exactly ADR 0106 section 1. No Secret get, list or
 * watch, so it cannot read old credentials back. No create on Pods (Jobs make them), Namespaces,
 * Roles or RoleBindings. `pods/log` is read with get, the only verb it has.
 */
export const RUNNER_ROLE_RULES: readonly PolicyRule[] = [
  {
    apiGroups: ["batch"],
    resources: ["jobs"],
    verbs: ["create", "get", "list", "watch", "delete"],
  },
  { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
  { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
  { apiGroups: [""], resources: ["secrets"], verbs: ["create", "delete"] },
  {
    apiGroups: ["networking.k8s.io"],
    resources: ["networkpolicies"],
    verbs: ["create", "delete"],
  },
  { apiGroups: [""], resources: ["services"], verbs: ["create", "delete"] },
  {
    apiGroups: [""],
    resources: ["persistentvolumeclaims"],
    verbs: ["create", "delete"],
  },
];

/** A project's ResourceQuota (ADR 0106 section 4). Values from the project's settings. */
export interface AgentQuota {
  pods: number;
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  storage: string;
  persistentVolumeClaims: number;
}

/** The runner's own namespace and ServiceAccount. The account never mounts a token in a pod. */
export function runnerNamespaceObjects(): NamespaceObject[] {
  const namespace: Namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: RUNNER_NAMESPACE,
      labels: {
        [LABEL_MANAGED_BY]: MANAGED_BY_INFRA,
        ...podSecurityLabels(),
      },
    },
  };
  const account: ServiceAccount = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: RUNNER_SERVICE_ACCOUNT, namespace: RUNNER_NAMESPACE },
    automountServiceAccountToken: false,
  };
  return [namespace, account];
}

/** One project's agent namespace and everything in it that is not a run. */
export function agentNamespaceObjects(
  slug: string,
  quota: AgentQuota,
): NamespaceObject[] {
  const name = agentNamespace(slug);
  const labels = { [LABEL_MANAGED_BY]: MANAGED_BY_INFRA, [LABEL_PROJECT]: slug };
  const namespace: Namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, labels: { ...labels, ...podSecurityLabels() } },
  };
  const defaultDeny: NetworkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "default-deny", namespace: name, labels },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    },
  };
  const resourceQuota: ResourceQuota = {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "agents", namespace: name, labels },
    spec: {
      hard: {
        pods: String(quota.pods),
        "requests.cpu": quota.cpu,
        "limits.cpu": quota.cpu,
        "requests.memory": quota.memory,
        "limits.memory": quota.memory,
        "requests.ephemeral-storage": quota.ephemeralStorage,
        "limits.ephemeral-storage": quota.ephemeralStorage,
        "requests.storage": quota.storage,
        persistentvolumeclaims: String(quota.persistentVolumeClaims),
      },
    },
  };
  const role: Role = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: RUNNER_SERVICE_ACCOUNT, namespace: name, labels },
    rules: RUNNER_ROLE_RULES.map((rule) => ({
      apiGroups: [...rule.apiGroups],
      resources: [...rule.resources],
      verbs: [...rule.verbs],
    })),
  };
  const binding: RoleBinding = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: RUNNER_SERVICE_ACCOUNT, namespace: name, labels },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: RUNNER_SERVICE_ACCOUNT,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: RUNNER_SERVICE_ACCOUNT,
        namespace: RUNNER_NAMESPACE,
      },
    ],
  };
  return [namespace, defaultDeny, resourceQuota, role, binding];
}

/** Pod Security Admission: a pod that breaks ADR 0106 section 4 is refused at creation. */
function podSecurityLabels(): Record<string, string> {
  return {
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  };
}
