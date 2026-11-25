// How the runner builds a run's task (ADR 0102, ADR 0106 sections 3 and 5, ADR 0107, ADR 0114
// sections 5 and 8). Everything comes from data: the role's bot file (contracts/bots/, checked at
// the spec version) gives the instructions, composed with the run's persona (ADR 0119 slice 2),
// the image kind, the tools, the hosts and the provider's address and key path; the run's route, recorded on the run, gives the model, the
// provider, the tier and the price; the run's input is the core's (D-213); the settings give the
// image references, the project's package registries (D-187) and, for a bot file that declares
// the documentation lookup, the one trusted documentation list (D-474, ADR 0119 slice 4c), whose
// hosts go to both the task file and the run's proxy.
//
// Credentials: the model key is read by its secret path for the route's provider only, and goes to
// the run's egress proxy only (D-143, ADR 0106 section 5). The GitHub installation token is minted
// per run and repository from the role's App, through the `InstallationTokens` port (D-156, D-159,
// D-178); it is minted last, so a run that would be refused for another reason mints none. QA's
// visual comparison gets neither the token nor the fetch step's hosts, since it reads only the
// images in its task file (N-57). The Council's call on a visual approval (task type
// `council:visual`, D-270) carries the option screenshots, and no other Council run carries any.
// Every Council run, of either task type, is a discussion (ADR 0119 slice 6e): its task file
// carries its question's chair, cast and pull-in limit as the core resolved them, and no other
// role's task carries one.
// Neither value is kept, logged, or put in the task file or the
// run's spec: `buildKubernetesTask` passes them to `start` in `credentials` only.
//
// QA's browser (ADR 0119 slice 5c, D-476): a QA review whose bot file declares `browser` and whose
// head's site passed the runner's check (flows/lib/start-run.ts) gets the site. Its task file and
// run spec then say `browser`, and its zip goes to `start` for the browser pod's site Secret only,
// never into the task file. A site for any other run refuses it before any token is minted.
import {
  buildKubernetesTask,
  type KubernetesBotFile,
} from "../../src/adapters/agent-runtime/kubernetes/build-task.ts";
import type { KubernetesAgentTask } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import {
  BOT_ROLES,
  instructionsFor,
  secretPathFor,
  type BotFiles,
} from "../../src/adapters/contracts-file/bot-files.ts";
import {
  TOKEN_ROLES,
  type InstallationTokens,
  type TokenRole,
} from "../../src/adapters/github/installation-tokens.ts";
import {
  MAX_TRUSTED_DOCS_HOSTS,
  readTrustedDocsHosts,
  TRUSTED_DOCS_HOSTS,
} from "../../src/core/docs-sites.ts";
import type { AgentRole, Store } from "../../src/core/store.ts";
import { PUSHING_ROLES } from "../../src/core/task-input.ts";
import { isCloseTaskType } from "../../src/core/task-types.ts";
import { VISUAL_CALL_TASK_TYPE } from "../../src/core/visual-call.ts";
import { VISUAL_TASK_TYPE } from "../../src/core/visual-comparison.ts";
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
  /** The settings: package registries and the trusted documentation list. */
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

/**
 * The one trusted documentation list from the settings (D-474, migration 0033), for a run whose
 * bot file declares the documentation lookup (ADR 0119 slice 4c). Each entry must be a canonical
 * host name, the task file's own rule, listed once, and at most as many as a run takes. A
 * missing or empty list gives the run no lookup; a malformed one refuses the run, naming the
 * setting, never a value.
 */
