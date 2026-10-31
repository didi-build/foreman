// Test support for the flows (build plan M3.1): the reconcile fixture's store, contracts, guards,
// clock, ids and fake GitHub, plus a fake agent runtime, a fake task source, a fake approval
// mapping and a Windmill execution count the test sets. Fake data only; nothing reaches Windmill,
// a cluster, a model or GitHub.
import type {
  AgentRunStatus,
  RunLimits,
} from "../../src/adapters/agent-runtime/runtime.ts";
import type { Run } from "../../src/core/store.ts";
import type { FlowDeps, FlowRuntime } from "../../flows/lib/compose.ts";
import { createReconcileFixture, HEAD } from "../reconcile-fixture.ts";

export { HEAD };

export interface FakeRuntime extends FlowRuntime {
  started: { task: unknown; limits: RunLimits }[];
  polled: unknown[];
  cleaned: unknown[];
  /** What `poll` reports for a run id; running when unset. */
  status: Map<string, AgentRunStatus>;
}

function createFakeRuntime(): FakeRuntime {
  const runtime: FakeRuntime = {
    started: [],
    polled: [],
    cleaned: [],
    status: new Map(),
    async start(task, limits) {
      runtime.started.push({ task, limits });
      return { runId: (task as { runId: string }).runId };
    },
    async poll(handle) {
      runtime.polled.push(handle);
      return (
        runtime.status.get((handle as { runId: string }).runId) ?? { state: "running" }
      );
    },
    async cancel() {},
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
  const tasksFor: string[] = [];
  let executions: number | null = 120;
  const deps: FlowDeps = {
    ...f.deps,
    runtime,
    tasks: {
      async taskFor(run: Run) {
        tasksFor.push(run.id);
        return { runId: run.id };
      },
    },
    // The decision conventions of docs/guards.md for a visual approval, as a test stand-in for
    // the mapping that is not decided yet.
    approvals: {
      async answerFor(gate, reply) {
        return {
          nodeId: gate.nodeId,
          kind: reply.approved ? "approval" : "answer",
          scope: { topicKey: gate.topicKey, outcome: reply.outcome },
          textVerbatim: reply.replyVerbatim ?? "",
          byActor: "didi",
        };
      },
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
    setExecutions: (count: number | null) => {
      executions = count;
    },
    footprint,
    live: () => f.setting("dry_run", false),
    killed: () => f.setting("kill_switch", true),
  };
}
