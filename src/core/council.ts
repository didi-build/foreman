// The Council slice (build plan M3.5, D-228, D-229, N-37, N-39, ADR 0107). Plain logic over an
// injected store, contracts, guards, clock and id source (D-162). It never starts a run: the
// runner starts the Council through the dispatch (flows/lib/council-runs.ts), and admission
// (src/core/runs.ts) decides as for every run.
//
// A Council question is open in two cases. An item waits in Escalated to Council with no Council
// decision since it got there (topic `escalation:<node id>`). A reversal opened its Council
// question, an open `council_question` gate request owned by the Council (topic
// `decision-reversed:<decision id>`, src/core/library.ts). Each Council run carries its
// question's topic (`runs.question_topic`, migration 0014).
//
// The Council has no tools (ADR 0107). It answers with structured output against the schema of its
// question's kind, which its bot file keeps (contracts/bots/council.yaml, `output_schemas`). When
// the run ends, the runner checks the answer against the same schema (src/core/output-schema.ts),
// then reads it, and records the `council_decision` itself, once per run (D-228): the
// Council never writes a decision or any evidence a guard trusts (essential 6). Its words are kept
// only inside that schema-checked answer. An answer that does not fit the schema, or a run that
// gave none, is not usable: the question gets one more run, and after that it goes to Didi as an
// `escalation` gate request with the reason.
//
// An escalation answer is recorded on the item with `scope {topicKey, runId, outcome,
// changesProductDirection, passesGate}` and the note as its text; the escalation pass then acts on
// it (src/core/escalations.ts, `council_decision_recorded`). A reversal answer gives a verdict for
// every item the reversal marked stale (D-229). It is recorded with the question's gate request
// answered, and its verdicts applied, in one transaction. Each item with a verdict is linked to
// the answer (`node_decisions`), so its own decisions list it (src/core/guards/council.ts).
// `cannot_decide` opens one `escalation` gate request for Didi on the reversal's topic for those
// items. A flag stays set while another reversal of a decision the item relies on has no Council
// verdict for it, or while another open reversal question still names it. Otherwise, when the
// item's stale episode holds a `redo` (this answer's, or an earlier answer's still waiting), an
// item still in an initial state of its track has its flag cleared (nothing was built yet, so the
// dispatch starts the work again); a merged item is due a rework item (D-233); any other
// item is due its redo move (D-231). With no `redo`, the flag is cleared. A merged item stays
// stale until the redo pass opens its rework item (below). The answer's scope names the items
// whose flags it cleared (`clearedNodeIds`).
//
// The redo move (`redo`, D-231) sends a stale item back to the start of its track: the contract
// move out of its state guarded by `council_redo_recorded`, with the trigger
// `council_redo:<Council decision id>`, so a repeat writes one row. Its transaction also clears
// the stale flag, resets both counters (as a Council resolution, D-169, D-227) and cancels the
// item's open visual-approval request, if any (O-52), and it refuses while a run other than a
// Council run is active on the item: the flow cancels those first through the runtime
// (flows/lib/council-runs.ts, D-202). The item keeps its branch and PR (D-220). An item in an
// escalated state has no redo move; it gets one once it returns.
//
// A merged item (it has a `merge_commit`) is not moved: its code is on main. Its redo opens one
// new work item instead (`rework`, D-233), in its track's start state (the state its track's redo
// moves lead to), on the same project and track, titled after the original, with the Council's
// note quoted as data and the reversed decision's id in its body, linked to the original with a
// `reworks` edge (migration 0015). The new item is agent-ready and off hold only if the original
// was. In the same transaction the original's stale flag is cleared; the edge ends its stale
// episode. It is opened once per (Council decision, original item).
//
// When Didi answers a reversal's gate request (the `escalation` gate request owned by Didi on the
// reversal's topic), the answer is recorded on the approval page (D-200) and the reversal gets one
// follow-up Council question (`followUp`, D-234): a new `council_question` on the same topic,
// for the items still stale from that gate request, carrying Didi's decision id. Its run's input
// quotes Didi's answer as data, and its answer is recorded and applied as any reversal answer.
// A `cannot_decide`, or no usable answer after its one re-run, sends those items back to Didi
// once more with a new gate request. Each Didi answer gets one follow-up, so nothing loops
// without Didi. For each reversal and item, the latest Council answer counts
// (src/core/guards/council.ts).
//
// A third question kind is the Council's call on a visual approval (`visual_call`, D-263, D-270,
// ./visual-call.ts): open while a `visual_approval` request owned by Didi is open on an item with
// no call recorded for it (topic `visual-call:<item id>`). Its run has task type `council:visual`
// and the option screenshots as images. The runner records the call as a `council_decision` on
// that topic, never on the visual-approval topic, so no guard reads it; nothing acts on it. No
// usable answer after the run and one re-run records the call as dropped, and nothing goes to Didi.
//
// A fourth question kind asks whether to stop a scanner idea the Scanner no longer finds
// (`scanner_gone`, D-301, O-93, ./scan-ideas.ts): open while a `council_question` request owned by
// the Council is open on `scanner-gone:<idea id>`, which the scan opens once per commit and only
// while no other request is open there. Its run has task type `council` and its input shows the
// idea with its scope updates (./council-input.ts). The answer (`stop`, `keep` or
// `cannot_decide`) is recorded as a `council_decision` on the idea with the request answered, in
// one transaction. A `stop` opens nothing here: the cancel step then acts on it under the approver
// rule (D-308, ./cancel.ts `cancelAuthority`): it cancels the work items and moves the idea to
// Rejected when the Council accepted the idea's plan, and otherwise opens Didi's request to
// confirm. A `cannot_decide`, or no usable answer after the re-run, opens one `escalation` request
// for Didi on the same topic, as O-93 built it. Recording the answer moves nothing.
//
// A sixth question kind is its sibling on a work item (`still_needed`, D-308 (3), O-97,
// ./still-needed.ts): open while a `council_question` request owned by the Council is open on
// `still-needed:<item id>`, which the runner opens when a merged change touches the same design
// feature folder, when the item's own run reports the work already done, or when Didi asks. Its
// answer has the scanner question's schema and is recorded and acted on the same way, on the
// item. While it is open, or while Didi's request to confirm a cancel is open on the item, the
// item's escalation question waits, so one question at a time is asked about it.
//
// A fifth question kind plans an idea the Scanner filed (`plan`, D-307, O-96): open while a
// scanner idea is in Submitted with no plan yet (no planning-chat submission and no Council
// planning answer on it, ./plans.ts) and no request on its topic `council-plan:<idea id>`. Its run
// has task type `council` and its input shows the idea, its finding and its scope updates
// (./council-input.ts). The answer (the plan, the product direction it keeps, and the call on
// whether Didi is needed with its reason) is checked against the bot file's schema and then read
// strictly, and recorded in one transaction: the plan as a `council_decision` on the idea with
// `scope.kind` `plan_proposal` and the call, and the direction as a `product_direction` decision
// by `council`. The plan approval step then takes it (./plans.ts): `no` is the Council's own
// acceptance, `yes` or `unsure` opens Didi's plan-approval request. No usable answer after the
// re-run opens one `escalation` request for Didi on the topic, not blocking; nothing acts on it.
// Ideas filed from a bot's out-of-scope findings (D-244, ./finding-ideas.ts, `body.source`
// `run_finding`) are planned the same way (D-316 (1)); their input quotes the finding and who
// found it instead of the Scanner's evidence. When Didi sends a Council plan back (Reject or
// Request changes, with feedback, on its plan-approval request), the question reopens on the same
// topic as a replan (D-316 (3)), in Submitted or Council planning: it opens at Didi's answer, so
// only runs since then count toward its run and re-run, its input quotes Didi's feedback verbatim
// and the earlier plan, and its recorded plan names the answer (`scope.replanOf`). The new plan is
// then the idea's latest, which closes the question, so each answer gets one replan; the plan
// approval step takes it under D-315. No usable replan opens Didi's request as above (D-316 (2)).
//
// Dry run and the kill switch write nothing, read inside the transaction that writes.
import type { Contracts, GuardRegistry, TransitionContract } from "./contracts.ts";
import {
  councilPlanInput,
  escalationInput,
  reversalInput,
  scannerGoneInput,
  stillNeededInput,
  type StillNeededReason,
  visualCallInput,
  type ScopeUpdateView,
} from "./council-input.ts";
import { CANCEL_REQUEST_PREFIX, STILL_NEEDED_PREFIX } from "./cancel.ts";
import { createEscalations, type EscalationStep } from "./escalations.ts";
import {
  COUNCIL_CANNOT_RESOLVE,
  escalationTopic,
  latestCouncilDecision,
} from "./guards/escalation.ts";
import {
  isMerged,
  REDO_GUARD,
  REDO_TRIGGER,
  redoState,
  reworkedAt,
  REWORK_EDGE,
  type Verdict,
} from "./guards/council.ts";
import { visualApprovalTopic } from "./guards/design.ts";
import { readQaVerdict } from "./guards/evidence.ts";
import { outputProblem, type OutputSchema } from "./output-schema.ts";
import type { BotProfile } from "./reconcile.ts";
import { quoted } from "./task-input.ts";
import { FINDING_SOURCE } from "./finding-ideas.ts";
import { isScannerIdea, SCANNER_GONE_PREFIX } from "./scan-ideas.ts";
import {
  COUNCIL_PLAN_PREFIX,
  councilPlanTopic,
  latestPlan,
  newestPlanRequest,
  PLAN_LIMITS,
  PLAN_PROPOSAL_KIND,
  planReturnOutcome,
  readNeedsDidi,
  requestSubmissionId,
  SUBMITTABLE_STATES,
  SUBMITTED_STATE,
  type NeedsDidi,
} from "./plans.ts";
import {
  createLibrary,
  type AlsoWrite,
  type Clock,
  type IdSource,
  type TransitionOutcome,
} from "./library.ts";
import type {
  AgentRole,
  CurrentDecision,
  Decision,
  GateRequest,
  Json,
  Node,
  Run,
  Store,
  StoreOps,
  Transition,
} from "./store.ts";
import { StoreConflictError } from "./store.ts";
import {
  readVisualCallAnswer,
  recordedCall,
  VISUAL_CALL_DROPPED,
  VISUAL_CALL_DROPPED_TEXT,
  VISUAL_CALL_PREFIX,
  VISUAL_CALL_TASK_TYPE,
  visualCallImages,
  visualCallRequest,
  type VisualCallAnswer,
  type VisualCallQuestion,
  type VisualCallRefusal,
} from "./visual-call.ts";
import type { ScreenshotBundles, VisualImage } from "./visual-comparison.ts";

/** The topic key prefixes of the Council questions. */
export const ESCALATION_PREFIX = "escalation:";
export const REVERSAL_PREFIX = "decision-reversed:";
export {
  COUNCIL_PLAN_PREFIX,
  SCANNER_GONE_PREFIX,
  STILL_NEEDED_PREFIX,
  VISUAL_CALL_PREFIX,
};

