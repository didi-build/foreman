// Where a new idea starts, until contracts/ holds the real Machine 1 contracts (ADR 0105, M2.1).
// From docs/spec.md section 3: an idea is logged as Submitted, owned by the runner. The API only
// creates ideas; no endpoint moves a node (essential 1), so no other contract is needed here.
import type { Contracts } from "../core/contracts.ts";

export const IDEA_ENTRY = { state: "submitted", ownerRole: "runner" } as const;

export const ENTRY_CONTRACTS: Contracts = {
  version: "entry-placeholder",
  contentHash: "entry-placeholder",
  states: { [IDEA_ENTRY.state]: { initial: true } },
  transitions: [],
};
