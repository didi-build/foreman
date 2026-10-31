// Seam: database integration (docs/test-plan.md, O-41). A fix round on the real Postgres store, as
// the factory_runner role: an item a failed staging check sent back to In development gets one
// Developer run for three triggers at once (admission's lock lets one through), with a fresh
// `dispatch_record` on the item's one branch and no move, and the item is not due after it.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startBuilderRuns } from "../../flows/lib/builder-runs.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createBuilderRuns } from "../../src/core/builder-runs.ts";
import type { Store } from "../../src/core/store.ts";
import { flowDepsFor } from "../flows/flow-fixture.ts";
import { REPO } from "../reconcile-fixture.ts";
import { setupStaging } from "../staging-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_builder_runs_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "fix rounds on Postgres (database integration, O-41)",
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

    it("starts one Developer run for three triggers at once after a staging fail, with no move", async () => {
      const t = await setupStaging({
        store,
        idPrefix: "73000000-0000-4000-8000",
        slug: "fix",
        pr: 31,
        mergeSha: "3".repeat(40),
      });
      for (const run of await store.listRuns({ nodeId: t.node.id })) {
        if (run.endedAt !== null) continue;
        await store.endRun(run.id, {
          endedAt: t.clock.now(),
          outcome: "success",
          turns: 1,
          minutes: 1,
          costUsd: null,
          tokens: null,
          transcriptRef: null,
          usageExhaustedCause: null,
          retryAfterSeconds: null,
          serviceTierServed: null,
          capacityRetries: null,
          capacityWaitSeconds: null,
          firstTokenMs: null,
          reportedCostUsd: null,
        });
      }
      t.deploy();
      t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
      await t.staging().verifyCommit(REPO, t.mergeSha);
      expect(await t.state()).toBe("in_development");
      const moves = (await store.listTransitions(t.node.id)).length;
      // The run starts after the fail move, as a real clock moves on.
      t.advanceMinutes(1);

      const { deps, runtime } = flowDepsFor(t.deps, t.checker);
      const all = await Promise.all([
        startBuilderRuns(deps, [t.node.id]),
        startBuilderRuns(deps, [t.node.id]),
        startBuilderRuns(deps),
      ]);
      expect(
        all
          .flat()
          .map((s) =>
            s.result.outcome === "not_admitted" ? s.result.reason : s.result.outcome,
          )
          .sort(),
      ).toEqual(["item_has_active_run", "item_has_active_run", "started"]);
      expect(runtime.started).toHaveLength(1);
      const developerRuns = (await store.listRuns({ nodeId: t.node.id })).filter(
        (r) => r.bot === "developer",
      );
      expect(developerRuns).toHaveLength(2);
      const records = await store.listEvidence({
        nodeId: t.node.id,
        kind: "dispatch_record",
      });
      expect(records.at(-1)).toMatchObject({
        runId: developerRuns[1]?.id,
        payload: { repo: REPO, branch: `foreman/${t.node.id}` },
      });
      expect(await store.listTransitions(t.node.id)).toHaveLength(moves);
      expect(await createBuilderRuns(t.deps).check(t.node.id)).toMatchObject({
        due: false,
        reason: "active_run",
      });
    });
  },
);
