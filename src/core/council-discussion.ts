// The runner's check of a Council discussion (ADR 0119 slice 6c, D-483, D-484, D-486 to D-488,
// O-180). A Council run that was a discussion reports its record beside the chair's answer
// (./discussion-record.ts). After the question kind's reader accepts the answer, the runner checks
// the record against what the question asked for: Product chairs; the cast is the question's own,
// in order (`councilCast`, ./council-cast.ts); each persona of the cast and each accepted pull-in
// gives exactly one view, nobody else does, and the chair gives none; the pull-ins keep to the
// table's limit, each bringing in a persona from outside the discussion, asked by someone in it,
// with a one-line reason. A pull-in refused for the limit means the question needs more personas
// than a discussion may pull in, so the chair's answer must take the question kind's own way to
// Didi (D-484).
//
// A record that fails a rule makes the answer unusable, as an answer outside its schema does
// (D-228): the run ends `fail`, the question gets one more run, and after that it goes to Didi (a
// visual call is dropped). Each rule has a fixed reason code, which never quotes the record.
//
// `discussionScope` is what a Council decision keeps of a checked record in its `scope` (D-488):
// the record as the image gave it, each text within its bound and safe for Postgres's jsonb.
//
// Plain logic, with type imports of the answers it reads.
import type {
  CouncilPlanAnswer,
  EscalationAnswer,
  ReversalAnswer,
  ScannerGoneAnswer,
} from "./council.ts";
import {
  MAX_REASON_CHARS,
  MAX_VIEW_CHARS,
  readDiscussionRecord,
  type DiscussionRecord,
} from "./discussion-record.ts";
import type { PersonaId } from "./personas.ts";
import type { Json } from "./store.ts";
import type { VisualCallAnswer } from "./visual-call.ts";

/** The chair's answer as its kind's reader gave it: what the third pull-in rule reads. */
export type DiscussedAnswer =
  | { kind: "escalation"; answer: Pick<EscalationAnswer, "outcome"> }
  | { kind: "reversal"; answer: Pick<ReversalAnswer, "verdicts"> }
  | { kind: "visual_call"; answer: Pick<VisualCallAnswer, "call"> }
  | {
      kind: "scanner_gone" | "still_needed";
      answer: Pick<ScannerGoneAnswer, "verdict">;
    }
  | { kind: "plan"; answer: Pick<CouncilPlanAnswer, "needsDidi"> };

/** What the runner expects of one question's discussion. */
export interface ExpectedDiscussion {
  /** The table's chair (D-462). */
  chair: PersonaId;
  /** The question's base cast, from `councilCast`, in its order (D-463). */
  cast: readonly PersonaId[];
  /** The table's pull-in limit (D-464). */
  maxPullIns: number;
  /** The chair's answer, already read by its kind's reader. */
  answer: DiscussedAnswer;
}

/** Why the runner refuses a discussion: one fixed code per rule, in the order they are checked. */
export const DISCUSSION_REFUSALS = [
  /** Not a discussion record within its bounds (./discussion-record.ts). */
  "not_a_record",
  /** The chair is not the table's chair. */
  "wrong_chair",
  /** The cast is not the question's cast, in its order. */
  "wrong_cast",
  /** More pull-ins than the table allows. */
  "too_many_pull_ins",
  /** A pull-in of the chair, a member of the cast or a persona already pulled in. */
  "pull_in_in_discussion",
  /** A pull-in asked by a persona who was not in the discussion. */
  "pull_in_by_outsider",
  /** A pull-in whose reason is blank. */
  "pull_in_reason",
  /** The chair gave a view. */
  "chair_view",
  /** A view from a persona who is neither in the cast nor pulled in. */
  "outside_view",
  /** A second view from the same persona. */
  "repeated_view",
  /** A view that names the wrong puller, or none for a pulled-in persona, or one for the cast. */
  "view_pulled_in_by",
  /** A member of the cast or a pulled-in persona gave no view. */
  "missing_view",
  /** A pull-in was refused for the limit, and the answer does not take the way to Didi (D-484). */
  "limit_without_didi",
] as const;
export type DiscussionRefusal = (typeof DISCUSSION_REFUSALS)[number];

/**
 * Whether the chair's answer takes its question kind's own way to Didi (D-484), as the Council's
 * bot file schemas and the readers in ./council.ts give it: an escalation `cannot_resolve`; a
 * reversal `cannot_decide` for every item, so it needs at least one item; a visual call
 * `needs_didi`; a scanner idea or a work item `cannot_decide`; a plan `needsDidi.needed` `yes`.
 */
