// Seam: database integration (docs/test-plan.md, build plan M2.4). The reconcile pass in dry run on
// the real Postgres store, as the factory_runner role: the dry-run transition rows it writes, the
// node left unchanged, no duplicate row on a second pass, and no run inserted. The store gained
// no call for the pass; this checks its reads and the dry-run write against the real schema.
// Then the live pass through the reconcile flow (D-329 slice 3, O-103): two passes at once, as
// two Windmill runs of the schedule could be, give one release and one first run per item, held
// by the node's version check and admission's lock, with the fake agent runtime.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Store } from "../../src/core/store.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { flowDepsFor } from "../flows/flow-fixture.ts";
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

    it("in live mode, two passes at once release once and start one first run per item", async () => {
      const f = await createReconcileFixture({
        store,
        idPrefix: "61000000-0000-4000-8000",
        slug: "live",
      });
      await f.setting("dry_run", false);
      const blocker = await f.node("done");
      const blocked = await f.node("blocked");
      await f.blocks(blocker.id, blocked.id);
      const ready = await f.node("ready_for_dev");
      const { deps, tasksFor } = flowDepsFor(f.deps);
      // The database is shared with the test above, whose items the live passes take on too.
      const mine = () =>
        tasksFor.filter((t) => [blocked.id, ready.id].includes(t.run.nodeId ?? ""));

      const passes = await Promise.all([reconcileFlow(deps), reconcileFlow(deps)]);

      expect(passes.map((p) => p.mode)).toEqual(["live", "live"]);
      const rows = await f.transitions(blocked.id, ready.id);
      expect(rows.map((t) => [t.nodeId, t.mode, t.toState])).toEqual([
        [blocked.id, "applied", "ready_for_dev"],
        [blocked.id, "applied", "in_development"],
        [ready.id, "applied", "in_development"],
      ]);
      for (const node of [blocked, ready]) {
        const runs = await store.listRuns({ nodeId: node.id });
        expect(runs.map((r) => [r.bot, r.endedAt])).toEqual([["developer", null]]);
        expect(await store.getNode(node.id)).toMatchObject({ state: "in_development" });
      }
      expect(mine()).toHaveLength(2);
      // The pass that lost each race says so, and throws nothing. It lost either before the
      // winner's first run moved the item (`noop`, `item_has_active_run`) or after it (the move
      // out of In development is refused, and the node is no longer in the state planned).
      const mineOf = <T extends { nodeId: string }>(steps: T[] | null) =>
        (steps ?? []).filter((s) => [blocked.id, ready.id].includes(s.nodeId));
      const releases = passes.flatMap((p) => mineOf(p.released));
      expect(releases.map((r) => r.move.outcome).sort()).toEqual([
        "applied",
        expect.stringMatching(/^(noop|rejected)$/),
      ]);
      const starts = passes
        .flatMap((p) => mineOf(p.dispatched))
        .map((d) =>
          d.result?.outcome === "not_admitted" ? d.result.reason : d.result?.outcome,
        );
      expect(starts.filter((o) => o === "started")).toHaveLength(1);
      expect(starts.filter((o) => o !== "started")).toEqual([
        expect.stringMatching(/^(item_has_active_run|state_changed)$/),
      ]);

      const third = await reconcileFlow(deps);
      expect(mineOf(third.released)).toEqual([]);
      expect(mineOf(third.dispatched)).toEqual([]);
      expect(mine()).toHaveLength(2);
    });
  },
);
