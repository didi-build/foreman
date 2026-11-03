// Where a new idea starts, until contracts/ holds the real Machine 1 contracts (ADR 0105, M2.1).
// From docs/spec.md section 3: an idea is logged as Submitted, owned by the runner. The state API
// creates ideas for the Council and Triage (`POST /ideas`) and for the planning chat with its plan
// (`POST /plans`, ./plans.ts, D-266), and the runner creates one for each bug a run reported
// outside its item (./finding-ideas.ts, D-244). None of them moves an idea: only the runner's plan
// approval step does, on Didi's answer (./plans.ts).
export const IDEA_ENTRY = { state: "submitted", ownerRole: "runner" } as const;
