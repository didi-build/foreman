// The Council slice (build plan M3.5, D-228, D-229, N-37, N-39, ADR 0107). Plain logic over an
// injected store, contracts, guards, clock and id source (D-162). It never starts a run: the
// runner starts the Council through the dispatch (flows/lib/council-runs.ts), and admission
// (src/core/runs.ts) decides as for every run.
//
// A Council question is open in two cases. An item waits in Escalated to Council with no Council
// decision since it got there (topic `escalation:<node id>`). A reversal opened its Council
// question, an open `council_question` gate request owned by the Council (topic
// `decision-reversed:<decision id>`, src/core/library.ts). Each Council run carries its
// question's topic (`runs.question_topic`, migration 0014).
//
// The Council has no tools (ADR 0107). It answers with structured output against the schema of its
// question's kind, which its bot profile keeps (`COUNCIL_OUTPUT_SCHEMAS`). When the run ends, the
// runner validates the answer and records the `council_decision` itself, once per run (D-228): the
// Council never writes a decision or any evidence a guard trusts (essential 6). Its words are kept
// only inside that schema-checked answer. An answer that does not fit the schema, or a run that
// gave none, is not usable: the question gets one more run, and after that it goes to Didi as an
// `escalation` gate request with the reason.
//
// An escalation answer is recorded on the item with `scope {topicKey, runId, outcome,
// changesProductDirection, passesGate}` and the note as its text; the escalation pass then acts on
// it (src/core/escalations.ts, `council_decision_recorded`). A reversal answer gives a verdict for
// every item the reversal marked stale (D-229). It is recorded with the question's gate request
// answered, and its verdicts applied, in one transaction: `still_valid` clears the stale flag;
// `redo` clears it for an item still in an initial state of its track (nothing was built yet, so
// the dispatch starts the work again) and leaves any other item stale, since no contract move
// sends an item back to the start of its track (N-40); `cannot_decide` opens one `escalation`
// gate request for Didi on the reversal's topic for those items. A flag stays set while another
// open reversal question still names the item.
//
// Dry run and the kill switch write nothing, read inside the transaction that writes.
import type { Contracts, GuardRegistry } from "./contracts.ts";
import { escalationInput, reversalInput } from "./council-input.ts";
import { createEscalations, type EscalationStep } from "./escalations.ts";
import {
  COUNCIL_CANNOT_RESOLVE,
  escalationTopic,
  latestCouncilDecision,
} from "./guards/escalation.ts";
import { readQaVerdict } from "./guards/evidence.ts";
import { createLibrary, type Clock, type IdSource } from "./library.ts";
import type {
  CurrentDecision,
  Decision,
  GateRequest,
  Json,
  Node,
  Run,
  Store,
  StoreOps,
  Transition,
} from "./store.ts";

/** The topic key prefixes of the two Council questions. */
export const ESCALATION_PREFIX = "escalation:";
export const REVERSAL_PREFIX = "decision-reversed:";

/** One run and one re-run per question; after that the question goes to Didi (D-228). */
export const COUNCIL_RUNS_PER_QUESTION = 2;

/** The Council's notes are kept up to this many characters, then cut with a marker. */
export const COUNCIL_NOTE_CHARS = 4000;

/** Run ends that are not a failure to answer: a provider wait (FR-11) and the runner's own stop. */
const NOT_AN_ATTEMPT: readonly (string | null)[] = ["usage_exhausted", "cancelled"];

const ESCALATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "note", "changesProductDirection", "passesGate"],
  properties: {
    outcome: { type: "string", enum: ["resolve", COUNCIL_CANNOT_RESOLVE] },
    note: { type: "string" },
    changesProductDirection: { type: "boolean" },
    passesGate: { type: "boolean" },
  },
} as const;

const REVERSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts", "note"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "verdict", "note"],
        properties: {
          nodeId: { type: "string" },
          verdict: { type: "string", enum: ["still_valid", "redo", "cannot_decide"] },
          note: { type: "string" },
        },
      },
    },
    note: { type: "string" },
  },
} as const;

/**
 * The Council bot profile's output schemas, one per question kind. Bot files are not loaded yet
 * (ADR 0107: the runner reads one profile per role from settings, `{runtime, botVersion}`), so the
 * profile's default lives here; the task file carries the one for the run's question, and the
 * runner validates the answer against the same one.
 */
