// The one composition module of the flow layer (build plan M3.1). It builds everything a flow
// needs from its environment: the store from the runner's database secret, the contracts, the
// task types and the bot files at the bundle's spec version, the guards, a clock and an id source,
// the runner's GitHub client over the runner App's narrow tokens (D-381), the agent runtime, the
// repo map's Job (and its scan mode), each run's task, the staging check, the staging deploy (CI's
// builds and the deploy adapter's target, O-116), the ports for `BOOTSTRAP_TOKEN`'s access, and the
// GitHub Apps' token ports, each App's key and id read on its first token (O-125). Flows take these
// as `FlowDeps` and hold no rule of their own (architecture section 2.4); tests build `FlowDeps`
// from fakes.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

import { createKubernetesClient } from "../../src/adapters/agent-runtime/kubernetes/client.ts";
import type { KubernetesRunSettings } from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import {
  createKubernetesRepoMaps,
  createKubernetesRepoScans,
  type RepoMapCluster,
} from "../../src/adapters/agent-runtime/kubernetes/repo-maps.ts";
import { createKubernetesRuntime } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import type { AgentRuntime } from "../../src/adapters/agent-runtime/runtime.ts";
import {
  botProfiles,
  botTaskTypes,
  readBotFiles,
  runLimits,
  taskTypeLimits,
} from "../../src/adapters/contracts-file/bot-files.ts";
import {
  loadAllContractFiles,
  loadTaskTypesFile,
} from "../../src/adapters/contracts-file/load.ts";
import {
  createCloudflareHttp,
  createCloudflareStagingTarget,
  type CloudflareCredentials,
  type StagingDeployCredentials,
} from "../../src/adapters/deploy/cloudflare-staging.ts";
import { createMarkerStagingChecker } from "../../src/adapters/deploy/staging-checker.ts";
import {
  createGitHubAppJwt,
  parseGitHubId,
  type GitHubAppRole,
} from "../../src/adapters/github/app-jwt.ts";
import {
  createGitHubBootstrapAccess,
  createGitHubBootstrapRuns,
} from "../../src/adapters/github/bootstrap-access.ts";
import {
  createBootstrapTokens,
  type BootstrapTokens,
} from "../../src/adapters/github/bootstrap-tokens.ts";
import {
  createInstallationTokens,
  type InstallationTokens,
} from "../../src/adapters/github/installation-tokens.ts";
import {
  createRunnerMergeTokens,
  type RunnerMergeTokens,
} from "../../src/adapters/github/merge-tokens.ts";
import type {
  GitHubAppJwt,
  NarrowTokenOptions,
} from "../../src/adapters/github/narrow-tokens.ts";
import {
  createGitHubPostHttp,
  type GitHubPostHttp,
} from "../../src/adapters/github/post-http.ts";
import { createGitHubProjectRepositories } from "../../src/adapters/github/project-repositories.ts";
import { createGitHubProjectSettings } from "../../src/adapters/github/project-settings.ts";
import {
  createRepositoryCreationTokens,
  type RepositoryCreationTokens,
} from "../../src/adapters/github/repository-creation-tokens.ts";
import {
  createGitHubHttp,
  type GitHubHttp,
  type RunnerAppTokens,
} from "../../src/adapters/github/runner-app-tokens.ts";
import { createRunnerGitHub } from "../../src/adapters/github/runner-github.ts";
import { createRunnerAppTokens } from "../../src/adapters/github/runner-read-tokens.ts";
import { createGitHubStagingBuilds } from "../../src/adapters/github/staging-builds.ts";
import { createGitHubWriteHttp } from "../../src/adapters/github/write-http.ts";
import { createGitHubScreenshotBundles } from "../../src/adapters/screenshots/github-artifacts.ts";
import { createGitHubRepoFolders } from "../../src/adapters/screenshots/github-folders.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { databasePoolConfig } from "../../src/adapters/store-postgres/tls.ts";
import type {
  BootstrapAccess,
  BootstrapRuns,
} from "../../src/core/bootstrap-access.ts";
import { validateContracts } from "../../src/core/contracts.ts";
import type { GitHub } from "../../src/core/github.ts";
import { GUARD_NAMES, GUARDS } from "../../src/core/guards/index.ts";
import type { Clock } from "../../src/core/library.ts";
import type { ReconcileDeps } from "../../src/core/reconcile.ts";
import type {
  ProjectRepositories,
  ProjectSettings,
} from "../../src/core/register-project.ts";
import type { RepoMaps } from "../../src/core/repo-map.ts";
import type { RepoScans } from "../../src/core/scan.ts";
import type { StagingChecker } from "../../src/core/staging.ts";
import type { StagingBuilds, StagingTarget } from "../../src/core/staging-deploy.ts";
import type { RunCapacityLimits } from "../../src/core/runs.ts";
import { validateTaskTypes } from "../../src/core/task-types.ts";
import type { Node, Project, Run } from "../../src/core/store.ts";
import type {
  RepoFolders,
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
  /**
   * The runner's staging check (ADR 0107), from the deploy adapter: the commit marker the
   * project's staging site serves (O-116). Public, so it needs no credential.
   */
  stagingChecker: StagingChecker;
  /**
   * CI's builds on main and their `staging-site` artifact (D-353, O-116), read with the runner
   * App's `actions: read` token for one repository (D-267, O-125).
   */
  stagingBuilds: StagingBuilds;
  /**
   * The deploy adapter's staging target (ADR 0111): the file set's check and Cloudflare's direct
   * upload to `<slug>-staging` (O-116). Refuses on its credential until Didi creates the staging
   * deploy token (D-353, runbook step 16), so nothing is uploaded.
   */
  stagingTarget: StagingTarget;
  tasks: TaskSource;
  /**
   * CI's screenshot bundles for the visual comparison (D-242), read as workflow artifacts with the
   * runner App's `actions: read` token (D-267, O-125).
   */
  screenshots: ScreenshotBundles;
  /**
   * The approved option's folder at a commit, for the visual comparison's integrity check (D-281),
   * read with the runner App's `contents: read` token (D-267, O-125).
   */
  repoFolders: RepoFolders;
  /**
   * The repo map per commit for Triage (D-251), built in its own short-lived Job in the project's
   * agent namespace, whose only network is GitHub and which holds only the runner App's
   * `contents: read` token (D-267, D-275 (2), O-125).
   */
  repoMaps: RepoMaps;
  /**
   * The Scanner's stage 1 scan of a project's repository (D-300, O-92): the repo map Job in its
   * scan mode, with the same isolation and the same one `contents: read` token.
   */
  repoScans: RepoScans;
  /**
   * Didi's register-project form (D-345, O-109): the slugs in the platform settings file on
   * `didi-build/foreman`'s main, read with the runner App's `contents: read` token for that one
   * repository (D-267, O-125).
   */
  projectSettings: ProjectSettings;
  /**
   * The form's repository step (D-345, D-346, D-348): the create from `didi-build/launchpad` with
   * the creation token, and the read of an existing repository with a `contents: read` token
   * (O-125).
   */
  projectRepositories: ProjectRepositories;
  /**
   * `BOOTSTRAP_TOKEN`'s selected repositories (D-358 lock (2), O-114): the form's grant, the
   * removal once Bootstrap's run ends and the reconcile pass's backstop, each with its own token
   * narrowed to one step ("Organization secrets", O-125).
   */
  bootstrapAccess: BootstrapAccess;
  /**
   * Bootstrap's restart from the form ("Actions: write", narrowed to the new repository) and its
   * newest restarted run, read with the runner App's `actions: read` token (D-267, O-114, O-125).
   */
  bootstrapRuns: BootstrapRuns;
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
 * A staging deploy credential port that always refuses (D-353, O-116), as the composition had
 * before it read Windmill (O-138); tests use it for a deploy that must reach no network.
 */
export function unbuiltStagingDeployCredentials(): StagingDeployCredentials {
  return {
    read: async () => {
      throw new NotBuiltError(
        "The staging deploy needs its Cloudflare token, created by Didi at first hosting through the new-credentials gate with Workers Scripts Edit only (D-353, runbook step 16)",
      );
    },
  };
}

/**
 * The staging deploy token and the account id, read by path from the flow's environment (Windmill
 * secret variables, D-370, ADR 0111 section 4) each time a deploy needs them, and never kept or
 * logged. The token is a new credential, Didi's gate (runbook step 16): until both variables
 * exist, the read throws, the target refuses the deploy as `credential_unavailable`, nothing is
 * uploaded and no failure is counted, so the composition reads them from the start (O-138).
 */
export function windmillStagingDeployCredentials(
  env: Pick<FlowEnvironment, "secret">,
): StagingDeployCredentials {
  return {
    read: async (): Promise<CloudflareCredentials> => ({
      accountId: (await env.secret(SECRET_PATHS.cloudflareAccountId)).trim(),
      token: (await env.secret(SECRET_PATHS.stagingDeployToken)).trim(),
    }),
  };
}

/** The deploy adapter's Cloudflare target (O-116), with the credential port it reads. */
export function runnerStagingTarget(
  credentials: StagingDeployCredentials,
): StagingTarget {
  return createCloudflareStagingTarget({ credentials, http: createCloudflareHttp() });
}

/** The GitHub Apps' token ports (D-365, D-368, O-125). */
export interface GitHubAppTokens {
  /**
   * The runner App's read tokens: one repository, `contents`, `actions`, `pull_requests` or
   * `checks` at read (D-267, D-365, D-381).
   */
  runner: RunnerAppTokens;
  /** The runner App's merge token: one repository, `contents: write` (D-365, D-381). */
  merge: RunnerMergeTokens;
  /** The runner App's repository creation token (D-346). */
  repositoryCreation: RepositoryCreationTokens;
  /** The runner App's tokens for `BOOTSTRAP_TOKEN`'s access (D-358). */
  bootstrap: BootstrapTokens;
  /** A Developer, Designer or QA run's token, from that role's own App (D-156, D-159). */
  installation: InstallationTokens;
}

/** The two HTTP ports the Apps' tokens use: the installation lookup and the mint. */
export interface GitHubAppHttp {
  get: GitHubHttp;
  post: GitHubPostHttp;
}

/** Where each App's key and id are read (flows/windmill.yaml, runbook step 15). */
const GITHUB_APP_VARIABLES: Readonly<
  Record<GitHubAppRole, { privateKey: string; appId: string }>
> = {
  runner: {
    privateKey: SECRET_PATHS.runnerAppPrivateKey,
    appId: VALUE_NAMES.runnerAppId,
  },
  developer: {
    privateKey: SECRET_PATHS.developerAppPrivateKey,
    appId: VALUE_NAMES.developerAppId,
  },
  designer: {
    privateKey: SECRET_PATHS.designerAppPrivateKey,
    appId: VALUE_NAMES.designerAppId,
  },
  qa: { privateKey: SECRET_PATHS.qaAppPrivateKey, appId: VALUE_NAMES.qaAppId },
};

/**
 * Made on the first call and kept for the flow. A failed attempt is not kept, so a read that
 * failed once is tried again on the next call.
 */
function onFirstUse<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () =>
    (made ??= make().catch((error: unknown) => {
      made = undefined;
      throw error;
    }));
}

