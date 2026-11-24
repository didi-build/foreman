// Builds the task `start` takes from the run the core admitted (ADR 0106 section 5, ADR 0107,
// ADR 0114 sections 5, 8 and 9). The model, the provider, the tier and the price come from the
// run's route as recorded on the run, and the Flex capacity bounds from the runner's settings (`runCapacityLimits`). The run's proxy
// gets only the route's provider, so a run can reach no other provider and its proxy holds no
// other provider's credential. The instructions and tools come from the bot file; the input is
// the core's (src/core/task-input.ts). Credential values pass through to `start` and are never
// kept here. QA's review with a site (ADR 0119 slice 5c) gets the browser: the run's spec and its
// task file say so, and the site's zip goes to `start` for the browser pod's Secret alone.
import type { RunCapacityLimits } from "../../../core/runs.ts";
import type { AgentRole, Run } from "../../../core/store.ts";
import { PUSHING_ROLES, runBranch } from "../../../core/task-input.ts";
import { isCloseTaskType } from "../../../core/task-types.ts";
import type { ModelProviderSetting } from "./manifests.ts";
import type { KubernetesAgentTask } from "./runtime.ts";
import {
  CLOSE_MODE,
  type AgentTaskFile,
  type ContextToolName,
  type TaskImage,
} from "./task.ts";

/** What a bot file gives a Kubernetes run (ADR 0107). No credential value is in it. */
export interface KubernetesBotFile {
  /** The agent image, pinned by digest. */
  image: string;
  /** The role's instructions: the stable, cached part of the task file. */
  instructions: string;
  /** Developer and Designer. */
  allowedTools?: string[];
  /**
   * The read-only context tools (ADR 0119 slice 3c): QA's review, Triage, the Developer and the
   * Designer. A close run and a run with images never get them.
   */
  contextTools?: ContextToolName[];
  /**
   * The trusted documentation hosts, for a bot file that declares the documentation lookup (ADR
   * 0119 slice 4b), as the task source reads them from the trusted list (slice 4c). A close run
   * and a run with images never get them. The same hosts go into the task file, for the tool,
   * and into the run's spec as `lookupHosts`, for its proxy's lookup route, so the two always
   * agree; the runtime accepts them only for the Developer and the Designer.
   */
  docsLookupHosts?: string[];
  /** CONNECT hosts for the agent's proxy. Empty for QA, Council and Triage. */
  allowedHosts: string[];
  /** QA's review only; the visual comparison has no fetch step. */
  fetchAllowedHosts?: string[];
  /** Council and Triage, and QA's visual comparison. */
  outputSchema?: Record<string, unknown>;
}

export interface KubernetesTaskParts {
  run: Pick<
    Run,
    | "id"
    | "bot"
    | "model"
    | "provider"
    | "serviceTierRequested"
    | "modelPrice"
    | "nodeId"
    | "headSha"
    | "prNumber"
    | "taskType"
  >;
  /** From the settings (migration 0007), read when the run is started. */
  capacity: RunCapacityLimits;
  projectSlug: string;
  /** `owner/name`. Only Developer, Designer and QA runs get it. */
  repository: string;
  bot: KubernetesBotFile;
  /** Every provider entry in the platform settings. The run gets only its route's. */
  providers: readonly ModelProviderSetting[];
  input: string;
  /** QA: the runner's evidence ids the verdict may cite. */
  evidenceIds?: string[];
  /**
   * QA's visual comparison: the image pairs, in order (D-242). The Council's visual call: the
   * option screenshots (D-270).
   */
  images?: TaskImage[];
  /**
   * QA's review only: the site the runner read and checked for the head (ADR 0119 slices 5a and
   * 5c), as GitHub's zip. Given, the run gets a browser pod with it; the bytes go to `start` for
   * the site Secret and never into the task file.
   */
  site?: Uint8Array;
  stateApiToken: string;
  /**
   * Developer and Designer: the agent pod. QA's review: the fetch pod. QA's visual comparison,
   * Council and Triage: none.
   */
  githubToken?: string;
  /** Model credential values by secret path. Only the route's provider's is passed on. */
  modelCredentials: Readonly<Record<string, string>>;
}

const ROLES: readonly AgentRole[] = [
  "developer",
  "designer",
  "qa",
  "council",
  "triage",
];
const WITH_REPOSITORY: readonly AgentRole[] = ["developer", "designer", "qa"];

