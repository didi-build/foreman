// Test support for the state API's three context routes (ADR 0119 slice 3b): one synthetic
// project with records of every kind the routes read, markers in every field they must never
// return, and a second project whose records must never reach a run of the first. The API tests
// (test/context-routes.test.ts) use it on the memory store, and the database tests
// (test/db/context-routes.test.ts) on Postgres, written as the runner's role and read as the
// state API's.
import { hashToken } from "../src/api/auth.ts";
import { testRouteColumns } from "../src/core/routing-testing.ts";
import type {
  AgentRole,
  Decision,
  Evidence,
  GateRequest,
  Json,
  Node,
  Run,
  Store,
  Transition,
} from "../src/core/store.ts";

export const PROJECT = "00000000-0000-4000-8000-00000000c001";
export const OTHER_PROJECT = "00000000-0000-4000-8000-00000000c002";
export const HEAD = "c0ffee0000000000000000000000000000000001";
export const SPEC = "context-routes-spec";
const BASE = Date.parse("2026-11-20T09:00:00Z");
/** A fixed time, `minutes` after the fixture's first record. */
export const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);

/** Texts that must never be in any context answer. */
export const NEVER_SHOWN = {
  pageUrl: "https://approvals.example.invalid/PAGE-URL-MARKER",
  approver: "APPROVER-MARKER",
  gatePayload: "GATE-PAYLOAD-MARKER",
  gateUrl: "https://approvals.example.invalid/GATE-URL-MARKER",
  builderReport: "BUILDER-REPORT-MARKER",
  docsNote: "DOCS-NOTE-MARKER",
  qaNote: "QA-NOTE-MARKER",
  payloadPath: "PAYLOAD-PATH-MARKER",
  branch: "BRANCH-MARKER",
  guardDetail: "GUARD-DETAIL-MARKER",
  triggerRef: "TRIGGER-REF-MARKER",
  actorId: "ACTOR-ID-MARKER",
  bodyExtra: "BODY-EXTRA-MARKER",
  check: "CHECK-COMMAND-MARKER",
  linearId: "LINEAR-ID-MARKER",
  transcript: "transcripts/TRANSCRIPT-MARKER",
  budget: "BUDGET-MARKER",
  handle: "HANDLE-MARKER",
  setting: "SETTING-MARKER",
  secretName: "SECRET_NAME_MARKER",
  otherProject: "OTHER-PROJECT-MARKER",
  dryRun: "DRY-RUN-MARKER",
  unknownActor: "unknown-actor-marker",
  scopeTopic: "SCOPE-TOPIC-MARKER",
} as const;

/** The fixture's records, by name. */
export interface ContextSeed {
  /** The work item every history test reads: code track, in development. */
  item: Node;
  /** A merged code item that shares a folder and words with `item`. */
  similar: Node;
  /** A design item that shares only the word "report". */
  design: Node;
  /** An infra item that shares nothing. */
  unrelated: Node;
  idea: Node;
  /** A work item of the other project, alike in every way. */
  foreign: Node;
  decisions: {
    approval: Decision;
    answer: Decision;
    council: Decision;
    direction: Decision;
    superseded: Decision;
    unknownActor: Decision;
    foreign: Decision;
  };
}

let n = 0;
/** A fresh id, unique within the test run. */
export const nextId = (): string =>
  `00000000-0000-4000-8000-${(0xc100000 + ++n).toString(16).padStart(12, "0")}`;

async function project(store: Store, id: string, slug: string): Promise<void> {
  await store.insertProject({
    id,
    slug,
    name: slug,
    repo: `didi-build/${slug}`,
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    deployTarget: "cloudflare",
    createdAt: at(0),
  });
}

