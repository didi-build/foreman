// The Postgres implementation of the core's Store (build plan M1.2). The only module with SQL
// for the factory schema (ADR 0104). It holds no business rules: guards, legal moves and
// counters live in the core.
import pg from "pg";

import {
  StoreConflictError,
  type CounterKind,
  type Store,
  type StoreOps,
} from "../../core/store.ts";
import {
  json,
  toCurrentDecision,
  toEdge,
  toEvidence,
  toGateRequest,
  toNode,
  toProject,
  toRun,
  toSetting,
  toSpecVersion,
  toTransition,
} from "./rows.ts";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Turns a unique-violation from Postgres into the core's conflict error; rethrows the rest. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === "23505") {
      throw new StoreConflictError(
        constraint ?? "unique",
        `A uniqueness rule refused the write (${constraint ?? "unique"})`,
      );
    }
    throw error;
  }
}

function ops(db: Queryable): StoreOps {
  const rows = async (text: string, values: unknown[] = []) =>
    run(async () => (await db.query(text, values)).rows as Record<string, unknown>[]);
  const one = async (text: string, values: unknown[] = []) =>
    (await rows(text, values))[0] ?? null;
  const exec = async (text: string, values: unknown[] = []) =>
    run(async () => (await db.query(text, values)).rowCount ?? 0);

  return {
    async insertProject(p) {
      await exec(
        `insert into factory.projects (id, slug, name, repo, linear_project_id, gallery_path_override,
           privileged_paths_extra, prod_requires_approval, staging_url, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          p.id,
          p.slug,
          p.name,
          p.repo,
          p.linearProjectId,
          p.galleryPathOverride,
          json(p.privilegedPathsExtra),
          p.prodRequiresApproval,
          p.stagingUrl,
          p.createdAt,
        ],
      );
    },
    async getProject(id) {
      const r = await one("select * from factory.projects where id = $1", [id]);
      return r && toProject(r);
    },

    async insertNode(n) {
      await exec(
        `insert into factory.nodes (id, project_id, type, track, state, substate, owner_role, title, body,
           hold, agent_ready, stale, blocked_reason, state_since, linear_issue_id, linear_status_synced,
           version, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          n.id,
          n.projectId,
          n.type,
          n.track,
          n.state,
          n.substate,
          n.ownerRole,
          n.title,
          json(n.body),
          n.hold,
          n.agentReady,
          n.stale,
          n.blockedReason,
          n.stateSince,
          n.linearIssueId,
          n.linearStatusSynced,
          n.version,
          n.createdAt,
          n.updatedAt,
        ],
      );
    },
    async getNode(id) {
      const r = await one("select * from factory.nodes where id = $1", [id]);
      return r && toNode(r);
    },
    async getNodeForUpdate(id) {
      const r = await one("select * from factory.nodes where id = $1 for update", [id]);
      return r && toNode(r);
    },
    async listNodes(filter) {
      const result = await rows(
        `select * from factory.nodes
         where ($1::uuid is null or project_id = $1) and ($2::text is null or state = $2)
         order by created_at, id`,
        [filter.projectId ?? null, filter.state ?? null],
      );
      return result.map(toNode);
    },
    async changeNodeState(id, expectedVersion, c) {
      const changed = await exec(
        `update factory.nodes
         set state = $3, substate = $4, owner_role = $5, blocked_reason = $6, state_since = $7,
             updated_at = $8, version = version + 1
         where id = $1 and version = $2`,
        [
          id,
          expectedVersion,
          c.state,
          c.substate,
          c.ownerRole,
          c.blockedReason,
          c.stateSince,
          c.updatedAt,
        ],
      );
      return changed === 1;
    },
    async setNodeFlags(id, flags, updatedAt) {
      await exec(
        `update factory.nodes
         set hold = coalesce($2, hold), agent_ready = coalesce($3, agent_ready),
             stale = coalesce($4, stale), updated_at = $5
         where id = $1`,
        [
          id,
          flags.hold ?? null,
          flags.agentReady ?? null,
          flags.stale ?? null,
          updatedAt,
        ],
      );
    },

    async insertEdge(e) {
      await exec(
        "insert into factory.edges (id, from_node, to_node, type, created_at) values ($1, $2, $3, $4, $5)",
        [e.id, e.fromNode, e.toNode, e.type, e.createdAt],
      );
    },
    async listEdges(filter) {
      const result = await rows(
        `select * from factory.edges
         where ($1::uuid is null or from_node = $1) and ($2::uuid is null or to_node = $2)
           and ($3::text is null or type = $3)
         order by created_at, id`,
        [filter.fromNode ?? null, filter.toNode ?? null, filter.type ?? null],
      );
      return result.map(toEdge);
    },

    async insertSpecVersion(s) {
      // The same version may be loaded again; the first record stands (the table is append-only).
      await exec(
        `insert into factory.spec_versions (version, content_hash, loaded_at) values ($1, $2, $3)
         on conflict (version) do nothing`,
        [s.version, s.contentHash, s.loadedAt],
      );
    },
    async getSpecVersion(version) {
      const r = await one("select * from factory.spec_versions where version = $1", [
        version,
      ]);
      return r && toSpecVersion(r);
    },

    async insertTransition(t) {
      await exec(
        `insert into factory.transitions (id, node_id, from_state, to_state, from_substate, to_substate,
           trigger_kind, trigger_ref, actor_kind, actor_id, guard_result, evidence_ids, spec_version,
           mode, reason, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          t.id,
          t.nodeId,
          t.fromState,
          t.toState,
          t.fromSubstate,
          t.toSubstate,
          t.triggerKind,
          t.triggerRef,
          t.actorKind,
          t.actorId,
          json(t.guardResult),
          t.evidenceIds,
          t.specVersion,
          t.mode,
          t.reason,
          t.at,
        ],
      );
    },
    async listTransitions(nodeId) {
      const result = await rows(
        "select * from factory.transitions where node_id = $1 order by at, id",
        [nodeId],
      );
      return result.map(toTransition);
    },

    async insertEvidence(e) {
      await exec(
        `insert into factory.evidence (id, node_id, run_id, kind, ref, commit_sha, payload, recorded_by,
           recorded_at, supersedes_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          e.id,
          e.nodeId,
          e.runId,
          e.kind,
          e.ref,
          e.commitSha,
          json(e.payload),
          e.recordedBy,
          e.recordedAt,
          e.supersedesId,
        ],
      );
    },
    async listEvidence(filter) {
      const result = await rows(
        `select * from factory.evidence
         where node_id = $1 and ($2::text is null or commit_sha = $2) and ($3::text is null or kind = $3)
         order by recorded_at, id`,
        [filter.nodeId, filter.commitSha ?? null, filter.kind ?? null],
      );
      return result.map(toEvidence);
    },

    async insertDecision(d) {
      await exec(
        `insert into factory.decisions (id, project_id, node_id, kind, scope, text_verbatim, by_actor, recorded_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          d.id,
          d.projectId,
          d.nodeId,
          d.kind,
          json(d.scope),
          d.textVerbatim,
          d.byActor,
          d.recordedAt,
        ],
      );
    },
    async insertDecisionEvent(e) {
      await exec(
        `insert into factory.decision_events (id, decision_id, kind, by_decision_id, reason, recorded_by, recorded_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          e.id,
          e.decisionId,
          e.kind,
          e.byDecisionId,
          e.reason,
          e.recordedBy,
          e.recordedAt,
        ],
      );
    },
    async getDecision(id) {
      const r = await one("select * from factory.decisions_current where id = $1", [
        id,
      ]);
      return r && toCurrentDecision(r);
    },
    async linkNodeToDecision(nodeId, decisionId) {
      await exec(
        `insert into factory.node_decisions (node_id, decision_id) values ($1, $2)
         on conflict do nothing`,
        [nodeId, decisionId],
      );
    },
    async listNodesForDecision(decisionId) {
      const result = await rows(
        "select node_id from factory.node_decisions where decision_id = $1 order by node_id",
        [decisionId],
      );
      return result.map((r) => r.node_id as string);
    },

    async insertGateRequest(g) {
      await exec(
        `insert into factory.gate_requests (id, project_id, node_id, topic_key, kind, owner, blocking, payload,
           approval_url, status, decision_id, superseded_by, created_at, answered_at, last_notified_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          g.id,
          g.projectId,
          g.nodeId,
          g.topicKey,
          g.kind,
          g.owner,
          g.blocking,
          json(g.payload),
          g.approvalUrl,
          g.status,
          g.decisionId,
          g.supersededBy,
          g.createdAt,
          g.answeredAt,
          g.lastNotifiedAt,
        ],
      );
    },
    async getGateRequest(id) {
      const r = await one("select * from factory.gate_requests where id = $1", [id]);
      return r && toGateRequest(r);
    },
    async findOpenGateRequest(projectId, topicKey) {
      const r = await one(
        "select * from factory.gate_requests where project_id = $1 and topic_key = $2 and status = 'open'",
        [projectId, topicKey],
      );
      return r && toGateRequest(r);
    },
    async closeGateRequest(id, close) {
      const changed = await exec(
        `update factory.gate_requests
         set status = $2, decision_id = $3, superseded_by = $4,
             answered_at = case when $2 = 'answered' then $5::timestamptz else answered_at end
         where id = $1 and status = 'open'`,
        [
          id,
          close.status,
          close.status === "answered" ? close.decisionId : null,
          close.status === "superseded" ? close.supersededBy : null,
          close.at,
        ],
      );
      return changed === 1;
    },

    async insertRun(r) {
      await exec(
        `insert into factory.runs (id, project_id, node_id, bot, agent_id, runtime, model, head_sha, bot_version,
           started_at, ended_at, outcome, turns, minutes, cost_usd, tokens, budget, parent_run_id, transcript_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          r.id,
          r.projectId,
          r.nodeId,
          r.bot,
          r.agentId,
          r.runtime,
          r.model,
          r.headSha,
          r.botVersion,
          r.startedAt,
          r.endedAt,
          r.outcome,
          r.turns,
          r.minutes,
          r.costUsd,
          r.tokens === null ? null : json(r.tokens),
          json(r.budget),
          r.parentRunId,
          r.transcriptRef,
        ],
      );
    },
    async getRun(id) {
      const r = await one("select * from factory.runs where id = $1", [id]);
      return r && toRun(r);
    },
    async endRun(id, end) {
      const changed = await exec(
        `update factory.runs
         set ended_at = $2, outcome = $3, turns = $4, minutes = $5, cost_usd = $6, tokens = $7,
             transcript_ref = $8
         where id = $1 and ended_at is null`,
        [
          id,
          end.endedAt,
          end.outcome,
          end.turns,
          end.minutes,
          end.costUsd,
          end.tokens === null ? null : json(end.tokens),
          end.transcriptRef,
        ],
      );
      return changed === 1;
    },

    async getCounter(nodeId, kind: CounterKind) {
      const r = await one(
        "select count from factory.counters where node_id = $1 and kind = $2",
        [nodeId, kind],
      );
      return r ? (r.count as number) : 0;
    },
    async setCounter(nodeId, kind, count, at) {
      await exec(
        `insert into factory.counters (node_id, kind, count, updated_at) values ($1, $2, $3, $4)
         on conflict (node_id, kind) do update set count = excluded.count, updated_at = excluded.updated_at`,
        [nodeId, kind, count, at],
      );
    },

    async getSetting(key) {
      const r = await one("select * from factory.settings where key = $1", [key]);
      return r && toSetting(r);
    },
    async setSetting(s) {
      await exec(
        `insert into factory.settings (key, value, updated_by, updated_at) values ($1, $2, $3, $4)
         on conflict (key) do update
           set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [s.key, json(s.value), s.updatedBy, s.updatedAt],
      );
    },

    async insertDecisionPointRecord(d) {
      await exec(
        `insert into factory.decision_point_records (id, project_id, node_id, decision_point, decider_id,
           input_hash, output, confidence, recorded_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          d.id,
          d.projectId,
          d.nodeId,
          d.decisionPoint,
          d.deciderId,
          d.inputHash,
          json(d.output),
          d.confidence,
          d.recordedAt,
        ],
      );
    },
    async insertDecisionPointOutcome(o) {
      await exec(
        `insert into factory.decision_point_outcomes (id, record_id, outcome, recorded_by, recorded_at)
         values ($1, $2, $3, $4, $5)`,
        [o.id, o.recordId, json(o.outcome), o.recordedBy, o.recordedAt],
      );
    },
  };
}

/** A Store over a connection pool. The caller owns the pool and ends it. */
export function createPostgresStore(pool: pg.Pool): Store {
  return {
    ...ops(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(ops(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
