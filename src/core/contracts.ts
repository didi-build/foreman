// The shape the library reads contracts in, and the validator for the files in contracts/
// (essential 3, ADR 0105). Rules live in the contract files and in guard functions, never in
// the library. Parsing is the contracts-file adapter's job; this module only checks the plain
// object it produces and maps it to these types.
import type { EvidenceKind, Node, StoreOps, Track } from "./store.ts";

export interface StateContract {
  /** The spec's name for the state, for example "In QA review". The consistency test reads it. */
  label?: string;
  /** The role that owns the state (Developer, Designer, QA, Operator, Runner, Council). */
  owner?: string;
  /** A node may only enter this state with a blocked reason (schema invariant 4). */
  requiresBlockedReason?: boolean;
  /** An escalated state: nothing in it is dispatched (schema invariant 6). */
  escalated?: boolean;
  /** A node may be created in this state. */
  initial?: boolean;
  /** The spec's contract fields, as text (ADR 0105). `budget` stays "not set" until decided. */
  purpose?: string;
  input?: string;
  output?: string;
  evidenceToExit?: string;
  tools?: string;
  budget?: string;
  sideEffects?: string;
  failure?: string;
}

export interface TransitionContract {
  /** State id, or "any" on an escalation transition (matches any non-escalated state). */
  from: string;
  /** State id, or "return" on an escalation transition (the state the node came from). */
  to: string;
  /** Guard names, looked up in the guard registry. Every one must pass. */
  guards: string[];
  /** The tracks the move applies to. Absent means every node, whatever its track. */
  tracks?: Track[];
  /** What starts it: an event, the reconcile pass, a bot report, a human answer. Text. */
  trigger?: string;
  /** The evidence kinds the guards read, for the record and the dry-run report. */
  evidence?: EvidenceKind[];
  timeout?: string;
  fallback?: string;
  /** Set from the file name (escalation.yaml) by the adapter, never from file content: may use `any` and `return`. */
  escalation?: boolean;
  /** Implements a prose fallback, so the spec consistency test expects no table row for it. */
  fallbackMove?: boolean;
}

export interface Contracts {
  /** The spec version: the git commit of docs/spec.md and contracts/. */
  version: string;
  contentHash: string;
  states: Record<string, StateContract>;
  transitions: TransitionContract[];
}

export interface GuardCheck {
  name: string;
  pass: boolean;
  evidenceIds: string[];
  detail?: string;
}

/** What a guard sees: the node and read-only store operations. A guard never writes. */
export interface GuardContext {
  node: Node;
  store: Pick<
    StoreOps,
    | "getNode"
    | "listEdges"
    | "listEvidence"
    | "listTransitions"
    | "getDecision"
    | "getCounter"
    | "getSetting"
    | "getRun"
    | "findOpenGateRequest"
  >;
}

export type Guard = (ctx: GuardContext) => Promise<GuardCheck>;

export type GuardRegistry = Record<string, Guard>;

const TRACKS: Track[] = ["design", "code", "infra", "docs"];

/** Must list every EvidenceKind; the type annotation makes a drift a compile error. */
const EVIDENCE_KINDS: EvidenceKind[] = [
  "ci_run",
  "test_report",
  "preview_check",
  "staging_check",
  "qa_verdict",
  "visual_comparison",
  "merge_commit",
  "spec_paths",
  "dispatch_record",
  "docs_note",
  "screenshot",
  "agent_report",
];

const STATE_ID = /^[a-z][a-z0-9_]*$/;

/** `any` and `return` are escalation keywords, never state ids (ADR 0105). */
const RESERVED_IDS = ["any", "return"];

const STATE_TEXT_FIELDS = [
  "purpose",
  "input",
  "output",
  "evidence_to_exit",
  "tools",
  "budget",
  "side_effects",
  "failure",
] as const;

const STATE_FLAGS = ["initial", "requires_blocked_reason", "escalated"] as const;

