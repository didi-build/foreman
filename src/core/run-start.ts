// What the runner records around starting an agent run (build plan M3.2, ADR 0106 sections 5 to
// 7, ADR 0113). The core never starts a run itself: the runner admits it (`runs.dispatch`), starts
// it through the agent runtime adapter, and then reports the start here. That report is one
// transaction: the runtime's handle on the run, the `dispatch_record` naming the branch, and the
// move out of the dispatch state through the library, so the contract's guards apply and the move
// either happens with its evidence or not at all.
//
// The dispatch move of a node is the contract move out of its state that the dispatch guard
// (`agent_ready_not_on_hold`) guards, as in the reconcile pass. A node with no such move (QA in
// review, a Developer run resumed after `usage_exhausted` in In development) gets no move, only
// its handle and, for a role that pushes, a fresh `dispatch_record`.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import {
  createLibrary,
  type AlsoWrite,
  type Clock,
  type IdSource,
  type TransitionRequest,
} from "./library.ts";
import type { AgentRole, Evidence, Json, Node, Run, Store } from "./store.ts";
import { PUSHING_ROLES, runBranch } from "./task-input.ts";

/** The guard that marks a move as the dispatch of a ready node (contracts/machine-2). */
export const DISPATCH_GUARD = "agent_ready_not_on_hold";

const ACTOR = { kind: "runner" as const, id: "dispatch" };

export interface RunStartOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/** Whether a dispatch may go ahead before anything is written or started. */
export type StartCheck =
  { allowed: true } | { allowed: false; reason: string; failedGuards: string[] };

/**
 * What `recordStart` wrote. Not recorded means nothing was written, and the runner must stop the
 * run it started: `kill_switch`, `dry_run`, `run_ended` (the run was ended meanwhile, for example
 * by the kill switch's cancel pass), `guard_failed` and the library's other refusals.
 */
export type StartRecord =
  | { recorded: true; transitionId: string | null; dispatchRecordId: string | null }
  | { recorded: false; reason: string; failedGuards: string[] };

export function createRunStart(options: RunStartOptions) {
  const { store, contracts, clock, ids } = options;
  const library = createLibrary(options);

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;

  /** The node's dispatch move, when the role dispatched is its state's owner. */
  function dispatchMove(node: Node, role: string): TransitionContract | undefined {
    if (stateOf(node.state)?.owner?.toLowerCase() !== role) return undefined;
    return contracts.transitions.find(
      (move) =>
        !move.escalation &&
        move.from === node.state &&
        move.guards.includes(DISPATCH_GUARD) &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  }

  const moveRequest = (node: Node, move: TransitionContract, runId: string) => ({
    nodeId: node.id,
    toState: move.to,
    trigger: { kind: "event" as const, ref: `dispatch:${runId}` },
    actor: ACTOR,
  });

  async function nodeOf(nodeId: string | null): Promise<Node> {
    const node = nodeId ? await store.getNode(nodeId) : null;
    if (!node) throw new Error("the run has no node");
    return node;
  }

  return {
    /**
     * Checks the dispatch move's guards before anything is admitted or started, so a run is not
     * started only for its move to be refused. Reads only. A node without a dispatch move passes.
     */
    async checkStart(nodeId: string, role: AgentRole): Promise<StartCheck> {
      const node = await nodeOf(nodeId);
      const move = dispatchMove(node, role);
      if (!move) return { allowed: true };
      const check = await library.checkTransition(moveRequest(node, move, "check"));
      if (check.outcome === "allowed") return { allowed: true };
      return {
        allowed: false,
        reason: check.reason ?? check.outcome,
        failedGuards: check.guardReport.filter((c) => !c.pass).map((c) => c.name),
      };
    },

    /**
     * Records a started run: its handle, its `dispatch_record` when the role pushes a branch
     * (`{repo, branch}`, docs/guards.md), and its dispatch move, all in one transaction. The
     * handle is written only while the run has not ended. A refusal writes nothing.
     */
    async recordStart(run: Run, handle: Json): Promise<StartRecord> {
      const node = await nodeOf(run.nodeId);
      const project = await store.getProject(node.projectId);
      if (!project) throw new Error("the run's project does not exist");
      const evidence: Evidence | null = PUSHING_ROLES.includes(run.bot as AgentRole)
        ? {
            id: ids.next(),
            nodeId: node.id,
            runId: run.id,
            kind: "dispatch_record",
            ref: `dispatch:${run.id}`,
            commitSha: null,
            payload: { repo: project.repo, branch: runBranch(node.id) },
            recordedBy: "runner",
            recordedAt: clock.now(),
            supersedesId: null,
          }
        : null;
      const writes: AlsoWrite = async (tx) => {
        if (!(await tx.setRunHandle(run.id, handle))) return "run_ended";
        if (evidence) await tx.insertEvidence(evidence);
        return null;
      };
      const recorded = (transitionId: string | null): StartRecord => ({
        recorded: true,
        transitionId,
        dispatchRecordId: evidence?.id ?? null,
      });

      const move = dispatchMove(node, run.bot);
      if (move) {
        if (move.evidence?.includes("dispatch_record") && !evidence) {
          return { recorded: false, reason: "no_dispatch_record", failedGuards: [] };
        }
        const request: TransitionRequest = {
          ...moveRequest(node, move, run.id),
          evidenceIds: evidence ? [evidence.id] : [],
          reason: "agent run started",
        };
        const result = await library.requestTransitionWith(request, writes);
        if (result.outcome === "applied") return recorded(result.transitionId ?? null);
        return {
          recorded: false,
          reason: result.reason ?? result.outcome,
          failedGuards: result.guardReport.filter((c) => !c.pass).map((c) => c.name),
        };
      }

      // No move: the same switches the library reads, inside the transaction that writes.
      const reason = await store
        .transaction(async (tx) => {
          if ((await tx.getSetting("kill_switch"))?.value === true)
            return "kill_switch";
          if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
          const refusal = await writes(tx);
          if (refusal) throw new StartRefused(refusal);
          return null;
        })
        .catch((error: unknown) => {
          if (error instanceof StartRefused) return error.reason;
          throw error;
        });
      return reason === null
        ? recorded(null)
        : { recorded: false, reason, failedGuards: [] };
    },
  };
}

/** Rolls back the no-move transaction when a write refuses. */
class StartRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export type RunStart = ReturnType<typeof createRunStart>;