/**
 * The GitHub Apps' token ports over their keys and ids in the flow's environment (D-368, D-370,
 * O-125). Each App's id and key are read on the first token minted with that App, so a flow that
 * mints none reads no key; the signer made from them is kept for the life of the flow, and no
 * token is ever kept. The runner App's installation id is read on its first token too. Each mint
 * checks its request before it signs, so a refused request reads no key.
 */
export function windmillGitHubAppTokens(
  env: Pick<FlowEnvironment, "secret" | "value">,
  clock: Clock,
  http: GitHubAppHttp = { get: createGitHubHttp(), post: createGitHubPostHttp() },
): GitHubAppTokens {
  const signer = (role: GitHubAppRole): GitHubAppJwt => {
    const { privateKey, appId } = GITHUB_APP_VARIABLES[role];
    const made = onFirstUse(async () =>
      createGitHubAppJwt({
        role,
        appId: parseGitHubId(await env.value(appId)),
        privateKeyPem: await env.secret(privateKey),
        clock,
      }),
    );
    return { sign: async () => (await made()).sign() };
  };
  const runnerJwt = signer("runner");
  const runnerInstallation = onFirstUse(async () =>
    parseGitHubId(await env.value(VALUE_NAMES.runnerAppInstallationId)),
  );
  const runner = async (): Promise<NarrowTokenOptions> => ({
    appJwt: runnerJwt,
    installationId: await runnerInstallation(),
    http: http.post,
  });
  return {
    runner: {
      mint: async (request) => createRunnerAppTokens(await runner()).mint(request),
    },
    merge: {
      mint: async (repository) =>
        createRunnerMergeTokens(await runner()).mint(repository),
    },
    repositoryCreation: {
      mint: async () => createRepositoryCreationTokens(await runner()).mint(),
    },
    bootstrap: {
      secretsChange: async (name) =>
        createBootstrapTokens(await runner()).secretsChange(name),
      secretsList: async () => createBootstrapTokens(await runner()).secretsList(),
      restart: async (name) => createBootstrapTokens(await runner()).restart(name),
    },
    installation: createInstallationTokens({
      apps: {
        developer: signer("developer"),
        designer: signer("designer"),
        qa: signer("qa"),
      },
      http: http.get,
      post: http.post,
    }),
  };
}