export const COUNCIL_OUTPUT_SCHEMAS = {
  escalation: ESCALATION_SCHEMA,
  reversal: REVERSAL_SCHEMA,
} as const;

export type Verdict = "still_valid" | "redo" | "cannot_decide";

export interface EscalationAnswer {
  outcome: "resolve" | typeof COUNCIL_CANNOT_RESOLVE;
  note: string;
  changesProductDirection: boolean;
  passesGate: boolean;
}

export interface ReversalAnswer {
  verdicts: { nodeId: string; verdict: Verdict; note: string }[];
  note: string;
}

export interface EscalationQuestion {
  kind: "escalation";
  topicKey: string;
  projectId: string;
  /** The escalated item; the Council's run is on it. */
  nodeId: string;
  /** When the item entered Escalated to Council. */
  openedAt: Date;
}

export interface ReversalQuestion {
  kind: "reversal";
  topicKey: string;
  projectId: string;
  /** The node the Council's run is on: the reversed decision's, else the first stale one. */
  nodeId: string | null;
  openedAt: Date;
  gateRequestId: string;
  decisionId: string;
  staleNodeIds: string[];
  reason: string | null;
}

export type CouncilQuestion = EscalationQuestion | ReversalQuestion;

/** What the runner does next for one open question. */
export type CouncilNext =
  /** An escalation with a Council decision since it was escalated: the escalation pass acts. */
  | { step: "answered"; question: CouncilQuestion; decisionId: string }
  | { step: "running"; question: CouncilQuestion; runId: string }
  /** A run is due: the first, or the one re-run after an unusable answer. */
  | { step: "start"; question: CouncilQuestion; nodeId: string; attempt: number }
  /** No usable answer after both runs: the question goes to Didi. */
  | { step: "to_didi"; question: CouncilQuestion; lastRunId: string; reason: string }
  /** A reversal question with no node to run on: no decision node and no stale item. */
  | { step: "no_node"; question: CouncilQuestion };

/** What happened to one stale item's verdict. */
export interface AppliedVerdict {
  nodeId: string;
  verdict: Verdict;
  result:
    /** The stale flag was cleared. */
    | "cleared"
    /** Left stale: another open reversal question still names the item. */
    | "stale_for_another_reversal"
    /** Left stale: the item is past the start of its track and no move sends it back (N-40). */
    | "redo_needs_move"
    /** Left stale: the item went to Didi with the others the Council could not decide. */
    | "to_didi"
    | "no_node";
}

/** What `recordAnswer` did with a Council run's answer. */
export type CouncilAnswer =
  | {
      recorded: true | "already_recorded";
      kind: CouncilQuestion["kind"];
      decisionId: string;
      /** A reversal answer, recorded now: each verdict and the gate request for Didi, if any. */
      verdicts?: AppliedVerdict[];
      didiGateRequestId?: string | null;
    }
  | {
      recorded: false;
      reason:
        | "kill_switch"
        | "dry_run"
        | "no_run"
        | "not_a_council_run"
        /** The question is no longer open: answered another way, or the item moved on. */
        | "question_closed"
        /** The answer does not fit the schema; `problem` names the field, never its value. */
        | "invalid";
      problem?: string;
    };

export interface CouncilOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

const isObject = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scopeOf = (decision: Pick<Decision, "scope">): { [key: string]: Json } =>
  isObject(decision.scope) ? (decision.scope as { [key: string]: Json }) : {};
const noteOf = (text: string): string =>
  text.length <= COUNCIL_NOTE_CHARS
    ? text
    : `${text.slice(0, COUNCIL_NOTE_CHARS)} [cut at ${COUNCIL_NOTE_CHARS} characters]`;
const textList = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Checks that an object has exactly these keys. Returns the first problem, naming the field. */
function exactKeys(value: { [key: string]: unknown }, keys: string[], at: string) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `${at}has a field the schema does not allow`;
  }
  for (const key of keys) {
    if (!(key in value)) return `${at}${key} is missing`;
  }
  return null;
}

