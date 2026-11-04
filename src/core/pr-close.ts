// How a cancelled work item's open pull request is closed (D-318, O-98). Plain logic over an
// injected store, clock and id source (D-162).
//
// The item's own bot closes it: a short run of the bot's own task type, `developer:close` or
// `designer:close` (contracts/task-types.yaml), whose image's wrapper does not start the model. It
// reads the run's input (`closeInputText`, read back strictly by `readCloseInput`), posts the one
// fixed comment (`CLOSE_COMMENT`) and closes that one pull request through GitHub's API with the
// run's own GitHub token, the same token and client it opens pull requests with
// (src/agent-images/opencode/close.ts). It touches no other pull request, branch or file, and
// refuses when the pull request's head is not the item's branch. The runner and the bots get no
// new permission or tool.
//
// When a close is due (`target`): the item is a work item in Cancelled, the store records its
// pull request (the latest `ci_run`'s PR and the latest `dispatch_record`'s repository, as the
// cancel step reports it), that repository is still the project's, the run that pushed the
// branch was the Developer's or the Designer's (that is the item's own bot), and no close run was
// ever started for that pull request on the item. So one close run per pull request, never a
// second once one was started, whatever its end. Admission refuses a second one under its lock
// too (src/core/runs.ts, `close_already_run`), so two passes at once start one run.
//
// The outcome is recorded once per run as an `agent_report` on the item by the runner, ref
// `runner:pr_close:run-<run id>`, payload `{kind: "pr_close", outcome, pullRequest}`: the
// wrapper's outcome (closed, already closed, already merged, not found, refused), or `failed`
// when the run ended any other way or its result cannot be read. No guard reads it: it has no
// `escalate`. The daily check shows it in the Stopped list (`closeOf`).
import type { Clock, IdSource } from "./library.ts";
import { recordedPullRequest } from "./cancel.ts";
import {
  CLOSE_OUTCOMES,
  closeInputText,
  readCloseResult,
  type CloseOutcome,
} from "./pr-close-input.ts";
import type { Evidence, Json, Node, Run, Store, StoreOps } from "./store.ts";
import { CLOSE_TASK_TYPES, isCloseTaskType, type CloseRole } from "./task-types.ts";

export { CLOSE_TASK_TYPES, isCloseTaskType, type CloseRole };
export * from "./pr-close-input.ts";
const CLOSE_ROLES = Object.keys(CLOSE_TASK_TYPES) as CloseRole[];

/** What the runner records: the wrapper's outcome, or `failed` for any other end. */
export type RecordedCloseOutcome = CloseOutcome | "failed";
const RECORDED_OUTCOMES: readonly unknown[] = [...CLOSE_OUTCOMES, "failed"];

/** `agent_report.payload.kind` of a close run's outcome. */
export const CLOSE_REPORT_KIND = "pr_close";
/** The `ref` of the outcome the runner records: one per run. */
export const closeReportRef = (runId: string): string => `runner:pr_close:run-${runId}`;

/** Why no close run is due for an item. */
export type CloseNotDue =
  | "no_node"
  | "not_cancelled"
  | "no_pull_request"
  | "other_repository"
  | "no_builder"
  | "close_already_run";

/** A due close: the item, its bot, its pull request and the run's input. */
export interface CloseTarget {
  item: Node;
  role: CloseRole;
  taskType: string;
  pullRequest: { repo: string; number: number };
  input: string;
}

/** What a close pass did for one item, or would do in dry run (flows/lib/close-runs.ts). */
export interface CloseRunStart {
  nodeId: string;
  pullRequest: number;
  /** The dispatch's outcome, `start_failed` when it threw, with its run or refusal. */
  outcome: string;
  runId?: string;
  reason?: string;
}

/** How the daily check shows an item's close (D-318). */
export type CloseStatus =
  | { status: "none" }
  | { status: "running"; runId: string }
  | { status: "ended"; runId: string; outcome: RecordedCloseOutcome };

export interface PullRequestClosesDeps {
  store: Pick<
    Store,
    | "getNode"
    | "getProject"
    | "getRun"
    | "listRuns"
    | "listEvidence"
    | "listNodes"
    | "transaction"
  >;
  clock: Clock;
  ids: IdSource;
}

/** The close runs on the item for this pull request, oldest first. */
const closeRunsFor = (runs: readonly Run[], prNumber: number): Run[] =>
  runs.filter((r) => isCloseTaskType(r.taskType) && r.prNumber === prNumber);

const field = (value: Json | undefined, key: string): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;

