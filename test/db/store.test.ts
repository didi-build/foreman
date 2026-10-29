// Seam: database integration (docs/test-plan.md, build plan M1.2). The Postgres store and the
// migration tool against a real PostgreSQL. The store connects through the factory_runner role,
// so a grant missing from the migration fails here.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StoreConflictError, type Node, type Store } from "../../src/core/store.ts";
import {
  MigrationError,
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_store_test_${process.pid}`;
const SHA = "c".repeat(40);
const T0 = new Date("2026-10-29T00:00:00Z");
const T1 = new Date("2026-10-29T01:00:00Z");

let counter = 0;
/** Deterministic ids for tests, the way the core's injected id source would supply them. */
const id = (): string =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

describe.skipIf(!adminUrl)("migration tool (database integration, ADR 0104)", () => {
  const name = `${DB}_migrate`;
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: createTestDatabase(name), max: 2 });
  });
  afterAll(async () => {
    await pool.end();
    dropTestDatabase(name);
  });

  it("applies every migration to an empty database, then nothing on a second run", async () => {
    const files = readMigrations();
    expect(await applyMigrations(pool, files)).toEqual(files.map((f) => f.name));
    expect(await applyMigrations(pool, files)).toEqual([]);
    const recorded = await pool.query(
      "select name from factory_meta.schema_migrations order by name",
    );
    expect(recorded.rows.map((r) => r.name)).toEqual(files.map((f) => f.name));
  });

  it("refuses to run when an applied migration's file has changed", async () => {
    const [first, ...rest] = readMigrations();
    const edited = { ...first!, sha256: "0".repeat(64) };
    await expect(applyMigrations(pool, [edited, ...rest])).rejects.toThrow(
      /changed after it was applied/,
    );
  });

  it("refuses to run when an applied migration's file is missing", async () => {
    await expect(applyMigrations(pool, [])).rejects.toThrow(/file is missing/);
  });

  it("rolls back a failing migration completely and does not record it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-migrations-"));
    writeFileSync(
      join(dir, "9001_broken.sql"),
      "create table factory.half_done (id int);\nselect no_such_function();\n",
    );
    const files = [...readMigrations(), ...readMigrations(dir)];
    await expect(applyMigrations(pool, files)).rejects.toThrow(MigrationError);
    const table = await pool.query("select to_regclass('factory.half_done') as t");
    expect(table.rows[0].t).toBeNull();
    const recorded = await pool.query(
      "select count(*)::int as n from factory_meta.schema_migrations where name = '9001_broken.sql'",
    );
    expect(recorded.rows[0].n).toBe(0);
  });
});

describe.skipIf(!adminUrl)(
  "Postgres store (database integration, build plan M1.2)",
  () => {
    let pool: pg.Pool;
    let store: Store;
    const projectId = id();

    const node = (overrides: Partial<Node> = {}): Node => ({
      id: id(),
      projectId,
      type: "work_item",
      track: "code",
      state: "ready_for_dev",
      substate: null,
      ownerRole: "developer",
      title: "An item",
      body: { acceptance: ["one", "two"] },
      hold: false,
      agentReady: true,
      stale: false,
      blockedReason: null,
      stateSince: T0,
      linearIssueId: null,
      linearStatusSynced: null,
      version: 0,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      // Run as the runner's group role, so the store only has the grants the migration gives it.
      pool = new pg.Pool({
        connectionString: url,
        max: 4,
        options: "-c role=factory_runner",
      });
      store = createPostgresStore(pool);
      await store.insertProject({
        id: projectId,
        slug: "rehearsal",
        name: "Rehearsal",
        repo: "didi-build/rehearsal",
        linearProjectId: null,
        galleryPathOverride: null,
        privilegedPathsExtra: ["infra/**"],
        prodRequiresApproval: true,
        stagingUrl: null,
        createdAt: T0,
      });
      await store.insertSpecVersion({ version: SHA, contentHash: "h", loadedAt: T0 });
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    it("runs as the factory_runner role", async () => {
      const who = await pool.query("select current_user as u");
      expect(who.rows[0].u).toBe("factory_runner");
    });

    it("round-trips a project and a node, with JSON arrays intact", async () => {
      const project = await store.getProject(projectId);
      expect(project?.privilegedPathsExtra).toEqual(["infra/**"]);
      const n = node();
      await store.insertNode(n);
      expect(await store.getNode(n.id)).toEqual(n);
      expect(
        (await store.listNodes({ projectId, state: "ready_for_dev" })).map((x) => x.id),
      ).toContain(n.id);
    });

    it("changes a node's state only at the expected version, and increments it", async () => {
      const n = node();
      await store.insertNode(n);
      const change = {
        state: "in_development",
        substate: null,
        ownerRole: "developer",
        blockedReason: null,
        stateSince: T1,
        updatedAt: T1,
      };
      expect(await store.changeNodeState(n.id, 0, change)).toBe(true);
      expect(await store.changeNodeState(n.id, 0, change)).toBe(false);
      const after = await store.getNode(n.id);
      expect(after?.version).toBe(1);
      expect(after?.state).toBe("in_development");
    });

    it("lets exactly one of two concurrent writers at the same version win", async () => {
      const n = node();
      await store.insertNode(n);
      const attempt = (state: string) =>
        store.transaction(async (tx) => {
          const current = await tx.getNodeForUpdate(n.id);
          return tx.changeNodeState(n.id, current?.version === 0 ? 0 : -1, {
            state,
            substate: null,
            ownerRole: "developer",
            blockedReason: null,
            stateSince: T1,
            updatedAt: T1,
          });
        });
      const results = await Promise.all([attempt("a"), attempt("b")]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.getNode(n.id))?.version).toBe(1);
    });

    it("commits a transition and the node change together, or rolls both back", async () => {
      const n = node();
      await store.insertNode(n);
      const transition = {
        id: id(),
        nodeId: n.id,
        fromState: "ready_for_dev",
        toState: "in_development",
        fromSubstate: null,
        toSubstate: null,
        triggerKind: "reconcile" as const,
        triggerRef: null,
        actorKind: "runner" as const,
        actorId: "runner",
        guardResult: [{ name: "blockers_done", pass: true, evidence: [] }],
        evidenceIds: [],
        specVersion: SHA,
        mode: "applied" as const,
        reason: null,
        at: T1,
      };
      const change = {
        state: "in_development",
        substate: null,
        ownerRole: "developer",
        blockedReason: null,
        stateSince: T1,
        updatedAt: T1,
      };

      await expect(
        store.transaction(async (tx) => {
          await tx.insertTransition(transition);
          await tx.changeNodeState(n.id, 0, change);
          throw new Error("guard changed its mind");
        }),
      ).rejects.toThrow("guard changed its mind");
      expect(await store.listTransitions(n.id)).toEqual([]);
      expect((await store.getNode(n.id))?.state).toBe("ready_for_dev");

      await store.transaction(async (tx) => {
        await tx.insertTransition(transition);
        await tx.changeNodeState(n.id, 0, change);
      });
      expect(await store.listTransitions(n.id)).toEqual([transition]);
      expect((await store.getNode(n.id))?.state).toBe("in_development");
    });

    it("filters evidence by commit and kind", async () => {
      const n = node();
      await store.insertNode(n);
      const base = {
        nodeId: n.id,
        runId: null,
        ref: "r",
        payload: {},
        recordedBy: "runner",
        recordedAt: T0,
        supersedesId: null,
      };
      await store.insertEvidence({ ...base, id: id(), kind: "ci_run", commitSha: SHA });
      await store.insertEvidence({
        ...base,
        id: id(),
        kind: "ci_run",
        commitSha: "d".repeat(40),
      });
      await store.insertEvidence({
        ...base,
        id: id(),
        kind: "docs_note",
        commitSha: null,
      });
      expect(await store.listEvidence({ nodeId: n.id, commitSha: SHA })).toHaveLength(
        1,
      );
      expect(await store.listEvidence({ nodeId: n.id, kind: "ci_run" })).toHaveLength(
        2,
      );
    });

    it("reports a decision's status from its events, and finds the nodes that depend on it", async () => {
      const n = node();
      await store.insertNode(n);
      const decision = {
        projectId,
        nodeId: null,
        kind: "answer" as const,
        scope: {},
        byActor: "didi",
        recordedAt: T0,
      };
      const first = { ...decision, id: id(), textVerbatim: "yes" };
      const second = { ...decision, id: id(), textVerbatim: "no" };
      await store.insertDecision(first);
      await store.insertDecision(second);
      await store.linkNodeToDecision(n.id, first.id);
      await store.linkNodeToDecision(n.id, first.id);
      expect((await store.getDecision(first.id))?.status).toBe("active");
      await store.insertDecisionEvent({
        id: id(),
        decisionId: first.id,
        kind: "superseded",
        byDecisionId: second.id,
        reason: null,
        recordedBy: "runner",
        recordedAt: T1,
      });
      const current = await store.getDecision(first.id);
      expect(current?.status).toBe("superseded");
      expect(current?.replacedById).toBe(second.id);
      expect(current?.textVerbatim).toBe("yes");
      expect(await store.listNodesForDecision(first.id)).toEqual([n.id]);
    });

    it("keeps one open gate request per topic, and closes a request only once", async () => {
      const request = {
        projectId,
        nodeId: null,
        topicKey: "spend:windmill",
        kind: "spend" as const,
        owner: "didi" as const,
        blocking: true,
        payload: { question: "Approve?" },
        approvalUrl: null,
        status: "open" as const,
        decisionId: null,
        supersededBy: null,
        createdAt: T0,
        answeredAt: null,
        lastNotifiedAt: null,
      };
      const first = { ...request, id: id() };
      await store.insertGateRequest(first);
      await expect(
        store.insertGateRequest({ ...request, id: id() }),
      ).rejects.toBeInstanceOf(StoreConflictError);
      expect((await store.findOpenGateRequest(projectId, "spend:windmill"))?.id).toBe(
        first.id,
      );

      const answer = {
        id: id(),
        projectId,
        nodeId: null,
        kind: "approval" as const,
        scope: {},
        textVerbatim: "yes",
        byActor: "didi",
        recordedAt: T1,
      };
      await store.insertDecision(answer);
      expect(
        await store.closeGateRequest(first.id, {
          status: "answered",
          decisionId: answer.id,
          at: T1,
        }),
      ).toBe(true);
      expect(
        await store.closeGateRequest(first.id, { status: "cancelled", at: T1 }),
      ).toBe(false);
      const closed = await store.getGateRequest(first.id);
      expect(closed?.status).toBe("answered");
      expect(closed?.answeredAt).toEqual(T1);
      expect(await store.findOpenGateRequest(projectId, "spend:windmill")).toBeNull();
    });

    it("records a run and ends it once, with numbers as numbers", async () => {
      const run = {
        id: id(),
        projectId,
        nodeId: null,
        bot: "developer",
        agentId: null,
        runtime: "claude_code",
        model: "model-a",
        headSha: SHA,
        botVersion: "v1",
        startedAt: T0,
        endedAt: null,
        outcome: null,
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: { maxTurns: 10, maxUsd: 1 },
        parentRunId: null,
        transcriptRef: null,
      };
      await store.insertRun(run);
      const end = {
        endedAt: T1,
        outcome: "success" as const,
        turns: 4,
        minutes: 2.5,
        costUsd: 0.31,
        tokens: { in: 10, out: 5 },
        transcriptRef: null,
      };
      expect(await store.endRun(run.id, end)).toBe(true);
      expect(await store.endRun(run.id, end)).toBe(false);
      const saved = await store.getRun(run.id);
      expect(saved?.minutes).toBe(2.5);
      expect(saved?.costUsd).toBe(0.31);
      expect(saved?.outcome).toBe("success");
    });

    it("starts counters at 0 and stores the count it is given", async () => {
      const n = node();
      await store.insertNode(n);
      expect(await store.getCounter(n.id, "failure")).toBe(0);
      await store.setCounter(n.id, "failure", 1, T0);
      await store.setCounter(n.id, "failure", 2, T1);
      expect(await store.getCounter(n.id, "failure")).toBe(2);
      expect(await store.getCounter(n.id, "qa_round")).toBe(0);
    });

    it("reads seeded settings and writes new values", async () => {
      expect((await store.getSetting("reconcile_interval_minutes"))?.value).toBe(120);
      await store.setSetting({
        key: "kill_switch",
        value: true,
        updatedBy: "didi",
        updatedAt: T1,
      });
      expect((await store.getSetting("kill_switch"))?.value).toBe(true);
    });

    it("loads a spec version once even when asked twice", async () => {
      await store.insertSpecVersion({
        version: SHA,
        contentHash: "other",
        loadedAt: T1,
      });
      expect((await store.getSpecVersion(SHA))?.contentHash).toBe("h");
    });

    it("records decision-point records and their outcomes", async () => {
      const recordId = id();
      await store.insertDecisionPointRecord({
        id: recordId,
        projectId,
        nodeId: null,
        decisionPoint: "triage_track",
        deciderId: "rule-v1",
        inputHash: "e".repeat(64),
        output: { track: "code" },
        confidence: 0.75,
        recordedAt: T0,
      });
      await store.insertDecisionPointOutcome({
        id: id(),
        recordId,
        outcome: { correct: true },
        recordedBy: "runner",
        recordedAt: T1,
      });
      await expect(
        store.insertDecisionPointOutcome({
          id: id(),
          recordId,
          outcome: { correct: false },
          recordedBy: "runner",
          recordedAt: T1,
        }),
      ).rejects.toBeInstanceOf(StoreConflictError);
    });

    it("sets node flags without touching the state or version", async () => {
      const n = node();
      await store.insertNode(n);
      await store.setNodeFlags(n.id, { stale: true }, T1);
      const after = await store.getNode(n.id);
      expect(after?.stale).toBe(true);
      expect(after?.hold).toBe(false);
      expect(after?.version).toBe(0);
    });

    it("lists edges by direction and type", async () => {
      const a = node();
      const b = node();
      await store.insertNode(a);
      await store.insertNode(b);
      await store.insertEdge({
        id: id(),
        fromNode: a.id,
        toNode: b.id,
        type: "blocks",
        createdAt: T0,
      });
      expect(await store.listEdges({ toNode: b.id, type: "blocks" })).toHaveLength(1);
      expect(await store.listEdges({ fromNode: b.id })).toEqual([]);
    });

    it("lists a node's decisions, recorded on it or linked to it, oldest first, with status (M2.2)", async () => {
      const n = node();
      const other = node();
      await store.insertNode(n);
      await store.insertNode(other);
      const decision = {
        projectId,
        kind: "answer" as const,
        scope: {},
        byActor: "didi",
        textVerbatim: "yes",
      };
      const linked = { ...decision, id: id(), nodeId: other.id, recordedAt: T0 };
      const direct = { ...decision, id: id(), nodeId: n.id, recordedAt: T1 };
      const unrelated = { ...decision, id: id(), nodeId: other.id, recordedAt: T0 };
      for (const d of [direct, linked, unrelated]) await store.insertDecision(d);
      await store.linkNodeToDecision(n.id, linked.id);
      await store.insertDecisionEvent({
        id: id(),
        decisionId: direct.id,
        kind: "reversed",
        byDecisionId: null,
        reason: "changed our mind",
        recordedBy: "runner",
        recordedAt: T1,
      });
      const listed = await store.listDecisionsForNode(n.id);
      expect(listed.map((d) => [d.id, d.status])).toEqual([
        [linked.id, "active"],
        [direct.id, "reversed"],
      ]);
    });

    it("lists a node's runs oldest first (M2.2)", async () => {
      const n = node();
      await store.insertNode(n);
      const run = {
        projectId,
        bot: "developer",
        agentId: null,
        runtime: "claude_code",
        model: "model-a",
        headSha: SHA,
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
      };
      const later = { ...run, id: id(), nodeId: n.id, startedAt: T1 };
      const earlier = { ...run, id: id(), nodeId: n.id, startedAt: T0 };
      await store.insertRun(later);
      await store.insertRun(earlier);
      await store.insertRun({ ...run, id: id(), nodeId: null, startedAt: T0 });
      expect((await store.listRuns({ nodeId: n.id })).map((r) => r.id)).toEqual([
        earlier.id,
        later.id,
      ]);
    });
  },
);
