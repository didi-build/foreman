// How Didi's answer on an approval page becomes a decision on its gate request (D-170, D-200,
// D-201, D-254). The page is one form with three fields: Decision (Approve, Request changes or
// Reject), Options (the request's options, any number of them) and Feedback (text). Approve
// records an `approval` by Didi. Reject records an `answer` with the outcome `rejected`. Request
// changes records an `answer` with the outcome `changes_requested`, which
// `changes_requested_recorded` reads (docs/guards.md), and the item goes back for revision.
// Didi's feedback is kept exactly as typed, with the page link and who the page says answered;
// the decision's `recordedAt` is the time. A request opened before D-254 shows the older form
// (Approve, Reject or Changes requested, and a reply); its answer is read the same way
// (flows/lib/approval.ts).
//
// The rules are checked after the form is sent (`approvalAnswerProblem`), since the page cannot
// check them itself: every option named is one the request lists; Approve on a request that lists
// options names exactly one, which becomes the approved option; Request changes may name any
// number (two or more ask the Designer to combine them, with the feedback); Request changes and
// Reject need feedback. An answer that breaks one records nothing, and the approval step opens a
// fresh request on the same topic with a one-line note saying why (the old one is superseded).
//
// A gate kind whose guard reads a special scope gets it here. A `privileged_path` request names
// the head commit it asks about (src/core/merge.ts), and `privileged_paths_approved` reads an
// approval with scope `{kind: "privileged_path", commitSha: <head>}` (docs/guards.md), so the
// answer carries that kind and the request's commit. A request that names no well-formed commit
// gets no `commitSha`, so its approval matches no head and the guard keeps failing.
//
// A `visual_approval` request lists the options it shows (`payload.options`, their names), and
// the page's Options field shows exactly those (`approvalFormEnums`). Approve records the one
// option it names as `scope.option`, which the visual comparison and the Designer's input read as
// the option Didi approved (src/core/visual-comparison.ts, D-242). Request changes and Reject
// record the options they name as `scope.options`, which the Designer's input quotes with the
// feedback. Nothing is guessed from Didi's words.
//
// The answer is recorded even while the kill switch or dry run is on (D-201): recording a fact is
// not acting on it, and the transition flows refuse or write dry-run rows until both are off.
import type { Decision, GateRequest, Json } from "./store.ts";

export type ApprovalChoice = "approve" | "reject" | "changes_requested";

/**
 * The Decision field's labels, exactly as `flows/windmill.yaml` lists them, and what each means
 * (D-254, amending D-200's labels).
 */
export const APPROVAL_CHOICE_LABELS: Readonly<Record<string, ApprovalChoice>> = {
  Approve: "approve",
  "Request changes": "changes_requested",
  Reject: "reject",
};

/**
 * The older form's labels (D-200), still read for a request opened before D-254, whose page
 * shows that form until it is answered or expires.
 */
export const OLDER_FORM_CHOICE_LABELS: Readonly<Record<string, ApprovalChoice>> = {
  Approve: "approve",
  Reject: "reject",
  "Changes requested": "changes_requested",
};

/** One answer from an approval page, as the page sent it. */
export interface ApprovalPageAnswer {
  choice: ApprovalChoice;
  /** Didi's feedback, exactly as typed, never trimmed. Null when the page sent none. */
  words: string | null;
  /** Who the page says answered; `anonymous` on Windmill's free plan (D-170). */
  approvers: string[];
  /** The options the answer names, by name, in the page's order. Left out: none. */
  options?: string[];
}

const OUTCOME: Record<ApprovalChoice, string> = {
  approve: "approved",
  reject: "rejected",
  changes_requested: "changes_requested",
};

export type ApprovalDecision = Omit<Decision, "id" | "recordedAt" | "projectId">;

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The option names a request lists (`payload.options`); only a visual approval lists any. */
export function requestOptions(gate: GateRequest): string[] {
  const payload = gate.payload;
  const options =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload.options
      : undefined;
  return Array.isArray(options)
    ? options.filter((o): o is string => typeof o === "string")
    : [];
}

/**
 * The choices the page's Options field shows for this request, for Windmill's dynamic enums: the
 * approval step returns them with the request (`enums`, checked at deploy, first-hosting runbook
 * step 15). Empty for a request that lists no options.
 */
