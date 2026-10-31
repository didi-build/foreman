// The store interface the core depends on (build plan M1.2). The core defines it; an adapter
// implements it (src/adapters/store-postgres/). Shapes follow the factory schema (ADR 0104).
// Ids and times are always passed in: the core takes them from its injected id source and
// clock (D-162), so nothing here generates them.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Project {
  id: string;
  slug: string;
  name: string;
  repo: string;
  linearProjectId: string | null;
  galleryPathOverride: string | null;
  privilegedPathsExtra: Json;
  prodRequiresApproval: boolean;
  stagingUrl: string | null;
  createdAt: Date;
}

export type NodeType = "idea" | "work_item";
export type Track = "design" | "code" | "infra" | "docs";

export interface Node {
  id: string;
  projectId: string;
  type: NodeType;
  track: Track | null;
  state: string;
  substate: string | null;
  ownerRole: string;
  title: string;
  body: Json;
  hold: boolean;
  agentReady: boolean;
  stale: boolean;
  blockedReason: string | null;
  stateSince: Date;
  linearIssueId: string | null;
  linearStatusSynced: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields a state change writes. `version` is checked and incremented by the store. */
export interface NodeStateChange {
  state: string;
  substate: string | null;
  ownerRole: string;
  blockedReason: string | null;
  stateSince: Date;
  updatedAt: Date;
}

export type EdgeType = "blocks" | "split_into" | "design_for";

export interface Edge {
  id: string;
  fromNode: string;
  toNode: string;
  type: EdgeType;
  createdAt: Date;
}

export interface Transition {
  id: string;
  nodeId: string;
  fromState: string;
  toState: string;
  fromSubstate: string | null;
  toSubstate: string | null;
  triggerKind: "event" | "reconcile" | "bot_report" | "human" | "timeout";
  triggerRef: string | null;
  actorKind: "runner" | "bot" | "operator" | "council";
  actorId: string;
  guardResult: Json;
  evidenceIds: string[];
  specVersion: string;
  mode: "applied" | "dry_run";
  reason: string | null;
  at: Date;
}

export type EvidenceKind =
  | "ci_run"
  | "test_report"
  | "preview_check"
  | "staging_check"
  | "qa_verdict"
  | "visual_comparison"
  | "merge_commit"
  | "spec_paths"
  | "dispatch_record"
  | "docs_note"
  | "screenshot"
  | "agent_report";

export interface Evidence {
  id: string;
  nodeId: string;
  runId: string | null;
  kind: EvidenceKind;
  ref: string;
  commitSha: string | null;
  payload: Json;
  recordedBy: string;
  recordedAt: Date;
  supersedesId: string | null;
}

export type DecisionKind =
  "approval" | "answer" | "council_decision" | "interview_answer" | "product_direction";

export interface Decision {
  id: string;
  projectId: string;
  nodeId: string | null;
  kind: DecisionKind;
  scope: Json;
  textVerbatim: string;
  byActor: string;
  recordedAt: Date;
}

export interface DecisionEvent {
  id: string;
  decisionId: string;
  kind: "reversed" | "superseded";
  byDecisionId: string | null;
  reason: string | null;
  recordedBy: string;
  recordedAt: Date;
}

/** A decision with its status derived from its event (the `decisions_current` view). */
export interface CurrentDecision extends Decision {
  status: "active" | "reversed" | "superseded";
  replacedById: string | null;
  statusChangedAt: Date | null;
}

export type GateKind =
  | "visual_approval"
  | "new_credentials"
  | "drop_data"
  | "dns"
  | "pii_access"
  | "spend"
  | "send_message"
  | "production_deploy"
  | "scope"
  | "escalation"
  | "playbook_rule"
  | "privileged_path"
  | "council_question";

export type GateStatus = "open" | "answered" | "superseded" | "expired" | "cancelled";

export interface GateRequest {
  id: string;
  projectId: string;
  nodeId: string | null;
  topicKey: string;
  kind: GateKind;
  owner: "didi" | "council";
  blocking: boolean;
  payload: Json;
  approvalUrl: string | null;
  status: GateStatus;
  decisionId: string | null;
  supersededBy: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  lastNotifiedAt: Date | null;
}

/** How a gate request leaves `open`. The store checks it was still open. */
export type GateClose =
  | { status: "answered"; decisionId: string; at: Date }
  | { status: "superseded"; supersededBy: string; at: Date }
  | { status: "expired" | "cancelled"; at: Date };

export type RunOutcome =
  "success" | "fail" | "timeout" | "cancelled" | "budget_exceeded" | "usage_exhausted";

/** Why a run ended `usage_exhausted` (ADR 0106 section 6). Only money fixes `out_of_credit`. */
export type UsageExhaustedCause = "rate_limit" | "capacity" | "out_of_credit";

export interface Run {
  id: string;
  projectId: string;
  nodeId: string | null;
  bot: string;
  agentId: string | null;
  runtime: string;
  model: string;
  headSha: string | null;
  /** The pull request a QA run reviews (ADR 0112). */
  prNumber: number | null;
  botVersion: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: RunOutcome | null;
  turns: number | null;
  minutes: number | null;
  costUsd: number | null;
  tokens: Json;
  budget: Json;
  parentRunId: string | null;
  transcriptRef: string | null;
  usageExhaustedCause: UsageExhaustedCause | null;
  retryAfterSeconds: number | null;
  // The route the core chose at admission (ADR 0114 section 2, migration 0005). `model` above is
  // the route's model.
  /** From contracts/task-types.yaml, for example `developer:code`. */
  taskType: string;
  /** The provider entry name, as in the egress proxy's provider list. */
  provider: string;
  /** From the model catalog. Kept on the run so the QA independence rule reads the store. */
  modelFamily: string;
  serviceTierRequested: ServiceTier;
  /** The tier the provider's responses reported; null when none reported it. */
  serviceTierServed: ServedTier | null;
  routingPolicyVersion: string;
  modelCatalogVersion: string;
  /** Flex capacity rejections retried inside the run (ADR 0114 section 9). */
  capacityRetries: number | null;
  capacityWaitSeconds: number | null;
  /** Time to the first output token of the first request, where the runtime reports it. */
  firstTokenMs: number | null;
  /** The runtime's own cost figure, kept for comparison with `costUsd`. */
  reportedCostUsd: number | null;
}

/** A provider service tier (ADR 0114 section 8). */
export type ServiceTier = "standard" | "flex" | "priority";

/** The tier a run was served at: one tier, or `mixed` when its responses differed. */
export type ServedTier = ServiceTier | "mixed";

export interface RunEnd {
  endedAt: Date;
  outcome: RunOutcome;
  turns: number | null;
  minutes: number | null;
  costUsd: number | null;
  tokens: Json;
  transcriptRef: string | null;
  /** Set only, and always, when the outcome is `usage_exhausted`. */
  usageExhaustedCause: UsageExhaustedCause | null;
  /** The provider's retry-after, only with `usage_exhausted`. */
  retryAfterSeconds: number | null;
}

export type CounterKind = "failure" | "qa_round";

export interface Setting {
  key: string;
  value: Json;
  updatedBy: string;
  updatedAt: Date;
}

export interface SpecVersion {
  version: string;
  contentHash: string;
  loadedAt: Date;
}

export interface DecisionPointRecord {
  id: string;
  projectId: string;
  nodeId: string | null;
  decisionPoint: string;
  deciderId: string;
  inputHash: string;
  output: Json;
  confidence: number;
  recordedAt: Date;
}

export type AgentRole = "developer" | "qa" | "designer" | "council" | "triage";

/** A per-run agent credential (ADR 0102). Only the token's SHA-256 hash is ever stored. */
export interface RunToken {
  tokenHash: string;
  runId: string;
  role: AgentRole;
  projectId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface DecisionPointOutcome {
  id: string;
  recordId: string;
  outcome: Json;
  recordedBy: string;
  recordedAt: Date;
}

export type GithubDeliveryOutcome = "recorded" | "ignored" | "rejected";

/** One GitHub webhook delivery the receiver handled (ADR 0113 section 3). Never the payload. */
export interface GithubDelivery {
  /** `X-GitHub-Delivery`. */
  deliveryId: string;
  eventType: string;
  /** `owner/name`, or null when a signed payload named none. */
  repository: string | null;
  receivedAt: Date;
  outcome: GithubDeliveryOutcome;
  /** A short fixed reason from the ingestion code, never text from the payload. */
  reason: string | null;
}

/** A node's latest `dispatch_record`: the repository and branch its PR must come from. */
export interface Dispatch {
  nodeId: string;
  repo: string;
  branch: string;
}

/** A write the store refused because of a uniqueness rule, for example a second open gate request. */
export class StoreConflictError extends Error {
  readonly constraint: string;
  constructor(constraint: string, message: string) {
    super(message);
    this.name = "StoreConflictError";
    this.constraint = constraint;
  }
}

/** Every read and write the core needs. Implementations hold no business rules. */
export interface StoreOps {
  insertProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project | null>;

