// The one composition module of the flow layer (build plan M3.1). It builds everything a flow
// needs from its environment: the store from the runner's database secret, the contracts, the
// task types and the bot files at the bundle's spec version, the guards, a clock and an id source,
// the GitHub reader, the agent runtime, each run's task and the staging check. Flows take these as `FlowDeps` and hold no rule of their own (architecture section
// 2.4); tests build `FlowDeps` from fakes.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

import { createKubernetesClient } from "../../src/adapters/agent-runtime/kubernetes/client.ts";
import type { KubernetesRunSettings } from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import { createKubernetesRuntime } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import type { AgentRuntime } from "../../src/adapters/agent-runtime/runtime.ts";
import {
  botProfiles,
  botTaskTypes,
  readBotFiles,
  runLimits,
} from "../../src/adapters/contracts-file/bot-files.ts";
import {
  loadAllContractFiles,
  loadTaskTypesFile,
} from "../../src/adapters/contracts-file/load.ts";
import { GitHubNotConfiguredError } from "../../src/adapters/github/client.ts";
import type { InstallationTokens } from "../../src/adapters/github/installation-tokens.ts";
import {
  createGitHubHttp,
  type RunnerAppTokens,
} from "../../src/adapters/github/runner-app-tokens.ts";
import { createGitHubRepoMaps } from "../../src/adapters/repo-map/github.ts";
import { createGitHubScreenshotBundles } from "../../src/adapters/screenshots/github-artifacts.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { validateContracts } from "../../src/core/contracts.ts";
import type { GitHub } from "../../src/core/github.ts";
import { GUARD_NAMES, GUARDS } from "../../src/core/guards/index.ts";
import type { ReconcileDeps } from "../../src/core/reconcile.ts";
import type { RepoMaps } from "../../src/core/repo-map.ts";
import type { StagingChecker } from "../../src/core/staging.ts";
import type { RunCapacityLimits } from "../../src/core/runs.ts";
import { validateTaskTypes } from "../../src/core/task-types.ts";
import type { Node, Project, Run } from "../../src/core/store.ts";
import type {
  ScreenshotBundles,
  VisualImage,
} from "../../src/core/visual-comparison.ts";
import { SECRET_PATHS, VALUE_NAMES, type FlowEnvironment } from "./environment.ts";
import { createTaskSource } from "./tasks.ts";

/** An agent runtime as flows see it. `cleanup` runs after a run's end is recorded (ADR 0107). */
export interface FlowRuntime extends AgentRuntime<unknown, unknown> {
  cleanup?(handle: unknown): Promise<void>;
}

/**
 * What the runner knows about a run when it builds the task to start it with: the admitted run
 * and its route, the item, the run's input (src/core/task-input.ts), its branch and its state API
 * token. The token is passed on to `start` and never kept or logged.
 */
export interface RunToStart {
  run: Run;
  node: Node;
  project: Project;
  input: string;
  /** Developer and Designer: the branch the run pushes to. */
  branch: string | null;
  /** QA: the runner's evidence ids the verdict may cite (ADR 0107). */
  evidenceIds: string[];
  /** The Flex capacity bounds from the settings (ADR 0114 section 9). */
  capacity: RunCapacityLimits;
  stateApiToken: string;
  /**
   * Council: the output schema of its question's kind, from the Council's bot file
   * (src/core/council.ts, D-228). QA's visual comparison: its answer schema (D-242). The task
   * file carries it, and the runner checks the answer against the same schema when the run ends.
   */
  outputSchema?: Record<string, unknown>;
  /** QA's visual comparison: the image pairs, in order, as PNG bytes (D-242, D-250). */
  images?: VisualImage[];
}

/**
 * The task a run is started with (ADR 0102, ADR 0106 section 5, ADR 0107): the bot file's
 * instructions and settings, the run's route as its proxy's provider list, and the credentials
 * (the state API token from the runner, the GitHub installation token and the model credential
 * through their adapters). Built by ./tasks.ts through `buildKubernetesTask`.
 */
export interface TaskSource {
  taskFor(start: RunToStart): Promise<unknown>;
}