/**
 * One run and one re-run per question; after that the question goes to Didi (D-228), or for a
 * visual call it is dropped (D-270).
 */
export const COUNCIL_RUNS_PER_QUESTION = 2;

/** The Council's notes are kept up to this many characters, then cut with a marker. */
export const COUNCIL_NOTE_CHARS = 4000;

/** A rework item's title is the original's, after this prefix, cut to `REWORK_TITLE_CHARS`. */
export const REWORK_TITLE_PREFIX = "Rework: ";
export const REWORK_TITLE_CHARS = 500;

/** Run ends that are not a failure to answer: a provider wait (FR-11) and the runner's own stop. */
const NOT_AN_ATTEMPT: readonly (string | null)[] = ["usage_exhausted", "cancelled"];

/** The fields of each answer, as the readers below check them. */
const ESCALATION_FIELDS = ["outcome", "note", "changesProductDirection", "passesGate"];

export type { Verdict };

export interface EscalationAnswer {
  outcome: "resolve" | typeof COUNCIL_CANNOT_RESOLVE;
  note: string;
  changesProductDirection: boolean;
  passesGate: boolean;
}

export interface ReversalAnswer {
  verdicts: { nodeId: string; verdict: Verdict; note: string }[];
  note: string;
}

/** The Council's answer on a scanner idea that is no longer found (D-301). */
export interface ScannerGoneAnswer {
  verdict: "stop" | "keep" | "cannot_decide";
  note: string;
}

export interface ScannerGoneQuestion {
  kind: "scanner_gone";
  topicKey: string;
  projectId: string;
  /** The scanner idea; the Council's run is on it. */
  nodeId: string;
  openedAt: Date;
  gateRequestId: string;
  /** The commit the scan no longer found the idea at (`payload.commitSha`). */
  commitSha: string | null;
}

/** A work item's "is this still needed?" question (D-308 (3)): the same answer as above. */
export interface StillNeededQuestion {
  kind: "still_needed";
  topicKey: string;
  projectId: string;
  /** The work item; the Council's run is on it. */
  nodeId: string;
  openedAt: Date;
  gateRequestId: string;
  /** Why the runner asks, from the request's payload. */
  reason: StillNeededReason;
  /** No commit: kept so the shared recording reads the same fields as the scanner question. */
  commitSha: string | null;
}

/** The Council's plan for an idea the Scanner filed (D-307). */
export interface CouncilPlanAnswer {
  plan: string;
  productDirection: string;
  needsDidi: NeedsDidi;
}

export interface CouncilPlanQuestion {
  kind: "plan";
  topicKey: string;
  projectId: string;
  /** The idea; the Council's run is on it. */
  nodeId: string;
  /** Who filed the idea: the Scanner, or the runner from a bot's finding (D-316 (1)). */
  source: CouncilPlanSource;
  /**
   * When the question opened: when the idea entered Submitted, or for a replan, when Didi's
   * answer that sent the Council's plan back was recorded (D-316 (3)).
   */
  openedAt: Date;
  /** A replan: Didi's answer that sent the Council's plan back, and that plan. Else null. */
  replan: { answerId: string; planId: string } | null;
}

/** The ideas the Council plans (D-307, D-316 (1)), by their recorded `body.source`. */
export type CouncilPlanSource = "scanner" | "run_finding";

/** Who filed the idea, when the Council plans ideas from that source; else null. */
export function councilPlanSource(
  node: Pick<Node, "type" | "body">,
): CouncilPlanSource | null {
  if (isScannerIdea(node)) return "scanner";
  return node.type === "idea" && field(node.body, "source") === FINDING_SOURCE
    ? "run_finding"
    : null;
}

export interface EscalationQuestion {
  kind: "escalation";
  topicKey: string;
  projectId: string;
  /** The escalated item; the Council's run is on it. */
  nodeId: string;
  /** When the item entered Escalated to Council. */
  openedAt: Date;
}

export interface ReversalQuestion {
  kind: "reversal";
  topicKey: string;
  projectId: string;
  /** The node the Council's run is on: the reversed decision's, else the first stale one. */
  nodeId: string | null;
  openedAt: Date;
  gateRequestId: string;
  decisionId: string;
  staleNodeIds: string[];
  reason: string | null;
  /** A follow-up after Didi answered the reversal's gate request: that answer (D-234). */
  didiDecisionId: string | null;
}

export type { VisualCallQuestion };

export type CouncilQuestion =
  | EscalationQuestion
  | ReversalQuestion
  | VisualCallQuestion
  | ScannerGoneQuestion
  | StillNeededQuestion
  | CouncilPlanQuestion;

/** A question that goes to Didi when it has no usable answer: every kind but the visual call. */
export type DidiBoundQuestion =
  | EscalationQuestion
  | ReversalQuestion
  | ScannerGoneQuestion
  | StillNeededQuestion
  | CouncilPlanQuestion;

/** What the runner does next for one open question. */
export type CouncilNext =
  /** An escalation with a Council decision since it was escalated: the escalation pass acts. */
  | { step: "answered"; question: CouncilQuestion; decisionId: string }
  | { step: "running"; question: CouncilQuestion; runId: string }
  /** A run is due: the first, or the one re-run after an unusable answer. */
  | { step: "start"; question: CouncilQuestion; nodeId: string; attempt: number }
  /** No usable answer after both runs: the question goes to Didi. */
  | { step: "to_didi"; question: DidiBoundQuestion; lastRunId: string; reason: string }
  /** A visual call with no usable answer after both runs: it is recorded as dropped (D-270). */
  | { step: "drop"; question: VisualCallQuestion; lastRunId: string; reason: string }
  /** A reversal question with no node to run on: no decision node and no stale item. */
  | { step: "no_node"; question: CouncilQuestion };

/** What happened to one stale item's verdict. */
export interface AppliedVerdict {
  nodeId: string;
  verdict: Verdict;
  result:
    /** The stale flag was cleared. */
    | "cleared"
    /**
     * Left stale: another reversal of a decision the item relies on has no Council verdict for it
     * yet, or another open reversal question still names it.
     */
    | "stale_for_another_reversal"
    /** Left stale until its redo move: the item is past the start of its track (D-231). */
    | "redo_move_due"
    /** Left stale until the redo pass opens its rework item: the item is merged (D-233). */
    | "rework_due"
    /** Left stale: the item went to Didi with the others the Council could not decide. */
    | "to_didi"
    | "no_node";
}

/** What the redo step found or did for one item (D-231). */
export type RedoStep =
  | { nodeId: string; step: "no_node" | "not_stale" }
  /** No redo stands: none was given, or a reversal it relies on has no verdict for it yet. */
  | { nodeId: string; step: "not_due"; why: "settled" | "unsettled" }
  /** Merged: its code is on main, so the redo opens a rework item instead (D-233). */
  | { nodeId: string; step: "rework_due"; councilDecisionId: string }
  /**
   * What `rework` did: `created` (the rework item, its link and the cleared flag committed),
   * `already_created` (this Council decision opened it before), or `refused` with the reason.
   */
  | {
      nodeId: string;
      step: "reworked";
      councilDecisionId: string;
      outcome: "created" | "already_created" | "refused";
      reworkNodeId: string | null;
      reason?: string;
    }
  /** No redo move out of its state now (an escalated state): it waits until it returns. */
  | { nodeId: string; step: "no_move"; councilDecisionId: string; state: string }
  /** The move is due. `activeRunIds` must be cancelled first (Council runs are not). */
  | {
      nodeId: string;
      step: "due";
      councilDecisionId: string;
      toState: string;
      activeRunIds: string[];
    }
  /** The library's answer to the move, or `run_active` when a run must be cancelled first. */
  | {
      nodeId: string;
      step: "moved";
      councilDecisionId: string;
      toState: string;
      outcome: TransitionOutcome;
      reason?: string;
      transitionId?: string;
      failedGuards: string[];
    };

/** What `recordAnswer` did with a Council run's answer. */
export type CouncilAnswer =
  | {
      recorded: true | "already_recorded";
      kind: CouncilQuestion["kind"];
      decisionId: string;
      /** A reversal answer, recorded now: each verdict and the gate request for Didi, if any. */
      verdicts?: AppliedVerdict[];
      didiGateRequestId?: string | null;
      /** A `stop` on a scanner idea or a work item: the cancel step is due (D-308). */
      cancelDue?: true;
    }
  | {
      recorded: false;
      reason:
        | "kill_switch"
        | "dry_run"
        | "no_run"
        | "not_a_council_run"
        /** The question is no longer open: answered another way, or the item moved on. */
        | "question_closed"
        /** The answer does not fit the schema; `problem` names the field, never its value. */
        | "invalid";
      problem?: string;
    };

/** What the follow-up after Didi's answer to a reversal's gate request found or did (D-234). */
export type FollowUpStep =
  | {
      topicKey: string;
      step: "not_due";
      why:
        /** The reversal's decision is not in the store. */
        | "no_decision"
        /** A question on the topic is open: the Council's, or Didi's. */
        | "open_question"
        /** Didi has answered no gate request on the topic. */
        | "no_didi_answer"
        /** Didi's latest answer already has its follow-up. */
        | "already_followed_up"
        /** None of the items Didi was asked about is still stale. */
        | "nothing_stale";
    }
  /** Not opened: the kill switch or dry run holds Didi's answer (D-201). */
  | { topicKey: string; step: "held"; reason: "kill_switch" | "dry_run" }
  /** The follow-up Council question is open; the Council pass starts its run. */
  | {
      topicKey: string;
      step: "opened";
      gateRequestId: string;
      didiDecisionId: string;
      staleNodeIds: string[];
    };

/** A follow-up that is due: what its question is opened with. */
interface FollowUpDue {
  projectId: string;
  nodeId: string | null;
  decisionId: string;
  didiGate: GateRequest;
  didiDecisionId: string;
  /** Every item Didi was asked about, still stale or not: the follow-up locks these. */
  askedNodeIds: string[];
  staleNodeIds: string[];
  reason: string | null;
}

export interface CouncilOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
  /** The Council's bot profile gives the output schema of each question kind (D-228). */
  bots: Pick<Record<AgentRole, BotProfile>, "council">;
  /** CI's screenshot bundles, for the visual call's option screenshots (D-270). */
  screenshots?: ScreenshotBundles;
}

/** What a visual call records, or why not (D-270). */
export type VisualCallRecord =
  | { recorded: true | "already_recorded"; decisionId: string }
  | { recorded: false; reason: "kill_switch" | "dry_run" | "question_closed" };

/**
 * The output schema of a question's kind, from the Council's bot file. The bot files loader
 * refuses a Council bot file without both, so a missing one is a wiring error and throws.
 */
