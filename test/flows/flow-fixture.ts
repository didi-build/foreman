// Test support for the flows (build plan M3.1, M3.2): the reconcile fixture's store, contracts,
// guards, clock, ids and fake GitHub, plus a fake agent runtime, a fake task source, a fake read
// of CI's `qa-site` builds, generated state API tokens and a Windmill execution count the test
// sets. Fake data only; nothing reaches
// Windmill, a cluster, a model or GitHub.
import { randomBytes } from "node:crypto";

import type {
  AgentRunStatus,
  RunLimits,
} from "../../src/adapters/agent-runtime/runtime.ts";
import {
  windmillGitHubAppTokens,
  type FlowDeps,
  type FlowRuntime,
  type RunToStart,
} from "../../flows/lib/compose.ts";
import {
  createFakeStagingBuilds,
  createFakeClusterTarget,
  createFakeStagingTarget,
  type FakeStagingBuilds,
  type FakeClusterTarget,
  type FakeStagingTarget,
} from "../../src/adapters/deploy/fake.ts";
import { createFakePublicNames } from "../../src/adapters/dns/fake.ts";
import { createFakeShortLivedVariables } from "../../src/adapters/windmill/fake-short-lived-variables.ts";
import { createFakeBootstrap } from "../../src/adapters/github/bootstrap-fake.ts";
import {
  createFakeProjectRepositories,
  createFakeProjectSettings,
  createFakeProjectWorkflows,
} from "../../src/adapters/github/new-project-fake.ts";
import {
  createFakeRepoMaps,
  createFakeRepoScans,
} from "../../src/adapters/repo-map/fake.ts";
import {
  createFakeRepoFolders,
  createFakeScreenshotBundles,
} from "../../src/adapters/screenshots/fake.ts";
import type {
  AddOnlyApplies,
  AddOnlyApplyJob,
} from "../../src/core/add-only-applies.ts";
import type {
  ClusterReleases,
  ImagesBuild,
  PlatformApplied,
} from "../../src/core/cluster-release.ts";
import type { QaSiteRead, QaSites } from "../../src/core/qa-site.ts";
import type { ReconcileDeps } from "../../src/core/reconcile.ts";
import type { StagingChecker } from "../../src/core/staging.ts";
import { createReconcileFixture, HEAD } from "../reconcile-fixture.ts";
import { createFakeStagingChecker } from "../staging-fixture.ts";
import { createFakeModelEval } from "./model-eval-fake.ts";

export { HEAD };

export interface FakeRuntime extends FlowRuntime {
  started: { task: unknown; limits: RunLimits }[];
  polled: unknown[];
  cancelled: unknown[];
  cleaned: unknown[];
  /** What `poll` reports for a run id; running when unset. */
  status: Map<string, AgentRunStatus>;
  /** Makes the next `start` or `cancel` fail. */
  failNext: Set<"start" | "cancel">;
  /** Runs before `start` returns, to change the store while a run is starting. */
  duringStart?: () => Promise<void>;
}

function createFakeRuntime(): FakeRuntime {
  const fail = (step: "start" | "cancel") => {
    if (!runtime.failNext.delete(step)) return;
    throw new Error(`the fake runtime refused to ${step}`);
  };
  const runtime: FakeRuntime = {
    started: [],
    polled: [],
    cancelled: [],
    cleaned: [],
    status: new Map(),
    failNext: new Set(),
    async start(task, limits) {
      fail("start");
      runtime.started.push({ task, limits });
      await runtime.duringStart?.();
      return { runtime: "fake", runId: (task as { runId: string }).runId };
    },
    async poll(handle) {
      runtime.polled.push(handle);
      return (
        runtime.status.get((handle as { runId: string }).runId) ?? { state: "running" }
      );
    },
    async cancel(handle) {
      fail("cancel");
      runtime.cancelled.push(handle);
    },
    async cleanup(handle) {
      runtime.cleaned.push(handle);
    },
  };
  return runtime;
}

export type FlowFixture = Awaited<ReturnType<typeof createFlowFixture>>;

