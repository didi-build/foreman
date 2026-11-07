// Print the cluster's standing objects as one Kubernetes List. Nothing here talks to a cluster.
//
//   node infra/kubernetes/render.ts <settings.json>
//
// The Platform workflow (.github/workflows/platform.yml, D-339, O-105) renders the reviewed
// settings file infra/kubernetes/settings/production.json this way, in a job with no secret, with
// a placeholder for `platform.kubernetesApi` that the jobs holding the cluster credential replace
// with the address they read from the cluster (D-349), and applies the result once Didi
// approves. The settings file holds no secret: images, app logins, ports, quotas and project
// slugs. Secrets are created separately by name, by the workflow's cluster Secrets job
// (docs/runbooks/first-hosting.md).
import { readFileSync } from "node:fs";

import {
  agentNamespaceObjects,
  runnerNamespaceObjects,
  type AgentQuota,
} from "../../src/adapters/agent-runtime/kubernetes/namespace.ts";
import type { NamespaceObject } from "../../src/adapters/agent-runtime/kubernetes/objects.ts";
import {
  platformObjects,
  type PlatformObject,
  type PlatformSettings,
} from "./platform.ts";

export interface ClusterSettings {
  platform: PlatformSettings;
  projects: { slug: string; quota: AgentQuota }[];
}

/**
 * The platform namespace, the runner's namespace, then one agent namespace per project. The run
 * watcher watches exactly those agent namespaces, and each one binds its Role (D-330).
 */
export function clusterObjects(settings: ClusterSettings): {
  apiVersion: "v1";
  kind: "List";
  items: (PlatformObject | NamespaceObject)[];
} {
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      ...platformObjects(
        settings.platform,
        settings.projects.map((p) => p.slug),
      ),
      ...runnerNamespaceObjects(),
      ...settings.projects.flatMap((p) => agentNamespaceObjects(p.slug, p.quota)),
    ],
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node infra/kubernetes/render.ts <settings.json>");
    process.exit(2);
  }
  const settings = JSON.parse(readFileSync(path, "utf8")) as ClusterSettings;
  process.stdout.write(`${JSON.stringify(clusterObjects(settings), null, 2)}\n`);
}