/** CI's builds on main and their `staging-site` artifact (O-116), with the runner's read tokens. */
export function runnerStagingBuilds(tokens: RunnerAppTokens): StagingBuilds {
  return createGitHubStagingBuilds({ tokens, http: createGitHubHttp() });
}

/**
 * The runner's own GitHub client (D-381, O-127): pull requests, changed files, check runs, CI's
 * workflow runs and jobs (D-354), the mergeable state, the squash merge, the compare and a
 * branch's head, each call with its own token for one repository and one permission.
 */
export function runnerGitHub(
  tokens: RunnerAppTokens,
  mergeTokens: RunnerMergeTokens,
): GitHub {
  return createRunnerGitHub({
    tokens,
    mergeTokens,
    http: createGitHubHttp(),
    write: createGitHubWriteHttp(),
  });
}

/** CI's screenshot bundles as workflow artifacts (D-242, D-267). */
export function runnerScreenshotBundles(tokens: RunnerAppTokens): ScreenshotBundles {
  return createGitHubScreenshotBundles({ tokens, http: createGitHubHttp() });
}

/** A folder's git tree id at a commit (D-281, D-267). */
export function runnerRepoFolders(tokens: RunnerAppTokens): RepoFolders {
  return createGitHubRepoFolders({ tokens, http: createGitHubHttp() });
}

