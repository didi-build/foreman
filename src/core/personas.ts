// The personas (ADR 0119, D-455 to D-457): the lens an agent brings to any task and any
// discussion. A persona is data in contracts/personas/<id>.yaml, beside the shared base every
// persona carries, contracts/personas/shared.yaml, loaded at the spec version like the bot files
// (ADR 0105). The contracts-file adapter parses the files; this module only checks the plain
// objects. No run reads them yet: ADR 0119's slice 2 composes them into each run's instructions.
//
// The check is strict and collects every problem at once: a missing or unknown persona, a missing
// or unknown part, an empty list, and text that is empty, not a string or more than one line.
// Problems name the file and the part, never a value from the files.

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