  insertNode(node: Node): Promise<void>;
  getNode(id: string): Promise<Node | null>;
  /** Locks the node row until the transaction ends. Use inside `transaction`. */
  getNodeForUpdate(id: string): Promise<Node | null>;
  listNodes(filter: { projectId?: string; state?: string }): Promise<Node[]>;
  /**
   * Writes a state change only if the node is still at `expectedVersion`, and increments the
   * version. Returns false when another writer got there first (schema invariant 1).
   */
  changeNodeState(
    id: string,
    expectedVersion: number,
    change: NodeStateChange,
  ): Promise<boolean>;
  setNodeFlags(
    id: string,
    flags: Partial<Pick<Node, "hold" | "agentReady" | "stale">>,
    updatedAt: Date,
  ): Promise<void>;

  insertEdge(edge: Edge): Promise<void>;
  listEdges(filter: {
    fromNode?: string;
    toNode?: string;
    type?: EdgeType;
  }): Promise<Edge[]>;

  insertSpecVersion(spec: SpecVersion): Promise<void>;
  getSpecVersion(version: string): Promise<SpecVersion | null>;

  insertTransition(transition: Transition): Promise<void>;
  listTransitions(nodeId: string): Promise<Transition[]>;

  insertEvidence(evidence: Evidence): Promise<void>;
  /**
   * Inserts evidence under an ingest key unless evidence with that key exists (ADR 0113).
   * Returns true when it inserted, false when the fact was already recorded.
   */
  insertEvidenceOnce(evidence: Evidence, ingestKey: string): Promise<boolean>;
  listEvidence(filter: {
    nodeId: string;
    commitSha?: string;
    kind?: EvidenceKind;
  }): Promise<Evidence[]>;

