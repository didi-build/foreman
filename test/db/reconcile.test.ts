// Seam: database integration (docs/test-plan.md, build plan M2.4). The reconcile pass in dry run on
// the real Postgres store, as the factory_runner role: the dry-run transition rows it writes, the
// node left unchanged, no duplicate row on a second pass, and no run inserted. The store gained
// no call for the pass; this checks its reads and the dry-run write against the real schema.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Store } from "../../src/core/store.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_reconcile_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "reconcile pass on Postgres (database integration, build plan M2.4)",
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

    it("writes dry-run rows only, once, and leaves nodes and runs as they were", async () => {
      const f = await createReconcileFixture({
        store,
        idPrefix: "60000000-0000-4000-8000",
      });
      const blocker = await f.node("done");
      const blocked = await f.node("blocked");
      await f.blocks(blocker.id, blocked.id);
      const ready = await f.node("ready_for_dev");

      const first = await f.pass({ windmillExecutionsThisMonth: 812 });

      expect(first.stopped).toBeNull();
      expect(first.releases.map((r) => r.outcome)).toEqual(["planned"]);
      expect(first.dispatches.map((d) => d.outcome)).toEqual(["planned"]);
      expect(first.executions).toMatchObject({ threshold: 800, alert: true });
      const rows = await f.transitions(blocked.id, ready.id);
      expect(rows.map((t) => [t.mode, t.fromState, t.toState])).toEqual([
        ["dry_run", "blocked", "ready_for_dev"],
        ["dry_run", "ready_for_dev", "in_development"],
      ]);
      expect(await store.getSpecVersion(f.contracts.version)).not.toBeNull();
      for (const node of [blocked, ready]) {
        const after = await store.getNode(node.id);
        expect(after).toMatchObject({ state: node.state, version: 0 });
      }
      expect(await store.listActiveRuns()).toEqual([]);

      f.advanceMinutes(120);
      const second = await f.pass();

      expect(await f.transitions(blocked.id, ready.id)).toEqual(rows);
      expect(second.releases.map((r) => r.outcome)).toEqual(["already_planned"]);
      expect(second.attention.map((a) => a.nodeId)).toEqual([ready.id]);
      expect(await store.listActiveRuns()).toEqual([]);
    });
  },
);
