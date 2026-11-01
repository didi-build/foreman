// Builder runs due without a move (build plan M3.2, D-213, D-220, O-41). The dispatch move
// (`agent_ready_not_on_hold`) starts the first Developer or Designer run on an item. When QA fails
// a round, or the staging check or deploy fails, the fail move sends the item back to the building
// state (In development, Building components) and nothing moved it there by a dispatch, so no run
// would start. This finds such items, and the item whose builder run ended `usage_exhausted`, so
// the runner can start the run with no move (src/core/run-start.ts writes only the handle and a
// fresh `dispatch_record` on the item's one branch, D-220). It also reads why the item came back,
// for the run's input (src/core/task-input.ts).
//
// Which states and moves count comes from the contracts, never from a list of state names: the
// building state is one whose owner is a role that pushes a branch (Developer, Designer), and a
// fail move is a move into it guarded by `qa_failed_with_findings` (QA's fail) or
// `staging_check_failed` (the staging fail path). Plain logic over an injected store, contracts,
// guards, clock and id source (D-162). It reads only: the runner starts the run through the
// dispatch flow, and admission (src/core/runs.ts) still decides, under its lock, with the kill
// switch, the limits and the usage-exhausted wait.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import { readQaVerdict } from "./guards/evidence.ts";
import { COUNCIL_TRIGGER, DIDI_TRIGGER } from "./escalations.ts";
import { failureCountKey } from "./failures.ts";
import { createLibrary, type Clock, type IdSource } from "./library.ts";
import { QA_FAIL_GUARD } from "./run-reports.ts";
import { DISPATCH_GUARD } from "./run-start.ts";
import { ESCALATION_GUARD, STAGING_FAIL_GUARD } from "./staging.ts";
import type { AgentRole, Evidence, Json, Node, Store, Transition } from "./store.ts";
import { PUSHING_ROLES, type ReturnReason } from "./task-input.ts";

/** The guards that mark a move as one that sends the item back to be fixed. */
export const RETURN_GUARDS: readonly string[] = [QA_FAIL_GUARD, STAGING_FAIL_GUARD];

const ACTOR = { kind: "runner" as const, id: "dispatch" };

export interface BuilderRunsOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/**
 * Why a builder run is due: `returned`, a fail move sent the item back and no run of the role
 * started since; `resumed`, the item's latest started run is the role's and ended
 * `usage_exhausted`, and admission then applies the wait (src/core/runs.ts); `refused`, the item's
 * latest started run is the role's, its done report was refused on its guards and counted toward
 * `failure` (P-03, M3.5, O-43), so the fix round goes on, bounded by the escalation.
 */
export type BuilderRunCause = "returned" | "resumed" | "refused";

