// The one composition module of the flow layer (build plan M3.1). It builds everything a flow
// needs from its environment: the store from the runner's database secret, the contracts at the
// bundle's spec version, the guards, a clock and an id source, the GitHub reader and the agent
// runtime. Flows take these as `FlowDeps` and hold no rule of their own (architecture section
// 2.4); tests build `FlowDeps` from fakes.
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createKubernetesClient } from "../../src/adapters/agent-runtime/kubernetes/client.ts";
import type { KubernetesRunSettings } from "../../src/adapters/agent-runtime/kubernetes/manifests.ts";
import { createKubernetesRuntime } from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import type { AgentRuntime } from "../../src/adapters/agent-runtime/runtime.ts";
import { loadContractFiles } from "../../src/adapters/contracts-file/load.ts";
import { GitHubNotConfiguredError } from "../../src/adapters/github/client.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { validateContracts } from "../../src/core/contracts.ts";
import type { GitHubReader } from "../../src/core/github.ts";
import { GUARD_NAMES, GUARDS } from "../../src/core/guards/index.ts";
import type { BotProfile, ReconcileDeps } from "../../src/core/reconcile.ts";
import { REHEARSAL_RUN_LIMITS } from "../../src/core/runs.ts";
import type { AgentRole, Decision, GateRequest, Run } from "../../src/core/store.ts";
import type { ApprovalReply } from "./approval.ts";
import { SECRET_PATHS, VALUE_NAMES, type FlowEnvironment } from "./environment.ts";

/** An agent runtime as flows see it. `cleanup` runs after a run's end is recorded (ADR 0107). */
export interface FlowRuntime extends AgentRuntime<unknown, unknown> {
  cleanup?(handle: unknown): Promise<void>;
}

/** The task and credentials a run is started with (ADR 0102, ADR 0106 section 5, ADR 0107). */
export interface TaskSource {
  taskFor(run: Run): Promise<unknown>;
}

export type ApprovalAnswer = Omit<Decision, "id" | "recordedAt" | "projectId">;

/** How an approval page reply becomes a decision on its gate request. */
export interface ApprovalAnswers {
  answerFor(gate: GateRequest, reply: ApprovalReply): Promise<ApprovalAnswer>;
}

export interface FlowDeps extends ReconcileDeps {
  runtime: FlowRuntime;
  tasks: TaskSource;
  approvals: ApprovalAnswers;
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

/** The runner's GitHub reader. The runner App is registered at M3 (D-178); until then it refuses. */
function unregisteredGitHub(): GitHubReader {
  const refuse = async (): Promise<never> => {
    throw new GitHubNotConfiguredError();
  };
  return {
    getPullRequest: refuse,
    listChangedPaths: refuse,
    listCheckRuns: refuse,
    listOpenPullRequests: refuse,
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
    if (!p || !text(p.runtime) || !text(p.model) || !text(p.botVersion)) {
      throw new Error(`${VALUE_NAMES.botProfiles} has no complete profile for ${role}`);
    }
    profiles[role] = { runtime: p.runtime, model: p.model, botVersion: p.botVersion };
  }
  return profiles;
}

export async function compose(env: FlowEnvironment): Promise<FlowDeps> {
  const { contracts, problems } = validateContracts(
    loadContractFiles(await env.value(VALUE_NAMES.specVersion)).raw,
    GUARD_NAMES,
  );
  if (!contracts) throw new Error(`The contracts are invalid: ${problems.join("; ")}`);
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
          "A run's task file and credentials need the bot files and per-run token issuance (ADR 0102, M3.2)",
        );
      },
    },
    approvals: {
      answerFor: async () => {
        throw new NotBuiltError(
          "How an approval page reply becomes a decision is not decided yet (M3.1 report)",
        );
      },
    },
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
