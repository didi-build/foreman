// Where a new idea starts, until contracts/ holds the real Machine 1 contracts (ADR 0105, M2.1).
// From docs/spec.md section 3: an idea is logged as Submitted, owned by the runner. The state API
// creates ideas for the Council and Triage (`POST /ideas`), and the runner creates one for each
// bug a run reported outside its item (./finding-ideas.ts, D-244). Neither moves an idea: no
// Machine 1 move exists yet.
export const IDEA_ENTRY = { state: "submitted", ownerRole: "runner" } as const;