function councilSchema(
  bots: CouncilOptions["bots"],
  kind: CouncilQuestion["kind"],
): OutputSchema {
  const schema = bots.council.outputSchemas?.[kind];
  if (!schema) throw new Error(`the Council bot file has no output schema for ${kind}`);
  return schema;
}

const isObject = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scopeOf = (decision: Pick<Decision, "scope">): { [key: string]: Json } =>
  isObject(decision.scope) ? (decision.scope as { [key: string]: Json }) : {};
const noteOf = (text: string): string =>
  text.length <= COUNCIL_NOTE_CHARS
    ? text
    : `${text.slice(0, COUNCIL_NOTE_CHARS)} [cut at ${COUNCIL_NOTE_CHARS} characters]`;
const textList = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Checks that an object has exactly these keys. Returns the first problem, naming the field. */
function exactKeys(value: { [key: string]: unknown }, keys: string[], at: string) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `${at}has a field the schema does not allow`;
  }
  for (const key of keys) {
    if (!(key in value)) return `${at}${key} is missing`;
  }
  return null;
}

/** Reads an escalation answer against its schema. Problems name the field, never its value. */
export function readEscalationAnswer(
  value: unknown,
): { answer: EscalationAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const shape = exactKeys(value, ESCALATION_FIELDS, "the answer ");
  if (shape) return { problem: shape };
  const { outcome, note, changesProductDirection, passesGate } = value;
  if (outcome !== "resolve" && outcome !== COUNCIL_CANNOT_RESOLVE) {
    return { problem: "outcome must be resolve or cannot_resolve" };
  }
  if (typeof note !== "string" || note.trim() === "") {
    return { problem: "note must be non-empty text" };
  }
  if (typeof changesProductDirection !== "boolean") {
    return { problem: "changesProductDirection must be true or false" };
  }
  if (typeof passesGate !== "boolean")
    return { problem: "passesGate must be true or false" };
  return {
    answer: { outcome, note: noteOf(note), changesProductDirection, passesGate },
  };
}

const VERDICTS: readonly string[] = ["still_valid", "redo", "cannot_decide"];

/**
 * Reads a reversal answer against its schema and the reversal's stale items: one verdict for each
 * of them, and none for anything else (D-229). Problems name the field, never its value.
 */
export function readReversalAnswer(
  value: unknown,
  staleNodeIds: readonly string[],
): { answer: ReversalAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const shape = exactKeys(value, ["verdicts", "note"], "the answer ");
  if (shape) return { problem: shape };
  if (typeof value.note !== "string") return { problem: "note must be text" };
  if (!Array.isArray(value.verdicts)) return { problem: "verdicts must be a list" };
  const verdicts: ReversalAnswer["verdicts"] = [];
  const seen = new Set<string>();
  for (const [i, raw] of value.verdicts.entries()) {
    const at = `verdicts[${i}].`;
    if (!isObject(raw)) return { problem: `verdicts[${i}] is not an object` };
    const fields = exactKeys(raw, ["nodeId", "verdict", "note"], `verdicts[${i}] `);
    if (fields) return { problem: fields };
    const { nodeId, verdict, note } = raw;
    if (typeof nodeId !== "string" || !staleNodeIds.includes(nodeId)) {
      return { problem: `${at}nodeId is not a stale item of this reversal` };
    }
    if (seen.has(nodeId)) return { problem: `${at}nodeId has a verdict already` };
    seen.add(nodeId);
    if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) {
      return { problem: `${at}verdict must be still_valid, redo or cannot_decide` };
    }
    if (typeof note !== "string") return { problem: `${at}note must be text` };
    verdicts.push({ nodeId, verdict: verdict as Verdict, note: noteOf(note) });
  }
  const missing = staleNodeIds.filter((id) => !seen.has(id)).length;
  if (missing > 0) {
    return { problem: `the verdicts miss ${missing} stale item(s) of this reversal` };
  }
  return { answer: { verdicts, note: noteOf(value.note) } };
}

const SCANNER_GONE_VERDICTS: readonly string[] = ["stop", "keep", "cannot_decide"];

/** Reads a scanner-gone answer against its schema. Problems name the field, never its value. */
export function readScannerGoneAnswer(
  value: unknown,
): { answer: ScannerGoneAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const shape = exactKeys(value, ["verdict", "note"], "the answer ");
  if (shape) return { problem: shape };
  const { verdict, note } = value;
  if (typeof verdict !== "string" || !SCANNER_GONE_VERDICTS.includes(verdict)) {
    return { problem: "verdict must be stop, keep or cannot_decide" };
  }
  if (typeof note !== "string" || note.trim() === "") {
    return { problem: "note must be non-empty text" };
  }
  return {
    answer: { verdict: verdict as ScannerGoneAnswer["verdict"], note: noteOf(note) },
  };
}

/**
 * Reads the Council's plan for a scanner idea against its schema (D-307): a non-blank plan and
 * product direction within the planning chat's bounds, and the call on Didi read as strictly as
 * `POST /plans` reads it. Problems name the field, never its value.
 */
export function readCouncilPlanAnswer(
  value: unknown,
): { answer: CouncilPlanAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const shape = exactKeys(
    value,
    ["plan", "productDirection", "needsDidi"],
    "the answer ",
  );
  if (shape) return { problem: shape };
  const { plan, productDirection } = value;
  if (
    typeof plan !== "string" ||
    plan.trim() === "" ||
    plan.length > PLAN_LIMITS.planChars
  ) {
    return {
      problem: `plan must be non-empty text of at most ${PLAN_LIMITS.planChars} characters`,
    };
  }
  if (
    typeof productDirection !== "string" ||
    productDirection.trim() === "" ||
    productDirection.length > PLAN_LIMITS.directionChars
  ) {
    return {
      problem: `productDirection must be non-empty text of at most ${PLAN_LIMITS.directionChars} characters`,
    };
  }
  const call = readNeedsDidi(value.needsDidi, "needsDidi");
  if ("problem" in call) return call;
  return { answer: { plan, productDirection, needsDidi: call.needsDidi } };
}

/** What Didi is asked when the Council gave no usable plan for a scanner idea (D-307). */
export const COUNCIL_PLAN_NO_ANSWER =
  "The Council gave no usable plan for this idea the Scanner filed. You can plan it in the planning chat.";

/** The same for an idea filed from a bot's out-of-scope finding (D-316 (1), (2)). */
export const COUNCIL_FINDING_PLAN_NO_ANSWER =
  "The Council gave no usable plan for this idea a bot found outside its own item. You can plan it in the planning chat.";

/** The same for a replan after Didi sent the Council's plan back (D-316 (2), (3)). */
export const COUNCIL_REPLAN_NO_ANSWER =
  "The Council gave no usable new plan for this idea after you sent its plan back. You can plan it in the planning chat.";

/** What Didi is asked when the Council's answer on a scanner idea needs Didi (D-301). */
const SCANNER_GONE_DIDI = {
  cannot_decide:
    "The Scanner no longer finds any of this idea's findings, and the Council could not decide whether to stop it.",
  no_answer:
    "The Scanner no longer finds any of this idea's findings, and the Council gave no usable answer on whether to stop it.",
} as const;

/** What Didi is told when the Council's answer on a work item needs Didi (D-308). */
const STILL_NEEDED_DIDI = {
  cannot_decide:
    "The Council was asked whether this work item is still needed and could not decide. Keeping or cancelling it is yours.",
  no_answer:
    "The Council was asked whether this work item is still needed and gave no usable answer. Keeping or cancelling it is yours.",
} as const;

const STILL_NEEDED_REASONS: readonly string[] = [
  "merged_change",
  "already_done",
  "didi_asked",
];

/** Rolls back the answer's transaction with the reason it was not recorded. */
class NotRecorded extends Error {
  readonly reason: "question_closed";
  constructor() {
    super("question_closed");
    this.reason = "question_closed";
  }
}

const field = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) ? (value as { [key: string]: Json })[key] : undefined;
const textOf = (value: Json | undefined): string | null =>
  typeof value === "string" ? value : null;