export function takesWayToDidi(discussed: DiscussedAnswer): boolean {
  switch (discussed.kind) {
    case "escalation":
      return discussed.answer.outcome === "cannot_resolve";
    case "reversal": {
      const { verdicts } = discussed.answer;
      return (
        verdicts.length > 0 && verdicts.every((v) => v.verdict === "cannot_decide")
      );
    }
    case "visual_call":
      return discussed.answer.call === "needs_didi";
    case "scanner_gone":
    case "still_needed":
      return discussed.answer.verdict === "cannot_decide";
    case "plan":
      return discussed.answer.needsDidi.needed === "yes";
  }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry === b[i]);

/** The first pull-in problem, in the order they were made, or null. */
function pullInProblem(
  record: DiscussionRecord,
  maxPullIns: number,
): DiscussionRefusal | null {
  if (record.pullIns.length > maxPullIns) return "too_many_pull_ins";
  const inDiscussion: PersonaId[] = [record.chair, ...record.cast];
  for (const pullIn of record.pullIns) {
    if (inDiscussion.includes(pullIn.persona)) return "pull_in_in_discussion";
    if (!inDiscussion.includes(pullIn.by)) return "pull_in_by_outsider";
    if (pullIn.reason.trim() === "") return "pull_in_reason";
    inDiscussion.push(pullIn.persona);
  }
  return null;
}

/** The first view problem, or null: every speaker once, the chair never, each puller named. */
function viewProblem(record: DiscussionRecord): DiscussionRefusal | null {
  const pulledInBy = new Map(record.pullIns.map((p) => [p.persona, p.by]));
  const spoke = new Set<PersonaId>();
  for (const view of record.views) {
    if (view.persona === record.chair) return "chair_view";
    const inCast = record.cast.includes(view.persona);
    if (!inCast && !pulledInBy.has(view.persona)) return "outside_view";
    if (spoke.has(view.persona)) return "repeated_view";
    spoke.add(view.persona);
    const puller = inCast ? undefined : pulledInBy.get(view.persona);
    if (view.pulledInBy !== puller) return "view_pulled_in_by";
  }
  const speakers = [...record.cast, ...pulledInBy.keys()];
  return speakers.every((persona) => spoke.has(persona)) ? null : "missing_view";
}

/**
 * Checks a run's discussion against its question (D-483, D-484, D-488). Returns the record read
 * strictly, or the code of the first rule it fails.
 */
export function checkDiscussion(
  value: unknown,
  expected: ExpectedDiscussion,
): { discussion: DiscussionRecord } | { refused: DiscussionRefusal } {
  const record = readDiscussionRecord(value);
  if (record === null) return { refused: "not_a_record" };
  if (record.chair !== expected.chair) return { refused: "wrong_chair" };
  if (!sameList(record.cast, expected.cast)) return { refused: "wrong_cast" };
  const problem = pullInProblem(record, expected.maxPullIns) ?? viewProblem(record);
  if (problem) return { refused: problem };
  const overLimit = record.refusedPullIns.some((refused) => refused.why === "limit");
  if (overLimit && !takesWayToDidi(expected.answer)) {
    return { refused: "limit_without_didi" };
  }
  return { discussion: record };
}

/** A lone surrogate half, or NUL: Postgres's jsonb refuses either. */
const UNSTORABLE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\0/g;

/**
 * A text cut to `max` characters without splitting a surrogate pair, with any lone surrogate half
 * or NUL replaced by U+FFFD, so the scope always stores. The image's own cut of a reason at its
 * bound can leave half a pair; a text within its bound is otherwise kept as it is.
 */
function storable(text: string, max: number): string {
  let cut = text;
  if (cut.length > max) {
    const last = cut.charCodeAt(max - 1);
    cut = cut.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
  }
  return cut.replace(UNSTORABLE, "\ufffd");
}

/**
 * What a Council decision's `scope.discussion` holds of a checked record (D-488): the chair, the
 * cast, each view with who pulled it in, each pull-in and each refused one, exactly as the image's
 * record holds them, each view cut again at `MAX_VIEW_CHARS` and each reason at `MAX_REASON_CHARS`.
 */
export function discussionScope(record: DiscussionRecord): Json {
  return {
    chair: record.chair,
    cast: [...record.cast],
    views: record.views.map((view) => ({
      persona: view.persona,
      ...(view.pulledInBy === undefined ? {} : { pulledInBy: view.pulledInBy }),
      text: storable(view.text, MAX_VIEW_CHARS),
    })),
    pullIns: record.pullIns.map((pullIn) => ({
      persona: pullIn.persona,
      by: pullIn.by,
      reason: storable(pullIn.reason, MAX_REASON_CHARS),
    })),
    refusedPullIns: record.refusedPullIns.map((refused) => ({
      persona: refused.persona,
      by: refused.by,
      reason: storable(refused.reason, MAX_REASON_CHARS),
      why: refused.why,
    })),
  };
}
