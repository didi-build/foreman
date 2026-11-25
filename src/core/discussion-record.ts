// A Council discussion's record (ADR 0119 slice 6, D-483, D-484, D-488): what the Messages API
// image reports beside the chair's answer, and the bounds every reader holds it to. Product
// chairs (D-462); each persona of the cast gives one view, a speaker may pull in a persona who is
// not yet in the discussion with a one-line reason, at most `MAX_PULL_INS` times, and the image
// refuses any other pull-in with a fixed text and records it as refused.
//
// The image builds the record (src/agent-images/claude-api/discussion.ts), the task file names
// the discussion's chair, cast and pull-in limit (src/adapters/agent-runtime/kubernetes/task.ts),
// and the Kubernetes runtime reads the record back from the result line with
// `readDiscussionRecord`. That reader checks the shape and the bounds only, strictly: anything
// else is no record. Whether the right personas spoke is the runner's check (slice 6c,
// ./council-discussion.ts).
//
// It imports only the personas, so each image's Dockerfile copies these two files alone.
import { PERSONAS, isPersonaId, type PersonaId } from "./personas.ts";

/** The persona who chairs every discussion and answers the question (D-462). */
export const DISCUSSION_CHAIR: PersonaId = "product";

/** The most personas one discussion pulls in (D-484). */
export const MAX_PULL_INS = 2;

/** A view as the record keeps it, and as a speaker may give it (D-488). */
export const MAX_VIEW_CHARS = 2000;

/** A pull-in's reason: one line of at most this many characters. */
export const MAX_REASON_CHARS = 300;

/** The most views a record holds. */
export const MAX_VIEWS = 5;

/** The most refused pull-ins a record holds; the image ends the run before one more. */
export const MAX_REFUSED_PULL_INS = 5;

/**
 * Why a pull-in was refused: the persona was already in the discussion, the reason was not one
 * line of 1 to `MAX_REASON_CHARS` characters, or the discussion had pulled in its limit already.
 */
export const PULL_IN_REFUSALS = ["in_discussion", "bad_reason", "limit"] as const;
export type PullInRefusal = (typeof PULL_IN_REFUSALS)[number];

export interface DiscussionView {
  persona: PersonaId;
  /** Only for a persona a speaker pulled in. */
  pulledInBy?: PersonaId;
  /** 1 to `MAX_VIEW_CHARS` characters, secret values removed. */
  text: string;
}

export interface PullIn {
  persona: PersonaId;
  by: PersonaId;
  /** One line, 1 to `MAX_REASON_CHARS` characters. */
  reason: string;
}

export interface RefusedPullIn {
  persona: PersonaId;
  by: PersonaId;
  /** One line of at most `MAX_REASON_CHARS` characters: the asked reason, cut and joined. */
  reason: string;
  why: PullInRefusal;
}

export interface DiscussionRecord {
  chair: PersonaId;
  /** In the task's order, never the chair. */
  cast: PersonaId[];
  /** In the order they were given. */
  views: DiscussionView[];
  pullIns: PullIn[];
  refusedPullIns: RefusedPullIn[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isOneLine = (text: unknown, min: number): text is string =>
  typeof text === "string" &&
  text.length >= min &&
  text.length <= MAX_REASON_CHARS &&
  !/[\r\n\u2028\u2029]/.test(text);

/** A reason as the record keeps it: on one line, trimmed and cut to the bound. */
export function recordedReason(reason: string): string {
  return reason
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .trim()
    .slice(0, MAX_REASON_CHARS)
    .trim();
}

function readView(value: unknown): DiscussionView | null {
  if (!isObject(value)) return null;
  const pulled = "pulledInBy" in value;
  if (!hasKeys(value, pulled ? ["persona", "pulledInBy", "text"] : ["persona", "text"]))
    return null;
  const { persona, pulledInBy, text } = value;
  if (!isPersonaId(persona) || (pulled && !isPersonaId(pulledInBy))) return null;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_VIEW_CHARS)
    return null;
  return {
    persona,
    ...(pulled ? { pulledInBy: pulledInBy as PersonaId } : {}),
    text,
  };
}

function readPullIn(value: unknown): PullIn | null {
  if (!isObject(value) || !hasKeys(value, ["persona", "by", "reason"])) return null;
  const { persona, by, reason } = value;
  if (!isPersonaId(persona) || !isPersonaId(by) || !isOneLine(reason, 1)) return null;
  return { persona, by, reason };
}

function readRefused(value: unknown): RefusedPullIn | null {
  if (!isObject(value) || !hasKeys(value, ["persona", "by", "reason", "why"]))
    return null;
  const { persona, by, reason, why } = value;
  if (!isPersonaId(persona) || !isPersonaId(by) || !isOneLine(reason, 0)) return null;
  if (!(PULL_IN_REFUSALS as readonly unknown[]).includes(why)) return null;
  return { persona, by, reason, why: why as PullInRefusal };
}

/** Each entry read, or null when the list is too long or any entry is not its shape. */
function readList<T>(value: unknown, max: number, read: (v: unknown) => T | null) {
  if (!Array.isArray(value) || value.length > max) return null;
  const entries = value.map(read);
  return entries.every((entry) => entry !== null) ? (entries as T[]) : null;
}

/**
 * The record from a result line, or null when it is not exactly that shape within its bounds:
 * the chair, a cast of distinct personas other than the chair, at most `MAX_VIEWS` views, at most
 * `MAX_PULL_INS` pull-ins and at most `MAX_REFUSED_PULL_INS` refused ones, with no other field.
 */
export function readDiscussionRecord(value: unknown): DiscussionRecord | null {
  if (
    !isObject(value) ||
    !hasKeys(value, ["chair", "cast", "views", "pullIns", "refusedPullIns"]) ||
    value.chair !== DISCUSSION_CHAIR
  )
    return null;
  const cast = readList(value.cast, PERSONAS.length - 1, (persona) =>
    isPersonaId(persona) && persona !== DISCUSSION_CHAIR ? persona : null,
  );
  if (cast === null || new Set(cast).size !== cast.length) return null;
  const views = readList(value.views, MAX_VIEWS, readView);
  const pullIns = readList(value.pullIns, MAX_PULL_INS, readPullIn);
  const refusedPullIns = readList(
    value.refusedPullIns,
    MAX_REFUSED_PULL_INS,
    readRefused,
  );
  if (views === null || pullIns === null || refusedPullIns === null) return null;
  return { chair: DISCUSSION_CHAIR, cast, views, pullIns, refusedPullIns };
}
