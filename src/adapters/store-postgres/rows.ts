// Maps factory schema rows (snake_case, from the pg driver) to the core's types and back.
// The driver returns `numeric` as a string, so those columns are converted here.
import type {
  CurrentDecision,
  Decision,
  Edge,
  Evidence,
  GateRequest,
  Json,
  Node,
  Project,
  Run,
  Setting,
  SpecVersion,
  Transition,
} from "../../core/store.ts";

type Row = Record<string, unknown>;

const num = (value: unknown): number | null => (value === null ? null : Number(value));

/** jsonb parameters are sent as text, so arrays are not mistaken for Postgres arrays. */
export const json = (value: Json): string => JSON.stringify(value);

export const toProject = (r: Row): Project => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name as string,
  repo: r.repo as string,
  linearProjectId: r.linear_project_id as string | null,
  galleryPathOverride: r.gallery_path_override as string | null,
  privilegedPathsExtra: r.privileged_paths_extra as Json,
  prodRequiresApproval: r.prod_requires_approval as boolean,
  stagingUrl: r.staging_url as string | null,
  createdAt: r.created_at as Date,
});

export const toNode = (r: Row): Node => ({
  id: r.id as string,
  projectId: r.project_id as string,
  type: r.type as Node["type"],
  track: r.track as Node["track"],
  state: r.state as string,
  substate: r.substate as string | null,
  ownerRole: r.owner_role as string,
  title: r.title as string,
  body: r.body as Json,
  hold: r.hold as boolean,
  agentReady: r.agent_ready as boolean,
  stale: r.stale as boolean,
  blockedReason: r.blocked_reason as string | null,
  stateSince: r.state_since as Date,
  linearIssueId: r.linear_issue_id as string | null,
  linearStatusSynced: r.linear_status_synced as string | null,
  version: r.version as number,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

export const toEdge = (r: Row): Edge => ({
  id: r.id as string,
  fromNode: r.from_node as string,
  toNode: r.to_node as string,
  type: r.type as Edge["type"],
  createdAt: r.created_at as Date,
});

export const toSpecVersion = (r: Row): SpecVersion => ({
  version: r.version as string,
  contentHash: r.content_hash as string,
  loadedAt: r.loaded_at as Date,
});

export const toTransition = (r: Row): Transition => ({
  id: r.id as string,
  nodeId: r.node_id as string,
  fromState: r.from_state as string,
  toState: r.to_state as string,
  fromSubstate: r.from_substate as string | null,
  toSubstate: r.to_substate as string | null,
  triggerKind: r.trigger_kind as Transition["triggerKind"],
  triggerRef: r.trigger_ref as string | null,
  actorKind: r.actor_kind as Transition["actorKind"],
  actorId: r.actor_id as string,
  guardResult: r.guard_result as Json,
  evidenceIds: r.evidence_ids as string[],
  specVersion: r.spec_version as string,
  mode: r.mode as Transition["mode"],
  reason: r.reason as string | null,
  at: r.at as Date,
});

export const toEvidence = (r: Row): Evidence => ({
  id: r.id as string,
  nodeId: r.node_id as string,
  runId: r.run_id as string | null,
  kind: r.kind as Evidence["kind"],
  ref: r.ref as string,
  commitSha: r.commit_sha as string | null,
  payload: r.payload as Json,
  recordedBy: r.recorded_by as string,
  recordedAt: r.recorded_at as Date,
  supersedesId: r.supersedes_id as string | null,
});

const toDecision = (r: Row): Decision => ({
  id: r.id as string,
  projectId: r.project_id as string,
  nodeId: r.node_id as string | null,
  kind: r.kind as Decision["kind"],
  scope: r.scope as Json,
  textVerbatim: r.text_verbatim as string,
  byActor: r.by_actor as string,
  recordedAt: r.recorded_at as Date,
});

export const toCurrentDecision = (r: Row): CurrentDecision => ({
  ...toDecision(r),
  status: r.status as CurrentDecision["status"],
  replacedById: r.replaced_by_id as string | null,
  statusChangedAt: r.status_changed_at as Date | null,
});

export const toGateRequest = (r: Row): GateRequest => ({
  id: r.id as string,
  projectId: r.project_id as string,
  nodeId: r.node_id as string | null,
  topicKey: r.topic_key as string,
  kind: r.kind as GateRequest["kind"],
  owner: r.owner as GateRequest["owner"],
  blocking: r.blocking as boolean,
  payload: r.payload as Json,
  approvalUrl: r.approval_url as string | null,
  status: r.status as GateRequest["status"],
  decisionId: r.decision_id as string | null,
  supersededBy: r.superseded_by as string | null,
  createdAt: r.created_at as Date,
  answeredAt: r.answered_at as Date | null,
  lastNotifiedAt: r.last_notified_at as Date | null,
});

export const toRun = (r: Row): Run => ({
  id: r.id as string,
  projectId: r.project_id as string,
  nodeId: r.node_id as string | null,
  bot: r.bot as string,
  agentId: r.agent_id as string | null,
  runtime: r.runtime as string,
  model: r.model as string,
  headSha: r.head_sha as string | null,
  botVersion: r.bot_version as string,
  startedAt: r.started_at as Date,
  endedAt: r.ended_at as Date | null,
  outcome: r.outcome as Run["outcome"],
  turns: r.turns as number | null,
  minutes: num(r.minutes),
  costUsd: num(r.cost_usd),
  tokens: r.tokens as Json,
  budget: r.budget as Json,
  parentRunId: r.parent_run_id as string | null,
  transcriptRef: r.transcript_ref as string | null,
});

export const toSetting = (r: Row): Setting => ({
  key: r.key as string,
  value: r.value as Json,
  updatedBy: r.updated_by as string,
  updatedAt: r.updated_at as Date,
});
