// Builds the task `start` takes from the run the core admitted (ADR 0106 section 5, ADR 0107,
// ADR 0114 section 5). The model and the provider come from the run's route, and the run's proxy
// gets only the route's provider, so a run can reach no other provider and its proxy holds no
// other provider's credential. The instructions and tools come from the bot file; the input is
// the core's (src/core/task-input.ts). Credential values pass through to `start` and are never
// kept here.
import type { AgentRole, Run } from "../../../core/store.ts";
import type { ModelProviderSetting } from "./manifests.ts";
import type { KubernetesAgentTask } from "./runtime.ts";
import type { AgentTaskFile } from "./task.ts";

/** What a bot file gives a Kubernetes run (ADR 0107). No credential value is in it. */
export interface KubernetesBotFile {
  /** The agent image, pinned by digest. */
  image: string;
  /** The role's instructions: the stable, cached part of the task file. */
  instructions: string;
  /** Developer and Designer. */
  allowedTools?: string[];
  /** CONNECT hosts for the agent's proxy. Empty for QA, Council and Triage. */
  allowedHosts: string[];
  /** QA only. */
  fetchAllowedHosts?: string[];
  /** Council and Triage. */
  outputSchema?: Record<string, unknown>;
}

export interface KubernetesTaskParts {
  run: Pick<
    Run,
    "id" | "bot" | "model" | "provider" | "nodeId" | "headSha" | "prNumber"
  >;
  projectSlug: string;
  /** `owner/name`. Only Developer, Designer and QA runs get it. */
  repository: string;
  bot: KubernetesBotFile;
  /** Every provider entry in the platform settings. The run gets only its route's. */
  providers: readonly ModelProviderSetting[];
  input: string;
  /** QA: the runner's evidence ids the verdict may cite. */
  evidenceIds?: string[];
  stateApiToken: string;
  /** Developer and Designer: the agent pod. QA: the fetch pod. Council and Triage: none. */
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
  if (bot.outputSchema !== undefined) task.outputSchema = bot.outputSchema;
  if (role === "qa") {
    task.nodeId = run.nodeId ?? "";
    task.evidenceIds = [...(parts.evidenceIds ?? [])];
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
          fetchAllowedHosts: [...(bot.fetchAllowedHosts ?? [])],
        }
      : {}),
    allowedHosts: [...bot.allowedHosts],
    providers: [{ ...provider }],
    credentials: {
      stateApiToken: parts.stateApiToken,
      ...(parts.githubToken !== undefined ? { githubToken: parts.githubToken } : {}),
      models,
    },
    task,
  };
}
