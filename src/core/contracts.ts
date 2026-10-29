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
  /** Set by the loader for transitions from escalation.yaml: may use `any` and `return`. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    return null;
  return value as string[];
}

/** True when two moves could both match one node: no tracks means every track. */
function tracksOverlap(a: Track[] | undefined, b: Track[] | undefined): boolean {
  if (!a || !b) return true;
  return a.some((track) => b.includes(track));
}

export interface ValidationResult {
  /** Present only when there are no problems. */
  contracts?: Contracts;
  problems: string[];
}

/**
 * Checks the plain object the contracts-file adapter produced and maps it to Contracts,
 * collecting every problem at once (ADR 0105): an unknown state, an unregistered guard, a
 * duplicate move, `any` or `return` outside escalation, a missing required field.
 */
export function validateContracts(
  raw: unknown,
  guardNames: string[],
): ValidationResult {
  const problems: string[] = [];
  if (!isRecord(raw)) return { problems: ["contracts must be an object"] };

  if (!isText(raw.version)) problems.push("version must be a non-empty string");
  if (!isText(raw.contentHash)) problems.push("contentHash must be a non-empty string");

  const states: Record<string, StateContract> = {};
  if (!isRecord(raw.states)) {
    problems.push("states must be an object of state ids");
  } else {
    for (const [id, value] of Object.entries(raw.states)) {
      if (!STATE_ID.test(id) || id === "any" || id === "return") {
        problems.push(`state id ${id} must be snake_case and not a reserved word`);
      }
      if (!isRecord(value)) {
        problems.push(`state ${id} must be an object`);
        continue;
      }
      if (!isText(value.label)) problems.push(`state ${id} needs a label`);
      if (!isText(value.owner)) problems.push(`state ${id} needs an owner`);
      for (const flag of ["initial", "requires_blocked_reason", "escalated"]) {
        if (value[flag] !== undefined && typeof value[flag] !== "boolean") {
          problems.push(`state ${id}: ${flag} must be a boolean`);
        }
      }
      for (const field of STATE_TEXT_FIELDS) {
        if (value[field] !== undefined && !isText(value[field])) {
          problems.push(`state ${id}: ${field} must be a non-empty string`);
        }
      }
      states[id] = {
        label: isText(value.label) ? value.label : undefined,
        owner: isText(value.owner) ? value.owner : undefined,
        initial: value.initial === true || undefined,
        requiresBlockedReason: value.requires_blocked_reason === true || undefined,
        escalated: value.escalated === true || undefined,
        purpose: isText(value.purpose) ? value.purpose : undefined,
        input: isText(value.input) ? value.input : undefined,
        output: isText(value.output) ? value.output : undefined,
        evidenceToExit: isText(value.evidence_to_exit)
          ? value.evidence_to_exit
          : undefined,
        tools: isText(value.tools) ? value.tools : undefined,
        budget: isText(value.budget) ? value.budget : undefined,
        sideEffects: isText(value.side_effects) ? value.side_effects : undefined,
        failure: isText(value.failure) ? value.failure : undefined,
      };
    }
  }

  const transitions: TransitionContract[] = [];
  if (!Array.isArray(raw.transitions)) {
    problems.push("transitions must be a list");
  } else {
    raw.transitions.forEach((value, index) => {
      if (!isRecord(value)) {
        problems.push(`transition ${index} must be an object`);
        return;
      }
      const from = isText(value.from) ? value.from : "";
      const to = isText(value.to) ? value.to : "";
      const where = `transition ${from || "?"} to ${to || "?"}`;
      if (!from || !to) problems.push(`transition ${index} needs from and to`);
      const escalation = value.escalation === true;

      if (from === "any" || to === "return") {
        if (!escalation)
          problems.push(`${where}: any and return are only for escalation.yaml`);
      }
      if (from !== "any" && from !== "" && !(from in states)) {
        problems.push(`${where}: unknown state ${from}`);
      }
      if (to !== "return" && to !== "" && !(to in states)) {
        problems.push(`${where}: unknown state ${to}`);
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
        if (
          !list ||
          list.length === 0 ||
          list.some((track) => !TRACKS.includes(track as Track))
        ) {
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
        if (
          !list ||
          list.some((kind) => !EVIDENCE_KINDS.includes(kind as EvidenceKind))
        ) {
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

      transitions.push({
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
      });
    });

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
  }

  if (problems.length > 0) return { problems };
  return {
    contracts: {
      version: raw.version as string,
      contentHash: raw.contentHash as string,
      states,
      transitions,
    },
    problems,
  };
}
