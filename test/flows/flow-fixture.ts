// Test support for the flows (build plan M3.1, M3.2): the reconcile fixture's store, contracts,
// guards, clock, ids and fake GitHub, plus a fake agent runtime, a fake task source, generated
// state API tokens and a Windmill execution count the test sets. Fake data only; nothing reaches
// Windmill, a cluster, a model or GitHub.
import { randomBytes } from "node:crypto";

import type {
  AgentRunStatus,
  RunLimits,
} from "../../src/adapters/agent-runtime/runtime.ts";
import type { FlowDeps, FlowRuntime, RunToStart } from "../../flows/lib/compose.ts";
import { createReconcileFixture, HEAD } from "../reconcile-fixture.ts";

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

export async function createFlowFixture() {
  const f = await createReconcileFixture();
  const runtime = createFakeRuntime();
  const tasksFor: RunToStart[] = [];
  const tokens: string[] = [];
  let executions: number | null = 120;
  const deps: FlowDeps = {
    ...f.deps,
    runtime,
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
    tasksFor,
    tokens,
    setExecutions: (count: number | null) => {
      executions = count;
    },
    footprint,
    live: () => f.setting("dry_run", false),
    killed: () => f.setting("kill_switch", true),
  };
}
