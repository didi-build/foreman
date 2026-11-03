// Seam: database integration (docs/test-plan.md, D-265). The Triage handoff on the real Postgres
// store as the factory_runner role: one transaction that moves the idea to Handed off and writes
// the work items, their edges, the decision links, the needsDidi gate request and the track
// decision records; two run ends for the same run at once hand off once; a write that fails part
// way leaves nothing behind; and a rejected answer is recorded once.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createLibrary } from "../../src/core/library.ts";
import type { Store } from "../../src/core/store.ts";
import { createTriage, TRACK_DECISION_POINT } from "../../src/core/triage.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import {
  BAD_ANSWERS,
  DIRECTION,
  goodAnswer,
  MAP_COMMIT,
  PLAN,
  REPO_MAP,
} from "../triage-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_triage_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "the Triage handoff on Postgres (database integration, D-265)",
  () => {
    let pool: pg.Pool;
    let store: Store;

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      pool = new pg.Pool({
        connectionString: url,
        max: 4,
        options: "-c role=factory_runner",
      });
      store = createPostgresStore(pool);
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    /** An idea in Triage with its plan and direction, and a finished Triage run at the map's commit. */
    async function ideaWithRun(prefix: string, slug: string) {
      const t = await createReconcileFixture({ store, idPrefix: prefix, slug });
      await t.setting("dry_run", false);
      const idea = await t.node("triage", {
        type: "idea",
        track: null,
        ownerRole: "triage",
        title: "Settings page",
        agentReady: false,
      });
      const library = createLibrary(t.deps);
      for (const [kind, scope, text] of [
        ["product_direction", {}, DIRECTION],
        ["council_decision", { kind: "plan_accepted" }, PLAN],
      ] as const) {
        await library.recordDecision({
          projectId: t.projectId,
          nodeId: idea.id,
          kind,
          scope,
          textVerbatim: text,
          byActor: "council",
        });
      }
      t.advanceMinutes(1);
      const run = await t.run(idea.id, "triage", 0, {
        headSha: MAP_COMMIT,
        taskType: "triage",
      });
      t.advanceMinutes(1);
      return { t, idea, run, triage: createTriage(t.deps) };
    }

    it("hands off once in one transaction when two run ends race", async () => {
      const { t, idea, run, triage } = await ideaWithRun(
        "9a000000-0000-4000-8000",
        "tr1",
      );
      const [a, b] = await Promise.all([
        triage.recordAnswer(run.id, goodAnswer(), REPO_MAP),
        triage.recordAnswer(run.id, goodAnswer(), REPO_MAP),
      ]);
      expect([a.recorded, b.recorded].sort()).toEqual(["already_handed_off", true]);
      expect((await store.getNode(idea.id))?.state).toBe("handed_off");

      const items = await pool.query(
        "select id, track, state, hold, agent_ready, blocked_reason is not null as blocked, body->>'triageKey' as key from factory.nodes where project_id = $1 and type = 'work_item' order by body->>'triageKey'",
        [t.projectId],
      );
      expect(
        items.rows.map((r) => [
          r.key,
          r.track,
          r.state,
          r.hold,
          r.agent_ready,
          r.blocked,
        ]),
      ).toEqual([
        ["old-settings", "code", "blocked", true, true, true],
        [
          "settings-design",
          "design",
          "ready_for_design_exploration",
          false,
          true,
          false,
        ],
        ["settings-dns", "infra", "ready_for_dev", false, true, false],
        ["settings-docs", "docs", "blocked", false, true, true],
        ["settings-wire", "code", "blocked", false, true, true],
      ]);
      const ids = items.rows.map((r) => r.id as string);
      const counts = async (sql: string) =>
        Number((await pool.query(sql, [ids])).rows[0]?.count ?? -1);
      expect(
        await counts(
          "select count(*) from factory.edges where to_node = any($1) and type = 'blocks'",
        ),
      ).toBe(3);
      expect(
        await counts(
          "select count(*) from factory.edges where to_node = any($1) and type = 'split_into'",
        ),
      ).toBe(5);
      expect(
        await counts(
          "select count(*) from factory.edges where to_node = any($1) and type = 'design_for'",
        ),
      ).toBe(1);
      expect(
        await counts(
          "select count(*) from factory.node_decisions where node_id = any($1)",
        ),
      ).toBe(10);
      expect(
        await counts(
          `select count(*) from factory.decision_point_records where node_id = any($1) and decision_point = '${TRACK_DECISION_POINT}'`,
        ),
      ).toBe(5);
      const gates = await pool.query(
        "select kind, owner, blocking, status from factory.gate_requests where node_id = any($1)",
        [ids],
      );
      expect(gates.rows).toEqual([
        { kind: "dns", owner: "didi", blocking: true, status: "open" },
      ]);
      const moves = await pool.query(
        "select from_state, to_state, mode from factory.transitions where node_id = $1",
        [idea.id],
      );
      expect(moves.rows).toEqual([
        { from_state: "triage", to_state: "handed_off", mode: "applied" },
      ]);
    });

    it("leaves nothing behind when a write fails part way, and the next attempt hands off", async () => {
      const { t, idea, run } = await ideaWithRun("9b000000-0000-4000-8000", "tr2");
      let gateCalls = 0;
      const failing: Store = {
        ...store,
        transaction: (work) =>
          store.transaction((tx) =>
            work({
              ...tx,
              insertGateRequest: async (request) => {
                gateCalls++;
                await tx.insertGateRequest(request);
                throw new Error("the gate request write failed");
              },
            }),
          ),
      };
      await expect(
        createTriage({ ...t.deps, store: failing }).recordAnswer(
          run.id,
          goodAnswer(),
          REPO_MAP,
        ),
      ).rejects.toThrow(/gate request write failed/);
      expect(gateCalls).toBe(1);
      expect((await store.getNode(idea.id))?.state).toBe("triage");
      const left = await pool.query(
        "select count(*) from factory.nodes where project_id = $1 and type = 'work_item'",
        [t.projectId],
      );
      expect(Number(left.rows[0]?.count)).toBe(0);
      expect(await store.listTransitions(idea.id)).toEqual([]);
      expect(
        await createTriage(t.deps).recordAnswer(run.id, goodAnswer(), REPO_MAP),
      ).toMatchObject({
        recorded: true,
      });
    });

    it("records a rejected answer once, on the idea, by the runner", async () => {
      const { idea, run, triage } = await ideaWithRun("9c000000-0000-4000-8000", "tr3");
      const bad = BAD_ANSWERS[0]?.answer();
      const [a, b] = await Promise.all([
        triage.recordAnswer(run.id, bad, REPO_MAP),
        triage.recordAnswer(run.id, bad, REPO_MAP),
      ]);
      expect([a, b]).toMatchObject([
        { recorded: false, reason: "rejected" },
        { recorded: false, reason: "rejected" },
      ]);
      const rows = await pool.query(
        "select recorded_by, payload->>'code' as code from factory.evidence where node_id = $1 and kind = 'agent_report'",
        [idea.id],
      );
      expect(rows.rows).toEqual([
        { recorded_by: "runner", code: "path_not_in_repo_map" },
      ]);
      expect((await store.getNode(idea.id))?.state).toBe("triage");
    });
  },
);
