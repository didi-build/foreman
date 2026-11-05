import { describe, expect, it } from "vitest";

import { CLIENT_OPERATIONS } from "./client.ts";
import { WATCHER_OPERATIONS } from "./job-watch.ts";
import {
  PLATFORM_NAMESPACE,
  RUNNER_NAMESPACE,
  RUNNER_ROLE_RULES,
  RUN_WATCHER_ROLE_RULES,
  RUN_WATCHER_SERVICE_ACCOUNT,
  agentNamespaceObjects,
  runnerNamespaceObjects,
  type AgentQuota,
} from "./namespace.ts";
import type { NamespaceObject, Role, RoleBinding } from "./objects.ts";

// Unit: the agent namespace, its default policies, the runner's RBAC and the run watcher's RBAC
// (D-330) as data (ADR 0106 sections 1, 2 and 4). Infrastructure code applies them; nothing here
// talks to a cluster.

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
const named = <K extends "Role" | "RoleBinding">(kind: K, name: string) =>
  objects.find((o) => o.kind === kind && o.metadata.name === name) as Extract<
    NamespaceObject,
    { kind: K }
  >;

/** Every right a Role grants, as `group/resource:verb`. */
const rights = (role: Role): string[] =>
  role.rules.flatMap((rule) =>
    rule.resources.flatMap((resource) =>
      rule.verbs.map((verb) => `${rule.apiGroups.join("|")}/${resource}:${verb}`),
    ),
  );

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
  const role = named("Role", "foreman-runner");

  it("is a namespaced Role and RoleBinding, never a cluster-wide one", () => {
    const kinds = [...objects, ...runnerNamespaceObjects()].map((o) => o.kind);
    expect(kinds).not.toContain("ClusterRole");
    expect(kinds).not.toContain("ClusterRoleBinding");
    expect(role.metadata.namespace).toBe("agents-rehearsal");
    const binding = named("RoleBinding", "foreman-runner");
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
    expect(rights(role).sort()).toEqual(
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

describe("run watcher RBAC (unit: D-330)", () => {
  const role = named("Role", RUN_WATCHER_SERVICE_ACCOUNT);
  const binding = named("RoleBinding", RUN_WATCHER_SERVICE_ACCOUNT);

  it("is exactly get, list and watch on Jobs, and nothing else", () => {
    expect(role.rules).toEqual(RUN_WATCHER_ROLE_RULES);
    expect(rights(role).sort()).toEqual(
      ["batch/jobs:get", "batch/jobs:list", "batch/jobs:watch"].sort(),
    );
  });

  it.each([
    ["batch", "jobs", "create"],
    ["batch", "jobs", "update"],
    ["batch", "jobs", "patch"],
    ["batch", "jobs", "delete"],
    ["batch", "jobs/status", "get"],
    ["", "pods", "get"],
    ["", "pods", "list"],
    ["", "pods/log", "get"],
    ["", "secrets", "get"],
    ["", "secrets", "list"],
    ["", "configmaps", "get"],
    ["", "namespaces", "list"],
    ["", "events", "list"],
  ])("cannot touch %s/%s with %s", (group, resource, verb) => {
    expect(grants(role, group, resource, verb)).toBe(false);
  });

  it("grants every call the watcher makes", () => {
    for (const op of WATCHER_OPERATIONS) {
      expect(grants(role, op.apiGroup, op.resource, op.verb), op.operation).toBe(true);
    }
  });

  it("is a Role and RoleBinding in the agent namespace itself, bound to the watcher's ServiceAccount in the platform namespace", () => {
    expect(role.metadata.namespace).toBe("agents-rehearsal");
    expect(binding.metadata.namespace).toBe("agents-rehearsal");
    expect(binding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: RUN_WATCHER_SERVICE_ACCOUNT,
    });
    expect(binding.subjects).toEqual([
      {
        kind: "ServiceAccount",
        name: RUN_WATCHER_SERVICE_ACCOUNT,
        namespace: PLATFORM_NAMESPACE,
      },
    ]);
  });

  it("gives the runner's Role nothing of the watcher's, and the watcher nothing of the runner's beyond reading Jobs", () => {
    const runner = named("Role", "foreman-runner");
    const runnerBinding = named("RoleBinding", "foreman-runner") as RoleBinding;
    expect(runnerBinding.subjects.map((s) => s.name)).toEqual(["foreman-runner"]);
    for (const right of rights(role)) expect(rights(runner)).toContain(right);
    expect(
      objects
        .filter((o) => o.kind === "Role" || o.kind === "RoleBinding")
        .map((o) => [o.kind, o.metadata.name]),
    ).toEqual([
      ["Role", "foreman-runner"],
      ["RoleBinding", "foreman-runner"],
      ["Role", RUN_WATCHER_SERVICE_ACCOUNT],
      ["RoleBinding", RUN_WATCHER_SERVICE_ACCOUNT],
    ]);
  });
});
