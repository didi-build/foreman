// The Council's cast as data (ADR 0119 slice 6a, D-462, D-463, D-482 to D-487, O-178). The
// Council's bot file (contracts/bots/council.yaml, `discussion`) names the chair, the most
// pull-ins a discussion may make (D-464) and each question kind's base cast: personas by id, and
// rule tokens resolved from the question. The contracts-file adapter checks the table
// (src/adapters/contracts-file/bot-files.ts) with the names below; `councilCast` resolves one
// question's cast to personas. The runner's check of a run's discussion resolves the cast it
// expects with it (./council-discussion.ts, slice 6c, O-180). No run is sent a cast until slice
// 6e, so every Council run keeps today's text and behaviour.
//
// The rule tokens, each valid for one question kind only:
// - `builder` (escalation, D-463, D-466): the Designer when the item's track is design, else the
//   Developer (a code, infra or docs item, or an item with no track).
// - `stale_builders` (reversal, D-486): from the tracks of the items the reversal made stale: the
//   Developer for a code, infra or docs item (or one with no track), the Designer for a design
//   item, both when both are stale, in the personas' own order (the Developer first), and nobody
//   when no item is stale, so Product decides alone.
// - `designer_if_ui` (plan, D-487): the Designer when a path of the idea's finding or of a scope
//   update is under `design/` or `components/` (it starts with that folder, from the repository's
//   root), when a Designer run found the idea, or when the item it was found on is a design item;
//   else nobody.
//
// A persona is in a cast at most once, at its first place. Plain logic, with type imports only.
import type { CouncilPlanSource, CouncilQuestion } from "./council.ts";
import type { ScopeUpdateView } from "./council-input.ts";
import type { PersonaId } from "./personas.ts";
import type { Json, Node } from "./store.ts";

export type CouncilQuestionKind = CouncilQuestion["kind"];

/** Every question kind the Council answers, once each, in its bot file's schema order. */
const KINDS: Readonly<Record<CouncilQuestionKind, true>> = {
  escalation: true,
  reversal: true,
  visual_call: true,
  scanner_gone: true,
  still_needed: true,
  plan: true,
};
export const COUNCIL_QUESTION_KINDS = Object.keys(
  KINDS,
) as readonly CouncilQuestionKind[];

/** The most personas a discussion may pull in beyond its base cast (D-464), one bound with the image's record. */
export { MAX_PULL_INS } from "./discussion-record.ts";

/** Each rule token: the one question kind whose cast may hold it, and every persona it may name. */
export const CAST_TOKENS = {
  builder: { kind: "escalation", mayName: ["developer", "designer"] },
  stale_builders: { kind: "reversal", mayName: ["developer", "designer"] },
  designer_if_ui: { kind: "plan", mayName: ["designer"] },
} as const satisfies Readonly<
  Record<string, { kind: CouncilQuestionKind; mayName: readonly PersonaId[] }>
>;
export type CastToken = keyof typeof CAST_TOKENS;

export const isCastToken = (value: unknown): value is CastToken =>
  typeof value === "string" && Object.hasOwn(CAST_TOKENS, value);

/** One entry of a base cast: a persona, or a rule token for the cast's question kind. */
export type CastEntry = PersonaId | CastToken;

/** The Council's discussion table, as the bot file check gives it. */
export interface CouncilDiscussion {
  /** Who chairs every discussion (D-462). Never in a cast. */
  chair: PersonaId;
  /** At most this many pull-ins beyond the base cast, 0 to `MAX_PULL_INS` (D-464). */
  maxPullIns: number;
  /** Each question kind's base cast, in the file's order (D-463). */
  casts: Readonly<Record<CouncilQuestionKind, readonly CastEntry[]>>;
}

/**
 * What the cast of each question kind is resolved from: the data the runner already builds for
 * the question's input (./council-input.ts), so a caller passes those objects as they are.
 */
export type CastQuestion =
  /** The escalated item (`EscalationInput.node`). */
  | { kind: "escalation"; node: Pick<Node, "track"> }
  /** Every item the reversal marked stale (`ReversalInput.staleItems`). */
  | { kind: "reversal"; staleItems: readonly Pick<Node, "track">[] }
  | {
      kind: "plan";
      /** The idea (`CouncilPlanInput.node`): a scanner idea's evidence, or who found it. */
      node: Pick<Node, "body">;
      source: CouncilPlanSource;
      /** The findings folded into a scanner idea (`CouncilPlanInput.scopeUpdates`). */
      scopeUpdates: readonly Pick<ScopeUpdateView, "path">[];
      /**
       * The item a bot's run found the idea on (`body.foundBy.nodeId`), with its track, or null
       * for a scanner idea or an item the store no longer has. The runner reads that item from
       * the store when it resolves the cast (./council.ts, O-178, O-180).
       */
      foundOn: Pick<Node, "track"> | null;
    }
  /** Casts of these kinds hold personas only, so nothing is read from the question. */
  | { kind: "still_needed" | "visual_call" | "scanner_gone" };

/** The folders a plan that touches the UI has a path under (D-487), from the repository's root. */
const UI_FOLDERS = ["design/", "components/"] as const;

const isUnderUiFolder = (path: string): boolean =>
  UI_FOLDERS.some((folder) => path.startsWith(folder));

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

/** A scanner idea's evidence paths (`body.evidence[].path`), as ./scan-ideas.ts writes them. */
function evidencePaths(body: Json): string[] {
  const evidence = field(body, "evidence");
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((entry) => field(entry, "path"))
    .filter((path): path is string => typeof path === "string");
}

/** Whether the plan touches the UI (D-487). */
function touchesUi(question: Extract<CastQuestion, { kind: "plan" }>): boolean {
  const paths = [
    ...(question.source === "scanner" ? evidencePaths(question.node.body) : []),
    ...question.scopeUpdates.map((update) => update.path),
  ];
  const foundByDesigner =
    question.source === "run_finding" &&
    field(field(question.node.body, "foundBy"), "role") === "designer";
  return (
    paths.some(isUnderUiFolder) ||
    foundByDesigner ||
    question.foundOn?.track === "design"
  );
}

/** The builder of an item (D-463): the Designer for a design item, else the Developer. */
const builderOf = (track: Node["track"]): PersonaId =>
  track === "design" ? "designer" : "developer";

/** The personas a token names for this question. Throws for a token of another kind. */
function resolveToken(token: CastToken, question: CastQuestion): PersonaId[] {
  if (CAST_TOKENS[token].kind !== question.kind) {
    throw new Error(
      `the rule token ${token} is for the ${CAST_TOKENS[token].kind} cast only`,
    );
  }
  if (question.kind === "escalation") return [builderOf(question.node.track)];
  if (question.kind === "reversal") {
    const builders = new Set(question.staleItems.map((item) => builderOf(item.track)));
    return (["developer", "designer"] as const).filter((id) => builders.has(id));
  }
  if (question.kind === "plan") return touchesUi(question) ? ["designer"] : [];
  return [];
}

/**
 * A question's base cast (D-463): its kind's entries in the table's order, each rule token
 * resolved from the question, each persona once at its first place. The chair is never in it.
 */
export function councilCast(
  table: CouncilDiscussion,
  question: CastQuestion,
): PersonaId[] {
  const cast: PersonaId[] = [];
  for (const entry of table.casts[question.kind]) {
    const names = isCastToken(entry) ? resolveToken(entry, question) : [entry];
    for (const id of names) {
      if (id !== table.chair && !cast.includes(id)) cast.push(id);
    }
  }
  return cast;
}
