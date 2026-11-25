// The personas (ADR 0119, D-455 to D-457): the lens an agent brings to any task and any
// discussion. A persona is data in contracts/personas/<id>.yaml, beside the shared base every
// persona carries, contracts/personas/shared.yaml, loaded at the spec version like the bot files
// (ADR 0105). The contracts-file adapter parses the files; this module checks the plain objects
// and composes a run's instructions from them.
//
// The check is strict and collects every problem at once: a missing or unknown persona, a missing
// or unknown part, an empty list, and text that is empty, not a string or more than one line.
// Problems name the file and the part, never a value from the files.
//
// The composition (ADR 0119 slice 2, D-458): a run's instructions are the shared base, then the
// task's persona, then the task's own instructions from its bot file, in one fixed frame.
// `composeInstructions` is the only place that frame is written. The runner and the weekly model
// test both read its text through the bot file loader, so the test measures what runs get.
// `composeDiscussionInstructions` (ADR 0119 slice 6) is the Council discussion's frame: the shared
// base, every persona with the chair first, then the discussion's task. Every Council run gets it
// since slice 6e, through the bot file loader as well.

/** The first four personas (D-456). Adding one is a change to this list and a new file. */
export const PERSONAS = ["product", "developer", "designer", "quality"] as const;
export type PersonaId = (typeof PERSONAS)[number];

/** The persona parts that are lists. `cares_most_about` is ranked, most important first. */
const PERSONA_LISTS = [
  "cares_most_about",
  "craft_standards",
  "watches_for",
  "never",
  "needs_to_know",
] as const;

/** The six parts every persona has, in this order (D-455). `notes` is an optional seventh. */
export const PERSONA_PARTS = ["lens", ...PERSONA_LISTS] as const;

/** The parts of the shared base every persona carries (D-455). */
export const SHARED_PARTS = [
  "user_flow",
  "intent",
  "uncertainty",
  "communication",
  "security_and_privacy",
] as const;

/** The shared base's file name, without `.yaml`. It is never a persona's id. */
export const SHARED_FILE_ID = "shared";

/** One persona, checked. Each list keeps the file's order. */
export interface Persona {
  id: PersonaId;
  /** One line. */
  lens: string;
  caresMostAbout: string[];
  craftStandards: string[];
  watchesFor: string[];
  never: string[];
  needsToKnow: string[];
  /** Empty when the file has no notes. */
  notes: string[];
}

/** The shared base, checked. */
export interface SharedBase {
  userFlow: string[];
  intent: string[];
  uncertainty: string[];
  communication: string[];
  securityAndPrivacy: string[];
}

export interface Personas {
  shared: SharedBase;
  personas: Record<PersonaId, Persona>;
}

/** The parsed files: the shared base, and each persona file's data by its name without `.yaml`. */
export interface RawPersonaFiles {
  shared: unknown;
  personas: Readonly<Record<string, unknown>>;
}

export interface PersonasResult {
  /** Present only when there are no problems. */
  personas?: Personas;
  problems: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Non-empty text on one line, as every entry of a part must be. */
const isLine = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value.trim());