export type BuilderRunCheck =
  | { due: true; nodeId: string; role: AgentRole; cause: BuilderRunCause }
  | {
      due: false;
      nodeId: string;
      reason:
        | "no_node"
        /** Not a building state: its owner does not push a branch, or it has a dispatch move. */
        | "not_building"
        /** On hold, not agent-ready, or escalated (schema invariant 6). */
        | "not_dispatchable"
        /** A run on the item is active, of any role: a QA run still at work, say. */
        | "active_run"
        /** The guards allow the escalation: the item belongs to the Council, not to a new run. */
        | "escalation_due"
        /** Not sent back since the role's last run, and that run did not end usage_exhausted. */
        | "not_due";
    };

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;
const text = (value: Json | undefined): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export function createBuilderRuns(options: BuilderRunsOptions) {
  const { store, contracts } = options;
  const library = createLibrary(options);

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;
  const trackMatches = (move: TransitionContract, node: Node): boolean =>
    !move.tracks || (node.track !== null && move.tracks.includes(node.track));
  const escalationMove = contracts.transitions.find(
    (m) => m.escalation && m.from === "any" && m.guards.includes(ESCALATION_GUARD),
  );

  /** The building role of the node's state: its owner, when that role pushes a branch. */
  function buildingRole(node: Node): AgentRole | null {
    const owner = stateOf(node.state)?.owner?.toLowerCase();
    const role = PUSHING_ROLES.find((r) => r === owner) ?? null;
    if (!role) return null;
    // A state with a dispatch move (Ready for dev) is dispatched by that move, not here.
    const hasDispatchMove = contracts.transitions.some(
      (m) =>
        !m.escalation &&
        m.from === node.state &&
        m.guards.includes(DISPATCH_GUARD) &&
        trackMatches(m, node),
    );
    return hasDispatchMove ? null : role;
  }

  /**
   * The move that sent the node back into its current state, when the node's latest applied
   * transition is one: a fail move (a contract move into this state, for its track, guarded by a
   * return guard), or the way back out of an escalation (`to: return`, M3.5), after which the
   * work goes on where it was escalated from.
   */
  async function returnMove(node: Node): Promise<Transition | null> {
    const last = (await store.listTransitions(node.id))
      .filter((t) => t.mode === "applied")
      .at(-1);
    if (!last || last.toState !== node.state) return null;
    const isReturn = contracts.transitions.some(
      (m) =>
        m.from === last.fromState &&
        trackMatches(m, node) &&
        (m.escalation
          ? m.to === "return"
          : m.to === last.toState && m.guards.some((g) => RETURN_GUARDS.includes(g))),
    );
    return isReturn ? last : null;
  }

  /** The Council's decision or Didi's answer a move out of an escalation names (escalations.ts). */
  async function escalationAnswer(back: Transition): Promise<ReturnReason | null> {
    const ref = back.triggerRef ?? "";
    const by = ref.startsWith(COUNCIL_TRIGGER)
      ? "council"
      : ref.startsWith(DIDI_TRIGGER)
        ? "didi"
        : null;
    if (!by) return null;
    const decision = await store.getDecision(ref.slice(ref.indexOf(":") + 1));
    return { kind: "escalation_resolved", by, note: decision?.textVerbatim ?? null };
  }

  /** The `failure_count` row of a refused done report by this run, if one was counted. */
  async function refusedReport(
    node: Node,
    runId: string,
  ): Promise<Evidence | undefined> {
    const key = failureCountKey("report_refused", runId);
    return (await store.listEvidence({ nodeId: node.id, kind: "failure_count" })).find(
      (e) => e.runId === runId && e.ref === key,
    );
  }

  /** Whether the guards would let the item escalate now (`escalation_trigger_met`). */
  async function escalationDue(node: Node): Promise<boolean> {
    if (!escalationMove) return false;
    const check = await library.checkTransition({
      nodeId: node.id,
      toState: escalationMove.to,
      blockedReason: "check only",
      trigger: { kind: "reconcile", ref: null },
      actor: ACTOR,
    });
    return check.outcome === "allowed";
  }

  async function check(nodeId: string): Promise<BuilderRunCheck> {
    const node = await store.getNode(nodeId);
    if (!node) return { due: false, nodeId, reason: "no_node" };
    const role = buildingRole(node);
    if (!role) return { due: false, nodeId, reason: "not_building" };
    if (!library.canDispatch(node)) {
      return { due: false, nodeId, reason: "not_dispatchable" };
    }
    const runs = await store.listRuns({ nodeId });
    if (runs.some((r) => r.endedAt === null)) {
      return { due: false, nodeId, reason: "active_run" };
    }
    // A builder run counts once its start was recorded with its `dispatch_record` (O-17). A run
    // that never started (its task or start failed, or its start record was refused) does not,
    // so the next trigger tries again.
    const recorded = new Set(
      (await store.listEvidence({ nodeId, kind: "dispatch_record" })).map(
        (e) => e.runId,
      ),
    );
    const started = runs.filter(
      (r) => !PUSHING_ROLES.includes(r.bot as AgentRole) || recorded.has(r.id),
    );
    let cause: BuilderRunCause | null = null;
    const back = await returnMove(node);
    if (
      back &&
      !started.some((r) => r.bot === role && r.startedAt.getTime() >= back.at.getTime())
    ) {
      cause = "returned";
    } else {
      const latest = started.at(-1);
      if (latest?.bot === role && latest.outcome === "usage_exhausted")
        cause = "resumed";
      else if (latest?.bot === role && (await refusedReport(node, latest.id)))
        cause = "refused";
    }
    if (!cause) return { due: false, nodeId, reason: "not_due" };
    if (await escalationDue(node)) {
      return { due: false, nodeId, reason: "escalation_due" };
    }
    return { due: true, nodeId, role, cause };
  }

  /** The evidence the fail move carried, of the kinds that say why. */
  async function reasonFrom(node: Node, back: Transition): Promise<ReturnReason> {
    const answered = await escalationAnswer(back);
    if (answered) return answered;
    const carried = new Set(back.evidenceIds);
    const rows: Evidence[] = [];
    for (const kind of [
      "qa_verdict",
      "staging_check",
      "staging_deploy_failed",
    ] as const) {
      rows.push(
        ...(await store.listEvidence({ nodeId: node.id, kind })).filter((e) =>
          carried.has(e.id),
        ),
      );
    }
    const evidence = rows
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
      .at(-1);
    if (!evidence) return { kind: "not_recorded" };
    if (evidence.kind === "qa_verdict") {
      const verdict = readQaVerdict(evidence.payload);
      if (!verdict || verdict.verdict !== "fail") return { kind: "not_recorded" };
      return {
        kind: "qa_fail",
        commitSha: evidence.commitSha,
        findings: verdict.findings,
      };
    }
    if (evidence.kind === "staging_check") {
      return {
        kind: "staging_check_failed",
        mergeCommitSha: evidence.commitSha,
        servedCommitSha: text(field(evidence.payload, "servedCommitSha")),
      };
    }
    return {
      kind: "staging_deploy_failed",
      mergeCommitSha: evidence.commitSha,
      deployedSha: text(field(evidence.payload, "deployedSha")),
      deployState: text(field(evidence.payload, "state")),
    };
  }

  return {
    /** Whether a builder run is due on the node now, and for which role. Reads only. */
    check,

    /** Every node a builder run is due on now, in the store's node order. Reads only. */
    async listDue(): Promise<Extract<BuilderRunCheck, { due: true }>[]> {
      const due: Extract<BuilderRunCheck, { due: true }>[] = [];
      for (const node of await store.listNodes({})) {
        const result = await check(node.id);
        if (result.due) due.push(result);
      }
      return due;
    },

    /**
     * Why the item came back, for the builder's input: from the evidence the fail move that sent
     * it into its current state carried. When the role's latest run reported done and the report
     * was refused (O-43), that comes first, with the checks that failed, and the fail move's reason
     * after it. Null when neither is how it got here (a first run).
     */
    async returnReason(nodeId: string): Promise<ReturnReason | null> {
      const node = await store.getNode(nodeId);
      const role = node ? buildingRole(node) : null;
      if (!node || !role) return null;
      const back = await returnMove(node);
      const earlier = back ? await reasonFrom(node, back) : null;
      const latest = (await store.listRuns({ nodeId }))
        .filter((r) => r.bot === role)
        .at(-1);
      const refused = latest ? await refusedReport(node, latest.id) : undefined;
      if (!refused) return earlier;
      const guards = field(refused.payload, "failedGuards");
      return {
        kind: "report_refused",
        failedGuards: Array.isArray(guards)
          ? guards.filter((g): g is string => typeof g === "string")
          : [],
        commitSha: refused.commitSha,
        earlier,
      };
    },
  };
}

export type BuilderRuns = ReturnType<typeof createBuilderRuns>;