/** The only keys a contract file, a state and a transition may hold (ADR 0105). */
const FILE_KEYS = ["part", "states", "transitions"];
const STATE_KEYS = ["label", "owner", ...STATE_FLAGS, ...STATE_TEXT_FIELDS];
const TRANSITION_KEYS = [
  "from",
  "to",
  "tracks",
  "trigger",
  "guards",
  "evidence",
  "timeout",
  "fallback",
  "fallback_move",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    return null;
  return value as string[];
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** True when two moves could both match one node: no tracks means every track. */
function tracksOverlap(a: Track[] | undefined, b: Track[] | undefined): boolean {
  if (!a || !b) return true;
  return a.some((track) => b.includes(track));
}

/**
 * One parsed contract file, as the contracts-file adapter hands it over. `escalation` is set by
 * the adapter from the file name (escalation.yaml), never from the file's content.
 */
export interface RawContractFile {
  name: string;
  escalation: boolean;
  data: unknown;
}

export interface ValidationResult {
  /** Present only when there are no problems. */
  contracts?: Contracts;
  problems: string[];
}

function validateState(
  where: string,
  value: unknown,
  problems: string[],
): StateContract | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  for (const key of unknownKeys(value, STATE_KEYS)) {
    problems.push(`${where}: unknown field ${key}`);
  }
  if (!isText(value.label)) problems.push(`${where} needs a label`);
  if (!isText(value.owner)) problems.push(`${where} needs an owner`);
  for (const flag of STATE_FLAGS) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") {
      problems.push(`${where}: ${flag} must be a boolean`);
    }
  }
  for (const field of STATE_TEXT_FIELDS) {
    if (value[field] !== undefined && !isText(value[field])) {
      problems.push(`${where}: ${field} must be a non-empty string`);
    }
  }
  return {
    label: isText(value.label) ? value.label : undefined,
    owner: isText(value.owner) ? value.owner : undefined,
    initial: value.initial === true || undefined,
    requiresBlockedReason: value.requires_blocked_reason === true || undefined,
    escalated: value.escalated === true || undefined,
    purpose: isText(value.purpose) ? value.purpose : undefined,
    input: isText(value.input) ? value.input : undefined,
    output: isText(value.output) ? value.output : undefined,
    evidenceToExit: isText(value.evidence_to_exit) ? value.evidence_to_exit : undefined,
    tools: isText(value.tools) ? value.tools : undefined,
    budget: isText(value.budget) ? value.budget : undefined,
    sideEffects: isText(value.side_effects) ? value.side_effects : undefined,
    failure: isText(value.failure) ? value.failure : undefined,
  };
}

function validateTransition(
  fileName: string,
  index: number,
  value: unknown,
  escalation: boolean,
  guardNames: string[],
  problems: string[],
): TransitionContract | null {
  if (!isRecord(value)) {
    problems.push(`${fileName}: transition ${index} must be an object`);
    return null;
  }
  const from = isText(value.from) ? value.from : "";
  const to = isText(value.to) ? value.to : "";
  const where = `${fileName}: transition ${from || "?"} to ${to || "?"}`;
  if (!from || !to) problems.push(`${fileName}: transition ${index} needs from and to`);
  for (const key of unknownKeys(value, TRANSITION_KEYS)) {
    problems.push(`${where}: unknown field ${key}`);
  }
  if ((from === "any" || to === "return") && !escalation) {
    problems.push(`${where}: any and return are only for escalation.yaml`);
  }
  if (from === "return" || to === "any") {
    problems.push(`${where}: return is only a target and any is only a source`);
  }

  const guards = stringList(value.guards);
  if (!guards) {
    problems.push(`${where}: guards must be a list of guard names`);
  } else {
    for (const guard of guards) {
      if (!guardNames.includes(guard))
        problems.push(`${where}: guard ${guard} is not registered`);
    }
  }

  let tracks: Track[] | undefined;
  if (value.tracks !== undefined) {
    const list = stringList(value.tracks);
    if (!list || list.length === 0 || list.some((t) => !TRACKS.includes(t as Track))) {
      problems.push(
        `${where}: tracks must be a non-empty list from ${TRACKS.join(", ")}`,
      );
    } else {
      tracks = list as Track[];
    }
  }

  let evidence: EvidenceKind[] | undefined;
  if (value.evidence !== undefined) {
    const list = stringList(value.evidence);
    if (!list || list.some((kind) => !EVIDENCE_KINDS.includes(kind as EvidenceKind))) {
      problems.push(`${where}: evidence must list known evidence kinds`);
    } else {
      evidence = list as EvidenceKind[];
    }
  }

  for (const field of ["trigger", "timeout", "fallback"]) {
    if (value[field] !== undefined && !isText(value[field])) {
      problems.push(`${where}: ${field} must be a non-empty string`);
    }
  }
  if (value.fallback_move !== undefined && typeof value.fallback_move !== "boolean") {
    problems.push(`${where}: fallback_move must be a boolean`);
  }

  return {
    from,
    to,
    guards: guards ?? [],
    tracks,
    trigger: isText(value.trigger) ? value.trigger : undefined,
    evidence,
    timeout: isText(value.timeout) ? value.timeout : undefined,
    fallback: isText(value.fallback) ? value.fallback : undefined,
    escalation: escalation || undefined,
    fallbackMove: value.fallback_move === true || undefined,
  };
}