export function createCouncil(options: CouncilOptions) {
  const { store, contracts, clock, ids } = options;
  const library = createLibrary(options);
  const escalations = createEscalations(options);
  const councilState = escalations.councilState;

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;

  async function escalationQuestion(
    nodeId: string,
  ): Promise<EscalationQuestion | null> {
    const node = await store.getNode(nodeId);
    if (!node || !councilState || node.state !== councilState) return null;
    // The item's "is this still needed?" question, or Didi's request to confirm its cancel, comes
    // first: one question at a time (D-308).
    const waits = (await store.listOpenGateRequests(node.projectId)).some(
      (g) =>
        g.nodeId === node.id &&
        (g.topicKey === `${STILL_NEEDED_PREFIX}${node.id}` ||
          g.topicKey.startsWith(CANCEL_REQUEST_PREFIX)),
    );
    if (waits) return null;
    return {
      kind: "escalation",
      topicKey: escalationTopic(node.id),
      projectId: node.projectId,
      nodeId: node.id,
      openedAt: node.stateSince,
    };
  }

  function reversalQuestion(gate: GateRequest): ReversalQuestion | null {
    if (
      gate.status !== "open" ||
      gate.owner !== "council" ||
      gate.kind !== "council_question" ||
      !gate.topicKey.startsWith(REVERSAL_PREFIX)
    ) {
      return null;
    }
    const staleNodeIds = textList(field(gate.payload, "staleNodeIds"));
    const reason = field(gate.payload, "reason");
    return {
      kind: "reversal",
      topicKey: gate.topicKey,
      projectId: gate.projectId,
      nodeId: gate.nodeId ?? staleNodeIds[0] ?? null,
      openedAt: gate.createdAt,
      gateRequestId: gate.id,
      decisionId: gate.topicKey.slice(REVERSAL_PREFIX.length),
      staleNodeIds,
      reason: typeof reason === "string" ? reason : null,
      didiDecisionId: textOf(field(gate.payload, "didiDecisionId")),
    };
  }

  function scannerGoneQuestion(gate: GateRequest): ScannerGoneQuestion | null {
    if (
      gate.status !== "open" ||
      gate.owner !== "council" ||
      gate.kind !== "council_question" ||
      gate.nodeId === null ||
      gate.topicKey !== `${SCANNER_GONE_PREFIX}${gate.nodeId}`
    ) {
      return null;
    }
    return {
      kind: "scanner_gone",
      topicKey: gate.topicKey,
      projectId: gate.projectId,
      nodeId: gate.nodeId,
      openedAt: gate.createdAt,
      gateRequestId: gate.id,
      commitSha: textOf(field(gate.payload, "commitSha")),
    };
  }

  function stillNeededQuestion(gate: GateRequest): StillNeededQuestion | null {
    const reason = field(gate.payload, "reason");
    if (
      gate.status !== "open" ||
      gate.owner !== "council" ||
      gate.kind !== "council_question" ||
      gate.nodeId === null ||
      gate.topicKey !== `${STILL_NEEDED_PREFIX}${gate.nodeId}` ||
      typeof reason !== "string" ||
      !STILL_NEEDED_REASONS.includes(reason)
    ) {
      return null;
    }
    return {
      kind: "still_needed",
      topicKey: gate.topicKey,
      projectId: gate.projectId,
      nodeId: gate.nodeId,
      openedAt: gate.createdAt,
      gateRequestId: gate.id,
      reason: reason as StillNeededReason,
      commitSha: null,
    };
  }

  /**
   * The Council's planning question on an idea the Scanner filed (D-307) or one filed from a
   * bot's out-of-scope finding (D-316 (1)): open while the idea is in Submitted with no plan and
   * no request on its topic. It reopens as a replan (D-316 (3)) while the idea is in Submitted or
   * Council planning, its latest plan is the Council's, and Didi's answer on the request for that
   * plan sent it back (Reject or Request changes, with feedback), with no request on the topic
   * since that answer. Once a new plan is recorded it is the latest, so each answer gets one
   * replan. Reads through `ops`, so the answer's transaction checks it again.
   */
  async function councilPlanQuestion(
    ops: Pick<
      StoreOps,
      | "getNode"
      | "getDecision"
      | "listEvidence"
      | "listDecisionsForNode"
      | "listGateRequests"
    >,
    nodeId: string,
  ): Promise<CouncilPlanQuestion | null> {
    const node = await ops.getNode(nodeId);
    const source = node ? councilPlanSource(node) : null;
    if (!node || !source || !SUBMITTABLE_STATES.includes(node.state)) return null;
    const topicKey = councilPlanTopic(node.id);
    const asked = await ops.listGateRequests(node.projectId, topicKey);
    const base = { kind: "plan" as const, topicKey, projectId: node.projectId, nodeId };
    const plan = await latestPlan(ops, node.id);
    if (!plan) {
      if (node.state !== SUBMITTED_STATE || asked.length > 0) return null;
      return { ...base, source, openedAt: node.stateSince, replan: null };
    }
    if (plan.source !== "council_run") return null;
    const request = await newestPlanRequest(ops, node);
    if (
      !request ||
      request.status !== "answered" ||
      !request.decisionId ||
      requestSubmissionId(request) !== plan.id
    ) {
      return null;
    }
    const answer = await ops.getDecision(request.decisionId);
    if (!answer || answer.nodeId !== node.id || planReturnOutcome(answer) === null) {
      return null;
    }
    const since = answer.recordedAt.getTime();
    if (asked.some((g) => g.createdAt.getTime() >= since)) return null;
    return {
      ...base,
      source,
      openedAt: answer.recordedAt,
      replan: { answerId: answer.id, planId: plan.id },
    };
  }

  /** The open question on a topic key, or null when it is not open. */
  async function question(topicKey: string): Promise<CouncilQuestion | null> {
    if (topicKey.startsWith(COUNCIL_PLAN_PREFIX)) {
      return councilPlanQuestion(store, topicKey.slice(COUNCIL_PLAN_PREFIX.length));
    }
    if (topicKey.startsWith(SCANNER_GONE_PREFIX)) {
      const node = await store.getNode(topicKey.slice(SCANNER_GONE_PREFIX.length));
      if (!node) return null;
      const gate = await store.findOpenGateRequest(node.projectId, topicKey);
      return gate ? scannerGoneQuestion(gate) : null;
    }
    if (topicKey.startsWith(STILL_NEEDED_PREFIX)) {
      const node = await store.getNode(topicKey.slice(STILL_NEEDED_PREFIX.length));
      if (!node) return null;
      const gate = await store.findOpenGateRequest(node.projectId, topicKey);
      return gate ? stillNeededQuestion(gate) : null;
    }
    if (topicKey.startsWith(ESCALATION_PREFIX)) {
      return escalationQuestion(topicKey.slice(ESCALATION_PREFIX.length));
    }
    if (topicKey.startsWith(REVERSAL_PREFIX)) {
      const decision = await store.getDecision(topicKey.slice(REVERSAL_PREFIX.length));
      if (!decision) return null;
      const gate = await store.findOpenGateRequest(decision.projectId, topicKey);
      return gate ? reversalQuestion(gate) : null;
    }
    if (topicKey.startsWith(VISUAL_CALL_PREFIX)) {
      const node = await store.getNode(topicKey.slice(VISUAL_CALL_PREFIX.length));
      if (!node) return null;
      const gate = await store.findOpenGateRequest(
        node.projectId,
        visualApprovalTopic(node.id),
      );
      return gate ? visualCallQuestion(gate) : null;
    }
    return null;
  }

  /** The visual call a gate request opens, when no call is recorded for it yet (D-270). */
  async function visualCallQuestion(
    gate: GateRequest,
  ): Promise<VisualCallQuestion | null> {
    const q = visualCallRequest(gate);
    if (!q) return null;
    const decisions = await store.listDecisionsForNode(q.nodeId);
    return recordedCall(decisions, q.nodeId, q.gateRequestId) ? null : q;
  }

  /** The Council decision a run recorded, if any (`scope.runId`). */
  async function decisionOfRun(run: Run): Promise<CurrentDecision | undefined> {
    if (!run.nodeId) return undefined;
    return (await store.listDecisionsForNode(run.nodeId)).find(
      (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
    );
  }

  /** The question's Council runs since it opened, oldest first. */
  async function runsFor(q: CouncilQuestion): Promise<Run[]> {
    if (!q.nodeId) return [];
    return (await store.listRuns({ nodeId: q.nodeId })).filter(
      (r) =>
        r.bot === "council" &&
        r.questionTopic === q.topicKey &&
        r.startedAt.getTime() >= q.openedAt.getTime(),
    );
  }

  async function next(q: CouncilQuestion): Promise<CouncilNext> {
    if (q.kind === "escalation") {
      const node = await store.getNode(q.nodeId);
      const decision = node ? await latestCouncilDecision({ node, store }) : undefined;
      if (decision) return { step: "answered", question: q, decisionId: decision.id };
    }
    if (!q.nodeId) return { step: "no_node", question: q };
    const runs = await runsFor(q);
    const active = runs.find((r) => r.endedAt === null);
    if (active) return { step: "running", question: q, runId: active.id };
    const attempts: Run[] = [];
    for (const r of runs) {
      if (NOT_AN_ATTEMPT.includes(r.outcome)) continue;
      if (!(await decisionOfRun(r))) attempts.push(r);
    }
    const last = attempts.at(-1);
    if (
      last &&
      attempts.length >= COUNCIL_RUNS_PER_QUESTION &&
      q.kind === "visual_call"
    ) {
      return {
        step: "drop",
        question: q,
        lastRunId: last.id,
        reason: `the Council's ${attempts.length} runs gave no usable call; the last ended ${last.outcome ?? "without an outcome"}`,
      };
    }
    if (
      last &&
      attempts.length >= COUNCIL_RUNS_PER_QUESTION &&
      q.kind !== "visual_call"
    ) {
      return {
        step: "to_didi",
        question: q,
        lastRunId: last.id,
        reason: `the Council's ${attempts.length} runs gave no usable answer; the last ended ${last.outcome ?? "without an outcome"}`,
      };
    }
    return {
      step: "start",
      question: q,
      nodeId: q.nodeId,
      attempt: attempts.length + 1,
    };
  }

  /** The escalation move into the Council state: the last applied one into it. */
  async function escalationMove(nodeId: string): Promise<Transition | undefined> {
    return (await store.listTransitions(nodeId))
      .filter((t) => t.mode === "applied" && t.toState === councilState)
      .at(-1);
  }

  async function escalationTaskInput(q: EscalationQuestion): Promise<string> {
    const node = (await store.getNode(q.nodeId)) as Node;
    const move = await escalationMove(node.id);
    const why: string[] = [];
    if (move?.reason) why.push(move.reason);
    if (Array.isArray(move?.guardResult)) {
      for (const check of move.guardResult) {
        const detail = field(check, "detail");
        if (field(check, "pass") === true && typeof detail === "string")
          why.push(detail);
      }
    }
    const failures = (
      await store.listEvidence({ nodeId: node.id, kind: "failure_count" })
    ).map((e) => ({
      cause: String(field(e.payload, "cause") ?? ""),
      failedGuards: textList(field(e.payload, "failedGuards")),
      commitSha: e.commitSha,
    }));
    const failedVerdict = (
      await store.listEvidence({ nodeId: node.id, kind: "qa_verdict" })
    )
      .map((e) => ({ e, verdict: readQaVerdict(e.payload) }))
      .filter((v) => v.verdict?.verdict === "fail")
      .at(-1);
    const stagingFails = [];
    for (const kind of ["staging_check", "staging_deploy_failed"] as const) {
      for (const e of await store.listEvidence({ nodeId: node.id, kind })) {
        if (kind === "staging_check" && field(e.payload, "pass") !== false) continue;
        stagingFails.push({ kind, commitSha: e.commitSha, at: e.recordedAt });
      }
    }
    stagingFails.sort((a, b) => a.at.getTime() - b.at.getTime());
    return escalationInput({
      node,
      escalatedFrom: move?.fromState ?? null,
      why,
      counters: {
        failure: await store.getCounter(node.id, "failure"),
        qaRound: await store.getCounter(node.id, "qa_round"),
      },
      failures,
      qaFail: failedVerdict
        ? {
            commitSha: failedVerdict.e.commitSha,
            findings: failedVerdict.verdict?.findings ?? [],
          }
        : null,
      stagingFails: stagingFails.map(({ kind, commitSha }) => ({ kind, commitSha })),
      scopeUpdates: await scopeUpdatesOf(node.id),
    });
  }

  /** The findings folded into a scanner idea, as the Council's input shows them (D-301). */
  async function scopeUpdatesOf(nodeId: string): Promise<ScopeUpdateView[]> {
    return (await store.listEvidence({ nodeId, kind: "scan_scope_update" })).map(
      (e) => {
        const line = field(e.payload, "line");
        return {
          check: textOf(field(e.payload, "check")) ?? "",
          path: textOf(field(e.payload, "path")) ?? "",
          line: typeof line === "number" ? line : null,
          target: textOf(field(e.payload, "target")),
          commitSha: e.commitSha,
        };
      },
    );
  }

  async function scannerGoneTaskInput(q: ScannerGoneQuestion): Promise<string> {
    const node = (await store.getNode(q.nodeId)) as Node;
    const workItems: Node[] = [];
    for (const edge of await store.listEdges({
      fromNode: node.id,
      type: "split_into",
    })) {
      const item = await store.getNode(edge.toNode);
      if (item) workItems.push(item);
    }
    return scannerGoneInput({
      node,
      scopeUpdates: await scopeUpdatesOf(node.id),
      notFoundAt: (
        await store.listEvidence({ nodeId: node.id, kind: "scan_not_found" })
      ).map((e) => e.commitSha),
      workItems,
    });
  }

  async function stillNeededTaskInput(q: StillNeededQuestion): Promise<string> {
    const node = (await store.getNode(q.nodeId)) as Node;
    const gate = await store.getGateRequest(q.gateRequestId);
    const payload = gate?.payload;
    const mergedId = textOf(field(payload, "mergedNodeId"));
    const merged = mergedId ? await store.getNode(mergedId) : null;
    return stillNeededInput({
      node,
      reason: q.reason,
      ...(merged
        ? {
            merged: {
              node: merged,
              commitSha: textOf(field(payload, "mergeCommitSha")),
              folders: textList(field(payload, "folders")),
            },
          }
        : {}),
      ...(q.reason === "merged_change"
        ? {}
        : { words: textOf(field(payload, "words")) }),
    });
  }

  async function councilPlanTaskInput(q: CouncilPlanQuestion): Promise<string> {
    const node = (await store.getNode(q.nodeId)) as Node;
    const scopeUpdates = q.source === "scanner" ? await scopeUpdatesOf(node.id) : [];
    if (!q.replan) return councilPlanInput({ node, source: q.source, scopeUpdates });
    const answer = await store.getDecision(q.replan.answerId);
    const plan = await store.getDecision(q.replan.planId);
    const outcome = answer ? planReturnOutcome(answer) : null;
    return councilPlanInput({
      node,
      source: q.source,
      scopeUpdates,
      ...(answer && plan && outcome
        ? { sentBack: { plan: plan.textVerbatim, outcome, words: answer.textVerbatim } }
        : {}),
    });
  }

  async function reversalTaskInput(q: ReversalQuestion): Promise<string> {
    const decision = await store.getDecision(q.decisionId);
    const staleItems: Node[] = [];
    for (const id of q.staleNodeIds) {
      const node = await store.getNode(id);
      if (node) staleItems.push(node);
    }
    const didi = q.didiDecisionId ? await store.getDecision(q.didiDecisionId) : null;
    return reversalInput({
      decision: {
        id: q.decisionId,
        kind: decision?.kind ?? "",
        byActor: decision?.byActor ?? "",
        textVerbatim: decision?.textVerbatim ?? "",
        recordedAt: decision?.recordedAt ?? q.openedAt,
      },
      reason: q.reason,
      staleItems,
      didiAnswer: didi
        ? {
            outcome: textOf(scopeOf(didi).outcome),
            words: didi.textVerbatim,
            recordedAt: didi.recordedAt,
          }
        : null,
    });
  }

  /** Whether another open reversal question, the Council's or Didi's, still names the node. */
  async function staleForAnother(
    tx: StoreOps,
    projectId: string,
    topicKey: string,
    nodeId: string,
  ): Promise<boolean> {
    return (await tx.listOpenGateRequests(projectId)).some(
      (g) =>
        g.topicKey.startsWith(REVERSAL_PREFIX) &&
        g.topicKey !== topicKey &&
        [
          ...textList(field(g.payload, "staleNodeIds")),
          ...textList(field(g.payload, "nodeIds")),
        ].includes(nodeId),
    );
  }

  /** The switches, read inside the transaction that writes. */
  async function held(tx: StoreOps): Promise<"kill_switch" | "dry_run" | null> {
    if ((await tx.getSetting("kill_switch"))?.value === true) return "kill_switch";
    if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
    return null;
  }

  async function recordEscalation(
    run: Run & { nodeId: string },
    q: EscalationQuestion,
    answer: EscalationAnswer,
  ): Promise<CouncilAnswer> {
    const decision: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      kind: "council_decision",
      scope: {
        topicKey: q.topicKey,
        runId: run.id,
        outcome: answer.outcome,
        changesProductDirection: answer.changesProductDirection,
        passesGate: answer.passesGate,
      },
      textVerbatim: answer.note,
      byActor: "council",
      recordedAt: clock.now(),
    };
    return store.transaction(async (tx): Promise<CouncilAnswer> => {
      const switches = await held(tx);
      if (switches) return { recorded: false, reason: switches };
      // The node's row lock makes the check and the insert one at a time per item.
      const node = await tx.getNodeForUpdate(q.nodeId);
      const earlier = (await tx.listDecisionsForNode(q.nodeId)).find(
        (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
      );
      if (earlier) {
        return {
          recorded: "already_recorded",
          kind: "escalation",
          decisionId: earlier.id,
        };
      }
      if (
        !node ||
        node.state !== councilState ||
        node.stateSince.getTime() > run.startedAt.getTime() ||
        (await latestCouncilDecision({ node, store: tx }))
      ) {
        return { recorded: false, reason: "question_closed" };
      }
      await tx.insertDecision(decision);
      return { recorded: true, kind: "escalation", decisionId: decision.id };
    });
  }

  /**
   * Records a visual call, or its drop, on the call's own topic (D-270): once per run and once per
   * visual-approval request, while the request is still open. The item's row is the only lock, so
   * two answers for the same request write one. It never touches the request.
   */
  async function writeVisualCall(
    q: VisualCallQuestion,
    runId: string,
    call: string,
    text: string,
    unsure?: boolean,
  ): Promise<VisualCallRecord> {
    const decision: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      kind: "council_decision",
      scope: {
        topicKey: q.topicKey,
        gateRequestId: q.gateRequestId,
        call,
        runId,
        ...(unsure === undefined ? {} : { unsure }),
      },
      textVerbatim: text,
      byActor: "council",
      recordedAt: clock.now(),
    };
    return store.transaction(async (tx): Promise<VisualCallRecord> => {
      const switches = await held(tx);
      if (switches) return { recorded: false, reason: switches };
      await tx.getNodeForUpdate(q.nodeId);
      const decisions = await tx.listDecisionsForNode(q.nodeId);
      const earlier = decisions.find(
        (d) =>
          d.kind === "council_decision" &&
          scopeOf(d).topicKey === q.topicKey &&
          scopeOf(d).runId === runId,
      );
      if (earlier) return { recorded: "already_recorded", decisionId: earlier.id };
      if (recordedCall(decisions, q.nodeId, q.gateRequestId)) {
        return { recorded: false, reason: "question_closed" };
      }
      if ((await tx.getGateRequest(q.gateRequestId))?.status !== "open") {
        return { recorded: false, reason: "question_closed" };
      }
      await tx.insertDecision(decision);
      return { recorded: true, decisionId: decision.id };
    });
  }

  async function recordVisualCall(
    run: Run,
    q: VisualCallQuestion,
    answer: VisualCallAnswer,
  ): Promise<CouncilAnswer> {
    const written = await writeVisualCall(
      q,
      run.id,
      answer.call,
      answer.reason,
      answer.unsure,
    );
    return written.recorded === false
      ? { recorded: false, reason: written.reason }
      : {
          recorded: written.recorded,
          kind: "visual_call",
          decisionId: written.decisionId,
        };
  }

  /** The `escalation` request for Didi on a scanner idea's or an item's question topic (D-301). */
  function scannerGoneDidiGate(
    q: ScannerGoneQuestion | StillNeededQuestion,
    question: string,
    extra: { [key: string]: Json },
    at: Date,
  ): GateRequest {
    return {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      topicKey: q.topicKey,
      kind: "escalation",
      owner: "didi",
      blocking: false,
      payload: { question, commitSha: q.commitSha, ...extra },
      approvalUrl: null,
      status: "open",
      decisionId: null,
      supersededBy: null,
      createdAt: at,
      answeredAt: null,
      lastNotifiedAt: null,
    };
  }

  /**
   * Records the Council's answer on a scanner idea that is no longer found (D-301), or on whether
   * a work item is still needed (D-308): the decision on the node and its request answered, once
   * per run and while the request is open, and for a `cannot_decide` one `escalation` request for
   * Didi on the same topic. A `stop` opens nothing here: the cancel step acts on it after the
   * run's end, under the approver rule (./cancel.ts). The node's row is the lock. Nothing here
   * moves a node.
   */
  async function recordScannerGone(
    run: Run & { nodeId: string },
    q: ScannerGoneQuestion | StillNeededQuestion,
    answer: ScannerGoneAnswer,
  ): Promise<CouncilAnswer> {
    const at = clock.now();
    const decision: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      kind: "council_decision",
      scope: {
        topicKey: q.topicKey,
        gateRequestId: q.gateRequestId,
        runId: run.id,
        verdict: answer.verdict,
        ...(q.kind === "still_needed"
          ? { reason: q.reason }
          : { commitSha: q.commitSha }),
      },
      textVerbatim: answer.note,
      byActor: "council",
      recordedAt: at,
    };
    return store
      .transaction(async (tx): Promise<CouncilAnswer> => {
        const switches = await held(tx);
        if (switches) return { recorded: false, reason: switches };
        await tx.getNodeForUpdate(q.nodeId);
        const earlier = (await tx.listDecisionsForNode(q.nodeId)).find(
          (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
        );
        if (earlier) {
          return {
            recorded: "already_recorded",
            kind: q.kind,
            decisionId: earlier.id,
          };
        }
        await tx.insertDecision(decision);
        const closed = await tx.closeGateRequest(q.gateRequestId, {
          status: "answered",
          decisionId: decision.id,
          at,
        });
        if (!closed) throw new NotRecorded();
        let didiGateRequestId: string | null = null;
        if (answer.verdict === "cannot_decide") {
          const gate = scannerGoneDidiGate(
            q,
            q.kind === "still_needed"
              ? STILL_NEEDED_DIDI.cannot_decide
              : SCANNER_GONE_DIDI.cannot_decide,
            { councilDecisionId: decision.id, councilNote: answer.note },
            at,
          );
          await tx.insertGateRequest(gate);
          didiGateRequestId = gate.id;
        }
        return {
          recorded: true,
          kind: q.kind,
          decisionId: decision.id,
          didiGateRequestId,
          ...(answer.verdict === "stop" ? { cancelDue: true as const } : {}),
        };
      })
      .catch((error: unknown) => {
        if (error instanceof NotRecorded)
          return { recorded: false, reason: error.reason };
        throw error;
      });
  }

  /**
   * Records the Council's plan for a scanner idea (D-307), once per run and while the question is
   * open: the plan as a `plan_proposal` council decision with the call on Didi, and the product
   * direction as a `product_direction` decision, in one transaction under the idea's row lock.
   * The plan approval step then acts on it (./plans.ts).
   */
  async function recordCouncilPlan(
    run: Run & { nodeId: string },
    q: CouncilPlanQuestion,
    answer: CouncilPlanAnswer,
  ): Promise<CouncilAnswer> {
    const at = clock.now();
    const direction: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      kind: "product_direction",
      scope: { source: "council_plan", topicKey: q.topicKey, runId: run.id },
      textVerbatim: answer.productDirection,
      byActor: "council",
      recordedAt: at,
    };
    const decision: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      kind: "council_decision",
      scope: {
        kind: PLAN_PROPOSAL_KIND,
        topicKey: q.topicKey,
        runId: run.id,
        needsDidi: answer.needsDidi as unknown as Json,
        productDirection: answer.productDirection,
        directionDecisionId: direction.id,
        // A replan names Didi's answer it follows (D-316 (3)).
        ...(q.replan ? { replanOf: q.replan.answerId } : {}),
      },
      textVerbatim: answer.plan,
      byActor: "council",
      recordedAt: at,
    };
    return store.transaction(async (tx): Promise<CouncilAnswer> => {
      const switches = await held(tx);
      if (switches) return { recorded: false, reason: switches };
      await tx.getNodeForUpdate(q.nodeId);
      const earlier = (await tx.listDecisionsForNode(q.nodeId)).find(
        (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
      );
      if (earlier) {
        return { recorded: "already_recorded", kind: "plan", decisionId: earlier.id };
      }
      // Still open, and still the same question: a replan for a later answer is not this one.
      const open = await councilPlanQuestion(tx, q.nodeId);
      if (!open || open.replan?.answerId !== q.replan?.answerId) {
        return { recorded: false, reason: "question_closed" };
      }
      await tx.insertDecision(direction);
      await tx.insertDecision(decision);
      return { recorded: true, kind: "plan", decisionId: decision.id };
    });
  }

  /** The redo move out of the node's state, for its track, if any (D-231). */
  function redoMove(node: Node): TransitionContract | undefined {
    return contracts.transitions.find(
      (m) =>
        !m.escalation &&
        m.from === node.state &&
        m.guards.includes(REDO_GUARD) &&
        (!m.tracks || (node.track !== null && m.tracks.includes(node.track))),
    );
  }

  /** Runs on the node that block its redo move: every active run but the Council's. */
  const blockingRuns = (runs: readonly Run[]) =>
    runs.filter((r) => r.endedAt === null && r.bot !== "council");

  async function recordReversal(
    run: Run & { nodeId: string },
    q: ReversalQuestion,
    answer: ReversalAnswer,
  ): Promise<CouncilAnswer> {
    const at = clock.now();
    const decisionId = ids.next();
    const scope = {
      topicKey: q.topicKey,
      runId: run.id,
      reversedDecisionId: q.decisionId,
      verdicts: answer.verdicts.map((v) => ({ ...v })),
    };
    return store
      .transaction(async (tx): Promise<CouncilAnswer> => {
        const switches = await held(tx);
        if (switches) return { recorded: false, reason: switches };
        // Lock the run's node and every item the answer names once, in one sorted order. Locking
        // them in the answer's own order would let two answers naming the same items in opposite
        // orders each hold one and wait on the other: a deadlock.
        const lockIds = [
          ...new Set([run.nodeId, ...answer.verdicts.map((v) => v.nodeId)]),
        ].sort();
        for (const lockId of lockIds) await tx.getNodeForUpdate(lockId);
        const earlier = (await tx.listDecisionsForNode(run.nodeId)).find(
          (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
        );
        if (earlier) {
          return {
            recorded: "already_recorded",
            kind: "reversal",
            decisionId: earlier.id,
          };
        }
        // The answer as it will be recorded, so each item's stale episode can include it.
        const pending: CurrentDecision = {
          id: decisionId,
          projectId: q.projectId,
          nodeId: run.nodeId,
          kind: "council_decision",
          scope: { ...scope, clearedNodeIds: [] },
          textVerbatim: answer.note,
          byActor: "council",
          recordedAt: at,
          status: "active",
          replacedById: null,
          statusChangedAt: null,
        };
        const verdicts: AppliedVerdict[] = [];
        const undecided: string[] = [];
        const linked: string[] = [];
        const cleared: string[] = [];
        for (const { nodeId, verdict } of answer.verdicts) {
          // Already locked above, in sorted order.
          const node = await tx.getNode(nodeId);
          if (!node) {
            verdicts.push({ nodeId, verdict, result: "no_node" });
            continue;
          }
          linked.push(nodeId);
          if (verdict === "cannot_decide") {
            undecided.push(nodeId);
            verdicts.push({ nodeId, verdict, result: "to_didi" });
            continue;
          }
          const episode = redoState(
            nodeId,
            [...(await tx.listDecisionsForNode(nodeId)), pending],
            await tx.listTransitions(nodeId),
            await reworkedAt(tx, nodeId),
          );
          if (
            episode.kind === "unsettled" ||
            (await staleForAnother(tx, q.projectId, q.topicKey, nodeId))
          ) {
            verdicts.push({ nodeId, verdict, result: "stale_for_another_reversal" });
            continue;
          }
          // Redo needs the item back at the start of its track. One still in an initial state has
          // built nothing yet, so clearing its flag lets the dispatch start the work again.
          if (episode.kind === "redo" && !stateOf(node.state)?.initial) {
            const merged = await isMerged({ node, store: tx });
            verdicts.push({
              nodeId,
              verdict,
              result: merged ? "rework_due" : "redo_move_due",
            });
            continue;
          }
          await tx.setNodeFlags(nodeId, { stale: false }, at);
          cleared.push(nodeId);
          verdicts.push({ nodeId, verdict, result: "cleared" });
        }
        const decision: Decision = {
          id: decisionId,
          projectId: q.projectId,
          nodeId: run.nodeId,
          kind: "council_decision",
          scope: { ...scope, clearedNodeIds: cleared },
          textVerbatim: answer.note,
          byActor: "council",
          recordedAt: at,
        };
        await tx.insertDecision(decision);
        // The question closes once: a second answer finds it closed and rolls back.
        const closed = await tx.closeGateRequest(q.gateRequestId, {
          status: "answered",
          decisionId: decision.id,
          at,
        });
        if (!closed) throw new NotRecorded();
        for (const nodeId of linked) await tx.linkNodeToDecision(nodeId, decision.id);
        let didiGateRequestId: string | null = null;
        if (undecided.length > 0) {
          const gate: GateRequest = {
            id: ids.next(),
            projectId: q.projectId,
            nodeId: (await tx.getGateRequest(q.gateRequestId))?.nodeId ?? null,
            topicKey: q.topicKey,
            kind: "escalation",
            owner: "didi",
            blocking: true,
            payload: {
              question:
                "A decision was reversed, and the Council could not decide whether the work on these items still stands.",
              decisionId: q.decisionId,
              nodeIds: undecided,
              councilDecisionId: decision.id,
              councilNote: answer.note,
            },
            approvalUrl: null,
            status: "open",
            decisionId: null,
            supersededBy: null,
            createdAt: at,
            answeredAt: null,
            lastNotifiedAt: null,
          };
          await tx.insertGateRequest(gate);
          didiGateRequestId = gate.id;
        }
        return {
          recorded: true,
          kind: "reversal",
          decisionId: decision.id,
          verdicts,
          didiGateRequestId,
        };
      })
      .catch((error: unknown) => {
        if (error instanceof NotRecorded)
          return { recorded: false, reason: error.reason };
        throw error;
      });
  }

  /** Where the item's redo stands, writing nothing (D-231). */
  async function redoCheck(
    nodeId: string,
  ): Promise<Exclude<RedoStep, { step: "moved" }>> {
    const node = await store.getNode(nodeId);
    if (!node) return { nodeId, step: "no_node" };
    if (!node.stale) return { nodeId, step: "not_stale" };
    const episode = redoState(
      nodeId,
      await store.listDecisionsForNode(nodeId),
      await store.listTransitions(nodeId),
      await reworkedAt(store, nodeId),
    );
    if (episode.kind !== "redo") return { nodeId, step: "not_due", why: episode.kind };
    const councilDecisionId = episode.decision.id;
    if (await isMerged({ node, store })) {
      return { nodeId, step: "rework_due", councilDecisionId };
    }
    const move = redoMove(node);
    if (!move) return { nodeId, step: "no_move", councilDecisionId, state: node.state };
    return {
      nodeId,
      step: "due",
      councilDecisionId,
      toState: move.to,
      activeRunIds: blockingRuns(await store.listRuns({ nodeId })).map((r) => r.id),
    };
  }

  /**
   * The writes that commit with the redo move: the redo still stands (read again under the move's
   * transaction), no run but the Council's is active, the flag cleared, both counters reset and
   * the open visual-approval request cancelled.
   */
  const redoWrites =
    (nodeId: string, councilDecisionId: string): AlsoWrite =>
    async (tx) => {
      // A plain read: the move's own update already holds this row's lock in this transaction.
      // Asking for FOR UPDATE here would wait on the key-share lock a racing move's transition
      // insert holds on the same row, while that move waits on this one: a deadlock.
      const node = await tx.getNode(nodeId);
      if (!node) return "no_node";
      // This move's own row is already written in the transaction: it is not an earlier redo.
      const trigger = `${REDO_TRIGGER}${councilDecisionId}`;
      const episode = redoState(
        nodeId,
        await tx.listDecisionsForNode(nodeId),
        (await tx.listTransitions(nodeId)).filter((t) => t.triggerRef !== trigger),
        await reworkedAt(tx, nodeId),
      );
      if (episode.kind !== "redo" || episode.decision.id !== councilDecisionId) {
        return "redo_not_due";
      }
      if (blockingRuns(await tx.listRuns({ nodeId })).length > 0) return "run_active";
      const at = clock.now();
      await tx.setNodeFlags(nodeId, { stale: false }, at);
      await tx.setCounter(nodeId, "failure", 0, at);
      await tx.setCounter(nodeId, "qa_round", 0, at);
      const approval = await tx.findOpenGateRequest(
        node.projectId,
        visualApprovalTopic(nodeId),
      );
      if (approval) await tx.closeGateRequest(approval.id, { status: "cancelled", at });
      return null;
    };

  /** The start state of a track: where its redo moves lead (D-231). */
  function trackStart(track: Node["track"]): string | undefined {
    if (track === null) return undefined;
    return contracts.transitions.find(
      (m) => m.guards.includes(REDO_GUARD) && (!m.tracks || m.tracks.includes(track)),
    )?.to;
  }

  /** The rework item a Council decision opened for the original, if any. */
  async function reworkOf(
    tx: StoreOps,
    nodeId: string,
    councilDecisionId: string,
  ): Promise<string | null> {
    for (const edge of await tx.listEdges({ toNode: nodeId, type: REWORK_EDGE })) {
      const rework = await tx.getNode(edge.fromNode);
      if (
        field(field(rework?.body, "rework"), "councilDecisionId") === councilDecisionId
      ) {
        return edge.fromNode;
      }
    }
    return null;
  }

  /** The body of a rework item: the runner's words, with the Council's notes quoted as data. */
  function reworkBody(
    original: Node,
    answer: CurrentDecision,
    mergeCommit: string | null,
  ): Json {
    const scope = scopeOf(answer);
    const reversedDecisionId = textOf(scope.reversedDecisionId) ?? "";
    const verdicts = Array.isArray(scope.verdicts) ? scope.verdicts : [];
    const itemNote =
      textOf(
        field(
          verdicts.find((v) => field(v, "nodeId") === original.id),
          "note",
        ),
      ) ?? "";
    const description = [
      `This item reworks item ${original.id}, which is already merged${mergeCommit ? ` (merge commit ${mergeCommit})` : ""}. Decision ${reversedDecisionId} that it relied on was reversed, and Council decision ${answer.id} gave it redo. Undo or rework the merged change as the Council's note says; nothing reverts main for you.`,
      "The Council's note for the item, as the Council wrote it:",
      itemNote.trim() === "" ? "(no note for the item)" : quoted(itemNote),
      "The Council's note on the whole answer:",
      answer.textVerbatim.trim() === "" ? "(no note)" : quoted(answer.textVerbatim),
    ].join("\n\n");
    return {
      description,
      rework: {
        originalNodeId: original.id,
        councilDecisionId: answer.id,
        reversedDecisionId,
        councilNote: itemNote,
      },
    };
  }

  /**
   * Opens the rework item for a merged item whose redo stands (D-233), with its `reworks` edge to
   * the original and the original's stale flag cleared, in one transaction that locks only the
   * original. Once per (Council decision, original item): a repeat, or a racing call that waits
   * on the lock, finds the item opened and writes nothing. Dry run and the kill switch write
   * nothing.
   */
  async function rework(nodeId: string, councilDecisionId: string): Promise<RedoStep> {
    const refused = (reason: string): RedoStep => ({
      nodeId,
      step: "reworked",
      councilDecisionId,
      outcome: "refused",
      reworkNodeId: null,
      reason,
    });
    return store.transaction(async (tx): Promise<RedoStep> => {
      const switches = await held(tx);
      if (switches) return refused(switches);
      // The only node locked: the new item is inserted, never locked.
      const node = await tx.getNodeForUpdate(nodeId);
      if (!node) return refused("no_node");
      const earlier = await reworkOf(tx, nodeId, councilDecisionId);
      if (earlier) {
        return {
          nodeId,
          step: "reworked",
          councilDecisionId,
          outcome: "already_created",
          reworkNodeId: earlier,
        };
      }
      if (!node.stale) return refused("not_stale");
      const episode = redoState(
        nodeId,
        await tx.listDecisionsForNode(nodeId),
        await tx.listTransitions(nodeId),
        await reworkedAt(tx, nodeId),
      );
      if (episode.kind !== "redo" || episode.decision.id !== councilDecisionId) {
        return refused("redo_not_due");
      }
      const merges = (await tx.listEvidence({ nodeId, kind: "merge_commit" })).filter(
        (e) => e.commitSha !== null,
      );
      if (merges.length === 0) return refused("not_merged");
      const start = trackStart(node.track);
      const startState = start ? stateOf(start) : undefined;
      if (!start || !startState?.initial) return refused("no_start_state");
      const at = clock.now();
      const title = `${REWORK_TITLE_PREFIX}${node.title}`;
      const created: Node = {
        id: ids.next(),
        projectId: node.projectId,
        type: "work_item",
        track: node.track,
        state: start,
        substate: null,
        ownerRole: (startState.owner ?? "runner").toLowerCase(),
        title:
          title.length <= REWORK_TITLE_CHARS
            ? title
            : title.slice(0, REWORK_TITLE_CHARS),
        body: reworkBody(node, episode.decision, merges.at(-1)?.commitSha ?? null),
        hold: node.hold,
        agentReady: node.agentReady,
        stale: false,
        blockedReason: null,
        stateSince: at,
        linearIssueId: null,
        linearStatusSynced: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      };
      await tx.insertNode(created);
      await tx.insertEdge({
        id: ids.next(),
        fromNode: created.id,
        toNode: nodeId,
        type: REWORK_EDGE,
        createdAt: at,
      });
      await tx.setNodeFlags(nodeId, { stale: false }, at);
      return {
        nodeId,
        step: "reworked",
        councilDecisionId,
        outcome: "created",
        reworkNodeId: created.id,
      };
    });
  }

  /**
   * Takes the item's redo move when it is due and no run but the Council's is active on it: back
   * to the start of its track, with the writes above, once per Council decision (trigger
   * `council_redo:<decision id>`). These writes are acts, so dry run refuses and writes nothing,
   * and the kill switch refuses, as for every move. A merged item gets its rework item instead.
   */
  async function redo(nodeId: string): Promise<RedoStep> {
    const check = await redoCheck(nodeId);
    if (check.step === "rework_due") return rework(nodeId, check.councilDecisionId);
    if (check.step !== "due") return check;
    const { councilDecisionId, toState } = check;
    const result = await library.requestTransitionOnce(
      {
        nodeId,
        toState,
        trigger: { kind: "event", ref: `${REDO_TRIGGER}${councilDecisionId}` },
        actor: { kind: "runner", id: "council" },
        reason: "the Council gave it redo after a reversal",
        runnerOnly: true,
      },
      redoWrites(nodeId, councilDecisionId),
    );
    return {
      nodeId,
      step: "moved",
      councilDecisionId,
      toState,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.transitionId ? { transitionId: result.transitionId } : {}),
      failedGuards: result.guardReport.filter((c) => !c.pass).map((c) => c.name),
    };
  }

  /**
   * Whether the reversal's topic is due a follow-up after Didi's answer (D-234), read through the
   * store or a transaction: no question is open on the topic, Didi answered the latest gate request
   * Didi was asked on it, no request on the topic carries that answer yet, and some item Didi was
   * asked about is still stale.
   */
  async function followUpDue(
    ops: StoreOps,
    topicKey: string,
  ): Promise<FollowUpDue | Extract<FollowUpStep, { step: "not_due" }>> {
    const notDue = (why: Extract<FollowUpStep, { step: "not_due" }>["why"]) => ({
      topicKey,
      step: "not_due" as const,
      why,
    });
    if (!topicKey.startsWith(REVERSAL_PREFIX)) return notDue("no_decision");
    const decisionId = topicKey.slice(REVERSAL_PREFIX.length);
    const decision = await ops.getDecision(decisionId);
    if (!decision) return notDue("no_decision");
    const gates = await ops.listGateRequests(decision.projectId, topicKey);
    if (gates.some((g) => g.status === "open")) return notDue("open_question");
    const didiGate = gates
      .filter(
        (g) =>
          g.owner === "didi" &&
          g.kind === "escalation" &&
          g.status === "answered" &&
          g.decisionId !== null,
      )
      .at(-1);
    if (!didiGate?.decisionId) return notDue("no_didi_answer");
    const didiDecisionId = didiGate.decisionId;
    if (gates.some((g) => field(g.payload, "didiDecisionId") === didiDecisionId)) {
      return notDue("already_followed_up");
    }
    const askedNodeIds = textList(field(didiGate.payload, "nodeIds"));
    const staleNodeIds: string[] = [];
    for (const id of askedNodeIds) {
      if ((await ops.getNode(id))?.stale) staleNodeIds.push(id);
    }
    if (staleNodeIds.length === 0) return notDue("nothing_stale");
    const first = gates.find((g) => g.kind === "council_question");
    return {
      projectId: decision.projectId,
      nodeId: didiGate.nodeId,
      decisionId,
      didiGate,
      didiDecisionId,
      askedNodeIds,
      staleNodeIds,
      reason: textOf(field(first?.payload, "reason")),
    };
  }

  /**
   * Opens the follow-up Council question on a reversal after Didi's answer (D-234): one
   * `council_question` owned by the Council on the same topic, for the items still stale from
   * Didi's gate request, with Didi's decision id, so the Council pass starts its run. Live mode
   * only, read inside the transaction that writes: under the kill switch or in dry run Didi's
   * answer stays recorded and nothing acts on it (D-201). The transaction locks every item Didi
   * was asked about and the request's node once, up front, in sorted id order, then reads again,
   * so two calls open one question.
   */
  async function followUp(topicKey: string): Promise<FollowUpStep> {
    const first = await followUpDue(store, topicKey);
    if (!("didiGate" in first)) return first;
    return store
      .transaction(async (tx): Promise<FollowUpStep> => {
        const switches = await held(tx);
        if (switches) return { topicKey, step: "held", reason: switches };
        const lockIds = [
          ...new Set(
            [first.nodeId, ...first.askedNodeIds].filter(
              (id): id is string => id !== null,
            ),
          ),
        ].sort();
        for (const lockId of lockIds) await tx.getNodeForUpdate(lockId);
        const due = await followUpDue(tx, topicKey);
        if (!("didiGate" in due)) return due;
        const gate: GateRequest = {
          id: ids.next(),
          projectId: due.projectId,
          nodeId: due.nodeId,
          topicKey,
          kind: "council_question",
          owner: "council",
          blocking: true,
          payload: {
            decisionId: due.decisionId,
            reason: due.reason,
            staleNodeIds: due.staleNodeIds,
            didiDecisionId: due.didiDecisionId,
            didiGateRequestId: due.didiGate.id,
          },
          approvalUrl: null,
          status: "open",
          decisionId: null,
          supersededBy: null,
          createdAt: clock.now(),
          answeredAt: null,
          lastNotifiedAt: null,
        };
        await tx.insertGateRequest(gate);
        return {
          topicKey,
          step: "opened",
          gateRequestId: gate.id,
          didiDecisionId: due.didiDecisionId,
          staleNodeIds: due.staleNodeIds,
        };
      })
      .catch((error: unknown): FollowUpStep => {
        // Another question on the topic was opened first (one open request per topic).
        if (
          error instanceof StoreConflictError &&
          error.constraint === "gate_requests_one_open_per_topic"
        ) {
          return { topicKey, step: "not_due", why: "open_question" };
        }
        throw error;
      });
  }

  return {
    question,

    redoCheck,
    redo,

    followUp,

    /**
     * The reversal topics a follow-up may be due on (D-234): every reversed decision a stale item
     * relies on, in the store's node order, each once. Reads only.
     */
    async followUpTopics(): Promise<string[]> {
      const topics = new Set<string>();
      for (const node of await store.listNodes({})) {
        if (!node.stale) continue;
        for (const d of await store.listDecisionsForNode(node.id)) {
          if (d.status === "reversed") topics.add(`${REVERSAL_PREFIX}${d.id}`);
        }
      }
      return [...topics];
    },

    /** The stale items, in the store's node order: where a redo may stand. Reads only. */
    async staleItems(): Promise<string[]> {
      return (await store.listNodes({})).filter((n) => n.stale).map((n) => n.id);
    },

    /** Every open Council question, escalations first, then scanner ideas to plan (D-307). */
    async questions(): Promise<CouncilQuestion[]> {
      const found: CouncilQuestion[] = [];
      if (councilState) {
        for (const node of await store.listNodes({ state: councilState })) {
          const q = await escalationQuestion(node.id);
          if (q) found.push(q);
        }
      }
      for (const state of SUBMITTABLE_STATES) {
        for (const node of await store.listNodes({ state })) {
          const q = await councilPlanQuestion(store, node.id);
          if (q) found.push(q);
        }
      }
      const projectIds = [
        ...new Set((await store.listNodes({})).map((n) => n.projectId)),
      ];
      for (const projectId of projectIds) {
        for (const gate of await store.listOpenGateRequests(projectId)) {
          const q =
            reversalQuestion(gate) ??
            scannerGoneQuestion(gate) ??
            stillNeededQuestion(gate) ??
            (await visualCallQuestion(gate));
          if (q) found.push(q);
        }
      }
      return found;
    },

    next,

    /**
     * What a Council run on the topic starts with: its input (src/core/council-input.ts) and the
     * output schema of its question's kind. Null when the question is not open.
     */
    async taskFor(topicKey: string): Promise<
      | {
          question: CouncilQuestion;
          input: string;
          outputSchema: Record<string, unknown>;
          /** `council`, or `council:visual` for a visual call (D-270). */
          taskType: string;
          /** A visual call: the option screenshots, labelled, one per option. */
          images?: VisualImage[];
        }
      /** A visual call whose option screenshots cannot be read: no run is started. */
      | {
          question: VisualCallQuestion;
          refused: VisualCallRefusal;
          input?: undefined;
          outputSchema?: undefined;
        }
      | null
    > {
      const q = await question(topicKey);
      if (!q) return null;
      const outputSchema = structuredClone(councilSchema(options.bots, q.kind));
      if (q.kind === "visual_call") {
        const read = await visualCallImages(store, options.screenshots, q);
        if ("refused" in read) return { question: q, refused: read.refused };
        const node = (await store.getNode(q.nodeId)) as Node;
        return {
          question: q,
          input: visualCallInput({
            node,
            imageLabels: read.images.map((i) => i.label),
          }),
          outputSchema,
          taskType: VISUAL_CALL_TASK_TYPE,
          images: read.images,
        };
      }
      const input =
        q.kind === "escalation"
          ? await escalationTaskInput(q)
          : q.kind === "scanner_gone"
            ? await scannerGoneTaskInput(q)
            : q.kind === "still_needed"
              ? await stillNeededTaskInput(q)
              : q.kind === "plan"
                ? await councilPlanTaskInput(q)
                : await reversalTaskInput(q);
      return { question: q, input, outputSchema, taskType: "council" };
    },

    /**
     * Validates a finished Council run's structured answer against its question's schema and
     * records the `council_decision` (D-228), once per run. A reversal answer is applied in the
     * same transaction (D-229). The agent's text outside the answer is never read.
     */
    async recordAnswer(runId: string, structured: unknown): Promise<CouncilAnswer> {
      const found = await store.getRun(runId);
      if (!found) return { recorded: false, reason: "no_run" };
      if (found.bot !== "council" || !found.questionTopic || !found.nodeId) {
        return { recorded: false, reason: "not_a_council_run" };
      }
      const run = found as Run & { nodeId: string };
      // The question first, then this run's own record: a run end racing another end of the same
      // run that records the answer (and so closes the question) in between then still finds that
      // record and reports `already_recorded`, never `question_closed`.
      const q = await question(found.questionTopic);
      const earlier = await decisionOfRun(run);
      if (earlier) {
        return {
          recorded: "already_recorded",
          kind: found.questionTopic.startsWith(REVERSAL_PREFIX)
            ? "reversal"
            : found.questionTopic.startsWith(VISUAL_CALL_PREFIX)
              ? "visual_call"
              : found.questionTopic.startsWith(SCANNER_GONE_PREFIX)
                ? "scanner_gone"
                : found.questionTopic.startsWith(STILL_NEEDED_PREFIX)
                  ? "still_needed"
                  : found.questionTopic.startsWith(COUNCIL_PLAN_PREFIX)
                    ? "plan"
                    : "escalation",
          decisionId: earlier.id,
        };
      }
      if (!q) return { recorded: false, reason: "question_closed" };
      // A run started for an earlier question on the same reversal topic (before Didi's answer
      // opened its follow-up, D-234), or for an earlier visual-approval request on the item, does
      // not answer this one.
      if (
        (q.kind === "reversal" ||
          q.kind === "visual_call" ||
          q.kind === "scanner_gone" ||
          q.kind === "still_needed" ||
          (q.kind === "plan" && q.replan !== null)) &&
        run.startedAt.getTime() < q.openedAt.getTime()
      ) {
        return { recorded: false, reason: "question_closed" };
      }
      // First the bot file's schema, then the reader's own checks (D-228).
      const problem = outputProblem(councilSchema(options.bots, q.kind), structured);
      if (problem) return { recorded: false, reason: "invalid", problem };
      if (q.kind === "visual_call") {
        const read = readVisualCallAnswer(structured);
        if ("problem" in read)
          return { recorded: false, reason: "invalid", problem: read.problem };
        return recordVisualCall(run, q, read.answer);
      }
      if (q.kind === "plan") {
        const read = readCouncilPlanAnswer(structured);
        if ("problem" in read)
          return { recorded: false, reason: "invalid", problem: read.problem };
        return recordCouncilPlan(run, q, read.answer);
      }
      if (q.kind === "scanner_gone" || q.kind === "still_needed") {
        const read = readScannerGoneAnswer(structured);
        if ("problem" in read)
          return { recorded: false, reason: "invalid", problem: read.problem };
        return recordScannerGone(run, q, read.answer);
      }
      if (q.kind === "escalation") {
        const read = readEscalationAnswer(structured);
        if ("problem" in read)
          return { recorded: false, reason: "invalid", problem: read.problem };
        return recordEscalation(run, q, read.answer);
      }
      const read = readReversalAnswer(structured, q.staleNodeIds);
      if ("problem" in read)
        return { recorded: false, reason: "invalid", problem: read.problem };
      return recordReversal(run, q, read.answer);
    },

    /**
     * Sends a question with no usable answer to Didi (D-228): for an escalation, one `escalation`
     * gate request on the item's topic and the move to Escalated to Didi; for a reversal, one
     * `escalation` gate request for Didi on the reversal's topic, which replaces the Council's
     * question. Live mode only; the kill switch and dry run open nothing.
     */
    async toDidi(
      q: CouncilQuestion,
      lastRunId: string,
      reason: string,
    ): Promise<
      | { kind: "escalation"; step: EscalationStep }
      | {
          kind: "reversal" | "scanner_gone" | "still_needed" | "plan";
          gateRequestId: string | null;
        }
    > {
      if (q.kind === "escalation") {
        return {
          kind: "escalation",
          step: await escalations.councilUnanswered(q.nodeId, lastRunId, reason),
        };
      }
      // A visual call never goes to Didi (D-270): it is dropped instead (`dropVisualCall`).
      if (q.kind === "visual_call") throw new Error("a visual call never goes to Didi");
      if (q.kind === "plan") {
        // One request for Didi on the topic, not blocking; it closes the Council's question.
        return store.transaction(async (tx) => {
          if (await held(tx)) return { kind: "plan", gateRequestId: null };
          await tx.getNodeForUpdate(q.nodeId);
          // A replan's question counts only requests since Didi's answer (D-316 (2)).
          const earlier = (await tx.listGateRequests(q.projectId, q.topicKey)).filter(
            (g) => !q.replan || g.createdAt.getTime() >= q.openedAt.getTime(),
          );
          if (earlier.length > 0) {
            return { kind: "plan", gateRequestId: earlier[0]?.id ?? null };
          }
          const at = clock.now();
          const gate: GateRequest = {
            id: ids.next(),
            projectId: q.projectId,
            nodeId: q.nodeId,
            topicKey: q.topicKey,
            kind: "escalation",
            owner: "didi",
            blocking: false,
            payload: {
              question: q.replan
                ? COUNCIL_REPLAN_NO_ANSWER
                : q.source === "run_finding"
                  ? COUNCIL_FINDING_PLAN_NO_ANSWER
                  : COUNCIL_PLAN_NO_ANSWER,
              reason,
              lastCouncilRunId: lastRunId,
              ...(q.replan ? { replanOf: q.replan.answerId } : {}),
            },
            approvalUrl: null,
            status: "open",
            decisionId: null,
            supersededBy: null,
            createdAt: at,
            answeredAt: null,
            lastNotifiedAt: null,
          };
          await tx.insertGateRequest(gate);
          return { kind: "plan", gateRequestId: gate.id };
        });
      }
      if (q.kind === "scanner_gone" || q.kind === "still_needed") {
        // One request for Didi on the topic, which replaces the Council's question.
        const kind = q.kind;
        return store.transaction(async (tx) => {
          if (await held(tx)) return { kind, gateRequestId: null };
          const open = await tx.findOpenGateRequest(q.projectId, q.topicKey);
          if (open?.owner === "didi") {
            return { kind, gateRequestId: open.id };
          }
          const at = clock.now();
          const gate = scannerGoneDidiGate(
            q,
            kind === "still_needed"
              ? STILL_NEEDED_DIDI.no_answer
              : SCANNER_GONE_DIDI.no_answer,
            { reason, lastCouncilRunId: lastRunId },
            at,
          );
          if (open) {
            await tx.closeGateRequest(open.id, {
              status: "superseded",
              supersededBy: gate.id,
              at,
            });
          }
          await tx.insertGateRequest(gate);
          return { kind, gateRequestId: gate.id };
        });
      }
      if ((await store.getSetting("kill_switch"))?.value === true)
        return { kind: "reversal", gateRequestId: null };
      if ((await store.getSetting("dry_run"))?.value !== false)
        return { kind: "reversal", gateRequestId: null };
      const open = await store.findOpenGateRequest(q.projectId, q.topicKey);
      if (open?.owner === "didi") return { kind: "reversal", gateRequestId: open.id };
      const gate = await library.openGateRequest({
        projectId: q.projectId,
        nodeId: open?.nodeId ?? null,
        topicKey: q.topicKey,
        kind: "escalation",
        owner: "didi",
        blocking: true,
        payload: {
          question:
            "A decision was reversed, and the Council gave no usable answer on what to redo.",
          decisionId: q.decisionId,
          nodeIds: q.staleNodeIds,
          reason,
          lastCouncilRunId: lastRunId,
        },
      });
      return { kind: "reversal", gateRequestId: gate.id };
    },

    /**
     * Records a visual call with no usable answer after its run and one re-run as dropped (D-270):
     * a `council_decision` on the call's topic with `call: "dropped"`, so the question closes.
     * Nothing goes to Didi and the request is not touched. Live mode only.
     */
    async dropVisualCall(
      q: VisualCallQuestion,
      lastRunId: string,
      reason: string,
    ): Promise<VisualCallRecord> {
      return writeVisualCall(
        q,
        lastRunId,
        VISUAL_CALL_DROPPED,
        `${VISUAL_CALL_DROPPED_TEXT} The runner's reason: ${reason}.`,
      );
    },
  };
}

export type Council = ReturnType<typeof createCouncil>;
