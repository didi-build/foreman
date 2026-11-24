// Seam: unit (flow layer: flows/lib/tasks.ts, ADR 0106 sections 3 and 5, ADR 0107, D-143, D-178,
// D-187). A run's task is built from the role's real bot file, the run's route and its input, and
// the Kubernetes runtime's own checks accept it. With a fake installation token port the
// Developer, Designer and QA tasks build; with the composition's real port and no App key stored
// they refuse, sending nothing (O-125). Council and Triage tasks need no token and build fully.
// Each task carries its task type's composed instructions (ADR 0119 slice 2), and a task type the
// role does not allow is refused. No secret value is in the task file or the run's spec:
// credentials are only in `credentials`, for `start`. A bot file that declares the documentation
// lookup gives the Developer's and the Designer's task file and run spec the trusted list from the
// settings (ADR 0119 slice 4c); a malformed list, or the lookup declared for QA or Triage, refuses
// the run before any token is minted.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { RunToStart } from "../../flows/lib/compose.ts";
import {
  createTaskSource,
  PACKAGE_REGISTRIES_SETTING,
  trustedDocsHosts,
} from "../../flows/lib/tasks.ts";
import {
  checkRunSpec,
  runSecrets,
  taskSecret,
} from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import type { KubernetesAgentTask } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import {
  instructionsFor,
  readBotFiles,
  runLimits,
} from "../../src/adapters/contracts-file/bot-files.ts";
import type {
  InstallationTokenRequest,
  InstallationTokens,
} from "../../src/adapters/github/installation-tokens.ts";
import { TRUSTED_DOCS_HOSTS } from "../../src/core/docs-sites.ts";
import {
  SEEDED_ROUTING_POLICY,
  TEST_TASK_TYPES,
} from "../../src/core/routing-testing.ts";
import type { AgentRole, Json } from "../../src/core/store.ts";
import { appTokensWithoutKeys } from "./flow-fixture.ts";

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
      // The role's default task type, as admission records it on every run.
      taskType: (BOTS[role].taskTypes as { default: string }).default,
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
    bots?: typeof BOTS;
    /** The `trusted_docs_hosts` setting's value; left out, the setting is missing. */
    trustedDocsHosts?: Json;
  } = {},
) {
  const secretsRead: string[] = [];
  const minted: InstallationTokenRequest[] = [];
  const tasks = createTaskSource({
    bots: options.bots ?? BOTS,
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
      getSetting: async (key) => {
        const value =
          key === PACKAGE_REGISTRIES_SETTING
            ? options.registries
            : key === TRUSTED_DOCS_HOSTS
              ? options.trustedDocsHosts
              : undefined;
        return value === undefined
          ? null
          : { key, value, updatedBy: "test", updatedAt: new Date(0) };
      },
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
      instructions: instructionsFor(BOTS.qa, "qa:review"),
      input: "Fixture input.",
      nodeId: NODE_ID,
      evidenceIds: [EVIDENCE_ID],
      contextTools: ["search_decisions", "find_similar_items", "read_item_history"],
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
    // The visual comparison's own composed text, which ends with its own task instructions.
    expect(file.instructions).toBe(instructionsFor(BOTS.qa, "qa:visual"));
    expect(
      file.instructions.endsWith(
        (BOTS.qa.taskInstructions?.["qa:visual"] ?? "").trimEnd(),
      ),
    ).toBe(true);
    expect(file.instructions).not.toBe(instructionsFor(BOTS.qa, "qa:review"));
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

  it("builds the Council's visual call task: its draft instructions, its schema and the option screenshots, no token (D-270)", async () => {
    const { tasks, minted } = source();
    const start = startFor("council", {
      outputSchema: BOTS.council.outputSchemas?.visual_call,
    });
    (start.run as { taskType: string }).taskType = "council:visual";
    start.images = [
      { label: "Image 1: option a", png: new Uint8Array([137, 80, 78, 71]) },
    ];
    const task = (await tasks.taskFor(start)) as KubernetesAgentTask;
    const { file, spec, credentials } = acceptedByRuntime("council", task);
    expect(spec.visual).toBeUndefined();
    expect(credentials.githubToken).toBeUndefined();
    expect(minted).toEqual([]);
    expect(file.instructions).toBe(BOTS.council.taskInstructions?.["council:visual"]);
    expect(file.outputSchema).toEqual(BOTS.council.outputSchemas?.visual_call);
    expect(file.images).toEqual([
      { label: "Image 1: option a", mediaType: "image/png", data: "iVBORw==" },
    ]);
    // Without its screenshots the visual call is refused; another Council run takes none.
    delete start.images;
    await expect(tasks.taskFor(start)).rejects.toThrow(
      "the Council's visual call needs the option screenshots",
    );
    const other = startFor("council", { outputSchema: COUNCIL_SCHEMA });
    other.images = [{ label: "Image 1: option a", png: new Uint8Array([1]) }];
    await expect(tasks.taskFor(other)).rejects.toThrow(
      "only a visual comparison or visual call run carries images",
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
    expect(task.task.instructions).toBe(instructionsFor(BOTS.qa, "qa:review"));
    expect(task.task.instructions.endsWith(BOTS.qa.instructions.trimEnd())).toBe(true);
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
    expect(file.instructions).toBe(instructionsFor(BOTS.triage, "triage"));
    expect(minted).toEqual([]);
  });

  it("gives QA's review, Triage and the builders the three context tools their bot files declare (ADR 0119 slice 3d)", async () => {
    const { tasks } = source();
    for (const role of ["qa", "triage", "developer", "designer"] as const) {
      const task = (await tasks.taskFor(startFor(role))) as KubernetesAgentTask;
      expect(task.task.contextTools, role).toEqual([
        "search_decisions",
        "find_similar_items",
        "read_item_history",
      ]);
    }
    const council = (await tasks.taskFor(
      startFor("council", { outputSchema: COUNCIL_SCHEMA }),
    )) as KubernetesAgentTask;
    expect(council.task).not.toHaveProperty("contextTools");
  });

  it("passes declared context tools to QA's review, Triage and the builders, never to qa:visual or a close run", async () => {
    const tools = ["search_decisions", "read_item_history"] as const;
    const declared = (role: "qa" | "triage" | "developer" | "designer") => ({
      ...BOTS[role],
      contextTools: [...tools],
    });
    const { tasks } = source({
      bots: {
        ...BOTS,
        qa: declared("qa"),
        triage: declared("triage"),
        developer: declared("developer"),
        designer: declared("designer"),
      },
    });
    for (const role of ["qa", "triage", "developer", "designer"] as const) {
      const task = (await tasks.taskFor(startFor(role))) as KubernetesAgentTask;
      // The runtime's own task file check accepts it.
      expect(acceptedByRuntime(role, task).file.contextTools, role).toEqual(tools);
    }
    const visual = startFor("qa", { outputSchema: BOTS.qa.outputSchemas?.visual });
    (visual.run as { taskType: string }).taskType = "qa:visual";
    visual.evidenceIds = [];
    visual.images = [
      { label: "Image 1: the approved option", png: new Uint8Array([1]) },
    ];
    const visualTask = (await tasks.taskFor(visual)) as KubernetesAgentTask;
    expect(acceptedByRuntime("qa", visualTask).file).not.toHaveProperty("contextTools");
    const close = startFor("developer");
    (close.run as { taskType: string; prNumber: number }).taskType = "developer:close";
    (close.run as { prNumber: number }).prNumber = 7;
    const closeTask = (await tasks.taskFor(close)) as KubernetesAgentTask;
    const { file } = acceptedByRuntime("developer", closeTask);
    expect(file.mode).toBe("close_pull_request");
    expect(file).not.toHaveProperty("contextTools");
  });

  it("gives the documentation lookup to the Developer only, as the real bot files declare it (ADR 0119 slice 4e, D-471)", async () => {
    const { tasks } = source({ trustedDocsHosts: ["vitest.dev"] });
    const developer = (await tasks.taskFor(
      startFor("developer"),
    )) as KubernetesAgentTask;
    const { spec, file } = acceptedByRuntime("developer", developer);
    expect(file.docsLookupHosts).toEqual(["vitest.dev"]);
    expect(spec.lookupHosts).toEqual(["vitest.dev"]);
    for (const role of ["qa", "triage", "designer"] as const) {
      const task = (await tasks.taskFor(startFor(role))) as KubernetesAgentTask;
      expect(task.task, role).not.toHaveProperty("docsLookupHosts");
      expect(task, role).not.toHaveProperty("lookupHosts");
    }
  });

  it("gives the trusted list to the Developer's and the Designer's task file and run spec when the bot file declares the lookup, never to a close run (ADR 0119 slice 4c)", async () => {
    const hosts = ["developer.mozilla.org", "vitest.dev"];
    const bots = {
      ...BOTS,
      developer: { ...BOTS.developer, docsLookup: true as const },
      designer: { ...BOTS.designer, docsLookup: true as const },
    };
    const { tasks } = source({ bots, trustedDocsHosts: hosts });
    for (const role of ["developer", "designer"] as const) {
      const task = (await tasks.taskFor(startFor(role))) as KubernetesAgentTask;
      // The runtime's own checks accept both: the tool's hosts and the proxy's route agree.
      const { spec, file } = acceptedByRuntime(role, task);
      expect(file.docsLookupHosts, role).toEqual(hosts);
      expect(spec.lookupHosts, role).toEqual(hosts);
    }
    // A bot file that does not declare it (the real Designer's) gets neither, whatever the list holds.
    const undeclared = source({ trustedDocsHosts: hosts });
    const plain = (await undeclared.tasks.taskFor(
      startFor("designer"),
    )) as KubernetesAgentTask;
    expect(plain.task).not.toHaveProperty("docsLookupHosts");
    expect(plain).not.toHaveProperty("lookupHosts");
    // A missing or an empty list gives no lookup, even when declared.
    for (const value of [undefined, null, []]) {
      const { tasks: none } = source({
        bots,
        ...(value === undefined ? {} : { trustedDocsHosts: value }),
      });
      const task = (await none.taskFor(startFor("developer"))) as KubernetesAgentTask;
      expect(
        acceptedByRuntime("developer", task).file,
        JSON.stringify(value),
      ).not.toHaveProperty("docsLookupHosts");
      expect(task, JSON.stringify(value)).not.toHaveProperty("lookupHosts");
    }
    // A close run starts no model: no lookup, and its list is not even read, so a malformed one
    // refuses no close run.
    for (const value of [hosts, "not a list"]) {
      const close = startFor("developer");
      (close.run as { taskType: string; prNumber: number }).taskType =
        "developer:close";
      (close.run as { prNumber: number }).prNumber = 7;
      const { tasks: closing } = source({ bots, trustedDocsHosts: value });
      const closeTask = (await closing.taskFor(close)) as KubernetesAgentTask;
      const { file } = acceptedByRuntime("developer", closeTask);
      expect(file.mode).toBe("close_pull_request");
      expect(file).not.toHaveProperty("docsLookupHosts");
      expect(closeTask).not.toHaveProperty("lookupHosts");
    }
  });

  it("gives a Developer run every host migration 0033 seeds, and the runtime accepts them (ADR 0119 slice 4c)", async () => {
    const sql = readFileSync("db/migrations/0033_trusted_docs_hosts.sql", "utf8");
    const seeded = JSON.parse(/'(\[[^']*\])'/.exec(sql)?.[1] ?? "null") as string[];
    expect(seeded).toHaveLength(14);
    expect(seeded).toEqual([...seeded].sort());
    expect(
      await trustedDocsHosts({
        getSetting: async (key) => ({
          key,
          value: seeded,
          updatedBy: "migration",
          updatedAt: new Date(0),
        }),
      }),
    ).toEqual(seeded);
    const bots = {
      ...BOTS,
      developer: { ...BOTS.developer, docsLookup: true as const },
    };
    const { tasks } = source({ bots, trustedDocsHosts: seeded });
    const task = (await tasks.taskFor(startFor("developer"))) as KubernetesAgentTask;
    const { spec, file } = acceptedByRuntime("developer", task);
    expect(file.docsLookupHosts).toEqual(seeded);
    expect(spec.lookupHosts).toEqual(seeded);
  });

  it("refuses a run whose trusted list is malformed, naming the setting and never a value, before any secret is read or token minted (ADR 0119 slice 4c)", async () => {
    const bots = {
      ...BOTS,
      developer: { ...BOTS.developer, docsLookup: true as const },
    };
    const malformed: Json[] = [
      "vitest.dev",
      { hosts: ["vitest.dev"] },
      [1],
      ["Vitest.dev"],
      ["vitest.dev."],
      ["https://vitest.dev"],
      ["vitest.dev:443"],
      ["*.vitest.dev"],
      ["10.0.0.1"],
      ["localhost"],
      ["vitest.dev", "vitest.dev"],
      Array.from({ length: 51 }, (_, i) => `docs${i}.example.com`),
    ];
    for (const value of malformed) {
      const { tasks, secretsRead, minted } = source({ bots, trustedDocsHosts: value });
      const refused = tasks.taskFor(startFor("developer"));
      await expect(refused, JSON.stringify(value)).rejects.toThrow(
        "trusted_docs_hosts must be a list of at most 50 canonical host names, each once",
      );
      const message = await refused.catch((error: Error) => error.message);
      expect(message).not.toMatch(/vitest|docs\d|10\.0|localhost/i);
      expect(secretsRead).toEqual([]);
      expect(minted).toEqual([]);
    }
    // Fifty hosts, the most a run takes, are accepted.
    const fifty = Array.from({ length: 50 }, (_, i) => `docs${i}.example.com`);
    const { tasks } = source({ bots, trustedDocsHosts: fifty });
    const task = (await tasks.taskFor(startFor("developer"))) as KubernetesAgentTask;
    expect(acceptedByRuntime("developer", task).spec.lookupHosts).toEqual(fifty);
  });

  it("refuses a QA or Triage run whose bot file declares the lookup, before any token is minted, and gives qa:visual none (ADR 0106 section 3, D-471)", async () => {
    const bots = {
      ...BOTS,
      qa: { ...BOTS.qa, docsLookup: true as const },
      triage: { ...BOTS.triage, docsLookup: true as const },
    };
    for (const role of ["qa", "triage"] as const) {
      const { tasks, secretsRead, minted } = source({
        bots,
        trustedDocsHosts: ["vitest.dev"],
      });
      await expect(tasks.taskFor(startFor(role)), role).rejects.toThrow(
        `a ${role} run has no documentation lookup yet: only the Developer and the Designer reach the lookup route (ADR 0106 section 3, D-471)`,
      );
      expect(secretsRead, role).toEqual([]);
      expect(minted, role).toEqual([]);
    }
    // QA's visual comparison reads only its images: no lookup, and no refusal.
    const { tasks } = source({ bots, trustedDocsHosts: ["vitest.dev"] });
    const visual = startFor("qa", { outputSchema: BOTS.qa.outputSchemas?.visual });
    (visual.run as { taskType: string }).taskType = "qa:visual";
    visual.evidenceIds = [];
    visual.images = [
      { label: "Image 1: the approved option", png: new Uint8Array([1]) },
    ];
    const visualTask = (await tasks.taskFor(visual)) as KubernetesAgentTask;
    expect(acceptedByRuntime("qa", visualTask).file).not.toHaveProperty(
      "docsLookupHosts",
    );
    expect(visualTask).not.toHaveProperty("lookupHosts");
  });

  it("gives each task type its own composed instructions, and refuses one the role does not allow (ADR 0119 slice 2)", async () => {
    const { tasks, secretsRead, minted } = source();
    const infra = startFor("developer");
    (infra.run as { taskType: string }).taskType = "developer:infra";
    const task = (await tasks.taskFor(infra)) as KubernetesAgentTask;
    const { file } = acceptedByRuntime("developer", task);
    expect(file.instructions).toBe(instructionsFor(BOTS.developer, "developer:infra"));
    const designer = (await tasks.taskFor(startFor("designer"))) as KubernetesAgentTask;
    expect(designer.task.instructions).toBe(instructionsFor(BOTS.designer, "designer"));
    const wrong = startFor("developer");
    (wrong.run as { taskType: string }).taskType = "qa:review";
    secretsRead.length = 0;
    minted.length = 0;
    await expect(tasks.taskFor(wrong)).rejects.toThrow(
      "the developer bot file does not allow task type qa:review",
    );
    expect(secretsRead).toEqual([]);
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

  it.each([
    ["developer", "platform/github/developer-app-private-key"],
    ["designer", "platform/github/designer-app-private-key"],
    ["qa", "platform/github/qa-app-private-key"],
  ] as const)(
    "refuses the %s with the composition's real token port when its App's key is not stored, sending nothing",
    async (role, keyPath) => {
      const apps = appTokensWithoutKeys();
      const { tasks } = source({ tokens: apps.installation });
      await expect(tasks.taskFor(startFor(role))).rejects.toThrow(
        `${keyPath} is not stored`,
      );
      expect(apps.sent).toEqual([]);
    },
  );

  it("refuses a route to a provider the role's bot file does not list, before any secret is read", async () => {
    const { tasks, secretsRead, minted } = source();
    await expect(
      tasks.taskFor(
        startFor("council", { provider: "openrouter", outputSchema: COUNCIL_SCHEMA }),
      ),
    ).rejects.toThrow("the council bot file has no entry for the run's provider");
    expect(secretsRead).toEqual([]);
    expect(minted).toEqual([]);
  });

  it.each(["qa", "council", "triage"] as const)(
    "builds a %s task on DeepInfra's Anthropic endpoint with its Messages API settings (O-152)",
    async (role) => {
      const { tasks, secretsRead } = source();
      const task = (await tasks.taskFor(
        startFor(role, {
          provider: "deepinfra",
          ...(role === "council" ? { outputSchema: COUNCIL_SCHEMA } : {}),
        }),
      )) as KubernetesAgentTask;
      const { spec, credentials } = acceptedByRuntime(role, task);
      expect(spec.image).toBe(IMAGES["claude-api"]);
      // Only the route's provider, and only its key.
      expect(spec.providers).toEqual([
        {
          name: "deepinfra",
          upstream: "https://api.deepinfra.com/anthropic",
          credential: "x-api-key",
          secretPath: "projects/rehearsal/models/deepinfra",
          baseUrlEnv: "ANTHROPIC_BASE_URL",
          messagesApi: { answer: "tool", promptCacheKey: true },
        },
      ]);
      expect(secretsRead).toEqual(["projects/rehearsal/models/deepinfra"]);
      expect(Object.keys(credentials.models)).toEqual([
        "projects/rehearsal/models/deepinfra",
      ]);
    },
  );

  it("finds each provider the seeded routes name in the role's bot file, so none is refused here (migrations 0024 and 0026)", () => {
    for (const [taskType, routing] of Object.entries(SEEDED_ROUTING_POLICY.taskTypes)) {
      const role = Object.entries(TEST_TASK_TYPES.roles).find(([, types]) =>
        types.allowed.includes(taskType),
      )?.[0] as AgentRole | undefined;
      if (!role) throw new Error(`no role allows ${taskType}`);
      const listed = BOTS[role].providers.map((provider) => provider.name);
      for (const { provider } of routing.candidates) {
        expect(listed, `${taskType} routes to ${provider}`).toContain(provider);
      }
    }
  });

  it("reads each project's key at its own path", async () => {
    const { tasks, secretsRead } = source();
    await tasks.taskFor(startFor("triage", { slug: "foreman" }));
    expect(secretsRead).toEqual(["projects/foreman/models/anthropic"]);
  });
});