/**
 * The repo map from the code at a commit, built in its own Job (D-251, D-267, D-275 (2)). The
 * token is minted before the cluster is read.
 */
export function runnerRepoMaps(
  cluster: () => Promise<RepoMapCluster>,
  tokens: RunnerAppTokens,
): RepoMaps {
  return createKubernetesRepoMaps({
    tokens,
    http: createGitHubHttp(),
    cluster,
    ids: { next: () => randomUUID() },
  });
}

/**
 * The Scanner's stage 1 scan at the default branch's head, in the repo map Job's scan mode (D-300,
 * O-92). The token is minted before the cluster is read.
 */
export function runnerRepoScans(
  cluster: () => Promise<RepoMapCluster>,
  tokens: RunnerAppTokens,
): RepoScans {
  return createKubernetesRepoScans({
    tokens,
    http: createGitHubHttp(),
    cluster,
    ids: { next: () => randomUUID() },
  });
}

/** The settings file's listed slugs on main (D-345, O-109). */
export function runnerProjectSettings(tokens: RunnerAppTokens): ProjectSettings {
  return createGitHubProjectSettings({ tokens, http: createGitHubHttp() });
}

/**
 * The create from Launchpad with the creation token (D-346: `contents: read` and
 * `repository_creation: write` on `didi-build/launchpad` only), and the read of an existing
 * repository with a `contents: read` token.
 */
