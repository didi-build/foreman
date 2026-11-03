// Seam: database integration (docs/test-plan.md, D-270). The Council's call on a visual approval
// on the real Postgres store, as the factory_runner role: a call is recorded once per run when two
// run ends race, and once per visual-approval request when two runs' answers, or an answer and a
// drop, race, since the item's row is locked before the check. The request is never touched.
// Synthetic images in a fake screenshot port; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createCouncil, type VisualCallQuestion } from "../../src/core/council.ts";
import type { Store } from "../../src/core/store.ts";
import { visualCallTopic } from "../../src/core/visual-call.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { CALL, setupVisualCall } from "../visual-call-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_visual_call_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "the Council's visual call on Postgres (database integration, D-270)",
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

    async function setup(idPrefix: string, slug: string) {
      const f = await createReconcileFixture({ store, idPrefix, slug });
      await f.setting("dry_run", false);
      const v = await setupVisualCall(f);
      const topic = visualCallTopic(v.nodeId);
      const council = createCouncil({ ...f.deps, screenshots: v.screenshots });
      const callRun = () =>
        f.run(v.nodeId, "council", 0, {
          questionTopic: topic,
          taskType: "council:visual",
        });
      const calls = async () =>
        (await store.listDecisionsForNode(v.nodeId)).filter(
          (d) => d.kind === "council_decision",
        );
      return { f, v, topic, council, callRun, calls };
    }

    it("records a call once per run when two run ends race, and leaves the request as it was", async () => {
      const t = await setup("8f100000-0000-4000-8000", "vcall-a");
      const run = await t.callRun();
      const results = await Promise.all([
        t.council.recordAnswer(run.id, CALL),
        t.council.recordAnswer(run.id, CALL),
      ]);
      expect(results.map((r) => r.recorded).sort()).toEqual(["already_recorded", true]);
      expect(await t.calls()).toMatchObject([
        {
          byActor: "council",
          scope: {
            topicKey: t.topic,
            gateRequestId: t.v.gate.id,
            call: CALL.call,
            runId: run.id,
          },
        },
      ]);
      expect(await store.getGateRequest(t.v.gate.id)).toMatchObject({
        status: "open",
        decisionId: null,
        payload: { options: ["a", "b"] },
      });
    });

    it("records one call per request when two runs' answers, or an answer and a drop, race", async () => {
      const t = await setup("8f200000-0000-4000-8000", "vcall-b");
      const first = await t.callRun();
      const second = await t.callRun();
      const results = await Promise.all([
        t.council.recordAnswer(first.id, CALL),
        t.council.recordAnswer(second.id, {
          call: "needs_didi",
          reason: "A new layout.",
        }),
      ]);
      expect(results.map((r) => r.recorded).sort()).toEqual([false, true]);
      expect(await t.calls()).toHaveLength(1);

      const u = await setup("8f300000-0000-4000-8000", "vcall-c");
      const q = (await u.council.question(u.topic)) as VisualCallQuestion;
      const run = await u.callRun();
      const raced = await Promise.all([
        u.council.recordAnswer(run.id, CALL),
        u.council.dropVisualCall(q, run.id, "test"),
      ]);
      expect(raced.filter((r) => r.recorded === true)).toHaveLength(1);
      expect(await u.calls()).toHaveLength(1);
      expect(await u.council.question(u.topic)).toBeNull();
    });
  },
);