  /**
   * Each node's latest `dispatch_record` that names `repo` (and `branch`, when given). A node
   * whose latest dispatch names another repository or branch is not returned.
   */
  listDispatches(filter: { repo: string; branch?: string }): Promise<Dispatch[]>;

  /** Records a webhook delivery. Returns false, writing nothing, if its id was already recorded. */
  recordGithubDelivery(delivery: GithubDelivery): Promise<boolean>;
  getGithubDelivery(deliveryId: string): Promise<GithubDelivery | null>;

  insertDecision(decision: Decision): Promise<void>;
  insertDecisionEvent(event: DecisionEvent): Promise<void>;
  getDecision(id: string): Promise<CurrentDecision | null>;
  linkNodeToDecision(nodeId: string, decisionId: string): Promise<void>;
  listNodesForDecision(decisionId: string): Promise<string[]>;
  /** Decisions about a node: recorded on it, or linked to it through `node_decisions`. Oldest first. */
  listDecisionsForNode(nodeId: string): Promise<CurrentDecision[]>;

  insertGateRequest(request: GateRequest): Promise<void>;
  getGateRequest(id: string): Promise<GateRequest | null>;
  findOpenGateRequest(projectId: string, topicKey: string): Promise<GateRequest | null>;
  listOpenGateRequests(projectId: string): Promise<GateRequest[]>;
  /** Moves an open request to a closed status. Returns false if it was no longer open. */
  closeGateRequest(id: string, close: GateClose): Promise<boolean>;

  insertRun(run: Run): Promise<void>;
  insertRunToken(token: RunToken): Promise<void>;
  getRunToken(tokenHash: string): Promise<RunToken | null>;
  /** Revokes the run's token, if it has one that is not revoked yet. Returns true if it did. */
  revokeRunToken(runId: string, at: Date): Promise<boolean>;
  getRun(id: string): Promise<Run | null>;
  /** A node's runs, oldest first. */
  listRuns(filter: { nodeId: string }): Promise<Run[]>;
  /** Every run with no end yet, across all projects, oldest first. */
  listActiveRuns(): Promise<Run[]>;
  /**
   * Makes run admission one at a time: a second caller waits here until the first one's
   * transaction ends. Use inside `transaction`, before reading the active runs.
   */
  lockRunAdmission(): Promise<void>;
  /** Records how a run ended. Returns false if it had already ended. */
  endRun(id: string, end: RunEnd): Promise<boolean>;
  /**
   * Keeps the runtime's handle on a run (migration 0006), so a later flow can poll or cancel it.
   * Writes only while the run has not ended and has no handle yet; returns false otherwise.
   */
  setRunHandle(id: string, handle: Json): Promise<boolean>;
  /** The handle the runtime returned for the run, or null when none was kept. */
  getRunHandle(id: string): Promise<Json | null>;

  getCounter(nodeId: string, kind: CounterKind): Promise<number>;
  setCounter(nodeId: string, kind: CounterKind, count: number, at: Date): Promise<void>;

  getSetting(key: string): Promise<Setting | null>;
  setSetting(setting: Setting): Promise<void>;

  insertDecisionPointRecord(record: DecisionPointRecord): Promise<void>;
  insertDecisionPointOutcome(outcome: DecisionPointOutcome): Promise<void>;
}

export interface Store extends StoreOps {
  /** Runs `work` in one database transaction: all of it commits, or none of it does. */
  transaction<T>(work: (tx: StoreOps) => Promise<T>): Promise<T>;
}