export function buildKubernetesTask(parts: KubernetesTaskParts): KubernetesAgentTask {
  const { run, bot } = parts;
  const role = ROLES.find((r) => r === run.bot);
  if (!role) throw new Error("the run's bot is not an agent role");
  const providers = parts.providers.filter((p) => p.name === run.provider);
  const [provider] = providers;
  if (!provider || providers.length !== 1) {
    throw new Error("the run's provider needs exactly one provider setting");
  }
  // Without its recorded price the run's dollar limit cannot be enforced: fail closed.
  if (!run.modelPrice) throw new Error("the run has no recorded price");
  const models: Record<string, string> = {};
  if (provider.secretPath) {
    const value = parts.modelCredentials[provider.secretPath];
    if (value !== undefined) models[provider.secretPath] = value;
  }

  const task: AgentTaskFile = {
    foremanTask: 1,
    instructions: bot.instructions,
    input: parts.input,
  };
  if (bot.allowedTools !== undefined) task.allowedTools = [...bot.allowedTools];
  // A close run starts no model (D-318), and QA's visual comparison reads only its images, so
  // neither gets the context tools.
  if (
    bot.contextTools !== undefined &&
    !isCloseTaskType(run.taskType) &&
    parts.images === undefined
  ) {
    task.contextTools = [...bot.contextTools];
  }
  // The same runs get no documentation lookup either. The run's proxy gets the same hosts below.
  if (
    bot.docsLookupHosts !== undefined &&
    bot.docsLookupHosts.length > 0 &&
    !isCloseTaskType(run.taskType) &&
    parts.images === undefined
  ) {
    task.docsLookupHosts = [...bot.docsLookupHosts];
  }
  if (bot.outputSchema !== undefined) task.outputSchema = bot.outputSchema;
  if (PUSHING_ROLES.includes(role)) {
    // The wrapper opens the run's PR on this branch and names this node with its docs note
    // (N-44, D-235). Neither is a credential; both come from the run as the core admitted it.
    if (!run.nodeId) throw new Error(`a ${role} run needs its node`);
    task.nodeId = run.nodeId;
    task.branch = runBranch(run.nodeId);
    // The close-only run of a cancelled item's pull request starts no model (D-318).
    if (isCloseTaskType(run.taskType)) task.mode = CLOSE_MODE;
  }
  if (role === "qa") {
    task.nodeId = run.nodeId ?? "";
    task.evidenceIds = [...(parts.evidenceIds ?? [])];
    if (parts.images !== undefined) task.images = parts.images.map((i) => ({ ...i }));
  } else if (role === "council") {
    // The Council's call on a visual approval reads the option screenshots (D-270). It has no
    // fetch step, workspace or token in any case.
    if (parts.images !== undefined) task.images = parts.images.map((i) => ({ ...i }));
  } else if (parts.images !== undefined) {
    throw new Error(`a ${role} run carries no images`);
  }
  // QA's review alone runs a browser (D-476): never the visual comparison or another role.
  const browser = parts.site !== undefined;
  if (browser) {
    if (role !== "qa" || parts.images !== undefined) {
      throw new Error("only QA's review (qa:review) runs a browser");
    }
    task.browser = true;
  }

  return {
    runId: run.id,
    role,
    projectSlug: parts.projectSlug,
    image: bot.image,
    model: run.model,
    ...(WITH_REPOSITORY.includes(role) ? { repository: parts.repository } : {}),
    ...(role === "qa"
      ? {
          headSha: run.headSha ?? undefined,
          prNumber: run.prNumber ?? undefined,
          // The visual comparison reads only its images: no fetch step and no GitHub token
          // (least privilege, N-57). The review fetches the PR's tree.
          ...(parts.images !== undefined
            ? { visual: true as const }
            : { fetchAllowedHosts: [...(bot.fetchAllowedHosts ?? [])] }),
          ...(browser ? { browser: true as const } : {}),
        }
      : {}),
    allowedHosts: [...bot.allowedHosts],
    // The lookup route on the run's proxy, for exactly the hosts the task file lists (slice 4a).
    ...(task.docsLookupHosts !== undefined
      ? { lookupHosts: [...task.docsLookupHosts] }
      : {}),
    providers: [{ ...provider }],
    serviceTier: run.serviceTierRequested,
    price: structuredClone(run.modelPrice),
    flexCapacityRetries: parts.capacity.flexCapacityRetries,
    maxRejectedModelRequests: parts.capacity.maxRejectedModelRequests,
    credentials: {
      stateApiToken: parts.stateApiToken,
      ...(parts.githubToken !== undefined ? { githubToken: parts.githubToken } : {}),
      models,
    },
    task,
    ...(parts.site !== undefined ? { site: parts.site } : {}),
  };
}
