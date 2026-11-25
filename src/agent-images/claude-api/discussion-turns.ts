// The turn of each call of a Council discussion (ADR 0119 slice 6, D-483, D-484): the second block
// of the call's first message, after the fenced input that every call shares. It says who chairs,
// the cast, each pull-in with its reason, and the views so far, then asks one persona for its view
// or Product, the chair, for the answer. Reasons and views are quoted as data, between <reason>
// and </reason> or <view persona="..."> and </view>, with any closing tag of either inside them
// escaped in any letter case, as the documentation lookup escapes its own (../shared/docs-lookup.ts).
// The texts passed in have their secret values removed already (./discussion.ts).
import type { DiscussionView, PullIn } from "../../core/discussion-record.ts";
import { PERSONA_NAMES, type PersonaId } from "../../core/personas.ts";

/** What a turn says of the discussion so far. */
export interface DiscussionState {
  chair: PersonaId;
  cast: readonly PersonaId[];
  pullIns: readonly PullIn[];
  views: readonly DiscussionView[];
  pullInsLeft: number;
}

const name = (id: PersonaId): string => PERSONA_NAMES[id];

/** A persona's name at a sentence start: "The Developer", "Product". */
const nameAtStart = (id: PersonaId): string =>
  `${name(id).charAt(0).toUpperCase()}${name(id).slice(1)}`;

/** "a", "a and b", "a, b and c". */
const listed = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`;

/** A quoted text that no closing view or reason tag inside it can end early. */
export const escapeQuoted = (text: string): string =>
  text.replace(/<\/(view|reason)/gi, "<\\/$1");

/** A view as every later speaker reads it, and as a pull-in's tool result. */
export const quoteView = (view: Pick<DiscussionView, "persona" | "text">): string =>
  `<view persona="${view.persona}">\n${escapeQuoted(view.text)}\n</view>`;

const quoteReason = (reason: string): string =>
  `<reason>${escapeQuoted(reason)}</reason>`;

/** The chair, the cast, the pull-ins but `except` and the views so far. */
function sofar(state: DiscussionState, except?: PullIn): string[] {
  const cast =
    state.cast.length === 0
      ? `${name(state.chair)} alone`
      : listed(state.cast.map(name));
  return [
    `${nameAtStart(state.chair)} chairs this discussion. The cast: ${cast}.`,
    ...state.pullIns
      .filter((pullIn) => pullIn !== except)
      .flatMap((pullIn) => [
        `Pulled in: ${name(pullIn.persona)} by ${name(pullIn.by)}, with the reason in <reason>.`,
        quoteReason(pullIn.reason),
      ]),
    ...(state.views.length === 0
      ? ["No one has spoken yet."]
      : [
          "The views so far follow, each between <view> and </view>.",
          ...state.views.map(quoteView),
        ]),
  ];
}

/** The turn that asks `speaker` for its view, once. A pulled-in persona hears who and why first. */
export function viewTurn(
  state: DiscussionState,
  speaker: PersonaId,
  pulledIn?: PullIn,
): string {
  return [
    ...(pulledIn === undefined
      ? []
      : [
          `${nameAtStart(pulledIn.by)} pulled you in, with the reason in <reason>.`,
          quoteReason(pulledIn.reason),
        ]),
    ...sofar(state, pulledIn),
    `Now give ${name(speaker)}'s view, once, through ${name(speaker)}'s persona. Pull-ins left: ${state.pullInsLeft}.`,
  ].join("\n");
}

/** "A third pull-in" for a limit of two, "A second" for one, "A pull-in" for none. */
const ORDINALS = ["A pull-in", "A second pull-in", "A third pull-in"] as const;

/** What the chair hears once a pull-in over the limit was refused: the question goes to Didi. */
export const overLimitSentence = (maxPullIns: number): string =>
  `${ORDINALS[maxPullIns] ?? "A pull-in"} was asked for and refused, so this question goes to Didi: answer with the question's way to Didi and name the persona it needs.`;

/**
 * The chair's turn: every view is in, so decide. When a pull-in over the limit was refused, the
 * question goes to Didi (D-484), and the turn says so.
 */
export function chairTurn(
  state: DiscussionState,
  maxPullIns: number,
  overLimit: boolean,
): string {
  return [
    ...sofar(state),
    `Every view is in. Now decide as ${name(state.chair)}, the chair: weigh the views and answer the question in its schema. Pull-ins left: ${state.pullInsLeft}.`,
    ...(overLimit ? [overLimitSentence(maxPullIns)] : []),
  ].join("\n");
}
