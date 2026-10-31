// Shared inputs for the Kubernetes adapter's tests. Not real images, hosts or credentials.
import type { RunLimits } from "../runtime.ts";
import type {
  KubernetesRunSettings,
  KubernetesRunSpec,
  RunCredentials,
} from "./manifests.ts";
import type { Resources } from "./objects.ts";
import type { AgentTaskFile } from "./task.ts";

const digest = (n: string): string => `@sha256:${n.repeat(64)}`;

const resources: Resources = {
  requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "1Gi" },
  limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "2Gi" },
};

export const SETTINGS: KubernetesRunSettings = {
  proxyImage: `registry.example.com/foreman/egress-proxy${digest("a")}`,
  fetchImage: `registry.example.com/foreman/qa-fetch${digest("b")}`,
  proxyPort: 8080,
  runAsUser: 1000,
  resources: { agent: resources, proxy: resources, fetch: resources },
  scratchSizeLimit: "1Gi",
  terminationGracePeriodSeconds: 30,
  ttlSecondsAfterFinished: 3600,
  proxyDeadlineMarginSeconds: 120,
  fetchMaxMinutes: 10,
  workspace: { size: "1Gi", storageClassName: "do-block-storage" },
  stateApi: {
    upstream: "http://state-api.foreman-platform.svc.cluster.local:8080",
    namespace: "foreman-platform",
    podLabels: { app: "state-api" },
    podPort: 8080,
  },
  clusterDns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
};

export const LIMITS: RunLimits = { maxTurns: 100, maxMinutes: 50, maxUsd: 5 };
export const QA_LIMITS: RunLimits = { maxTurns: 50, maxMinutes: 20, maxUsd: 2 };

export const MODEL_KEY = "model-key-value-not-real-0123456789";
export const STATE_TOKEN = "state-token-value-not-real-0123456789";
export const GITHUB_TOKEN = "github-token-value-not-real-0123456789";
export const MODEL_SECRET_PATH = "projects/rehearsal/models/anthropic";

/** The Developer and Designer image (D-222) and the Messages API image (QA, Council, Triage). */
export const OPENCODE_IMAGE = `registry.example.com/foreman/opencode${digest("c")}`;
export const CLAUDE_API_IMAGE = `registry.example.com/foreman/claude-api${digest("d")}`;

const base = {
  projectSlug: "rehearsal",
  image: CLAUDE_API_IMAGE,
  model: "claude-sonnet-5-5",
  providers: [
    {
      name: "anthropic",
      upstream: "https://api.anthropic.com",
      credential: "x-api-key" as const,
      secretPath: MODEL_SECRET_PATH,
      baseUrlEnv: "ANTHROPIC_BASE_URL",
      api: { kind: "anthropic" as const, path: "/v1" },
    },
  ],
  serviceTier: "standard" as const,
  price: {
    tiers: ["standard" as const],
    pricePerMTok: {
      standard: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    },
  },
  flexCapacityRetries: 3,
  maxRejectedModelRequests: 6,
};

export const DEVELOPER: KubernetesRunSpec = {
  ...base,
  runId: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
  role: "developer",
  image: OPENCODE_IMAGE,
  repository: "didi-build/rehearsal",
  allowedHosts: ["github.com", "api.github.com", "registry.npmjs.org"],
};

export const QA: KubernetesRunSpec = {
  ...base,
  runId: "5e1f0a9b-8c7d-4e6f-a5b4-c3d2e1f0a9b8",
  role: "qa",
  model: "claude-opus-5-5",
  repository: "didi-build/rehearsal",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  prNumber: 42,
  allowedHosts: [],
  fetchAllowedHosts: ["github.com", "codeload.github.com"],
};

export const COUNCIL: KubernetesRunSpec = {
  ...base,
  runId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  role: "council",
  allowedHosts: [],
};

export function credentialsFor(spec: KubernetesRunSpec): RunCredentials {
  return {
    stateApiToken: STATE_TOKEN,
    models: { [MODEL_SECRET_PATH]: MODEL_KEY },
    ...(spec.role === "council" || spec.role === "triage"
      ? {}
      : { githubToken: GITHUB_TOKEN }),
  };
}

export const QA_NODE_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
export const QA_EVIDENCE_ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";

/** A small valid task file for each fixture's role. Not real instructions. */
export function taskFor(spec: KubernetesRunSpec): AgentTaskFile {
  const base = {
    foremanTask: 1 as const,
    instructions: "Fixture instructions.",
    input: "Fixture input.",
  };
  if (spec.role === "developer" || spec.role === "designer") {
    return { ...base, allowedTools: ["Read", "Edit", "Bash(git status)"] };
  }
  if (spec.role === "qa") {
    return { ...base, nodeId: QA_NODE_ID, evidenceIds: [QA_EVIDENCE_ID] };
  }
  return {
    ...base,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    },
  };
}
