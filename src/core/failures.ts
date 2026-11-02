// The P-03 failure counts that have no move of their own (build plan M3.5, D-169, O-43, O-44).
// QA's fail and the staging fail count in the transaction of their move back (src/core/run-reports.ts,
// src/core/staging.ts). Two counts have no move: a done report the runner refused on its guards,
// and a repeated failed start. Each is recorded as `failure_count` evidence on the node under a
// key that names its cause and run, in the transaction that adds one to `failure`, so the row and
// the count commit together and a repeated report or a retried flow counts once. After a count the
// runner asks for the escalation with the same trigger, which `escalation_trigger_met` allows once
// `failure` reaches `failure_threshold`; asking again after a count is how a call cut short
// between the two is recovered.
//
// Which reports and which starts count is decided by the callers' rules below and in
// run-reports.ts, never by an agent's word. Dry run and the kill switch count nothing: the switches
// are read inside the transaction that writes. Plain logic over an injected store, contracts,
// guards, clock and id source (D-162).
import { createEscalations, type EscalationMove } from "./escalations.ts";
import type { Contracts, GuardRegistry } from "./contracts.ts";
import type { Clock, IdSource, Trigger } from "./library.ts";
import type { Evidence, Json, Run, Store } from "./store.ts";

/** Why a `failure_count` row added one to `failure`. */
export type FailureCause = "report_refused" | "dispatch_failed";

/** The key a count is recorded under: one per cause and run. */
export const failureCountKey = (cause: FailureCause, runId: string): string =>
  `runner:failure_count:${cause}:run-${runId}`;

/**
 * How many failed starts in a row on an item make a dispatch failure "repeated" (P-03, O-44): the
 * first is retried by the next trigger without a count, and each one after it in the same row
 * counts one.
 */
export const DISPATCH_FAILURES_BEFORE_COUNT = 1;

export interface FailuresOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

/** What a count did. `already_counted` and `counted` both ask for the escalation. */
export type FailureCount =
  | {
      counted: true | "already_counted";
      failures: number;
      escalation?: EscalationMove;
    }
  | {
      counted: false;
      reason:
        | "kill_switch"
        | "dry_run"
        | "no_run"
        | "no_node"
        | "not_a_failed_start"
        | "first_failed_start"
        /** A Council run's failed start counts as one of its question's runs instead (D-228). */
        | "council_run";
    };

export function createFailures(options: FailuresOptions) {
  const { store, clock, ids } = options;
  const escalations = createEscalations(options);

  /** One count under its key, with its evidence row, in one transaction. */
  async function countOnce(
    run: Run & { nodeId: string },
    cause: FailureCause,
    payload: { [key: string]: Json },
    commitSha: string | null,
  ): Promise<
    { counted: true | "already_counted"; failures: number } | "kill_switch" | "dry_run"
  > {
    const key = failureCountKey(cause, run.id);
    return store.transaction(async (tx) => {
      if ((await tx.getSetting("kill_switch"))?.value === true) return "kill_switch";
      if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
      const at = clock.now();
      const evidence: Evidence = {
        id: ids.next(),
        nodeId: run.nodeId,
        runId: run.id,
        kind: "failure_count",
        ref: key,
        commitSha,
        payload: { cause, ...payload },
        recordedBy: "runner",
        recordedAt: at,
        supersedesId: null,
      };
      const current = await tx.getCounter(run.nodeId, "failure");
      if (!(await tx.insertEvidenceOnce(evidence, key))) {
        return { counted: "already_counted" as const, failures: current };
      }
      await tx.setCounter(run.nodeId, "failure", current + 1, at);
      return { counted: true as const, failures: current + 1 };
    });
  }

  /** Counts, then asks for the escalation with the trigger the count came from. */
  async function countAndEscalate(
    run: Run & { nodeId: string },
    cause: FailureCause,
    payload: { [key: string]: Json },
    commitSha: string | null,
    trigger: Trigger,
    reason: string,
  ): Promise<FailureCount> {
    const counted = await countOnce(run, cause, payload, commitSha);
    if (counted === "kill_switch" || counted === "dry_run") {
      return { counted: false, reason: counted };
    }
    const escalation = await escalations.escalate(run.nodeId, trigger, reason);
    return {
      ...counted,
      ...(escalation && escalation.outcome !== "rejected" ? { escalation } : {}),
    };
  }

  const withNode = (run: Run | null): (Run & { nodeId: string }) | null =>
    run && run.nodeId ? (run as Run & { nodeId: string }) : null;

  /** A run admitted and ended `fail` by the runner before it started: it has no handle. */
  async function failedStart(run: Run): Promise<boolean> {
    return run.outcome === "fail" && (await store.getRunHandle(run.id)) === null;
  }

  return {
    /**
     * A done report the runner refused on the guards of its move (P-03): `failure` up by one,
     * once per report. The caller (src/core/run-reports.ts) decides that the report counts.
     */
    async reportRefused(
      runId: string,
      trigger: Trigger,
      failedGuards: string[],
      headSha: string | null,
    ): Promise<FailureCount> {
      const run = withNode(await store.getRun(runId));
      if (!run) return { counted: false, reason: "no_run" };
      return countAndEscalate(
        run,
        "report_refused",
        { failedGuards },
        headSha,
        trigger,
        "a done report was refused on its guards, and the failure counter reached its limit",
      );
    },

    /**
     * A repeated dispatch failure (P-03, O-44): a run the runner admitted and then ended `fail`
     * because its task or its start failed (it has no handle), when it is not the first such run
     * in a row on the item. The row is the node's latest runs that all ended this way; a run that
     * started, or a refusal that admitted no run (the kill switch, dry run, the limits, the
     * usage-exhausted wait), is not part of it and does not count. A Council run is not the
     * item's work: its failed start counts as one of its question's runs (src/core/council.ts).
     */
    async dispatchFailed(runId: string): Promise<FailureCount> {
      const run = withNode(await store.getRun(runId));
      if (!run) return { counted: false, reason: "no_run" };
      if (!(await store.getNode(run.nodeId)))
        return { counted: false, reason: "no_node" };
      if (run.bot === "council") return { counted: false, reason: "council_run" };
      if (!(await failedStart(run))) {
        return { counted: false, reason: "not_a_failed_start" };
      }
      // The item's own work only: a Council run on the item is not part of the row.
      const runs = (await store.listRuns({ nodeId: run.nodeId })).filter(
        (r) => r.bot !== "council",
      );
      const upTo = runs.slice(0, runs.findIndex((r) => r.id === run.id) + 1);
      let inRow = 0;
      for (let i = upTo.length - 1; i >= 0; i--) {
        if (!(await failedStart(upTo[i] as Run))) break;
        inRow++;
      }
      if (inRow <= DISPATCH_FAILURES_BEFORE_COUNT) {
        return { counted: false, reason: "first_failed_start" };
      }
      return countAndEscalate(
        run,
        "dispatch_failed",
        { failedStartsInRow: inRow },
        null,
        { kind: "event", ref: `dispatch_failed:${run.id}` },
        "the dispatch failed repeatedly, and the failure counter reached its limit",
      );
    },
  };
}

export type Failures = ReturnType<typeof createFailures>;
