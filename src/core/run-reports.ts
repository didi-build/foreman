// The move a finished agent run asks for (build plan M3.2, ADR 0102, ADR 0107). When the runner
// has recorded a run's end as `success`, the agent has reported its work done: the Developer's
// work on a PR, the Designer's options, spec or components, QA's verdict. The runner then asks the
// library for the contract move out of the node's state that such a report triggers, and the
// contract's guards decide from evidence the runner recorded (essential 6). The agent's own words
// are never read here: only the run's end as the runner recorded it, and the node's state.
//
// Which moves a report triggers comes from the contracts, as for the dispatch move (run-start.ts):
// a move out of the node's state, for its track, in a state the run's role owns. Escalations, the
// prose fallbacks, the dispatch move and the moves on which the runner merges the PR are left out.
// When a state has more than one such move (QA's pass and fail), each is asked for in contract
// order and the guards let at most one through. A report counts only for the state the run worked
// in: if the node has moved since the run started, other than by the run's own dispatch move, the
// report is stale and asks for nothing. A move whose guards fail writes nothing: the item
// stays where it is, which is the contract's fallback. The failure counter half of that fallback
// is the P-03 rules, built with M3.5.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import {
  createLibrary,
  type Clock,
  type IdSource,
  type TransitionOutcome,
} from "./library.ts";
import { DISPATCH_GUARD } from "./run-start.ts";
import type { Node, Store } from "./store.ts";

/**
 * The guard of the moves on which the runner merges the PR after QA passes (contracts/machine-2).
 * The merge is built with M3.3 (D-218), so until then a QA pass does not move the item: moving it
 * to staging verification without the merge would skip the merge and its guards.
 */
export const MERGE_MOVE_GUARD = "qa_verdict_independent_on_head";

const ACTOR = { kind: "runner" as const, id: "run_end" };

export interface RunReportsOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/** Why no move was asked for. */
export type NoReportedMove =
  | "no_run"
  | "not_ended"
  | "not_success"
  | "no_node"
  | "not_owner"
  | "state_changed"
  | "no_move";

export type ReportedMove =
  | { requested: false; reason: NoReportedMove }
  | {
      requested: true;
      /** The library's outcome for the last move asked for. */
      outcome: TransitionOutcome;
      toState: string;
      reason?: string;
      transitionId?: string;
      /** The guards that failed, on every move asked for. */
      failedGuards: string[];
    };

/** The trigger id of the report a run made: one per run, so a repeated end moves once. */
export const reportTrigger = (runId: string) => ({
  kind: "bot_report" as const,
  ref: `run:${runId}`,
});

export function createRunReports(options: RunReportsOptions) {
  const { store, contracts } = options;
  const library = createLibrary(options);

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;

  /** The moves a report by `role` triggers from the node's state, in contract order. */
  function reportMoves(node: Node, role: string): TransitionContract[] {
    if (stateOf(node.state)?.owner?.toLowerCase() !== role) return [];
    return contracts.transitions.filter(
      (move) =>
        !move.escalation &&
        !move.fallbackMove &&
        move.from === node.state &&
        !move.guards.includes(DISPATCH_GUARD) &&
        !move.guards.includes(MERGE_MOVE_GUARD) &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  }

  return {
    reportMoves,

    /**
     * Asks for the move the run's report triggers, once its end is recorded. Each move goes
     * through `requestTransitionOnce` with the run's own trigger id, so a retried run-end flow
     * writes one transition row. The kill switch and dry run apply as for every move.
     */
    async requestReportedMove(runId: string): Promise<ReportedMove> {
      const run = await store.getRun(runId);
      if (!run) return { requested: false, reason: "no_run" };
      if (run.endedAt === null) return { requested: false, reason: "not_ended" };
      if (run.outcome !== "success") return { requested: false, reason: "not_success" };
      const node = run.nodeId ? await store.getNode(run.nodeId) : null;
      if (!node) return { requested: false, reason: "no_node" };
      const history = await store.listTransitions(node.id);
      const trigger = reportTrigger(run.id);
      // A report already taken, applied or dry run: the same row again, as requestTransitionOnce.
      const earlier = history.find(
        (past) => past.triggerKind === trigger.kind && past.triggerRef === trigger.ref,
      );
      if (earlier) {
        return {
          requested: true,
          outcome: "noop",
          toState: earlier.toState,
          reason: "duplicate_trigger",
          transitionId: earlier.id,
          failedGuards: [],
        };
      }
      if (stateOf(node.state)?.owner?.toLowerCase() !== run.bot) {
        return { requested: false, reason: "not_owner" };
      }
      const movedSince = history.some(
        (past) =>
          past.mode === "applied" &&
          past.at.getTime() >= run.startedAt.getTime() &&
          past.triggerRef !== `dispatch:${run.id}`,
      );
      if (movedSince) return { requested: false, reason: "state_changed" };
      const moves = reportMoves(node, run.bot);
      if (moves.length === 0) return { requested: false, reason: "no_move" };

      const failedGuards: string[] = [];
      let last: ReportedMove | undefined;
      for (const move of moves) {
        const result = await library.requestTransitionOnce({
          nodeId: node.id,
          toState: move.to,
          trigger,
          actor: ACTOR,
          reason: `${run.bot} run reported done`,
        });
        failedGuards.push(
          ...result.guardReport.filter((c) => !c.pass).map((c) => c.name),
        );
        last = {
          requested: true,
          outcome: result.outcome,
          toState: move.to,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.transitionId ? { transitionId: result.transitionId } : {}),
          failedGuards,
        };
        // Only a move the guards refused leaves room for the next one.
        if (result.outcome !== "rejected") break;
      }
      return last as ReportedMove;
    },
  };
}

export type RunReports = ReturnType<typeof createRunReports>;