export function runnerProjectRepositories(
  creationTokens: RepositoryCreationTokens,
  readTokens: RunnerAppTokens,
): ProjectRepositories {
  return createGitHubProjectRepositories({
    creationTokens,
    readTokens,
    http: createGitHubHttp(),
    post: createGitHubPostHttp(),
  });
}

/**
 * The secret's list: grant, removal and list (O-114), each with its own token narrowed to one step
 * (D-358: "Organization secrets" write for one repository's grant or removal, read for the list).
 */
export function runnerBootstrapAccess(tokens: BootstrapTokens): BootstrapAccess {
  return createGitHubBootstrapAccess({
    tokens,
    http: createGitHubHttp(),
    write: createGitHubWriteHttp(),
  });
}

/**
 * Bootstrap's restart ("Actions: write" for the one repository, D-358) and its newest restarted
 * run, read with an `actions: read` token (O-114).
 */
export function runnerBootstrapRuns(
  tokens: BootstrapTokens,
  readTokens: RunnerAppTokens,
): BootstrapRuns {
  return createGitHubBootstrapRuns({
    tokens,
    readTokens,
    http: createGitHubHttp(),
    post: createGitHubPostHttp(),
  });
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
  // The pool connects on first use, over TLS verified against Supabase's CA (D-364, O-117). A
  // refused config throws here; a connection error is thrown by the call that needs it.
  const pool = new pg.Pool(
    databasePoolConfig(await env.secret(SECRET_PATHS.database), { max: 2 }),
  );
  pool.on("error", () => undefined);
  const store = createPostgresStore(pool);
  const clock: Clock = { now: () => new Date() };
  // Each App's key and id are read on its first token, so a flow that mints none reads no key.
  const apps = windmillGitHubAppTokens(env, clock);
  // Read on the first task built, so a flow that starts no agent never needs it.
  let images: Promise<Record<string, string>> | undefined;
  // The cluster client and run settings, built on first use by an agent run or a repo map Job,
  // so a flow that uses neither never reads the cluster token.
  let cluster: Promise<RepoMapCluster> | undefined;
  const clusterParts = () =>
    (cluster ??= (async () => ({
      client: createKubernetesClient({
        server: await env.value(VALUE_NAMES.clusterEndpoint),
        ca: await env.value(VALUE_NAMES.clusterCaCertificate),
        token: await env.secret(SECRET_PATHS.clusterToken),
      }),
      settings: jsonValue(
        VALUE_NAMES.agentRunSettings,
        await env.value(VALUE_NAMES.agentRunSettings),
      ) as KubernetesRunSettings,
    }))());

  return {
    store,
    contracts,
    guards: GUARDS,
    clock,
    ids: { next: () => randomUUID() },
    github: runnerGitHub(apps.runner, apps.merge),
    appLogins,
    runnerAppSlug,
    limits: runLimits(botFiles),
    taskLimits: taskTypeLimits(botFiles),
    bots: botProfiles(botFiles),
    taskTypes: checked.taskTypes,
    runtime: lazyRuntime(async () => createKubernetesRuntime(await clusterParts())),
    stagingChecker: createMarkerStagingChecker(),
    stagingBuilds: runnerStagingBuilds(apps.runner),
    stagingTarget: runnerStagingTarget(windmillStagingDeployCredentials(env)),
    screenshots: runnerScreenshotBundles(apps.runner),
    repoFolders: runnerRepoFolders(apps.runner),
    repoMaps: runnerRepoMaps(clusterParts, apps.runner),
    repoScans: runnerRepoScans(clusterParts, apps.runner),
    projectSettings: runnerProjectSettings(apps.runner),
    projectRepositories: runnerProjectRepositories(
      apps.repositoryCreation,
      apps.runner,
    ),
    bootstrapAccess: runnerBootstrapAccess(apps.bootstrap),
    bootstrapRuns: runnerBootstrapRuns(apps.bootstrap, apps.runner),
    tasks: createTaskSource({
      bots: botFiles,
      images: () =>
        (images ??= env
          .value(VALUE_NAMES.agentImages)
          .then((raw) => parseAgentImages(raw))),
      secret: (path) => env.secret(path),
      githubTokens: apps.installation,
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
