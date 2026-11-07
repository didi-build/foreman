// Shared by the admin workflow tests (D-339, O-105): the committed settings file, filled in with
// made-up values where first hosting fills it (digests, app logins, the Windmill host and
// workspace, a project), plus an API server address. Nothing here is a real value: every address
// is a documentation address (RFC 5737).
import { readFileSync } from "node:fs";

import { clusterObjects, type ClusterSettings } from "../infra/kubernetes/render.ts";

export const SETTINGS_FILE = "infra/kubernetes/settings/production.json";

/** An API server address as the jobs with the cluster credential put it in (D-349). */
export const RUN_TIME_KUBERNETES_API = { addresses: ["192.0.2.10"], port: 443 };

/** The placeholder the platform workflow's render job writes instead (D-349, O-107). */
export const RENDER_PLACEHOLDER = { addresses: ["192.0.2.1"], port: 443 };

type KubernetesApi = { addresses: string[]; port: number };

export const committedSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;

const fakeDigest = (seed: string): string =>
  [...seed.padEnd(64, "0")]
    .slice(0, 64)
    .map((c) => (c.charCodeAt(0) % 16).toString(16))
    .join("");

/** Each empty value the settings file leaves for first hosting, filled with a made-up one. */
function fill(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    if (value.endsWith("@sha256:")) return `${value}${fakeDigest(path)}`;
    if (value === "")
      return path.endsWith(".host") ? "windmill.example.com" : "example";
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => fill(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fill(v, `${path}.${k}`)]),
    );
  }
  return value;
}

export const EXAMPLE_PROJECT = {
  slug: "rehearsal",
  quota: {
    pods: 10,
    cpu: "2",
    memory: "4Gi",
    ephemeralStorage: "4Gi",
    storage: "5Gi",
    persistentVolumeClaims: 2,
  },
};

/** The committed settings with first hosting's values made up and an API address added. */
export function filledSettings(
  kubernetesApi: KubernetesApi = RUN_TIME_KUBERNETES_API,
): ClusterSettings {
  const settings = fill(committedSettings(), "") as {
    platform: Record<string, unknown>;
    projects: ClusterSettings["projects"];
  };
  return {
    platform: {
      ...settings.platform,
      kubernetesApi,
    } as unknown as ClusterSettings["platform"],
    projects: settings.projects.length > 0 ? settings.projects : [EXAMPLE_PROJECT],
  };
}

export const renderedObjects = (
  kubernetesApi: KubernetesApi = RUN_TIME_KUBERNETES_API,
) => clusterObjects(filledSettings(kubernetesApi));