export const approvalFormEnums = (gate: GateRequest): { options: string[] } => ({
  options: requestOptions(gate),
});

/** The one-line notes a fresh request carries when an answer broke a rule (D-254). */
export const ANSWER_PROBLEMS = {
  unknownOption:
    "The answer named an option this request does not show: pick from the listed options.",
  repeatedOption: "The answer named the same option twice: name each option once.",
  approveNeedsOneOption:
    "Approve needs exactly one option: pick the option you approve.",
  changesNeedFeedback: "Request changes needs feedback: say what to change.",
  rejectNeedsFeedback: "Reject needs feedback: say why.",
  approveQuestionNeedsFeedback:
    "Approve on a question needs feedback: say what you decided, so the work can go on.",
} as const;

/**
 * Gate kinds that put a question to Didi, whose answer the item needs in Didi's own words
 * (`didi_answer_recorded`). On these, Approve needs feedback too (D-257).
 */
const QUESTION_KINDS: ReadonlySet<GateRequest["kind"]> = new Set([
  "escalation",
  "council_question",
]);

/**
 * Why an answer breaks the form's rules (D-254), as a one-line note, or null when it keeps them.
 * Fixed text only: it never quotes Didi's words or an option.
 */
export function approvalAnswerProblem(
  gate: GateRequest,
  answer: ApprovalPageAnswer,
): string | null {
  const listed = requestOptions(gate);
  const named = answer.options ?? [];
  if (named.some((o) => !listed.includes(o))) return ANSWER_PROBLEMS.unknownOption;
  if (new Set(named).size !== named.length) return ANSWER_PROBLEMS.repeatedOption;
  const hasFeedback = answer.words !== null && answer.words.trim() !== "";
  if (answer.choice === "approve") {
    if (listed.length > 0 && named.length !== 1)
      return ANSWER_PROBLEMS.approveNeedsOneOption;
    if (QUESTION_KINDS.has(gate.kind) && !hasFeedback) {
      return ANSWER_PROBLEMS.approveQuestionNeedsFeedback;
    }
    return null;
  }
  if (hasFeedback) return null;
  return answer.choice === "reject"
    ? ANSWER_PROBLEMS.rejectNeedsFeedback
    : ANSWER_PROBLEMS.changesNeedFeedback;
}

/**
 * The options a visual-approval answer records: Approve's one option as `option`, and the options
 * Request changes or Reject name as `options`. Only names the request lists are kept; an answer
 * that names others never gets here (`approvalAnswerProblem`).
 */
function optionScope(
  gate: GateRequest,
  answer: ApprovalPageAnswer,
): { [key: string]: Json } {
  if (gate.kind !== "visual_approval") return {};
  const listed = requestOptions(gate);
  const named = (answer.options ?? []).filter((o) => listed.includes(o));
  if (answer.choice === "approve") {
    return named.length === 1 ? { option: named[0] as string } : {};
  }
  return named.length > 0 ? { options: named } : {};
}

/** The scope fields a gate kind's guard reads, from the gate request itself. */
function guardScope(gate: GateRequest): { [key: string]: Json } {
  if (gate.kind !== "privileged_path") return {};
  const payload = gate.payload;
  const commitSha =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload.commitSha
      : undefined;
  return {
    kind: "privileged_path",
    ...(typeof commitSha === "string" && COMMIT_SHA.test(commitSha)
      ? { commitSha }
      : {}),
  };
}

/** The decision an approval page answer records on its gate request. */
export function approvalDecision(
  gate: GateRequest,
  answer: ApprovalPageAnswer,
): ApprovalDecision {
  const scope: { [key: string]: Json } = {
    topicKey: gate.topicKey,
    gateRequestId: gate.id,
    gateKind: gate.kind,
    outcome: OUTCOME[answer.choice],
    via: "approval_page",
    pageUrl: gate.approvalUrl,
    approvers: [...answer.approvers],
    ...guardScope(gate),
    ...optionScope(gate, answer),
  };
  return {
    nodeId: gate.nodeId,
    kind: answer.choice === "approve" ? "approval" : "answer",
    scope,
    textVerbatim: answer.words ?? "",
    byActor: "didi",
  };
}