/** The add-only apply jobs the daily check reads from GitHub (O-158), as the test sets them. */
export interface FakeAddOnlyApplies extends AddOnlyApplies {
  jobs: AddOnlyApplyJob[];
  /** Makes the read throw, as a refused token or a failed call would. */
  fail: boolean;
  /** The window start each read was asked for. */
  reads: Date[];
}

function createFakeAddOnlyApplies(): FakeAddOnlyApplies {
  const fake: FakeAddOnlyApplies = {
    jobs: [],
    fail: false,
    reads: [],
    async jobsSince(since) {
      fake.reads.push(since);
      if (fake.fail) throw new Error("the fake GitHub refused the read");
      return fake.jobs;
    },
  };
  return fake;
}

/** CI's `qa-site` builds for QA's browser (ADR 0119 slice 5c), as the test sets them. */
export interface FakeQaSites extends QaSites {
  /** What a read gives, by `repo#workflowRunId`; none kept when unset. */
  sites: Map<string, QaSiteRead>;
  /** Each read, as `repo#workflowRunId`. */
  reads: string[];
}

function createFakeQaSites(): FakeQaSites {
  const fake: FakeQaSites = {
    sites: new Map(),
    reads: [],
    async read(repo, workflowRunId) {
      const key = `${repo}#${workflowRunId}`;
      fake.reads.push(key);
      return fake.sites.get(key) ?? { found: false, reason: "missing" };
    },
  };
  return fake;
}

/** Foreman's newest build and apply the daily check reads from GitHub (O-166), as the test sets them. */
export interface FakeClusterReleases extends ClusterReleases {
  build: ImagesBuild | null;
  applied: PlatformApplied | null;
  /** Makes each read throw, as a refused token or a failed call would. */
  fail: boolean;
  /** The repositories each read was asked for. */
  reads: string[];
}

function createFakeClusterReleases(): FakeClusterReleases {
  const fake: FakeClusterReleases = {
    build: null,
    applied: null,
    fail: false,
    reads: [],
    async latestBuild(repo) {
      fake.reads.push(repo);
      if (fake.fail) throw new Error("the fake GitHub refused the read");
      return fake.build;
    },
    async latestApplied(repo) {
      fake.reads.push(repo);
      if (fake.fail) throw new Error("the fake GitHub refused the read");
      return fake.applied;
    },
  };
  return fake;
}

/**
 * The composition's real GitHub App token ports (O-125) with no App key stored: each App's first
 * token fails on reading its key, so nothing is signed or sent. Its HTTP ports refuse and record,
 * so a test can check that nothing was sent.
 */
export function appTokensWithoutKeys() {
  const sent: string[] = [];
  const tokens = windmillGitHubAppTokens(
    {
      secret: async (path) => {
        throw new Error(`${path} is not stored`);
      },
      value: async () => "1001",
    },
    { now: () => new Date(0) },
    {
      get: {
        get: async (request) => {
          sent.push(request.path);
          throw new Error("no network in tests");
        },
      },
      post: {
        post: async (request) => {
          sent.push(request.path);
          throw new Error("no network in tests");
        },
      },
    },
  );
  return { ...tokens, sent };
}

/**
 * The flow parts around a fixture's core deps: a fake runtime, a fake task source that keeps
 * what each start was given, generated tokens and a Windmill execution count the test sets.
 */
