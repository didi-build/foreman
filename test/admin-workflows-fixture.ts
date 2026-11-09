// Shared by the admin workflow tests (D-339, O-105): the committed settings file, with made-up
// values in place of what first hosting fills in (digests, app logins, the Windmill host and
// workspace, a project), plus an API server address. Nothing here is a real value: every address
// is a documentation address (RFC 5737).
import { readFileSync } from "node:fs";

import {
  clusterObjects,
  forServerSideApply,
  type ClusterSettings,
} from "../infra/kubernetes/render.ts";

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

/**
 * Each value first hosting fills in, made up: an image's digest, the Windmill host and workspace,
 * and the app logins, whether the committed file still leaves them empty or holds the real ones,
 * so no test reads a production value. Any other empty value is made up too.
 */
function fill(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    const digestAt = value.indexOf("@sha256:");
    if (path.startsWith(".platform.images.") && digestAt >= 0)
      return `${value.slice(0, digestAt + "@sha256:".length)}${fakeDigest(path)}`;
    if (path === ".platform.windmill.host") return "windmill.example.com";
    if (
      path === ".platform.windmill.workspace" ||
      path.startsWith(".platform.receiver.")
    )
      return "example";
    if (value === "") return "example";
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

/**
 * The rendered objects as the Platform workflow's render job prints them
 * (`node infra/kubernetes/render.ts`): the form the plan, the address swap and the apply read, so
 * the scripts are tested on what they really get (O-119).
 */
export const renderedObjects = (
  kubernetesApi: KubernetesApi = RUN_TIME_KUBERNETES_API,
) => forServerSideApply(clusterObjects(filledSettings(kubernetesApi)));
