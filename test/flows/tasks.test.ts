// Seam: unit (flow layer: flows/lib/tasks.ts, ADR 0106 sections 3 and 5, ADR 0107, D-143, D-178,
// D-187). A run's task is built from the role's real bot file, the run's route and its input, and
// the Kubernetes runtime's own checks accept it. With a fake installation token port the
// Developer, Designer and QA tasks build; with the runner's real port they refuse until the
// GitHub Apps exist. Council and Triage tasks need no token and build fully. No secret value is in
// the task file or the run's spec: credentials are only in `credentials`, for `start`.
import { describe, expect, it } from "vitest";

import {
  NotBuiltError,
  unregisteredInstallationTokens,
} from "../../flows/lib/compose.ts";
import type { RunToStart } from "../../flows/lib/compose.ts";
import { createTaskSource, PACKAGE_REGISTRIES_SETTING } from "../../flows/lib/tasks.ts";
import {
  checkRunSpec,
  runSecrets,
  taskSecret,
} from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import type { KubernetesAgentTask } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import {
  readBotFiles,
  runLimits,
} from "../../src/adapters/contracts-file/bot-files.ts";
import type {
  InstallationTokenRequest,
  InstallationTokens,
} from "../../src/adapters/github/installation-tokens.ts";
import type { AgentRole, Json } from "../../src/core/store.ts";

const BOTS = readBotFiles();
const LIMITS = runLimits(BOTS);
const DIGEST = `@sha256:${"c".repeat(64)}`;
const IMAGES = {
  opencode: `registry.example.com/foreman/opencode${DIGEST}`,
  "claude-api": `registry.example.com/foreman/claude-api${DIGEST}`,
};
// Fake values, shaped like credentials so a leak would be found. Not real.
const MODEL_KEY = "model-key-value-not-real-0123456789";
const GITHUB_TOKEN = "github-token-value-not-real-0123456789";
const STATE_TOKEN = "state-token-value-not-real-0123456789";
const NODE_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const EVIDENCE_ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const PRICE = {
  tiers: ["standard"],
  pricePerMTok: { standard: { input: 3, cachedInput: 0.3, output: 15 } },
};

function startFor(
  role: AgentRole,
  extra: { provider?: string; slug?: string; outputSchema?: unknown } = {},
): RunToStart {
  return {
    run: {
      id: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
      bot: role,
      model: role === "qa" ? "claude-opus-5-5" : "claude-sonnet-5-5",
      provider: extra.provider ?? "anthropic",
      serviceTierRequested: "standard",
      modelPrice: PRICE,
      nodeId: NODE_ID,
      headSha: role === "qa" ? HEAD : null,
      prNumber: role === "qa" ? 42 : null,
    },
    node: { id: NODE_ID },
    project: { slug: extra.slug ?? "rehearsal", repo: "didi-build/rehearsal" },
    input: "Fixture input.",
    branch: role === "developer" || role === "designer" ? `foreman/${NODE_ID}` : null,
    evidenceIds: role === "qa" ? [EVIDENCE_ID] : [],
    capacity: { flexCapacityRetries: 3, maxRejectedModelRequests: 6 },
    stateApiToken: STATE_TOKEN,
    ...(extra.outputSchema ? { outputSchema: extra.outputSchema } : {}),
  } as unknown as RunToStart;
}

function source(
  options: {
    tokens?: InstallationTokens;
    registries?: Json;
  } = {},
) {
  const secretsRead: string[] = [];
  const minted: InstallationTokenRequest[] = [];
  const tasks = createTaskSource({
    bots: BOTS,
    images: async () => IMAGES,
    secret: async (path) => {
      secretsRead.push(path);
      return MODEL_KEY;
    },
    githubTokens: options.tokens ?? {
      mint: async (request) => {
        minted.push(request);
        return GITHUB_TOKEN;
      },
    },
    store: {
      getSetting: async (key) =>
        key === PACKAGE_REGISTRIES_SETTING && options.registries !== undefined
          ? {
              key,
              value: options.registries,
              updatedBy: "test",
              updatedAt: new Date(0),
            }
          : null,
    },
  });
  return { tasks, secretsRead, minted };
}

