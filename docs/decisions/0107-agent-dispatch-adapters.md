# 0107. Agent dispatch adapters per runtime

- **Status:** proposed. Desk research only: the M0.2 runs have not happened yet. Reviewed with the other Milestone 0 ADRs at the end of M0, and finished in M3.2.
- **Date:** 2026-10-28
- **Related:** [M0.2 spike record](../spikes/m0.2-agent-dispatch.md), V-01 and V-04, D-119 (model assignments), D-139 (open-source models), [ADR 0101](./0101-repo-layout-and-tooling.md)

## Context

The runner dispatches agents into states and reads their results (`docs/architecture/technical-architecture.md`, sections 2.7 and 2.8). The Developer is Claude Code. QA is Grok, which must be a different model family from the builder. Cursor has no role. Didi wants to try open-source models later (D-139), so the adapter must not assume one vendor.

## Decision

### One adapter interface, one implementation per runtime

Each runtime sits behind one interface in `src/adapters/agent-runtime/`. Proposed shape:

```ts
interface AgentRuntime {
  start(task: AgentTask, limits: RunLimits): Promise<AgentRunResult>;
}
interface RunLimits {
  maxTurns: number;
  maxMinutes: number;
  maxUsd: number;
}
interface AgentRunResult {
  status: "success" | "max_turns" | "budget" | "error" | "timeout" | "usage_exhausted";
  finalText: string;
  structured?: unknown; // for example a QA verdict, validated by the caller
  turns?: number;
  costUsd?: number;
  model: string;
}
```

`status` uses the `runs.outcome` values from `docs/schema.md`, so every run maps straight into the `runs` table.

### Implementations, in order of confidence

| Runtime                         | Used for                                  | How                                                                                         |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code                     | Developer                                 | `claude -p --output-format json` with turn and budget caps, or the Agent SDK in process     |
| OpenAI-compatible chat endpoint | QA verdicts (Grok today)                  | One call with a JSON-schema response. The same code reaches xAI, OpenRouter, Ollama or vLLM |
| goose or opencode (later)       | Open-source agents that edit code (D-139) | Headless run with JSON output against an OpenAI-compatible model server                     |
| Cursor cloud agents             | None (D-119)                              | Not built unless Didi gives Cursor a role                                                   |

QA does not need an agent that edits code. It needs a structured verdict on the PR's head commit, backed by evidence the runner collects itself (CI, preview checks). One API call gives that and works for any vendor.

### Rules every implementation follows

- The runner enforces a wall-clock limit itself, on top of any limit the runtime offers. Some runtimes do not document when they stop.
- The caller validates `structured` output. A QA verdict that does not name the head commit is rejected (P-04).
- Credentials come from the secrets interface by path, never from code. Values are never logged.
- A "usage exhausted" response becomes status `usage_exhausted`, so the dispatch is queued and resumed, not counted as a failure (FR-11).

## Constraints

- No production credentials and no real personal data reach any runtime.
- QA's model family must differ from the builder's. The runner checks this from the `runs` table, not from the agent's word.
- Nothing is built in M0. The adapters are built in M3.2.

## How success is judged

1. Each M0.2 script returns a record with a definite status on a trivial task in the scratch repo, and the independent check agrees with it.
2. `qa-verdict.ts` returns a valid fail verdict naming the commit for the sample diff with a known defect.
3. The same QA script works against a second OpenAI-compatible endpoint with only settings changed (shows D-139 is cheap to add).

## Reasons

- One interface keeps the runner free of runtime details, and adding a model becomes a new implementation, not a change to flows.
- An OpenAI-compatible QA call is the smallest thing that works and is the most portable across vendors and open-weight models.

## Consequences

- Grok Build CLI and Cursor are optional. If Grok's API cannot give a usable verdict, QA moves to another non-Claude model with no code change.
- Open-source agents that edit code need a model server with tool calling. That is an infrastructure cost decided when the experiment starts.
