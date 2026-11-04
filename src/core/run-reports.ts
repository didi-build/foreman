// The move a finished agent run asks for (build plan M3.2, ADR 0102, ADR 0107). When the runner
// has recorded a run's end as `success`, the agent has reported its work done: the Developer's
// work on a PR, the Designer's options, spec or components, QA's verdict. The runner then asks the
// library for the contract move out of the node's state that such a report triggers, and the
// contract's guards decide from evidence the runner recorded (essential 6). The agent's own words
// are never read here: only the run's end as the runner recorded it, and the node's state.
//
// Which moves a report triggers comes from the contracts, as for the dispatch move (run-start.ts):
// a move out of the node's state, for its track, in a state the run's role owns. Escalations, the
// prose fallbacks and the dispatch move are left out. A move on which the runner merges the PR
// (QA's pass, guard `qa_verdict_independent_on_head`) goes through the merge (src/core/merge.ts,
// M3.3): the merge guard decides, the runner squash-merges, and only then is the move written.
// When a state has more than one such move (QA's pass and fail), each is asked for in contract
// order and the guards let at most one through. A report counts only for the state the run worked
// in: if the node has moved since the run started, other than by the run's own dispatch move, the
// report is stale and asks for nothing. A move whose guards fail writes nothing: the item
// stays where it is, which is the contract's fallback.
//
// QA's fail (P-03, D-169, O-41): the fail move adds one to `qa_round` and to `failure` in the same
// transaction, then asks for the escalation, which the guards allow once `failure` reaches
// `failure_threshold`. The third failed round is refused by `not_third_failed_round`, and goes to
// Escalated to Council instead, counted in the escalation's own transaction (the guard
// `escalation_trigger_met` names that round). Both take the run's trigger id, so a repeated report
// counts once; a repeated report after the fail move asks again for an escalation it left behind.
// Dry run writes the rows as dry run and no counter.
//
// A refused done report (P-03, M3.5, O-43): when the report of a role that pushes a branch
// (Developer, Designer) finds every move it triggers refused by the guards, `failure` goes up by
// one, once per report (src/core/failures.ts), and the escalation is asked for. That includes a
// done report on a head QA already failed, which `no_failed_qa_verdict_on_head` refuses (O-42).
// Three refusals do not count: CI still `pending` on the head (no result yet, not a failure; the
// report counts if it is asked for again once CI is red), a refusal by `scope_matches_plan`
// alone (a scope change, which the contract sends to the Council, not to the counter), and a
// refusal by `options_attached` alone (the Designer's options are captured by the runner once CI
// has rendered them, after the report; the capture then asks for the same report's move again,
// src/core/option-capture.ts, O-88). When the capture itself refuses for a reason the Designer
// caused, the capture counts that, once per head (src/core/failures.ts, O-89). A QA run's
// report never counts: a merge waiting on a condition is not a failure.
//
// QA's visual comparison (D-252): a `differs` record passes `qa_failed_with_findings`, so the
// visual run's report takes QA's fail move like a fail verdict. A visual run that could not tell
// asks for the escalation after its moves are refused; the guards allow it only on the second
// `cannot_tell` on the head in the current state, and refuse it, writing nothing, on the first.
//
// Option folders Didi did not approve (D-259): when QA's report finds the merge refused because
// the PR still carries such folders (`unpicked_options_removed`), `qa_failed_with_findings`
// passes too, so the same report goes on to QA's fail move in contract order, counted and
// escalated at the cap as above, with the run's trigger. When the check fails closed for missing
// data, the fail move is refused as well and the item stays In QA review (the merge's fallback).
//
// A builder that stopped because the item needs a decision (D-237, O-63): the run ended `success`
// with its reason, and the run-end flow records that reason with `recordNeedsDecision` before the
// end, as an `agent_report` asking to escalate, the form `escalation_trigger_met` already reads
// ("a bot asked"). The report then asks for the escalation to the Council (D-177) with the run's
// trigger instead of the done move, so nothing is counted toward `failure` and no fix round
// starts. The Council decides; when it decides Didi is needed, the item goes on to Didi (M3.5).
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import type { GitHub } from "./github.ts";
import {
  createLibrary,
  type AlsoWrite,
  type Clock,
  type IdSource,
  type Trigger,
  type TransitionOutcome,
} from "./library.ts";
import { createEscalations, type EscalationMove } from "./escalations.ts";
import { createFailures, type FailureCount } from "./failures.ts";
import { REDO_GUARD } from "./guards/council.ts";
import { headCommit, readCiRun, readVisualComparison } from "./guards/evidence.ts";
import { createMerges, MERGE_MOVE_GUARD } from "./merge.ts";
import { OPTIONS_GUARD } from "./option-capture.ts";
import { DISPATCH_GUARD } from "./run-start.ts";
import type { AgentRole, CounterKind, Evidence, Node, Run, Store } from "./store.ts";
import { PUSHING_ROLES } from "./task-input.ts";
import { VISUAL_TASK_TYPE } from "./visual-comparison.ts";

