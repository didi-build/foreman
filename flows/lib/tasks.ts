// How the runner builds a run's task (ADR 0102, ADR 0106 sections 3 and 5, ADR 0107, ADR 0114
// sections 5 and 8). Everything comes from data: the role's bot file (contracts/bots/, checked at
// the spec version) gives the instructions, the image kind, the tools, the hosts and the
// provider's address and key path; the run's route, recorded on the run, gives the model, the
// provider, the tier and the price; the run's input is the core's (D-213); the settings give the
// image references and the project's package registries (D-187).
//
// Credentials: the model key is read by its secret path for the route's provider only, and goes to
// the run's egress proxy only (D-143, ADR 0106 section 5). The GitHub installation token is minted
// per run and repository from the role's App, through the `InstallationTokens` port (D-156, D-159,
// D-178); it is minted last, so a run that would be refused for another reason mints none. Neither
// value is kept, logged, or put in the task file or the run's spec: `buildKubernetesTask` passes
// them to `start` in `credentials` only.
import {
  buildKubernetesTask,
  type KubernetesBotFile,
} from "../../src/adapters/agent-runtime/kubernetes/build-task.ts";
import type { KubernetesAgentTask } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import {
  BOT_ROLES,
  secretPathFor,
  type BotFiles,
} from "../../src/adapters/contracts-file/bot-files.ts";
import {
  TOKEN_ROLES,
  type InstallationTokens,
  type TokenRole,
} from "../../src/adapters/github/installation-tokens.ts";
import type { AgentRole, Store } from "../../src/core/store.ts";
import { PUSHING_ROLES } from "../../src/core/task-input.ts";
import type { RunToStart, TaskSource } from "./compose.ts";

/** The setting that lists each project's package registries (D-187), by project slug. */
export const PACKAGE_REGISTRIES_SETTING = "package_registries";

export interface TaskSourceOptions {
  bots: BotFiles;
  /** The agent image references by image kind, each pinned by digest (`agent_images`). */
  images(): Promise<Readonly<Record<string, string>>>;
  /** A secret by its path. Never logged. */
  secret(path: string): Promise<string>;
  githubTokens: InstallationTokens;
  store: Pick<Store, "getSetting">;
}

/**
 * The project's package registries from the settings (D-187). A project with no entry gets none:
 * a run reaches no registry Didi has not listed. A malformed entry refuses the run.
 */
async function packageRegistries(
  store: TaskSourceOptions["store"],
  projectSlug: string,
): Promise<string[]> {
  const value = (await store.getSetting(PACKAGE_REGISTRIES_SETTING))?.value;
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${PACKAGE_REGISTRIES_SETTING} must be an object of project slugs`);
  }
  const entry = (value as Record<string, unknown>)[projectSlug];
  if (entry === undefined) return [];
  if (!Array.isArray(entry) || !entry.every((h) => typeof h === "string")) {
    throw new Error(
      `${PACKAGE_REGISTRIES_SETTING} for the project must be a list of hosts`,
    );
  }
  return entry as string[];
}

export function createTaskSource(options: TaskSourceOptions): TaskSource {
  return {
    async taskFor(start: RunToStart): Promise<KubernetesAgentTask> {
      const { run, project } = start;
      const role = BOT_ROLES.find((r) => r === run.bot) as AgentRole | undefined;
      if (!role) throw new Error("the run's bot is not an agent role");
      const bot = options.bots[role];

      const image = (await options.images())[bot.image];
      if (typeof image !== "string") {
        throw new Error(`agent_images has no ${bot.image} image`);
      }
      // The route's provider, from the role's bot file: a run reaches no other provider.
      const entry = bot.providers.find((p) => p.name === run.provider);
      if (!entry)
        throw new Error(`the ${role} bot file has no entry for the run's provider`);
      const provider = entry.secretPath
        ? { ...entry, secretPath: secretPathFor(entry.secretPath, project.slug) }
        : { ...entry };

      let outputSchema: Record<string, unknown> | undefined;
      if (role === "council") {
        // The question's kind picks the schema; the core read it from this same bot file.
        if (!start.outputSchema)
          throw new Error("a Council run needs its question's output schema");
        outputSchema = start.outputSchema;
      } else if (role === "triage") {
        outputSchema = bot.outputSchemas?.answer;
      }
      const allowedHosts = PUSHING_ROLES.includes(role)
        ? [
            ...new Set([
              ...bot.allowedHosts,
              ...(await packageRegistries(options.store, project.slug)),
            ]),
          ]
        : [...bot.allowedHosts];
      const botFile: KubernetesBotFile = {
        image,
        instructions: bot.instructions,
        allowedHosts,
        ...(bot.allowedTools ? { allowedTools: [...bot.allowedTools] } : {}),
        ...(bot.fetchAllowedHosts
          ? { fetchAllowedHosts: [...bot.fetchAllowedHosts] }
          : {}),
        ...(outputSchema ? { outputSchema: structuredClone(outputSchema) } : {}),
      };

      const modelCredentials: Record<string, string> = {};
      if (provider.secretPath) {
        modelCredentials[provider.secretPath] = await options.secret(
          provider.secretPath,
        );
      }
      const tokenRole = TOKEN_ROLES.find((r) => r === role) as TokenRole | undefined;
      const githubToken = tokenRole
        ? await options.githubTokens.mint({
            role: tokenRole,
            repository: project.repo,
            access: tokenRole === "qa" ? "read" : "write",
            runId: run.id,
          })
        : undefined;

      return buildKubernetesTask({
        run,
        capacity: start.capacity,
        projectSlug: project.slug,
        repository: project.repo,
        bot: botFile,
        providers: [provider],
        input: start.input,
        evidenceIds: start.evidenceIds,
        stateApiToken: start.stateApiToken,
        ...(githubToken !== undefined ? { githubToken } : {}),
        modelCredentials,
      });
    },
  };
}