export function flowDepsFor(
  base: ReconcileDeps,
  stagingChecker: StagingChecker = createFakeStagingChecker(),
  staging: {
    builds?: FakeStagingBuilds;
    target?: FakeStagingTarget;
    cluster?: FakeClusterTarget;
  } = {},
) {
  const runtime = createFakeRuntime();
  const stagingBuilds = staging.builds ?? createFakeStagingBuilds();
  const stagingTarget = staging.target ?? createFakeStagingTarget();
  const clusterTarget = staging.cluster ?? createFakeClusterTarget();
  const clusterReleases = createFakeClusterReleases();
  const shortLivedVariables = createFakeShortLivedVariables();
  const screenshots = createFakeScreenshotBundles();
  const repoFolders = createFakeRepoFolders();
  const repoMaps = createFakeRepoMaps();
  const qaSites = createFakeQaSites();
  const repoScans = createFakeRepoScans();
  const projectSettings = createFakeProjectSettings();
  const projectWorkflows = createFakeProjectWorkflows();
  const publicNames = createFakePublicNames();
  const projectRepositories = createFakeProjectRepositories();
  // One fake for both ports, so a grant, a restart and a removal see the same state (O-114).
  const bootstrap = createFakeBootstrap();
  const addOnlyApplies = createFakeAddOnlyApplies();
  const modelEval = createFakeModelEval();
  const tasksFor: RunToStart[] = [];
  const tokens: string[] = [];
  let executions: number | null = 120;
  const deps: FlowDeps = {
    ...base,
    runtime,
    stagingChecker,
    stagingBuilds,
    deployTargets: { cloudflare: stagingTarget, cluster: clusterTarget },
    clusterReleases,
    shortLivedVariables,
    screenshots,
    repoFolders,
    repoMaps,
    qaSites,
    repoScans,
    projectSettings,
    projectWorkflows,
    publicNames,
    projectRepositories,
    bootstrapAccess: bootstrap,
    bootstrapRuns: bootstrap,
    addOnlyApplies,
    modelEval,
    // The task is what the fake runtime gets: the run's id, model and provider, and its token.
    tasks: {
      async taskFor(start) {
        tasksFor.push(start);
        return {
          runId: start.run.id,
          model: start.run.model,
          provider: start.run.provider,
          stateApiToken: start.stateApiToken,
        };
      },
    },
    // Generated per test run, never logged and never in an assertion message.
    newRunToken: () => {
      const token = randomBytes(32).toString("base64url");
      tokens.push(token);
      return token;
    },
    async executionsThisMonth() {
      if (executions === null) throw new Error("no Windmill token");
      return executions;
    },
    async close() {},
  };
  return {
    deps,
    runtime,
    stagingBuilds,
    stagingTarget,
    clusterTarget,
    clusterReleases,
    shortLivedVariables,
    screenshots,
    repoFolders,
    repoMaps,
    qaSites,
    repoScans,
    projectSettings,
    projectWorkflows,
    publicNames,
    projectRepositories,
    bootstrap,
    addOnlyApplies,
    modelEval,
    tasksFor,
    tokens,
    setExecutions: (count: number | null) => {
      executions = count;
    },
  };
}

export async function createFlowFixture() {
  const f = await createReconcileFixture();
  const stagingChecker = createFakeStagingChecker();
  const {
    deps,
    runtime,
    stagingBuilds,
    stagingTarget,
    clusterTarget,
    clusterReleases,
    shortLivedVariables,
    screenshots,
    repoFolders,
    repoMaps,
    qaSites,
    repoScans,
    projectSettings,
    projectWorkflows,
    publicNames,
    projectRepositories,
    bootstrap,
    addOnlyApplies,
    modelEval,
    tasksFor,
    tokens,
    setExecutions,
  } = flowDepsFor(f.deps, stagingChecker);

  /** What a flow could have written for these nodes, to compare before and after. */
  async function footprint(...nodeIds: string[]) {
    return JSON.stringify({
      nodes: await Promise.all(nodeIds.map((id) => f.store.getNode(id))),
      transitions: await f.transitions(...nodeIds),
      runs: await Promise.all(nodeIds.map((id) => f.store.listRuns({ nodeId: id }))),
      decisions: await Promise.all(
        nodeIds.map((id) => f.store.listDecisionsForNode(id)),
      ),
      gates: await f.store.listOpenGateRequests(f.projectId),
    });
  }

  return {
    ...f,
    deps,
    runtime,
    stagingChecker,
    stagingBuilds,
    stagingTarget,
    clusterTarget,
    clusterReleases,
    shortLivedVariables,
    screenshots,
    repoFolders,
    repoMaps,
    qaSites,
    repoScans,
    projectSettings,
    projectWorkflows,
    publicNames,
    projectRepositories,
    bootstrap,
    addOnlyApplies,
    modelEval,
    tasksFor,
    tokens,
    setExecutions,
    footprint,
    live: () => f.setting("dry_run", false),
    killed: () => f.setting("kill_switch", true),
  };
}
