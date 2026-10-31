// The one composition module of the flow layer (build plan M3.1). It builds everything a flow
// needs from its environment: the store from the runner's database secret, the contracts at the
// bundle's spec version, the guards, a clock and an id source, the GitHub reader and the agent
// runtime. Flows take these as `FlowDeps` and hold no rule of their own (architecture section
// 2.4); tests build `FlowDeps` from fakes.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

import { createKubernetesClient } from "../../src/adapters/agent-runtime/kubernetes/client.ts";
import type { KubernetesRunSettings } from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import { createKubernetesRuntime } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import type { AgentRuntime } from "../../src/adapters/agent-runtime/runtime.ts";
import {
  loadContractFiles,
  loadTaskTypesFile,
} from "../../src/adapters/contracts-file/load.ts";
import { GitHubNotConfiguredError } from "../../src/adapters/github/client.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { validateContracts } from "../../src/core/contracts.ts";
import type { GitHub } from "../../src/core/github.ts";
import { GUARD_NAMES, GUARDS } from "../../src/core/guards/index.ts";
import type { BotProfile, ReconcileDeps } from "../../src/core/reconcile.ts";
import { REHEARSAL_RUN_LIMITS, type RunCapacityLimits } from "../../src/core/runs.ts";
import { validateTaskTypes } from "../../src/core/task-types.ts";
import type { AgentRole, Node, Project, Run } from "../../src/core/store.ts";
import { SECRET_PATHS, VALUE_NAMES, type FlowEnvironment } from "./environment.ts";

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
}

/**
 * The task a run is started with (ADR 0102, ADR 0106 section 5, ADR 0107): the bot file's
 * instructions and settings, the run's route as its proxy's provider list, and the credentials
 * (the state API token from the runner, the GitHub installation token and the model credential
 * through their adapters). For the Kubernetes runtime, `buildKubernetesTask` builds it.
 */
export interface TaskSource {
  taskFor(start: RunToStart): Promise<unknown>;
}

export interface FlowDeps extends ReconcileDeps {
  runtime: FlowRuntime;
  tasks: TaskSource;
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

const AGENT_ROLES: readonly AgentRole[] = [
  "developer",
  "qa",
  "designer",
  "council",
  "triage",
];

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
  };
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

export function parseBotProfiles(raw: string): Record<AgentRole, BotProfile> {
  const value = jsonValue(VALUE_NAMES.botProfiles, raw) as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const profiles = {} as Record<AgentRole, BotProfile>;
  for (const role of AGENT_ROLES) {
    const p = (value as Record<string, Partial<BotProfile> | undefined> | null)?.[role];
    if (!p || !text(p.runtime) || !text(p.botVersion)) {
      throw new Error(`${VALUE_NAMES.botProfiles} has no complete profile for ${role}`);
    }
    // A model in the profile is ignored: each run's route names it (ADR 0114 section 5).
    profiles[role] = { runtime: p.runtime, botVersion: p.botVersion };
  }
  return profiles;
}

export async function compose(env: FlowEnvironment): Promise<FlowDeps> {
  const specVersion = await env.value(VALUE_NAMES.specVersion);
  const { contracts, problems } = validateContracts(
    loadContractFiles(specVersion).raw,
    GUARD_NAMES,
  );
  if (!contracts) throw new Error(`The contracts are invalid: ${problems.join("; ")}`);
  const checked = validateTaskTypes(specVersion, loadTaskTypesFile());
  if (!checked.taskTypes) {
    throw new Error(`The task types are invalid: ${checked.problems.join("; ")}`);
  }
  const bots = parseBotProfiles(await env.value(VALUE_NAMES.botProfiles));
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

  return {
    store: createPostgresStore(pool),
    contracts,
    guards: GUARDS,
    clock: { now: () => new Date() },
    ids: { next: () => randomUUID() },
    github: unregisteredGitHub(),
    appLogins,
    runnerAppSlug,
    limits: REHEARSAL_RUN_LIMITS,
    bots,
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
    tasks: {
      taskFor: async () => {
        throw new NotBuiltError(
          "A run's task needs the bot files, the provider settings and the GitHub App's installation tokens (ADR 0107, D-178)",
        );
      },
    },
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