export { MERGE_MOVE_GUARD };

/** The guard of QA's fail move (contracts/machine-2): the verdict lists findings. */
export const QA_FAIL_GUARD = "qa_failed_with_findings";
/** The guard on QA's fail move that refuses the round that reaches the cap. */
export const ROUND_CAP_GUARD = "not_third_failed_round";

/** The guard whose refusal alone is a scope change for the Council, not a failure (O-43). */
export const SCOPE_GUARD = "scope_matches_plan";
/** The guard that reads CI on the head: a `pending` head is not yet a failure (O-43). */
const CI_GUARD = "ci_green_on_head";

/** The escalation a QA fail asked for, as the library decided it. */
export type ReportedEscalation = EscalationMove;

const ACTOR = { kind: "runner" as const, id: "run_end" };

export interface RunReportsOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  /** For the merge on a QA pass. */
  github: GitHub;
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
      /** The merge commit, when the move was the merge and the PR is merged. */
      mergeCommitSha?: string;
      /** The privileged-path gate request a merge waits on. */
      gateRequestId?: string;
      /** After QA's fail: the escalation asked for (O-41). */
      escalation?: ReportedEscalation;
      /** A refused done report, counted toward `failure` (P-03, O-43). */
      failureCount?: FailureCount;
    };

/** The longest reason a builder's stop may give (the runtime checks the same bound). */
export const NEEDS_DECISION_REASON_CHARS = 1000;

/** The `ref` of the `agent_report` the runner records for a builder's stop: one per run. */
export const needsDecisionRef = (runId: string): string =>
  `runner:needs_decision:run-${runId}`;

/** The runner's reason on the escalation after a second `cannot_tell` on the head (D-252). */
export const VISUAL_CANNOT_TELL_REASON =
  "the visual comparison could not tell twice on the same head";

/** The runner's own reason on the escalation move; the bot's words stay in its report. */
export const NEEDS_DECISION_ESCALATION_REASON =
  "the builder stopped: the item needs a product decision or a new feature";

/** What `recordNeedsDecision` did. */
export type NeedsDecisionRecord =
  | { recorded: true | "already_recorded" }
  | {
      recorded: false;
      reason: "no_run" | "no_node" | "not_a_builder" | "bad_reason";
    };

const FAILURE_LIMIT_REASON =
  "QA failed the round, and the failure counter reached its limit";

/** The trigger id of the report a run made: one per run, so a repeated end moves once. */
export const reportTrigger = (runId: string) => ({
  kind: "bot_report" as const,
  ref: `run:${runId}`,
});