export async function trustedDocsHosts(
  store: TaskSourceOptions["store"],
): Promise<string[]> {
  const hosts = readTrustedDocsHosts(
    (await store.getSetting(TRUSTED_DOCS_HOSTS))?.value,
  );
  if (!hosts) {
    throw new Error(
      `${TRUSTED_DOCS_HOSTS} must be a list of at most ${MAX_TRUSTED_DOCS_HOSTS} canonical host names, each once`,
    );
  }
  return hosts;
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

      const visual = role === "qa" && run.taskType === VISUAL_TASK_TYPE;
      const visualCall = role === "council" && run.taskType === VISUAL_CALL_TASK_TYPE;
      const withImages = visual || visualCall;
      if (visualCall && (!start.images || start.images.length === 0)) {
        throw new Error("the Council's visual call needs the option screenshots");
      }
      if (!withImages && start.images !== undefined) {
        throw new Error("only a visual comparison or visual call run carries images");
      }
      // Every Council run is its question's discussion (ADR 0119 slice 6e), and no other run is.
      if (role === "council" && start.discussion === undefined) {
        throw new Error("a Council run needs its question's discussion");
      }
      if (role !== "council" && start.discussion !== undefined) {
        throw new Error("only a Council run is a discussion");
      }
      // QA's review alone gets a site, and only from a bot file that declares the browser.
      if (start.site !== undefined) {
        if (role !== "qa" || visual) {
          throw new Error("only QA's review (qa:review) runs a browser");
        }
        if (!bot.browser) throw new Error("the qa bot file declares no browser");
      }
      let outputSchema: Record<string, unknown> | undefined;
      if (visual) {
        // The visual comparison's answer schema and its images (D-242); the core read the schema
        // from this same bot file.
        if (!start.outputSchema || !start.images || start.images.length === 0) {
          throw new Error("a visual comparison run needs its answer schema and images");
        }
        outputSchema = start.outputSchema;
      } else if (role === "council") {
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
      // The run's task type's instructions: the shared base, its persona and the task's own text
      // (ADR 0119 slice 2), the task's text being its own where it has one (QA's `qa:visual`,
      // D-242, the Council's `council:visual`, D-270). A task type the role does not allow throws.
      const instructions = instructionsFor(bot, run.taskType);
      // The documentation lookup, only for a bot file that declares it, and never for the visual
      // comparison, which reads only its images, or a close run, which starts no model. The
      // list is read only then, so a malformed list refuses no other run. The run's proxy
      // serves the lookup only for the roles that may reach outside hosts, the Developer and the
      // Designer (ADR 0106 section 3, D-471): QA and Triage wait for that record to change, so a
      // bot file of theirs that declares it refuses the run before any token is minted.
      let docsLookupHosts: string[] = [];
      if (bot.docsLookup && !visual && !isCloseTaskType(run.taskType)) {
        if (!PUSHING_ROLES.includes(role)) {
          throw new Error(
            `a ${role} run has no documentation lookup yet: only the Developer and the Designer reach the lookup route (ADR 0106 section 3, D-471)`,
          );
        }
        docsLookupHosts = await trustedDocsHosts(options.store);
      }
      const botFile: KubernetesBotFile = {
        image,
        instructions,
        allowedHosts,
        ...(bot.allowedTools ? { allowedTools: [...bot.allowedTools] } : {}),
        // The read-only context tools (ADR 0119 slice 3c), not for the visual comparison, which
        // reads only its images; `buildKubernetesTask` also leaves them out of a close run.
        ...(bot.contextTools && !visual ? { contextTools: [...bot.contextTools] } : {}),
        ...(docsLookupHosts.length > 0 ? { docsLookupHosts } : {}),
        // The visual comparison has no fetch step (N-57): it reads only its images.
        ...(bot.fetchAllowedHosts && !visual
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
      // QA's visual comparison reads no repository, so no token is minted for it (N-57).
      const tokenRole = visual
        ? undefined
        : (TOKEN_ROLES.find((r) => r === role) as TokenRole | undefined);
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
        ...(withImages
          ? {
              images: (start.images ?? []).map((image) => ({
                label: image.label,
                mediaType: "image/png" as const,
                data: Buffer.from(image.png).toString("base64"),
              })),
            }
          : {}),
        ...(start.site !== undefined ? { site: start.site.zip } : {}),
        ...(start.discussion !== undefined
          ? {
              discussion: {
                chair: start.discussion.chair,
                cast: [...start.discussion.cast],
                maxPullIns: start.discussion.maxPullIns,
              },
            }
          : {}),
        stateApiToken: start.stateApiToken,
        ...(githubToken !== undefined ? { githubToken } : {}),
        modelCredentials,
      });
    },
  };
}