/** The runtime's own checks, as `start` runs them before it creates anything. */
function acceptedByRuntime(role: AgentRole, task: KubernetesAgentTask) {
  const { credentials, task: file, ...spec } = task;
  checkRunSpec(spec, LIMITS[role]);
  runSecrets(spec, credentials);
  taskSecret(spec, file);
  // No credential value anywhere but `credentials`.
  const outside = JSON.stringify({ spec, file });
  for (const value of [MODEL_KEY, GITHUB_TOKEN, STATE_TOKEN]) {
    expect(outside).not.toContain(value);
  }
  return { spec, file, credentials };
}

const COUNCIL_SCHEMA = BOTS.council.outputSchemas?.reversal;

describe("a run's task (unit: flow layer, flows/lib/tasks.ts)", () => {
  it("builds QA's task from its bot file, with a read-only token for its fetch step", async () => {
    const { tasks, secretsRead, minted } = source();
    const task = (await tasks.taskFor(startFor("qa"))) as KubernetesAgentTask;
    const { spec, file, credentials } = acceptedByRuntime("qa", task);
    expect(spec.image).toBe(IMAGES["claude-api"]);
    expect(spec.model).toBe("claude-opus-5-5");
    expect(spec.allowedHosts).toEqual([]);
    expect(spec.fetchAllowedHosts).toEqual(BOTS.qa.fetchAllowedHosts);
    expect(spec.providers).toEqual([
      {
        name: "anthropic",
        upstream: "https://api.anthropic.com",
        credential: "x-api-key",
        secretPath: "projects/rehearsal/models/anthropic",
        baseUrlEnv: "ANTHROPIC_BASE_URL",
      },
    ]);
    expect(file).toEqual({
      foremanTask: 1,
      instructions: BOTS.qa.instructions,
      input: "Fixture input.",
      nodeId: NODE_ID,
      evidenceIds: [EVIDENCE_ID],
    });
    expect(minted).toEqual([
      {
        role: "qa",
        repository: "didi-build/rehearsal",
        access: "read",
        runId: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
      },
    ]);
    expect(secretsRead).toEqual(["projects/rehearsal/models/anthropic"]);
    expect(credentials).toEqual({
      stateApiToken: STATE_TOKEN,
      githubToken: GITHUB_TOKEN,
      models: { "projects/rehearsal/models/anthropic": MODEL_KEY },
    });
  });

  it("builds QA's visual comparison task: its own instructions, its answer schema and the images, no evidence ids (D-242)", async () => {
    const { tasks, minted } = source();
    const start = startFor("qa", { outputSchema: BOTS.qa.outputSchemas?.visual });
    (start.run as { taskType: string }).taskType = "qa:visual";
    start.evidenceIds = [];
    start.images = [
      { label: "Image 1: the approved option", png: new Uint8Array([137, 80, 78, 71]) },
      { label: "Image 2: the built component", png: new Uint8Array([137, 80, 78, 72]) },
    ];
    const task = (await tasks.taskFor(start)) as KubernetesAgentTask;
    const { file, spec, credentials } = acceptedByRuntime("qa", task);
    // Least privilege (N-57): no fetch step, no GitHub hosts and no token minted.
    expect(spec.visual).toBe(true);
    expect(spec.fetchAllowedHosts).toBeUndefined();
    expect(credentials.githubToken).toBeUndefined();
    expect(minted).toEqual([]);
    expect(file.instructions).toBe(BOTS.qa.taskInstructions?.["qa:visual"]);
    expect(file.instructions).not.toBe(BOTS.qa.instructions);
    expect(file.outputSchema).toEqual(BOTS.qa.outputSchemas?.visual);
    expect(file.evidenceIds).toEqual([]);
    expect(file.images).toEqual([
      {
        label: "Image 1: the approved option",
        mediaType: "image/png",
        data: "iVBORw==",
      },
      {
        label: "Image 2: the built component",
        mediaType: "image/png",
        data: "iVBOSA==",
      },
    ]);
    // Without its images or schema the run is refused.
    delete start.images;
    await expect(tasks.taskFor(start)).rejects.toThrow(
      "a visual comparison run needs its answer schema and images",
    );
  });

  it("keeps QA's review task as it was: no images, no schema, the review instructions, its fetch step and read token", async () => {
    const { tasks, minted } = source();
    const task = (await tasks.taskFor(startFor("qa"))) as KubernetesAgentTask;
    const { spec, credentials } = acceptedByRuntime("qa", task);
    expect(spec.visual).toBeUndefined();
    expect(spec.fetchAllowedHosts).toEqual(BOTS.qa.fetchAllowedHosts);
    expect(credentials.githubToken).toBe(GITHUB_TOKEN);
    expect(minted).toMatchObject([{ role: "qa", access: "read" }]);
    expect(task.task.images).toBeUndefined();
    expect(task.task.outputSchema).toBeUndefined();
    expect(task.task.instructions).toBe(BOTS.qa.instructions);
  });

  it("builds the Council's task with its question's schema, and no GitHub token", async () => {
    const { tasks, minted } = source();
    const task = (await tasks.taskFor(
      startFor("council", { outputSchema: COUNCIL_SCHEMA }),
    )) as KubernetesAgentTask;
    const { file, credentials } = acceptedByRuntime("council", task);
    expect(file.instructions).toBe(BOTS.council.instructions);
    expect(file.outputSchema).toEqual(COUNCIL_SCHEMA);
    expect(credentials.githubToken).toBeUndefined();
    expect(minted).toEqual([]);
    // The Council's schema comes with its question; without one the run is refused.
    await expect(tasks.taskFor(startFor("council"))).rejects.toThrow(
      "a Council run needs its question's output schema",
    );
  });

  it("builds Triage's task with the schema from its bot file", async () => {
    const { tasks, minted } = source();
    const task = (await tasks.taskFor(startFor("triage"))) as KubernetesAgentTask;
    const { file } = acceptedByRuntime("triage", task);
    expect(file.outputSchema).toEqual(BOTS.triage.outputSchemas?.answer);
    expect(minted).toEqual([]);
  });

  it.each(["developer", "designer"] as const)(
    "builds the %s's task with its tools, hosts and the project's registries",
    async (role) => {
      const { tasks, minted } = source({
        registries: { rehearsal: ["registry.npmjs.org"], other: ["pypi.org"] },
      });
      const task = (await tasks.taskFor(
        startFor(role, { provider: "deepinfra" }),
      )) as KubernetesAgentTask;
      const { spec, file, credentials } = acceptedByRuntime(role, task);
      expect(spec.image).toBe(IMAGES.opencode);
      expect(spec.repository).toBe("didi-build/rehearsal");
      expect(spec.allowedHosts).toEqual([
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
      ]);
      // Only the route's provider, and only its key.
      expect(spec.providers.map((p) => [p.name, p.secretPath])).toEqual([
        ["deepinfra", "projects/rehearsal/models/deepinfra"],
      ]);
      expect(Object.keys(credentials.models)).toEqual([
        "projects/rehearsal/models/deepinfra",
      ]);
      expect(file.allowedTools).toEqual(BOTS[role].allowedTools);
      expect(file.allowedTools).not.toContain("mcp__magicpath");
      expect(minted.map((m) => [m.role, m.access])).toEqual([[role, "write"]]);
    },
  );

  it("gives a project with no registries listed none", async () => {
    const { tasks } = source({ registries: { other: ["pypi.org"] } });
    const task = (await tasks.taskFor(startFor("developer"))) as KubernetesAgentTask;
    expect(task.allowedHosts).toEqual(BOTS.developer.allowedHosts);
    const bad = source({ registries: { rehearsal: "registry.npmjs.org" } });
    await expect(bad.tasks.taskFor(startFor("developer"))).rejects.toThrow(
      "package_registries for the project must be a list of hosts",
    );
  });

  it.each(["developer", "designer", "qa"] as const)(
    "refuses the %s with the runner's real token port until its GitHub App exists",
    async (role) => {
      const { tasks } = source({ tokens: unregisteredInstallationTokens() });
      await expect(tasks.taskFor(startFor(role))).rejects.toThrow(NotBuiltError);
    },
  );

  it("refuses a route to a provider the role's bot file does not list, before any secret is read", async () => {
    const { tasks, secretsRead, minted } = source();
    await expect(
      tasks.taskFor(
        startFor("council", { provider: "deepinfra", outputSchema: COUNCIL_SCHEMA }),
      ),
    ).rejects.toThrow("the council bot file has no entry for the run's provider");
    expect(secretsRead).toEqual([]);
    expect(minted).toEqual([]);
  });

  it("reads each project's key at its own path", async () => {
    const { tasks, secretsRead } = source();
    await tasks.taskFor(startFor("triage", { slug: "foreman" }));
    expect(secretsRead).toEqual(["projects/foreman/models/anthropic"]);
  });
});