/** A non-empty list of one-line texts, trimmed, or a problem naming `where`. */
function lines(
  value: unknown,
  where: string,
  problems: string[],
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where} must be a non-empty list of text`);
    return undefined;
  }
  if (!value.every(isLine)) {
    problems.push(`${where}: each entry must be non-empty text on one line`);
    return undefined;
  }
  return value.map((entry) => entry.trim());
}

/**
 * The file as a mapping with only `allowed` keys, and each of `lists` a list of lines. Every
 * problem is added; the lists come back only when the file has none.
 */
function checkFile<P extends string>(
  file: string,
  raw: unknown,
  allowed: readonly string[],
  lists: readonly P[],
  problems: string[],
): { data: Record<string, unknown>; lists: Record<P, string[]> } | undefined {
  if (raw === undefined) {
    problems.push(`${file} is missing`);
    return undefined;
  }
  if (!isRecord(raw)) {
    problems.push(`${file} must be a mapping of its parts`);
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(raw).filter((key) => !allowed.includes(key))) {
    problems.push(`${file}: unknown part ${key}`);
  }
  const checked = {} as Record<P, string[]>;
  for (const part of lists) {
    const value = lines(raw[part], `${file} ${part}`, problems);
    if (value) checked[part] = value;
  }
  return problems.length > before ? undefined : { data: raw, lists: checked };
}

function checkShared(raw: unknown, problems: string[]): SharedBase | undefined {
  const file = `${SHARED_FILE_ID}.yaml`;
  const checked = checkFile(file, raw, SHARED_PARTS, SHARED_PARTS, problems);
  if (!checked) return undefined;
  const { lists } = checked;
  return {
    userFlow: lists.user_flow,
    intent: lists.intent,
    uncertainty: lists.uncertainty,
    communication: lists.communication,
    securityAndPrivacy: lists.security_and_privacy,
  };
}

function checkPersona(
  id: PersonaId,
  raw: unknown,
  problems: string[],
): Persona | undefined {
  const file = `${id}.yaml`;
  const allowed = ["persona", ...PERSONA_PARTS, "notes"];
  const notes = isRecord(raw) && raw.notes !== undefined ? ["notes" as const] : [];
  const before = problems.length;
  const checked = checkFile(file, raw, allowed, [...PERSONA_LISTS, ...notes], problems);
  if (isRecord(raw)) {
    if (raw.persona !== id)
      problems.push(`${file}: persona must be ${id}, its file's name`);
    if (!isLine(raw.lens))
      problems.push(`${file} lens must be non-empty text on one line`);
  }
  if (!checked || problems.length > before) return undefined;
  const { data, lists } = checked;
  return {
    id,
    lens: (data.lens as string).trim(),
    caresMostAbout: lists.cares_most_about,
    craftStandards: lists.craft_standards,
    watchesFor: lists.watches_for,
    never: lists.never,
    needsToKnow: lists.needs_to_know,
    notes: notes.length > 0 ? lists.notes : [],
  };
}

/** Checks the shared base and every persona file, collecting every problem at once. */
export function validatePersonas(raw: RawPersonaFiles): PersonasResult {
  const problems: string[] = [];
  for (const name of Object.keys(raw.personas)) {
    if (!(PERSONAS as readonly string[]).includes(name)) {
      problems.push(`${name}.yaml is not the file of a persona`);
    }
  }
  const shared = checkShared(raw.shared, problems);
  const personas = {} as Record<PersonaId, Persona>;
  for (const id of PERSONAS) {
    const persona = checkPersona(id, raw.personas[id], problems);
    if (persona) personas[id] = persona;
  }
  if (problems.length > 0 || !shared) return { problems };
  return { personas: { shared, personas }, problems };
}

export const isPersonaId = (value: unknown): value is PersonaId =>
  (PERSONAS as readonly unknown[]).includes(value);

/** The persona a task type runs with (D-458), and another persona's craft standards it also holds. */
export interface TaskPersona {
  persona: PersonaId;
  /** The Designer holds the Developer's standards for its code; `qa:visual` the Designer's. */
  withCraftStandardsOf?: PersonaId;
}

export interface ComposeInput extends TaskPersona {
  personas: Personas;
  /** The task's own instructions, from its bot file. */
  task: string;
}

/** Each persona's name as the composed text says it mid-sentence. */
export const PERSONA_NAMES: Readonly<Record<PersonaId, string>> = {
  product: "Product",
  developer: "the Developer",
  designer: "the Designer",
  quality: "Quality",
};

/** The three sections of a composed text, in order. */
export const COMPOSED_HEADINGS = {
  shared: "## What every agent shares",
  persona: "## Your persona",
  task: "## Your task",
} as const;

/** The label before each list of the shared base, in the shared base's order (D-455). */
const SHARED_LABELS: Readonly<Record<keyof SharedBase, string>> = {
  userFlow: "The user's flow:",
  intent: "Didi's intent:",
  uncertainty: "Uncertainty:",
  communication: "How you communicate:",
  securityAndPrivacy: "Security and privacy:",
};

type PersonaList = Exclude<keyof Persona, "id" | "lens">;

/** The label before each list of a persona, in the persona's order (D-455). */
const PERSONA_LABELS: Readonly<Record<PersonaList, string>> = {
  caresMostAbout: "What you care about most, most important first:",
  craftStandards: "How you do good work:",
  watchesFor: "What you watch for:",
  never: "What you never do:",
  needsToKnow: "What you need to know:",
  notes: "Notes:",
};