/** Reads an escalation answer against its schema. Problems name the field, never its value. */
export function readEscalationAnswer(
  value: unknown,
): { answer: EscalationAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const keys = Object.keys(ESCALATION_SCHEMA.properties);
  const shape = exactKeys(value, keys, "the answer ");
  if (shape) return { problem: shape };
  const { outcome, note, changesProductDirection, passesGate } = value;
  if (outcome !== "resolve" && outcome !== COUNCIL_CANNOT_RESOLVE) {
    return { problem: "outcome must be resolve or cannot_resolve" };
  }
  if (typeof note !== "string" || note.trim() === "") {
    return { problem: "note must be non-empty text" };
  }
  if (typeof changesProductDirection !== "boolean") {
    return { problem: "changesProductDirection must be true or false" };
  }
  if (typeof passesGate !== "boolean")
    return { problem: "passesGate must be true or false" };
  return {
    answer: { outcome, note: noteOf(note), changesProductDirection, passesGate },
  };
}

const VERDICTS: readonly string[] = ["still_valid", "redo", "cannot_decide"];

/**
 * Reads a reversal answer against its schema and the reversal's stale items: one verdict for each
 * of them, and none for anything else (D-229). Problems name the field, never its value.
 */
export function readReversalAnswer(
  value: unknown,
  staleNodeIds: readonly string[],
): { answer: ReversalAnswer } | { problem: string } {
  if (!isObject(value)) return { problem: "the answer is not an object" };
  const shape = exactKeys(value, ["verdicts", "note"], "the answer ");
  if (shape) return { problem: shape };
  if (typeof value.note !== "string") return { problem: "note must be text" };
  if (!Array.isArray(value.verdicts)) return { problem: "verdicts must be a list" };
  const verdicts: ReversalAnswer["verdicts"] = [];
  const seen = new Set<string>();
  for (const [i, raw] of value.verdicts.entries()) {
    const at = `verdicts[${i}].`;
    if (!isObject(raw)) return { problem: `verdicts[${i}] is not an object` };
    const fields = exactKeys(raw, ["nodeId", "verdict", "note"], `verdicts[${i}] `);
    if (fields) return { problem: fields };
    const { nodeId, verdict, note } = raw;
    if (typeof nodeId !== "string" || !staleNodeIds.includes(nodeId)) {
      return { problem: `${at}nodeId is not a stale item of this reversal` };
    }
    if (seen.has(nodeId)) return { problem: `${at}nodeId has a verdict already` };
    seen.add(nodeId);
    if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) {
      return { problem: `${at}verdict must be still_valid, redo or cannot_decide` };
    }
    if (typeof note !== "string") return { problem: `${at}note must be text` };
    verdicts.push({ nodeId, verdict: verdict as Verdict, note: noteOf(note) });
  }
  const missing = staleNodeIds.filter((id) => !seen.has(id)).length;
  if (missing > 0) {
    return { problem: `the verdicts miss ${missing} stale item(s) of this reversal` };
  }
  return { answer: { verdicts, note: noteOf(value.note) } };
}

/** Rolls back the answer's transaction with the reason it was not recorded. */
class NotRecorded extends Error {
  readonly reason: "question_closed";
  constructor() {
    super("question_closed");
    this.reason = "question_closed";
  }
}

const field = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) ? (value as { [key: string]: Json })[key] : undefined;

