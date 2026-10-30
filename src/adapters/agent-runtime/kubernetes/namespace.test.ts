import { describe, expect, it } from "vitest";

import { CLIENT_OPERATIONS } from "./client.ts";
import {
  RUNNER_NAMESPACE,
  RUNNER_ROLE_RULES,
  agentNamespaceObjects,
  runnerNamespaceObjects,
  type AgentQuota,
} from "./namespace.ts";
import type { NamespaceObject, Role, RoleBinding } from "./objects.ts";

// Unit: the agent namespace, its default policies and the runner's RBAC as data (ADR 0106
// sections 1, 2 and 4). Infrastructure code applies them; nothing here talks to a cluster.

const QUOTA: AgentQuota = {
  pods: 12,
  cpu: "4",
  memory: "8Gi",
  ephemeralStorage: "20Gi",
  storage: "10Gi",
  persistentVolumeClaims: 4,
};

const objects = agentNamespaceObjects("rehearsal", QUOTA);
const find = <K extends NamespaceObject["kind"]>(kind: K) =>
  objects.find((o) => o.kind === kind) as Extract<NamespaceObject, { kind: K }>;

/** Does the Role grant this verb on this resource? Wildcards count as a grant. */
function grants(role: Role, apiGroup: string, resource: string, verb: string): boolean {
  return role.rules.some(
    (rule) =>
      (rule.apiGroups.includes(apiGroup) || rule.apiGroups.includes("*")) &&
      (rule.resources.includes(resource) || rule.resources.includes("*")) &&
      (rule.verbs.includes(verb) || rule.verbs.includes("*")),
  );
}

describe("agent namespace (unit: ADR 0106 sections 1, 2 and 4)", () => {
  it("is agents-<slug>, with the project label and Pod Security Admission restricted", () => {
    const namespace = find("Namespace");
    expect(namespace.metadata.name).toBe("agents-rehearsal");
    expect(namespace.metadata.labels).toMatchObject({
      "foreman/project": "rehearsal",
      "pod-security.kubernetes.io/enforce": "restricted",
    });
  });

  it("denies all ingress and egress by default", () => {
    const policy = find("NetworkPolicy");
    expect(policy.spec).toEqual({
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    });
  });

  it("has a ResourceQuota on pods, CPU, memory and storage", () => {
    expect(find("ResourceQuota").spec.hard).toEqual({
      pods: "12",
      "requests.cpu": "4",
      "limits.cpu": "4",
      "requests.memory": "8Gi",
      "limits.memory": "8Gi",
      "requests.ephemeral-storage": "20Gi",
      "limits.ephemeral-storage": "20Gi",
      "requests.storage": "10Gi",
      persistentvolumeclaims: "4",
    });
  });

  it("puts every object in the namespace it describes", () => {
    for (const object of objects.filter((o) => o.kind !== "Namespace")) {
      expect(object.metadata.namespace).toBe("agents-rehearsal");
    }
  });
});

describe("runner RBAC (unit: ADR 0106 section 1)", () => {
  const role = find("Role");

  it("is a namespaced Role and RoleBinding, never a cluster-wide one", () => {
    const kinds = [...objects, ...runnerNamespaceObjects()].map((o) => o.kind);
    expect(kinds).not.toContain("ClusterRole");
    expect(kinds).not.toContain("ClusterRoleBinding");
    expect(role.metadata.namespace).toBe("agents-rehearsal");
    const binding = find("RoleBinding") as RoleBinding;
    expect(binding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: role.metadata.name,
    });
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: "foreman-runner", namespace: RUNNER_NAMESPACE },
    ]);
  });

  it("has exactly the rights in ADR 0106 and no wildcard", () => {
    expect(role.rules).toEqual(RUNNER_ROLE_RULES);
    const flat = role.rules.flatMap((rule) =>
      rule.resources.flatMap((resource) =>
        rule.verbs.map((verb) => `${rule.apiGroups.join("|")}/${resource}:${verb}`),
      ),
    );
    expect(flat.sort()).toEqual(
      [
        "batch/jobs:create",
        "batch/jobs:get",
        "batch/jobs:list",
        "batch/jobs:watch",
        "batch/jobs:delete",
        "/pods:get",
        "/pods:list",
        "/pods:watch",
        "/pods/log:get",
        "/secrets:create",
        "/secrets:delete",
        "networking.k8s.io/networkpolicies:create",
        "networking.k8s.io/networkpolicies:delete",
        "/services:create",
        "/services:delete",
        "/persistentvolumeclaims:create",
        "/persistentvolumeclaims:delete",
      ].sort(),
    );
  });

  it.each(["get", "list", "watch", "update", "patch"])(
    "cannot %s Secrets, so it never reads a credential back",
    (verb) => {
      expect(grants(role, "", "secrets", verb)).toBe(false);
    },
  );

  it.each([
    ["", "namespaces", "create"],
    ["rbac.authorization.k8s.io", "roles", "create"],
    ["rbac.authorization.k8s.io", "rolebindings", "create"],
    ["", "pods", "create"],
    ["", "pods/exec", "create"],
    ["", "serviceaccounts", "create"],
    ["", "configmaps", "get"],
  ])("cannot touch %s/%s with %s", (group, resource, verb) => {
    expect(grants(role, group, resource, verb)).toBe(false);
  });

  it("grants every operation the runtime's client makes, and nothing the client cannot use", () => {
    for (const op of CLIENT_OPERATIONS) {
      expect(grants(role, op.apiGroup, op.resource, op.verb), op.operation).toBe(true);
    }
  });

  it("gives the runner's ServiceAccount no mounted token", () => {
    const account = runnerNamespaceObjects().find((o) => o.kind === "ServiceAccount");
    expect(account).toMatchObject({ automountServiceAccountToken: false });
  });
});
