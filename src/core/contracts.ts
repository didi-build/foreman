// The shape the library reads contracts in (essential 3). Minimal until ADR 0105 (M2) defines
// the real format in contracts/. Rules live here and in guard functions, never in the library.
import type { Node, StoreOps } from "./store.ts";

export interface StateContract {
  /** A node may only enter this state with a blocked reason (schema invariant 4). */
  requiresBlockedReason?: boolean;
  /** An escalated state: nothing in it is dispatched (schema invariant 6). */
  escalated?: boolean;
  /** A node may be created in this state. */
  initial?: boolean;
}

export interface TransitionContract {
  from: string;
  to: string;
  /** Guard names, looked up in the guard registry. Every one must pass. */
  guards: string[];
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
