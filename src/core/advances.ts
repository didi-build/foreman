// Advance from evidence (architecture section 2.5 step 4, D-274, D-329 slice 4, O-104). A node
// advances from evidence when its state has a move guarded by `ci_green_on_head` for its track,
// other than a move on which the runner merges (`qa_verdict_independent_on_head`, the merge
// step's own, ./merge.ts), and that move's guards pass now: In development and Building
// components into In QA review, after which QA's run starts on the head. Which moves those are
// comes from the contracts (`advanceMovesFor`), never from a list of states here.
//
// One list of moves and one request, so the event and the pass cannot drift: the reconcile pass
// plans each such move in its step 4 (./reconcile.ts), the called flow `f/foreman/advance_item`
// plans one item's advance with the pass's own code and acts on it as the pass does
// (`advanceItem` in flows/lib/reconcile-steps.ts), and the ingest flow asks `due` after it
// records CI's end on a PR head, before it takes that step in its own run
// (flows/lib/ingest-delivery.ts, O-128). Every one asks the library with the pass's own trigger
// and actor, so the guards decide the same way on every path.
//
// `due` reads the kill switch and dry run first, as every flow reads them, then the node and the
// move's guards through the library, and writes nothing. The ingest flow runs it as the runner's
// role. Until O-128 the receiver ran it as its own role `factory_ingest` (migrations 0002 and
// 0020), which cannot read decisions: on a design item whose head QA already reported on, the
// guard `no_failed_qa_verdict_on_head` reads Didi's approved option, so the check threw there and
// the reconcile pass decided (O-104). The runner reads it, so the same check now decides that case
// at once. Plain logic over an injected store, contracts, guards, clock and id source (D-162).
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import { createLibrary, type Clock, type IdSource, type Trigger } from "./library.ts";
import { MERGE_MOVE_GUARD } from "./merge.ts";
import type { Node, Store } from "./store.ts";

/** The guard section 2.5 step 4 advances on: CI green on the head commit. */
export const ADVANCE_GUARD = "ci_green_on_head";

/** The pass's own actor and trigger, on every path that asks for an advance (O-103, O-104). */
export const ADVANCE_ACTOR = { kind: "runner" as const, id: "reconcile" };
export const ADVANCE_TRIGGER: Trigger = { kind: "reconcile", ref: null };

/** The advance moves out of the node's state, for its track, in contract order. */
export function advanceMovesFor(
  contracts: Contracts,
  node: Node,
): TransitionContract[] {
  const state = Object.hasOwn(contracts.states, node.state)
    ? contracts.states[node.state]
    : undefined;
  if (state?.escalated) return [];
  return contracts.transitions.filter(
    (move) =>
      !move.escalation &&
      move.from === node.state &&
      (!move.tracks || (node.track !== null && move.tracks.includes(node.track))) &&
      move.guards.includes(ADVANCE_GUARD) &&
      !move.guards.includes(MERGE_MOVE_GUARD),
  );
}

export interface AdvancesOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/** Whether an advance from evidence is due on a node now, and if not, why. */
export type AdvanceDue =
  | { due: true; nodeId: string; toState: string }
  | {
      due: false;
      nodeId: string;
      reason: "kill_switch" | "dry_run" | "no_node" | "no_advance_move";
    }
  | { due: false; nodeId: string; reason: "guard_failed"; failedGuards: string[] };

export function createAdvances(options: AdvancesOptions) {
  const { store, contracts } = options;
  const library = createLibrary(options);

  return {
    /**
     * Whether the advance is due: neither switch holds the runner, and the guards of one of the
     * node's advance moves pass now. Reads only.
     */
    async due(nodeId: string): Promise<AdvanceDue> {
      if ((await store.getSetting("kill_switch"))?.value === true) {
        return { due: false, nodeId, reason: "kill_switch" };
      }
      // A missing setting means dry run, as in the library.
      if ((await store.getSetting("dry_run"))?.value !== false) {
        return { due: false, nodeId, reason: "dry_run" };
      }
      const node = await store.getNode(nodeId);
      if (!node) return { due: false, nodeId, reason: "no_node" };
      const moves = advanceMovesFor(contracts, node);
      if (moves.length === 0) return { due: false, nodeId, reason: "no_advance_move" };
      const failedGuards: string[] = [];
      for (const move of moves) {
        const check = await library.checkTransition({
          nodeId,
          toState: move.to,
          trigger: ADVANCE_TRIGGER,
          actor: ADVANCE_ACTOR,
        });
        if (check.outcome === "allowed") return { due: true, nodeId, toState: move.to };
        failedGuards.push(
          ...check.guardReport.filter((c) => !c.pass).map((c) => c.name),
        );
      }
      return { due: false, nodeId, reason: "guard_failed", failedGuards };
    },
  };
}

export type Advances = ReturnType<typeof createAdvances>;