/** A persona's name at the start of a heading or a sentence: "The Developer", "Quality". */
const capitalized = (id: PersonaId): string => {
  const name = PERSONA_NAMES[id];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

/** The label before another persona's craft standards, which the task also holds. */
const otherStandardsLabel = (id: PersonaId): string =>
  `${capitalized(id)}'s craft standards, which you also hold the work to:`;

const BLOCK_SEPARATOR = "\n\n";

const labelledList = (label: string, entries: readonly string[]): string =>
  [label, ...entries.map((entry) => `- ${entry}`)].join("\n");

/** The shared base's blocks: each of its lists after its label. */
const sharedBlocks = (shared: SharedBase): string[] =>
  (Object.keys(SHARED_LABELS) as (keyof SharedBase)[]).map((part) =>
    labelledList(SHARED_LABELS[part], shared[part]),
  );

/** A persona's blocks: its lens, then each of its lists after its label, notes only if any. */
const personaBlocks = (persona: Persona): string[] => [
  persona.lens,
  ...(Object.keys(PERSONA_LABELS) as PersonaList[])
    .filter((part) => persona[part].length > 0)
    .map((part) => labelledList(PERSONA_LABELS[part], persona[part])),
];

/**
 * A run's instructions (ADR 0119 slice 2): the shared base, then the persona, with another
 * persona's craft standards when the task asks for them, then the task's own instructions, last
 * and unchanged but for their trailing whitespace. Blocks are one blank line apart, and lists are
 * `- ` lines. The text ends with the task's last character.
 */
export function composeInstructions({
  personas,
  persona: id,
  withCraftStandardsOf,
  task,
}: ComposeInput): string {
  const otherStandards = withCraftStandardsOf
    ? [
        labelledList(
          otherStandardsLabel(withCraftStandardsOf),
          personas.personas[withCraftStandardsOf].craftStandards,
        ),
      ]
    : [];
  return [
    COMPOSED_HEADINGS.shared,
    ...sharedBlocks(personas.shared),
    COMPOSED_HEADINGS.persona,
    ...personaBlocks(personas.personas[id]),
    ...otherStandards,
    COMPOSED_HEADINGS.task,
    task.trimEnd(),
  ].join(BLOCK_SEPARATOR);
}

/** The sections of a Council discussion's composed text (ADR 0119 slice 6), in order. */
export const DISCUSSION_HEADINGS = {
  shared: COMPOSED_HEADINGS.shared,
  personas: "## The personas in this discussion",
  task: COMPOSED_HEADINGS.task,
} as const;

/** The heading over one persona in a discussion's text: "### Product, the chair" for the chair. */
export const discussionPersonaHeading = (id: PersonaId, chair: PersonaId): string =>
  id === chair ? `### ${capitalized(id)}, the chair` : `### ${capitalized(id)}`;

export interface ComposeDiscussionInput {
  personas: Personas;
  /** Who chairs the discussion (D-462): the Council's bot file's `discussion.chair`. */
  chair: PersonaId;
  /** The discussion's task, from the Council's bot file. */
  task: string;
}

/**
 * A Council discussion's instructions (ADR 0119 slice 6, D-462, D-483): the shared base, then
 * every persona, the chair first and the others in `PERSONAS` order, each under its heading and
 * as `composeInstructions` gives a persona, then the task's own instructions, last and unchanged
 * but for their trailing whitespace. Every call of one discussion has the same text, so it stays
 * in the cached prefix. Every Council run gets it since slice 6e.
 */
export function composeDiscussionInstructions({
  personas,
  chair,
  task,
}: ComposeDiscussionInput): string {
  const order = [chair, ...PERSONAS.filter((id) => id !== chair)];
  return [
    DISCUSSION_HEADINGS.shared,
    ...sharedBlocks(personas.shared),
    DISCUSSION_HEADINGS.personas,
    ...order.flatMap((id) => [
      discussionPersonaHeading(id, chair),
      ...personaBlocks(personas.personas[id]),
    ]),
    DISCUSSION_HEADINGS.task,
    task.trimEnd(),
  ].join(BLOCK_SEPARATOR);
}