/**
 * Checks the parsed contract files the contracts-file adapter produced, merges them and maps
 * them to Contracts, collecting every problem at once (ADR 0105): a file of the wrong shape, an
 * unknown field, a state declared in two files, an unknown state, an unregistered guard, a
 * duplicate move, `any` or `return` outside escalation.yaml, a missing required field.
 * State ids are looked up as own keys only, so names like `toString` are never "known".
 */
export function validateContracts(
  raw: unknown,
  guardNames: string[],
): ValidationResult {
  const problems: string[] = [];
  if (!isRecord(raw)) return { problems: ["contracts must be an object"] };

  if (!isText(raw.version)) problems.push("version must be a non-empty string");
  if (!isText(raw.contentHash)) problems.push("contentHash must be a non-empty string");

  const states = new Map<string, StateContract>();
  const declaredIn = new Map<string, string>();
  const transitions: TransitionContract[] = [];
  const pendingTransitions: { file: RawContractFile; index: number; value: unknown }[] =
    [];

  if (!Array.isArray(raw.files)) {
    problems.push("files must be a list of parsed contract files");
  } else {
    for (const file of raw.files as RawContractFile[]) {
      if (
        !isRecord(file) ||
        !isText(file.name) ||
        typeof file.escalation !== "boolean"
      ) {
        problems.push("each file needs a name, an escalation flag and its data");
        continue;
      }
      const data = file.data;
      if (!isRecord(data)) {
        problems.push(
          `${file.name}: must be a mapping of part, states and transitions`,
        );
        continue;
      }
      for (const key of unknownKeys(data, FILE_KEYS)) {
        problems.push(`${file.name}: unknown field ${key}`);
      }
      const expectedPart = file.name.replace(/\.yaml$/, "");
      if (data.part !== undefined && data.part !== expectedPart) {
        problems.push(
          `${file.name}: part must be ${expectedPart}, the file's own name`,
        );
      }

      if (data.states !== undefined) {
        if (!isRecord(data.states)) {
          problems.push(`${file.name}: states must be a mapping of state ids`);
        } else {
          for (const id of Object.keys(data.states)) {
            if (!STATE_ID.test(id) || RESERVED_IDS.includes(id)) {
              problems.push(
                `${file.name}: state id ${id} must be snake_case and not a reserved word`,
              );
            }
            const already = declaredIn.get(id);
            if (already) {
              problems.push(
                `state ${id} is declared in both ${already} and ${file.name}; each state lives in exactly one file`,
              );
              continue;
            }
            declaredIn.set(id, file.name);
            const state = validateState(
              `${file.name}: state ${id}`,
              data.states[id],
              problems,
            );
            if (state) states.set(id, state);
          }
        }
      }

      if (data.transitions !== undefined) {
        if (!Array.isArray(data.transitions)) {
          problems.push(`${file.name}: transitions must be a list`);
        } else {
          data.transitions.forEach((value, index) =>
            pendingTransitions.push({ file, index, value }),
          );
        }
      }
    }
  }

  // Transitions are checked after every file's states are known, since files reference each
  // other's states (design.yaml uses code.yaml's QA tail).
  for (const { file, index, value } of pendingTransitions) {
    const move = validateTransition(
      file.name,
      index,
      value,
      file.escalation,
      guardNames,
      problems,
    );
    if (!move) continue;
    const where = `${file.name}: transition ${move.from || "?"} to ${move.to || "?"}`;
    if (move.from && move.from !== "any" && !states.has(move.from)) {
      problems.push(`${where}: unknown state ${move.from}`);
    }
    if (move.to && move.to !== "return" && !states.has(move.to)) {
      problems.push(`${where}: unknown state ${move.to}`);
    }
    transitions.push(move);
  }

  for (let a = 0; a < transitions.length; a++) {
    for (let b = a + 1; b < transitions.length; b++) {
      const first = transitions[a] as TransitionContract;
      const second = transitions[b] as TransitionContract;
      if (
        first.from === second.from &&
        first.to === second.to &&
        tracksOverlap(first.tracks, second.tracks)
      ) {
        problems.push(
          `duplicate move ${first.from} to ${first.to} for overlapping tracks`,
        );
      }
    }
  }

  if (problems.length > 0) return { problems };
  // A prototype-free object, so a lookup by a state id never finds an inherited name.
  const stateRecord = Object.assign(
    Object.create(null) as Record<string, StateContract>,
    Object.fromEntries(states),
  );
  return {
    contracts: {
      version: raw.version as string,
      contentHash: raw.contentHash as string,
      states: stateRecord,
      transitions,
    },
    problems,
  };
}