export function createRunReports(options: RunReportsOptions) {
  const { store, contracts, clock } = options;
  const library = createLibrary(options);
  const merges = createMerges(options);
  const escalations = createEscalations(options);
  const failures = createFailures(options);

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;
  const dryRunOn = async () => (await store.getSetting("dry_run"))?.value !== false;

  /** P-03: a failed QA round adds one to `qa_round` and to `failure`, with its move. */
  const countFailedRound =
    (nodeId: string): AlsoWrite =>
    async (tx) => {
      const at = clock.now();
      for (const kind of ["qa_round", "failure"] as CounterKind[]) {
        await tx.setCounter(nodeId, kind, (await tx.getCounter(nodeId, kind)) + 1, at);
      }
      return null;
    };

  /** Asks for the Council with the report's trigger. The guards decide. */
  const escalate = (
    nodeId: string,
    trigger: Trigger,
    reason: string,
    alsoWrite?: AlsoWrite,
  ): Promise<ReportedEscalation | undefined> =>
    escalations.escalate(nodeId, trigger, reason, alsoWrite);

  /**
   * Whether a report whose moves the guards all refused counts toward `failure` (O-43): the run's
   * role pushes a branch, and the refusal is not CI still pending on the head, nor a scope change
   * alone. Reads only.
   */
  async function refusalCounts(
    node: Node,
    run: Run,
    failed: string[],
  ): Promise<{ counts: boolean; headSha: string | null }> {
    const head = await headCommit({ node, store });
    const headSha = head?.sha ?? null;
    if (!PUSHING_ROLES.includes(run.bot as AgentRole) || failed.length === 0) {
      return { counts: false, headSha };
    }
    if (failed.every((name) => name === SCOPE_GUARD)) return { counts: false, headSha };
    // The options are the runner's to capture once CI has rendered them, after the Designer's
    // report (./option-capture.ts, O-88): their absence alone is not the Designer's failure.
    if (failed.every((name) => name === OPTIONS_GUARD))
      return { counts: false, headSha };
    if (
      failed.includes(CI_GUARD) &&
      head &&
      readCiRun(head.ciRun.payload)?.conclusion === "pending"
    ) {
      return { counts: false, headSha };
    }
    return { counts: true, headSha };
  }

  const isQaFailMove = (from: string, to: string): boolean =>
    contracts.transitions.some(
      (m) =>
        !m.escalation &&
        m.from === from &&
        m.to === to &&
        m.guards.includes(QA_FAIL_GUARD),
    );

  /**
   * The moves a report by `role` triggers from the node's state, in contract order. A redo move
   * is the Council's (D-231, src/core/council.ts), never a report's.
   */
  function reportMoves(node: Node, role: string): TransitionContract[] {
    if (stateOf(node.state)?.owner?.toLowerCase() !== role) return [];
    return contracts.transitions.filter(
      (move) =>
        !move.escalation &&
        !move.fallbackMove &&
        move.from === node.state &&
        !move.guards.includes(DISPATCH_GUARD) &&
        !move.guards.includes(REDO_GUARD) &&
        (!move.tracks || (node.track !== null && move.tracks.includes(node.track))),
    );
  }

  /** The `agent_report` a builder's stop was recorded as, if this run made one (O-63). */
  async function neededDecision(node: Node, run: Run): Promise<Evidence | undefined> {
    const ref = needsDecisionRef(run.id);
    return (await store.listEvidence({ nodeId: node.id, kind: "agent_report" })).find(
      (e) => e.runId === run.id && e.ref === ref,
    );
  }

  /** Whether this run is a visual comparison whose recorded outcome is `cannot_tell` (D-252). */
  async function couldNotTell(node: Node, run: Run): Promise<boolean> {
    if (run.bot !== "qa" || run.taskType !== VISUAL_TASK_TYPE) return false;
    const row = (
      await store.listEvidence({ nodeId: node.id, kind: "visual_comparison" })
    ).find((e) => e.runId === run.id);
    return row ? readVisualComparison(row.payload)?.outcome === "cannot_tell" : false;
  }

  return {
    reportMoves,

    /**
     * Records a builder's stop for a decision as an `agent_report` asking to escalate, with the
     * bot's reason, once per run (O-63). It is a record of what the run said, like the run's end,
     * so it is written whatever the switches say; the escalation move obeys them. The node is
     * locked first, so two flows for the same run write one row.
     */
    async recordNeedsDecision(
      runId: string,
      reason: string,
    ): Promise<NeedsDecisionRecord> {
      const run = await store.getRun(runId);
      if (!run) return { recorded: false, reason: "no_run" };
      if (!PUSHING_ROLES.includes(run.bot as AgentRole)) {
        return { recorded: false, reason: "not_a_builder" };
      }
      const text = reason.trim();
      if (text === "" || text.length > NEEDS_DECISION_REASON_CHARS) {
        return { recorded: false, reason: "bad_reason" };
      }
      const nodeId = run.nodeId;
      if (!nodeId) return { recorded: false, reason: "no_node" };
      const ref = needsDecisionRef(run.id);
      return store.transaction(async (tx) => {
        if (!(await tx.getNodeForUpdate(nodeId))) {
          return { recorded: false as const, reason: "no_node" as const };
        }
        const earlier = (await tx.listEvidence({ nodeId, kind: "agent_report" })).some(
          (e) => e.runId === run.id && e.ref === ref,
        );
        if (earlier) return { recorded: "already_recorded" as const };
        await tx.insertEvidence({
          id: options.ids.next(),
          nodeId,
          runId: run.id,
          kind: "agent_report",
          ref,
          commitSha: null,
          payload: { escalate: true, reason: text },
          recordedBy: "runner",
          recordedAt: clock.now(),
          supersedesId: null,
        });
        return { recorded: true as const };
      });
    },

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
        // QA's fail move taken, and the item still where it sent it: ask again for the
        // escalation a failure part way may have left behind (taken once per trigger).
        const recover =
          earlier.mode === "applied" &&
          node.state === earlier.toState &&
          isQaFailMove(earlier.fromState, earlier.toState);
        const escalation = recover
          ? await escalate(node.id, trigger, FAILURE_LIMIT_REASON)
          : undefined;
        return {
          requested: true,
          outcome: "noop",
          toState: earlier.toState,
          reason: "duplicate_trigger",
          transitionId: earlier.id,
          failedGuards: [],
          ...(escalation && escalation.outcome !== "rejected" ? { escalation } : {}),
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
      // A builder that stopped for a decision asks for the escalation, not the done move (O-63).
      if (
        PUSHING_ROLES.includes(run.bot as AgentRole) &&
        (await neededDecision(node, run))
      ) {
        const escalation = await escalate(
          node.id,
          trigger,
          NEEDS_DECISION_ESCALATION_REASON,
        );
        if (!escalation) return { requested: false, reason: "no_move" };
        return {
          requested: true,
          outcome: escalation.outcome,
          toState: escalation.toState,
          ...(escalation.reason ? { reason: escalation.reason } : {}),
          ...(escalation.transitionId ? { transitionId: escalation.transitionId } : {}),
          failedGuards: escalation.failedGuards,
          escalation,
        };
      }
      const moves = reportMoves(node, run.bot);
      if (moves.length === 0) return { requested: false, reason: "no_move" };

      const failedGuards: string[] = [];
      let last: ReportedMove | undefined;
      // What the merge left, kept on the result even when a later move is the last asked for.
      let mergeFacts: { mergeCommitSha?: string; gateRequestId?: string } = {};
      for (const move of moves) {
        if (move.guards.includes(MERGE_MOVE_GUARD)) {
          const merged = await merges.mergeOnPass(node.id, trigger);
          failedGuards.push(...merged.failedGuards);
          mergeFacts = {
            ...(merged.mergeCommitSha ? { mergeCommitSha: merged.mergeCommitSha } : {}),
            ...(merged.gateRequestId ? { gateRequestId: merged.gateRequestId } : {}),
          };
          last = {
            requested: true,
            outcome: merged.outcome,
            toState: move.to,
            ...(merged.reason ? { reason: merged.reason } : {}),
            ...(merged.transitionId ? { transitionId: merged.transitionId } : {}),
            failedGuards,
            ...mergeFacts,
          };
          // As for any move: only a merge the guards refused leaves room for the next one.
          if (merged.outcome !== "rejected") break;
          continue;
        }
        const qaFail = move.guards.includes(QA_FAIL_GUARD);
        const dryRun = qaFail && (await dryRunOn());
        // P-03: the counts commit with the move. Dry run writes none.
        const counts = qaFail && !dryRun ? countFailedRound(node.id) : undefined;
        const result = await library.requestTransitionOnce(
          {
            nodeId: node.id,
            toState: move.to,
            trigger,
            actor: ACTOR,
            reason: `${run.bot} run reported done`,
          },
          counts,
        );
        const moveFailed = result.guardReport.filter((c) => !c.pass).map((c) => c.name);
        failedGuards.push(...moveFailed);
        let escalation: ReportedEscalation | undefined;
        if (qaFail && result.outcome === "applied") {
          escalation = await escalate(node.id, trigger, FAILURE_LIMIT_REASON);
        } else if (
          qaFail &&
          result.outcome === "rejected" &&
          moveFailed.length === 1 &&
          moveFailed[0] === ROUND_CAP_GUARD
        ) {
          // The round that reaches the cap: counted with the escalation, not with a move.
          escalation = await escalate(
            node.id,
            trigger,
            "QA failed the round that reaches the QA round cap",
            counts,
          );
        }
        last = {
          requested: true,
          outcome: result.outcome,
          toState: move.to,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.transitionId ? { transitionId: result.transitionId } : {}),
          failedGuards,
          ...mergeFacts,
          ...(escalation && escalation.outcome !== "rejected" ? { escalation } : {}),
        };
        // Only a move the guards refused leaves room for the next one.
        if (result.outcome !== "rejected") break;
      }
      // D-252: a visual run that could not tell asks for the escalation. The guards allow it on
      // the second `cannot_tell` on the head (`escalation_trigger_met`); on the first they refuse
      // it, nothing is written, and the run-end flow starts the one more run instead.
      if (
        last?.requested &&
        last.outcome === "rejected" &&
        !last.escalation &&
        (await couldNotTell(node, run))
      ) {
        const escalation = await escalate(node.id, trigger, VISUAL_CANNOT_TELL_REASON);
        if (escalation && escalation.outcome !== "rejected")
          last = { ...last, escalation };
      }
      // Every move the report triggers was refused by its guards: the done report failed (P-03).
      if (
        last?.requested &&
        last.outcome === "rejected" &&
        last.reason === "guard_failed" &&
        !last.escalation
      ) {
        const refusal = await refusalCounts(node, run, failedGuards);
        if (refusal.counts) {
          const failureCount = await failures.reportRefused(
            run.id,
            trigger,
            [...new Set(failedGuards)],
            refusal.headSha,
          );
          last = { ...last, failureCount };
        }
      }
      return last as ReportedMove;
    },
  };
}

export type RunReports = ReturnType<typeof createRunReports>;