export function createCouncil(options: CouncilOptions) {
  const { store, contracts, clock, ids } = options;
  const library = createLibrary(options);
  const escalations = createEscalations(options);
  const councilState = escalations.councilState;

  const stateOf = (name: string) =>
    Object.hasOwn(contracts.states, name) ? contracts.states[name] : undefined;

  async function escalationQuestion(
    nodeId: string,
  ): Promise<EscalationQuestion | null> {
    const node = await store.getNode(nodeId);
    if (!node || !councilState || node.state !== councilState) return null;
    return {
      kind: "escalation",
      topicKey: escalationTopic(node.id),
      projectId: node.projectId,
      nodeId: node.id,
      openedAt: node.stateSince,
    };
  }

  function reversalQuestion(gate: GateRequest): ReversalQuestion | null {
    if (
      gate.status !== "open" ||
      gate.owner !== "council" ||
      gate.kind !== "council_question" ||
      !gate.topicKey.startsWith(REVERSAL_PREFIX)
    ) {
      return null;
    }
    const staleNodeIds = textList(field(gate.payload, "staleNodeIds"));
    const reason = field(gate.payload, "reason");
    return {
      kind: "reversal",
      topicKey: gate.topicKey,
      projectId: gate.projectId,
      nodeId: gate.nodeId ?? staleNodeIds[0] ?? null,
      openedAt: gate.createdAt,
      gateRequestId: gate.id,
      decisionId: gate.topicKey.slice(REVERSAL_PREFIX.length),
      staleNodeIds,
      reason: typeof reason === "string" ? reason : null,
    };
  }

  /** The open question on a topic key, or null when it is not open. */
  async function question(topicKey: string): Promise<CouncilQuestion | null> {
    if (topicKey.startsWith(ESCALATION_PREFIX)) {
      return escalationQuestion(topicKey.slice(ESCALATION_PREFIX.length));
    }
    if (topicKey.startsWith(REVERSAL_PREFIX)) {
      const decision = await store.getDecision(topicKey.slice(REVERSAL_PREFIX.length));
      if (!decision) return null;
      const gate = await store.findOpenGateRequest(decision.projectId, topicKey);
      return gate ? reversalQuestion(gate) : null;
    }
    return null;
  }

  /** The Council decision a run recorded, if any (`scope.runId`). */
  async function decisionOfRun(run: Run): Promise<CurrentDecision | undefined> {
    if (!run.nodeId) return undefined;
    return (await store.listDecisionsForNode(run.nodeId)).find(
      (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
    );
  }

  /** The question's Council runs since it opened, oldest first. */
  async function runsFor(q: CouncilQuestion): Promise<Run[]> {
    if (!q.nodeId) return [];
    return (await store.listRuns({ nodeId: q.nodeId })).filter(
      (r) =>
        r.bot === "council" &&
        r.questionTopic === q.topicKey &&
        r.startedAt.getTime() >= q.openedAt.getTime(),
    );
  }

  async function next(q: CouncilQuestion): Promise<CouncilNext> {
    if (q.kind === "escalation") {
      const node = await store.getNode(q.nodeId);
      const decision = node ? await latestCouncilDecision({ node, store }) : undefined;
      if (decision) return { step: "answered", question: q, decisionId: decision.id };
    }
    if (!q.nodeId) return { step: "no_node", question: q };
    const runs = await runsFor(q);
    const active = runs.find((r) => r.endedAt === null);
    if (active) return { step: "running", question: q, runId: active.id };
    const attempts: Run[] = [];
    for (const r of runs) {
      if (NOT_AN_ATTEMPT.includes(r.outcome)) continue;
      if (!(await decisionOfRun(r))) attempts.push(r);
    }
    const last = attempts.at(-1);
    if (last && attempts.length >= COUNCIL_RUNS_PER_QUESTION) {
      return {
        step: "to_didi",
        question: q,
        lastRunId: last.id,
        reason: `the Council's ${attempts.length} runs gave no usable answer; the last ended ${last.outcome ?? "without an outcome"}`,
      };
    }
    return {
      step: "start",
      question: q,
      nodeId: q.nodeId,
      attempt: attempts.length + 1,
    };
  }

  /** The escalation move into the Council state: the last applied one into it. */
  async function escalationMove(nodeId: string): Promise<Transition | undefined> {
    return (await store.listTransitions(nodeId))
      .filter((t) => t.mode === "applied" && t.toState === councilState)
      .at(-1);
  }

  async function escalationTaskInput(q: EscalationQuestion): Promise<string> {
    const node = (await store.getNode(q.nodeId)) as Node;
    const move = await escalationMove(node.id);
    const why: string[] = [];
    if (move?.reason) why.push(move.reason);
    if (Array.isArray(move?.guardResult)) {
      for (const check of move.guardResult) {
        const detail = field(check, "detail");
        if (field(check, "pass") === true && typeof detail === "string")
          why.push(detail);
      }
    }
    const failures = (
      await store.listEvidence({ nodeId: node.id, kind: "failure_count" })
    ).map((e) => ({
      cause: String(field(e.payload, "cause") ?? ""),
      failedGuards: textList(field(e.payload, "failedGuards")),
      commitSha: e.commitSha,
    }));
    const failedVerdict = (
      await store.listEvidence({ nodeId: node.id, kind: "qa_verdict" })
    )
      .map((e) => ({ e, verdict: readQaVerdict(e.payload) }))
      .filter((v) => v.verdict?.verdict === "fail")
      .at(-1);
    const stagingFails = [];
    for (const kind of ["staging_check", "staging_deploy_failed"] as const) {
      for (const e of await store.listEvidence({ nodeId: node.id, kind })) {
        if (kind === "staging_check" && field(e.payload, "pass") !== false) continue;
        stagingFails.push({ kind, commitSha: e.commitSha, at: e.recordedAt });
      }
    }
    stagingFails.sort((a, b) => a.at.getTime() - b.at.getTime());
    return escalationInput({
      node,
      escalatedFrom: move?.fromState ?? null,
      why,
      counters: {
        failure: await store.getCounter(node.id, "failure"),
        qaRound: await store.getCounter(node.id, "qa_round"),
      },
      failures,
      qaFail: failedVerdict
        ? {
            commitSha: failedVerdict.e.commitSha,
            findings: failedVerdict.verdict?.findings ?? [],
          }
        : null,
      stagingFails: stagingFails.map(({ kind, commitSha }) => ({ kind, commitSha })),
    });
  }

  async function reversalTaskInput(q: ReversalQuestion): Promise<string> {
    const decision = await store.getDecision(q.decisionId);
    const staleItems: Node[] = [];
    for (const id of q.staleNodeIds) {
      const node = await store.getNode(id);
      if (node) staleItems.push(node);
    }
    return reversalInput({
      decision: {
        id: q.decisionId,
        kind: decision?.kind ?? "",
        byActor: decision?.byActor ?? "",
        textVerbatim: decision?.textVerbatim ?? "",
        recordedAt: decision?.recordedAt ?? q.openedAt,
      },
      reason: q.reason,
      staleItems,
    });
  }

  /** Whether another open reversal question, the Council's or Didi's, still names the node. */
  async function staleForAnother(
    tx: StoreOps,
    projectId: string,
    topicKey: string,
    nodeId: string,
  ): Promise<boolean> {
    return (await tx.listOpenGateRequests(projectId)).some(
      (g) =>
        g.topicKey.startsWith(REVERSAL_PREFIX) &&
        g.topicKey !== topicKey &&
        [
          ...textList(field(g.payload, "staleNodeIds")),
          ...textList(field(g.payload, "nodeIds")),
        ].includes(nodeId),
    );
  }

  /** The switches, read inside the transaction that writes. */
  async function held(tx: StoreOps): Promise<"kill_switch" | "dry_run" | null> {
    if ((await tx.getSetting("kill_switch"))?.value === true) return "kill_switch";
    if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
    return null;
  }

  async function recordEscalation(
    run: Run & { nodeId: string },
    q: EscalationQuestion,
    answer: EscalationAnswer,
  ): Promise<CouncilAnswer> {
    const decision: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: q.nodeId,
      kind: "council_decision",
      scope: {
        topicKey: q.topicKey,
        runId: run.id,
        outcome: answer.outcome,
        changesProductDirection: answer.changesProductDirection,
        passesGate: answer.passesGate,
      },
      textVerbatim: answer.note,
      byActor: "council",
      recordedAt: clock.now(),
    };
    return store.transaction(async (tx): Promise<CouncilAnswer> => {
      const switches = await held(tx);
      if (switches) return { recorded: false, reason: switches };
      // The node's row lock makes the check and the insert one at a time per item.
      const node = await tx.getNodeForUpdate(q.nodeId);
      const earlier = (await tx.listDecisionsForNode(q.nodeId)).find(
        (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
      );
      if (earlier) {
        return {
          recorded: "already_recorded",
          kind: "escalation",
          decisionId: earlier.id,
        };
      }
      if (
        !node ||
        node.state !== councilState ||
        node.stateSince.getTime() > run.startedAt.getTime() ||
        (await latestCouncilDecision({ node, store: tx }))
      ) {
        return { recorded: false, reason: "question_closed" };
      }
      await tx.insertDecision(decision);
      return { recorded: true, kind: "escalation", decisionId: decision.id };
    });
  }

  async function recordReversal(
    run: Run & { nodeId: string },
    q: ReversalQuestion,
    answer: ReversalAnswer,
  ): Promise<CouncilAnswer> {
    const at = clock.now();
    const decision: Decision = {
      id: ids.next(),
      projectId: q.projectId,
      nodeId: run.nodeId,
      kind: "council_decision",
      scope: {
        topicKey: q.topicKey,
        runId: run.id,
        reversedDecisionId: q.decisionId,
        verdicts: answer.verdicts.map((v) => ({ ...v })),
      },
      textVerbatim: answer.note,
      byActor: "council",
      recordedAt: at,
    };
    return store
      .transaction(async (tx): Promise<CouncilAnswer> => {
        const switches = await held(tx);
        if (switches) return { recorded: false, reason: switches };
        await tx.getNodeForUpdate(run.nodeId);
        const earlier = (await tx.listDecisionsForNode(run.nodeId)).find(
          (d) => d.kind === "council_decision" && scopeOf(d).runId === run.id,
        );
        if (earlier) {
          return {
            recorded: "already_recorded",
            kind: "reversal",
            decisionId: earlier.id,
          };
        }
        await tx.insertDecision(decision);
        // The question closes once: a second answer finds it closed and rolls back.
        const closed = await tx.closeGateRequest(q.gateRequestId, {
          status: "answered",
          decisionId: decision.id,
          at,
        });
        if (!closed) throw new NotRecorded();
        const verdicts: AppliedVerdict[] = [];
        const undecided: string[] = [];
        for (const { nodeId, verdict } of answer.verdicts) {
          const node = await tx.getNodeForUpdate(nodeId);
          if (!node) {
            verdicts.push({ nodeId, verdict, result: "no_node" });
            continue;
          }
          if (verdict === "cannot_decide") {
            undecided.push(nodeId);
            verdicts.push({ nodeId, verdict, result: "to_didi" });
            continue;
          }
          // Redo needs the item back at the start of its track. One still in an initial state has
          // built nothing yet, so clearing its flag lets the dispatch start the work again. No
          // contract move sends any other item back (N-40): it stays paused.
          if (verdict === "redo" && !stateOf(node.state)?.initial) {
            verdicts.push({ nodeId, verdict, result: "redo_needs_move" });
            continue;
          }
          if (await staleForAnother(tx, q.projectId, q.topicKey, nodeId)) {
            verdicts.push({ nodeId, verdict, result: "stale_for_another_reversal" });
            continue;
          }
          await tx.setNodeFlags(nodeId, { stale: false }, at);
          verdicts.push({ nodeId, verdict, result: "cleared" });
        }
        let didiGateRequestId: string | null = null;
        if (undecided.length > 0) {
          const gate: GateRequest = {
            id: ids.next(),
            projectId: q.projectId,
            nodeId: (await tx.getGateRequest(q.gateRequestId))?.nodeId ?? null,
            topicKey: q.topicKey,
            kind: "escalation",
            owner: "didi",
            blocking: true,
            payload: {
              question:
                "A decision was reversed, and the Council could not decide whether the work on these items still stands.",
              decisionId: q.decisionId,
              nodeIds: undecided,
              councilDecisionId: decision.id,
              councilNote: answer.note,
            },
            approvalUrl: null,
            status: "open",
            decisionId: null,
            supersededBy: null,
            createdAt: at,
            answeredAt: null,
            lastNotifiedAt: null,
          };
          await tx.insertGateRequest(gate);
          didiGateRequestId = gate.id;
        }
        return {
          recorded: true,
          kind: "reversal",
          decisionId: decision.id,
          verdicts,
          didiGateRequestId,
        };
      })
      .catch((error: unknown) => {
        if (error instanceof NotRecorded)
          return { recorded: false, reason: error.reason };
        throw error;
      });
  }

  return {
    question,

    /** Every open Council question, escalations first, in the store's order. */
    async questions(): Promise<CouncilQuestion[]> {
      const found: CouncilQuestion[] = [];
      if (councilState) {
        for (const node of await store.listNodes({ state: councilState })) {
          const q = await escalationQuestion(node.id);
          if (q) found.push(q);
        }
      }
      const projectIds = [
        ...new Set((await store.listNodes({})).map((n) => n.projectId)),
      ];
      for (const projectId of projectIds) {
        for (const gate of await store.listOpenGateRequests(projectId)) {
          const q = reversalQuestion(gate);
          if (q) found.push(q);
        }
      }
      return found;
    },

    next,

    /**
     * What a Council run on the topic starts with: its input (src/core/council-input.ts) and the
     * output schema of its question's kind. Null when the question is not open.
     */
    async taskFor(topicKey: string): Promise<{
      question: CouncilQuestion;
      input: string;
      outputSchema: Record<string, unknown>;
    } | null> {
      const q = await question(topicKey);
      if (!q) return null;
      const input =
        q.kind === "escalation"
          ? await escalationTaskInput(q)
          : await reversalTaskInput(q);
      return {
        question: q,
        input,
        outputSchema: structuredClone(COUNCIL_OUTPUT_SCHEMAS[q.kind]) as Record<
          string,
          unknown
        >,
      };
    },

    /**
     * Validates a finished Council run's structured answer against its question's schema and
     * records the `council_decision` (D-228), once per run. A reversal answer is applied in the
     * same transaction (D-229). The agent's text outside the answer is never read.
     */
    async recordAnswer(runId: string, structured: unknown): Promise<CouncilAnswer> {
      const found = await store.getRun(runId);
      if (!found) return { recorded: false, reason: "no_run" };
      if (found.bot !== "council" || !found.questionTopic || !found.nodeId) {
        return { recorded: false, reason: "not_a_council_run" };
      }
      const run = found as Run & { nodeId: string };
      const earlier = await decisionOfRun(run);
      const q = await question(found.questionTopic);
      if (earlier) {
        return {
          recorded: "already_recorded",
          kind: found.questionTopic.startsWith(REVERSAL_PREFIX)
            ? "reversal"
            : "escalation",
          decisionId: earlier.id,
        };
      }
      if (!q) return { recorded: false, reason: "question_closed" };
      if (q.kind === "escalation") {
        const read = readEscalationAnswer(structured);
        if ("problem" in read)
          return { recorded: false, reason: "invalid", problem: read.problem };
        return recordEscalation(run, q, read.answer);
      }
      const read = readReversalAnswer(structured, q.staleNodeIds);
      if ("problem" in read)
        return { recorded: false, reason: "invalid", problem: read.problem };
      return recordReversal(run, q, read.answer);
    },

    /**
     * Sends a question with no usable answer to Didi (D-228): for an escalation, one `escalation`
     * gate request on the item's topic and the move to Escalated to Didi; for a reversal, one
     * `escalation` gate request for Didi on the reversal's topic, which replaces the Council's
     * question. Live mode only; the kill switch and dry run open nothing.
     */
    async toDidi(
      q: CouncilQuestion,
      lastRunId: string,
      reason: string,
    ): Promise<
      | { kind: "escalation"; step: EscalationStep }
      | { kind: "reversal"; gateRequestId: string | null }
    > {
      if (q.kind === "escalation") {
        return {
          kind: "escalation",
          step: await escalations.councilUnanswered(q.nodeId, lastRunId, reason),
        };
      }
      if ((await store.getSetting("kill_switch"))?.value === true)
        return { kind: "reversal", gateRequestId: null };
      if ((await store.getSetting("dry_run"))?.value !== false)
        return { kind: "reversal", gateRequestId: null };
      const open = await store.findOpenGateRequest(q.projectId, q.topicKey);
      if (open?.owner === "didi") return { kind: "reversal", gateRequestId: open.id };
      const gate = await library.openGateRequest({
        projectId: q.projectId,
        nodeId: open?.nodeId ?? null,
        topicKey: q.topicKey,
        kind: "escalation",
        owner: "didi",
        blocking: true,
        payload: {
          question:
            "A decision was reversed, and the Council gave no usable answer on what to redo.",
          decisionId: q.decisionId,
          nodeIds: q.staleNodeIds,
          reason,
          lastCouncilRunId: lastRunId,
        },
      });
      return { kind: "reversal", gateRequestId: gate.id };
    },
  };
}

export type Council = ReturnType<typeof createCouncil>;