export interface FlowDeps extends ReconcileDeps {
  runtime: FlowRuntime;
  /** The runner's staging smoke check (ADR 0107), from the deploy adapter (M3.7). */
  stagingChecker: StagingChecker;
  tasks: TaskSource;
  /**
   * CI's screenshot bundles for the visual comparison (D-242), read as workflow artifacts with the
   * runner App's `actions: read` token (D-267). Refuses until the runner App exists (D-178).
   */
  screenshots: ScreenshotBundles;
  /**
   * The repo map per commit for Triage (D-251), from the code GitHub serves with the runner App's
   * `contents: read` token (D-267). Refuses until the runner App exists (D-178).
   */
  repoMaps: RepoMaps;
  /** A new opaque state API token for one run (ADR 0102). Never logged. */
  newRunToken(): string;
  executionsThisMonth(): Promise<number>;
  /** Releases what the flow opened, such as the database pool. */
  close(): Promise<void>;
}

/** A part the runner cannot build yet. The message says what it waits on. */
export class NotBuiltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotBuiltError";
  }
}

/**
 * The runner's GitHub reads and merge calls. The runner App is registered at M3 (D-178); until
 * then every call refuses, so nothing is merged.
 */
function unregisteredGitHub(): GitHub {
  const refuse = async (): Promise<never> => {
    throw new GitHubNotConfiguredError();
  };
  return {
    getPullRequest: refuse,
    listChangedPaths: refuse,
    listCheckRuns: refuse,
    listOpenPullRequests: refuse,
    getMergeability: refuse,
    squashMerge: refuse,
    listDeployments: refuse,
    listRecentDeployments: refuse,
    compareCommits: refuse,
    getBranchHead: refuse,
  };
}

/**
 * The staging check needs the deploy adapter, which knows each project's staging target (ADR
 * 0111, build plan M3.7, N-29). Until it exists every check refuses, so nothing is recorded.
 */
function unbuiltStagingChecker(): StagingChecker {
  return {
    check: async () => {
      throw new NotBuiltError(
        "The staging check needs the deploy adapter's staging target (build plan M3.7, N-29)",
      );
    },
  };
}

/**
 * The runner App's read-only tokens for the repo map and the screenshot bundles (D-267). The runner
 * App is registered at first hosting through the new-credentials gate (D-178), with `contents:
 * read` and `actions: read`; until then every request refuses, so no repo map is read (no Triage
 * run starts) and no screenshot bundle is read (no visual comparison starts).
 */
export function unregisteredRunnerAppTokens(): RunnerAppTokens {
  return {
    mint: async () => {
      throw new NotBuiltError(
        "The runner App's read-only token needs the runner App, registered at first hosting through the new-credentials gate with contents read and actions read (D-178, D-267)",
      );
    },
  };
}

/** CI's screenshot bundles as workflow artifacts (D-242, D-267); refuses on the token today. */
export function runnerScreenshotBundles(
  tokens: RunnerAppTokens = unregisteredRunnerAppTokens(),
): ScreenshotBundles {
  return createGitHubScreenshotBundles({ tokens, http: createGitHubHttp() });
}

/** The repo map from the code at a commit (D-251, D-267); refuses on the token today. */
export function runnerRepoMaps(
  tokens: RunnerAppTokens = unregisteredRunnerAppTokens(),
): RepoMaps {
  return createGitHubRepoMaps({ tokens, http: createGitHubHttp() });
}

/** Built on first use, so a flow that never starts an agent never reads the cluster token. */
function lazyRuntime(build: () => Promise<FlowRuntime>): FlowRuntime {
  let made: Promise<FlowRuntime> | undefined;
  const get = () => (made ??= build());
  return {
    start: async (task, limits) => (await get()).start(task, limits),
    poll: async (handle) => (await get()).poll(handle),
    cancel: async (handle) => (await get()).cancel(handle),
    cleanup: async (handle) => (await get()).cleanup?.(handle),
  };
}

