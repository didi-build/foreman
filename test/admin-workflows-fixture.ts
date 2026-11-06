// Shared by the admin workflow tests (D-339, O-105): the committed settings file, filled in with
// made-up values where first hosting fills it (digests, app logins, the Windmill host and
// workspace, a project), plus the API server address the platform workflow reads at run time.
// Nothing here is a real value: the address is a documentation address (RFC 5737).
import { readFileSync } from "node:fs";

import { clusterObjects, type ClusterSettings } from "../infra/kubernetes/render.ts";

export const SETTINGS_FILE = "infra/kubernetes/settings/production.json";

export const RUN_TIME_KUBERNETES_API = { addresses: ["192.0.2.10"], port: 443 };

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

/** The committed settings with first hosting's values made up and the run-time address added. */
export function filledSettings(): ClusterSettings {
  const settings = fill(committedSettings(), "") as {
    platform: Record<string, unknown>;
    projects: ClusterSettings["projects"];
  };
  return {
    platform: {
      ...settings.platform,
      kubernetesApi: RUN_TIME_KUBERNETES_API,
    } as unknown as ClusterSettings["platform"],
    projects: settings.projects.length > 0 ? settings.projects : [EXAMPLE_PROJECT],
  };
}

export const renderedObjects = () => clusterObjects(filledSettings());