/**
 * The close of the item's recorded pull request as the store has it: no close run yet, one
 * running, or the outcome of the one that ended (`failed` when it ended with none recorded).
 */
export async function closeOf(
  store: Pick<StoreOps, "listRuns" | "listEvidence">,
  nodeId: string,
  prNumber: number,
): Promise<CloseStatus> {
  const run = closeRunsFor(await store.listRuns({ nodeId }), prNumber).at(-1);
  if (!run) return { status: "none" };
  if (run.endedAt === null) return { status: "running", runId: run.id };
  const report = (await store.listEvidence({ nodeId, kind: "agent_report" })).find(
    (e) => e.ref === closeReportRef(run.id),
  );
  const outcome = field(report?.payload, "outcome");
  return {
    status: "ended",
    runId: run.id,
    outcome: RECORDED_OUTCOMES.includes(outcome as RecordedCloseOutcome)
      ? (outcome as RecordedCloseOutcome)
      : "failed",
  };
}

export function createPullRequestCloses(deps: PullRequestClosesDeps) {
  const { store, clock, ids } = deps;

  /** The bot of the run that pushed the item's branch: its latest `dispatch_record`'s run. */
  async function builderOf(nodeId: string): Promise<CloseRole | null> {
    const records = await store.listEvidence({ nodeId, kind: "dispatch_record" });
    const runId = records.at(-1)?.runId;
    const run = runId ? await store.getRun(runId) : null;
    return CLOSE_ROLES.find((r) => r === run?.bot) ?? null;
  }

  async function target(nodeId: string): Promise<CloseTarget | { why: CloseNotDue }> {
    const item = await store.getNode(nodeId);
    if (!item) return { why: "no_node" };
    if (item.type !== "work_item" || item.state !== "cancelled")
      return { why: "not_cancelled" };
    const pr = await recordedPullRequest(store, item.id);
    if (!pr) return { why: "no_pull_request" };
    const project = await store.getProject(item.projectId);
    if (project?.repo !== pr.repo) return { why: "other_repository" };
    const role = await builderOf(item.id);
    if (!role) return { why: "no_builder" };
    if (closeRunsFor(await store.listRuns({ nodeId: item.id }), pr.number).length > 0)
      return { why: "close_already_run" };
    return {
      item,
      role,
      taskType: CLOSE_TASK_TYPES[role],
      pullRequest: pr,
      input: closeInputText(pr.repo, pr.number),
    };
  }

  return {
    target,

    /** Every cancelled work item whose close is due. Reads only. */
    async pending(): Promise<string[]> {
      const due: string[] = [];
      for (const item of await store.listNodes({ state: "cancelled" })) {
        if (!("why" in (await target(item.id)))) due.push(item.id);
      }
      return due;
    },

    /**
     * Records a close run's outcome once, as an `agent_report` on its item by the runner. `result`
     * is the run's structured result when the run ended `success`, else null, which records
     * `failed`. Returns the outcome recorded now or before, or null for a run that is not a close
     * run, has no node or whose node is gone.
     */
    async recordOutcome(
      runId: string,
      result: unknown,
    ): Promise<RecordedCloseOutcome | null> {
      const run = await store.getRun(runId);
      if (!run?.nodeId || !isCloseTaskType(run.taskType) || run.prNumber === null)
        return null;
      const nodeId = run.nodeId;
      const read = result === null ? null : readCloseResult(result);
      const outcome: RecordedCloseOutcome =
        read && read.pullRequest === run.prNumber ? read.closeOutcome : "failed";
      const ref = closeReportRef(run.id);
      return store.transaction(async (tx) => {
        if (!(await tx.getNode(nodeId))) return null;
        const earlier = (await tx.listEvidence({ nodeId, kind: "agent_report" })).find(
          (e) => e.ref === ref,
        );
        if (earlier) return field(earlier.payload, "outcome") as RecordedCloseOutcome;
        const evidence: Evidence = {
          id: ids.next(),
          nodeId,
          runId: run.id,
          kind: "agent_report",
          ref,
          commitSha: null,
          payload: {
            kind: CLOSE_REPORT_KIND,
            outcome,
            pullRequest: run.prNumber as number,
          },
          recordedBy: "runner",
          recordedAt: clock.now(),
          supersedesId: null,
        };
        await tx.insertEvidence(evidence);
        return outcome;
      });
    },

    /** The close of the item's pull request as the store has it (`closeOf`). */
    closeOf: (nodeId: string, prNumber: number) => closeOf(store, nodeId, prNumber),
  };
}

export type PullRequestCloses = ReturnType<typeof createPullRequestCloses>;