async function node(
  store: Store,
  fields: Pick<Node, "projectId" | "type" | "track" | "state" | "title" | "body"> & {
    minutes: number;
  },
): Promise<Node> {
  const created: Node = {
    id: nextId(),
    projectId: fields.projectId,
    type: fields.type,
    track: fields.track,
    state: fields.state,
    substate: null,
    ownerRole: fields.type === "idea" ? "council" : "developer",
    title: fields.title,
    body: fields.body,
    hold: false,
    agentReady: true,
    stale: false,
    blockedReason: null,
    stateSince: at(fields.minutes),
    linearIssueId: `${NEVER_SHOWN.linearId}-${n}`,
    linearStatusSynced: null,
    version: 0,
    createdAt: at(fields.minutes),
    updatedAt: at(fields.minutes),
  };
  await store.insertNode(created);
  return created;
}

/** A run with the route columns every run carries, as the runner records one. */
export function runRecord(
  role: AgentRole,
  fields: Partial<Run> & Pick<Run, "projectId" | "nodeId" | "startedAt">,
): Run {
  return {
    id: nextId(),
    bot: role,
    agentId: null,
    runtime: "claude_code",
    model: "model-a",
    headSha: role === "qa" ? HEAD : null,
    prNumber: null,
    botVersion: "v1",
    endedAt: null,
    outcome: null,
    turns: null,
    minutes: null,
    costUsd: null,
    tokens: null,
    budget: {},
    parentRunId: null,
    transcriptRef: null,
    usageExhaustedCause: null,
    retryAfterSeconds: null,
    questionTopic: null,
    ...testRouteColumns(role),
    ...fields,
  };
}

/**
 * Issues a run and its token the way the runner does at dispatch (ADR 0102): the store keeps only
 * the token's hash. The run is on `nodeId`, or on no node.
 */
export async function issueToken(
  store: Store,
  role: AgentRole,
  options: {
    projectId?: string;
    nodeId?: string | null;
    expiresAt?: Date;
    revoked?: boolean;
    ended?: boolean;
  } = {},
): Promise<string> {
  const projectId = options.projectId ?? PROJECT;
  const run = runRecord(role, {
    projectId,
    nodeId: options.nodeId ?? null,
    startedAt: at(0),
    ...(options.ended ? { endedAt: at(1), outcome: "success" as const } : {}),
  });
  await store.insertRun(run);
  const token = `context-test-token-${run.id.replaceAll("-", "")}`;
  await store.insertRunToken({
    tokenHash: hashToken(token),
    runId: run.id,
    role,
    projectId,
    expiresAt: options.expiresAt ?? new Date("2099-01-01T00:00:00Z"),
    revokedAt: options.revoked ? at(1) : null,
  });
  return token;
}