/** Parses a plain JSON value. The error names the value, never its content. */
function jsonValue(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

/**
 * The GitHub installation tokens of the Developer, Designer and QA runs. They come from the role's
 * GitHub App, registered at M3 through the new-credentials gate (D-156, D-178); until then every
 * request refuses, so no Developer, Designer or QA run starts.
 */
export function unregisteredInstallationTokens(): InstallationTokens {
  return {
    mint: async () => {
      throw new NotBuiltError(
        "A run's GitHub installation token needs its role's GitHub App, registered at M3 through the new-credentials gate (D-156, D-178)",
      );
    },
  };
}

/** The agent image references by image kind (`agent_images`). Names the value, never its content. */
function parseAgentImages(raw: string): Record<string, string> {
  const value = jsonValue(VALUE_NAMES.agentImages, raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((v) => typeof v === "string")
  ) {
    throw new Error(`${VALUE_NAMES.agentImages} must be an object of image references`);
  }
  return value as Record<string, string>;
}

export async function compose(env: FlowEnvironment): Promise<FlowDeps> {
  const specVersion = await env.value(VALUE_NAMES.specVersion);
  const { contracts, problems } = validateContracts(
    loadAllContractFiles(specVersion).raw,
    GUARD_NAMES,
  );
  if (!contracts) throw new Error(`The contracts are invalid: ${problems.join("; ")}`);
  // The bot files at the bundle's spec version (contracts/bots/, docs/bot-files.md).
  const botFiles = readBotFiles();
  const checked = validateTaskTypes(
    specVersion,
    loadTaskTypesFile(),
    botTaskTypes(botFiles),
  );
  if (!checked.taskTypes) {
    throw new Error(`The task types are invalid: ${checked.problems.join("; ")}`);
  }
  const appLogins = [
    await env.value(VALUE_NAMES.developerAppLogin),
    await env.value(VALUE_NAMES.designerAppLogin),
  ];
  const runnerAppSlug = await env.value(VALUE_NAMES.runnerAppSlug);
  // The pool connects on first use. A connection error is thrown by the call that needs it.
  const pool = new pg.Pool({
    connectionString: await env.secret(SECRET_PATHS.database),
    max: 2,
  });
  pool.on("error", () => undefined);
  const store = createPostgresStore(pool);
  // Read on the first task built, so a flow that starts no agent never needs it.
  let images: Promise<Record<string, string>> | undefined;

  return {
    store,
    contracts,
    guards: GUARDS,
    clock: { now: () => new Date() },
    ids: { next: () => randomUUID() },
    github: unregisteredGitHub(),
    appLogins,
    runnerAppSlug,
    limits: runLimits(botFiles),
    bots: botProfiles(botFiles),
    taskTypes: checked.taskTypes,
    runtime: lazyRuntime(async () =>
      createKubernetesRuntime({
        client: createKubernetesClient({
          server: await env.value(VALUE_NAMES.clusterEndpoint),
          ca: await env.value(VALUE_NAMES.clusterCaCertificate),
          token: await env.secret(SECRET_PATHS.clusterToken),
        }),
        settings: jsonValue(
          VALUE_NAMES.agentRunSettings,
          await env.value(VALUE_NAMES.agentRunSettings),
        ) as KubernetesRunSettings,
      }),
    ),
    stagingChecker: unbuiltStagingChecker(),
    screenshots: runnerScreenshotBundles(),
    repoMaps: runnerRepoMaps(),
    tasks: createTaskSource({
      bots: botFiles,
      images: () =>
        (images ??= env
          .value(VALUE_NAMES.agentImages)
          .then((raw) => parseAgentImages(raw))),
      secret: (path) => env.secret(path),
      githubTokens: unregisteredInstallationTokens(),
      store,
    }),
    // 32 random bytes: far beyond guessing, and inside the API's token pattern (src/api/auth.ts).
    newRunToken: () => randomBytes(32).toString("base64url"),
    executionsThisMonth: () => env.executionsThisMonth(),
    close: () => pool.end(),
  };
}

/** Composes, runs one flow and always releases what was opened. Used by each flow's `main`. */
export async function withFlowDeps<T>(
  env: FlowEnvironment,
  work: (deps: FlowDeps) => Promise<T>,
): Promise<T> {
  const deps = await compose(env);
  try {
    return await work(deps);
  } finally {
    await deps.close();
  }
}