/** Seeds both projects. The store may be the memory store or Postgres as the runner's role. */
export async function seedContextRoutes(store: Store): Promise<ContextSeed> {
  await project(store, PROJECT, "context-rehearsal");
  await project(store, OTHER_PROJECT, "context-elsewhere");
  await store.insertSpecVersion({ version: SPEC, contentHash: "h", loadedAt: at(0) });
  await store.setSetting({
    key: "context_fixture_marker",
    value: NEVER_SHOWN.setting,
    updatedBy: "test",
    updatedAt: at(0),
  });
  await store.insertProjectSecretName({
    id: nextId(),
    projectId: PROJECT,
    name: NEVER_SHOWN.secretName,
    setAt: at(0),
    windmillRunId: null,
    recordedBy: "runner:set-project-secret",
  });

  const idea = await node(store, {
    projectId: PROJECT,
    type: "idea",
    track: null,
    state: "handed_off",
    title: "Report exports",
    body: { description: "People want to take the report away as a file." },
    minutes: 1,
  });
  const item = await node(store, {
    projectId: PROJECT,
    type: "work_item",
    track: "code",
    state: "in_development",
    title: "Export the report as CSV",
    body: {
      description: "The report page exports its rows as a CSV file.",
      acceptanceCriteria: ["A CSV file downloads", "The header row names each column"],
      pathsInScope: ["src/report/export.ts", "src/report/csv/"],
      checks: [NEVER_SHOWN.check],
      notes: NEVER_SHOWN.bodyExtra,
    },
    minutes: 2,
  });
  const similar = await node(store, {
    projectId: PROJECT,
    type: "work_item",
    track: "code",
    state: "done",
    title: "Add a header row to the report CSV",
    body: {
      description: "Name each column of the CSV.",
      pathsInScope: ["src/report/csv/header.ts"],
      checks: [NEVER_SHOWN.check],
    },
    minutes: 3,
  });
  const design = await node(store, {
    projectId: PROJECT,
    type: "work_item",
    track: "design",
    state: "exploring_options",
    title: "Report page layout",
    body: { pathsInScope: ["components/report-page/"] },
    minutes: 4,
  });
  const unrelated = await node(store, {
    projectId: PROJECT,
    type: "work_item",
    track: "infra",
    state: "ready_for_dev",
    title: "Rotate the database password",
    body: { pathsInScope: ["infra/db/"] },
    minutes: 5,
  });
  const foreign = await node(store, {
    projectId: OTHER_PROJECT,
    type: "work_item",
    track: "code",
    state: "in_development",
    title: `${NEVER_SHOWN.otherProject} export the report as CSV`,
    body: {
      description: `${NEVER_SHOWN.otherProject} CSV export`,
      pathsInScope: ["src/report/export.ts"],
    },
    minutes: 6,
  });

  // Decisions: the search for "csv export" matches every one of the project's, newest last.
  const decide = async (
    minutes: number,
    fields: Pick<Decision, "kind" | "textVerbatim" | "byActor"> &
      Partial<Pick<Decision, "nodeId" | "scope" | "projectId">>,
  ): Promise<Decision> => {
    const decision: Decision = {
      id: nextId(),
      projectId: fields.projectId ?? PROJECT,
      nodeId: fields.nodeId ?? null,
      kind: fields.kind,
      scope: fields.scope ?? {},
      textVerbatim: fields.textVerbatim,
      byActor: fields.byActor,
      recordedAt: at(minutes),
    };
    await store.insertDecision(decision);
    return decision;
  };
  const approval = await decide(10, {
    kind: "approval",
    nodeId: item.id,
    byActor: "didi",
    textVerbatim: "Approved: the CSV export keeps one header row.",
    scope: {
      topicKey: NEVER_SHOWN.scopeTopic,
      gateKind: "visual_approval",
      outcome: "approved",
      via: "approval_page",
      pageUrl: NEVER_SHOWN.pageUrl,
      approvers: [NEVER_SHOWN.approver],
    },
  });
  const answer = await decide(11, {
    kind: "answer",
    nodeId: item.id,
    byActor: "didi",
    textVerbatim: "Changes requested: the CSV Export must quote commas.",
    scope: {
      gateKind: "not_a_gate_kind",
      outcome: "maybe",
      pageUrl: NEVER_SHOWN.pageUrl,
      approvers: [NEVER_SHOWN.approver],
    },
  });
  const council = await decide(12, {
    kind: "council_decision",
    nodeId: item.id,
    byActor: "council",
    textVerbatim: "Resolve: keep the csv export to one file.",
    scope: {
      topicKey: NEVER_SHOWN.scopeTopic,
      outcome: "resolve",
      changesProductDirection: false,
      passesGate: false,
    },
  });
  const direction = await decide(13, {
    kind: "product_direction",
    byActor: "triage",
    textVerbatim: "Exports stay CSV only for now.",
  });
  const unknownActor = await decide(14, {
    kind: "interview_answer",
    nodeId: idea.id,
    byActor: NEVER_SHOWN.unknownActor,
    textVerbatim:
      "An answer about the CSV export from an actor the routes do not name.",
  });
  // The newest of all, but superseded, so it comes after every active one.
  const superseded = await decide(15, {
    kind: "interview_answer",
    nodeId: idea.id,
    byActor: "planning",
    textVerbatim: "Old answer: export as CSV and as a spreadsheet.",
  });
  await store.insertDecisionEvent({
    id: nextId(),
    decisionId: superseded.id,
    kind: "superseded",
    byDecisionId: direction.id,
    reason: null,
    recordedBy: "runner",
    recordedAt: at(16),
  });
  const foreignDecision = await decide(17, {
    projectId: OTHER_PROJECT,
    kind: "product_direction",
    byActor: "triage",
    nodeId: foreign.id,
    textVerbatim: `${NEVER_SHOWN.otherProject}: the CSV export goes everywhere.`,
  });

  // The item's state moves: four applied, the newest one back from QA, and one dry run.
  const move = async (
    minutes: number,
    fields: Pick<Transition, "fromState" | "toState" | "triggerKind"> &
      Partial<Transition>,
  ): Promise<void> => {
    await store.insertTransition({
      id: nextId(),
      nodeId: item.id,
      fromSubstate: null,
      toSubstate: null,
      triggerRef: NEVER_SHOWN.triggerRef,
      actorKind: "runner",
      actorId: NEVER_SHOWN.actorId,
      guardResult: [],
      evidenceIds: [],
      specVersion: SPEC,
      mode: "applied",
      reason: null,
      at: at(minutes),
      ...fields,
    });
  };
  await move(20, {
    fromState: "triage",
    toState: "ready_for_dev",
    triggerKind: "reconcile",
  });
  await move(21, {
    fromState: "ready_for_dev",
    toState: "in_development",
    triggerKind: "event",
    guardResult: [
      {
        name: "agent_ready",
        pass: true,
        evidenceIds: [],
        detail: NEVER_SHOWN.guardDetail,
      },
    ],
  });
  await move(22, {
    fromState: "in_development",
    toState: "in_qa_review",
    triggerKind: "bot_report",
  });
  await move(23, {
    fromState: "in_qa_review",
    toState: "in_development",
    triggerKind: "bot_report",
    reason: "QA failed the head: the CSV misses quotes.",
    guardResult: [
      {
        name: "qa_failed_with_findings",
        pass: true,
        evidenceIds: [],
        detail: NEVER_SHOWN.guardDetail,
      },
      {
        name: "ci_green_on_head",
        pass: false,
        evidenceIds: [],
        detail: NEVER_SHOWN.guardDetail,
      },
      { name: "Not A Guard Name", pass: false, evidenceIds: [] },
    ],
  });
  await move(24, {
    fromState: "in_development",
    toState: "done",
    triggerKind: "reconcile",
    mode: "dry_run",
    reason: NEVER_SHOWN.dryRun,
  });

  // Runs on the item: a Developer run that ended, a QA run that failed, and one running now.
  const developerRun = runRecord("developer", {
    projectId: PROJECT,
    nodeId: item.id,
    startedAt: at(21),
    endedAt: at(22),
    outcome: "success",
    turns: 12,
    minutes: 4,
    costUsd: 1.25,
    tokens: { input: 1000, output: 200 },
    budget: { usd: 5, note: NEVER_SHOWN.budget },
    transcriptRef: NEVER_SHOWN.transcript,
  });
  const qaRun = runRecord("qa", {
    projectId: PROJECT,
    nodeId: item.id,
    startedAt: at(22),
    endedAt: at(23),
    outcome: "fail",
    costUsd: 0.75,
  });
  const runningRun = runRecord("developer", {
    projectId: PROJECT,
    nodeId: item.id,
    startedAt: at(25),
  });
  for (const run of [developerRun, qaRun, runningRun]) await store.insertRun(run);
  await store.setRunHandle(runningRun.id, { job: NEVER_SHOWN.handle });

  const evidence = async (
    minutes: number,
    fields: Pick<Evidence, "kind" | "payload" | "recordedBy"> & Partial<Evidence>,
  ): Promise<Evidence> => {
    const row: Evidence = {
      id: nextId(),
      nodeId: item.id,
      runId: null,
      ref: "ref",
      commitSha: null,
      recordedAt: at(minutes),
      supersedesId: null,
      ...fields,
    };
    await store.insertEvidence(row);
    return row;
  };
  await evidence(21, {
    kind: "dispatch_record",
    recordedBy: "runner",
    runId: developerRun.id,
    payload: {
      repo: "didi-build/context-rehearsal",
      branch: `foreman/${NEVER_SHOWN.branch}`,
    },
  });
  const ci = await evidence(22, {
    kind: "ci_run",
    recordedBy: "github",
    commitSha: HEAD,
    payload: { conclusion: "success", pr: 12, changedPaths: [NEVER_SHOWN.payloadPath] },
  });
  await evidence(22, {
    kind: "agent_report",
    recordedBy: "developer",
    runId: developerRun.id,
    payload: { summary: NEVER_SHOWN.builderReport },
  });
  await evidence(22, {
    kind: "docs_note",
    recordedBy: "developer",
    runId: developerRun.id,
    commitSha: HEAD,
    payload: { impact: "updated", note: NEVER_SHOWN.docsNote },
  });
  await evidence(23, {
    kind: "qa_verdict",
    recordedBy: "qa",
    runId: qaRun.id,
    commitSha: HEAD,
    payload: {
      verdict: "fail",
      findings: [
        {
          path: "src/report/export.ts",
          startLine: 3,
          endLine: 4,
          note: NEVER_SHOWN.qaNote,
        },
      ],
      evidenceIds: [ci.id],
    },
  });
  await evidence(23, {
    kind: "merge_check",
    recordedBy: "runner",
    commitSha: HEAD,
    payload: { pr: 12, mergeable: true },
  });
  await evidence(24, {
    kind: "staging_deploy_failed",
    recordedBy: "runner",
    commitSha: HEAD,
    payload: { cause: "infrastructure", reason: "refused", text: "Cloudflare refused" },
  });
  await evidence(24, {
    kind: "staging_check",
    recordedBy: "runner",
    commitSha: HEAD,
    payload: { pass: false },
  });
  await store.insertEvidence({
    id: nextId(),
    nodeId: foreign.id,
    runId: null,
    kind: "ci_run",
    ref: NEVER_SHOWN.otherProject,
    commitSha: HEAD,
    payload: { conclusion: "failure", pr: 99 },
    recordedBy: "github",
    recordedAt: at(24),
    supersedesId: null,
  });

  // Gate requests on the item: one Didi answered with the approval, one open.
  const gate = (
    minutes: number,
    fields: Pick<GateRequest, "kind" | "status" | "topicKey"> & Partial<GateRequest>,
  ): GateRequest => ({
    id: nextId(),
    projectId: PROJECT,
    nodeId: item.id,
    owner: "didi",
    blocking: true,
    payload: { options: [NEVER_SHOWN.gatePayload] } as Json,
    approvalUrl: NEVER_SHOWN.gateUrl,
    decisionId: null,
    supersededBy: null,
    createdAt: at(minutes),
    answeredAt: null,
    lastNotifiedAt: null,
    ...fields,
  });
  await store.insertGateRequest(
    gate(9, {
      kind: "visual_approval",
      status: "answered",
      topicKey: `visual:${item.id}`,
      decisionId: approval.id,
      answeredAt: at(10),
    }),
  );
  await store.insertGateRequest(
    gate(24, { kind: "escalation", status: "open", topicKey: `escalation:${item.id}` }),
  );

  return {
    item,
    similar,
    design,
    unrelated,
    idea,
    foreign,
    decisions: {
      approval,
      answer,
      council,
      direction,
      superseded,
      unknownActor,
      foreign: foreignDecision,
    },
  };
}

/** Every key of every object in a JSON value, at any depth. */
export function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      keysOf(entry, into);
    }
  }
  return into;
}

/**
 * Key names no context answer may hold, case-folded: `scope` and `body` as whole names (an item's
 * `pathsInScope` is shown), and the rest as any part of a name.
 */
export const FORBIDDEN_KEY =
  /^scope$|^body$|approval_?url|token|hash|budget|cost|price|payload|transcript|handle|linear|setting|secret|guard_?result|trigger_?ref|actor_?id|model/i;

/** The decision ids of a decision view list, in order. */
export const idsOf = (decisions: readonly { id: string }[]): string[] =>
  decisions.map((d) => d.id);
