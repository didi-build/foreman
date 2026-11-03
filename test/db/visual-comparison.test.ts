// Seam: database integration (docs/test-plan.md, D-242). The runner records a visual comparison
// answer on the real Postgres store as the factory_runner role: one `visual_comparison` row on
// the run's head commit, and two run ends for the same run at once write one, since the item's
// row is locked first. A comparison that differs sends the item back through QA's fail move, and
// two `cannot_tell` on the head escalate it (D-252). Synthetic images in a fake screenshot port;
// no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pngCodec } from "../../src/adapters/screenshots/png.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import type { Store } from "../../src/core/store.ts";
import { createRunReports } from "../../src/core/run-reports.ts";
import { createVisualComparisons } from "../../src/core/visual-comparison.ts";
import { createReconcileFixture, HEAD } from "../reconcile-fixture.ts";
import { answer, HEAD_CHANGED_PATHS, setupVisual } from "../visual-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_visual_comparison_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "visual comparison records on Postgres (database integration, D-242)",
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

    it("records one row on the head commit when two run ends for the same run race", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8e000000-0000-4000-8000",
        slug: "vc",
      });
      await t.setting("dry_run", false);
      const v = await setupVisual(t);
      const run = await v.visualRun();
      const visual = createVisualComparisons({
        ...t.deps,
        screenshots: v.screenshots,
        repoFolders: v.repoFolders,
        png: pngCodec,
      });
      const [a, b] = await Promise.all([
        visual.recordAnswer(run.id, answer("differs")),
        visual.recordAnswer(run.id, answer("differs")),
      ]);
      expect([a.recorded, b.recorded].sort()).toEqual(["already_recorded", true]);
      const rows = await pool.query(
        "select kind, commit_sha, recorded_by, payload->>'pass' as pass, payload->>'outcome' as outcome from factory.evidence where node_id = $1 and kind = 'visual_comparison'",
        [v.nodeId],
      );
      expect(rows.rows).toEqual([
        {
          kind: "visual_comparison",
          commit_sha: HEAD,
          recorded_by: "runner",
          pass: "false",
          outcome: "differs",
        },
      ]);
    });

    const ended = {
      outcome: "success" as const,
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
    };

    it("a differs record sends the item back through QA's fail move, counted, and two cannot_tell escalate it (D-252)", async () => {
      for (const [prefix, results, state] of [
        ["8e100000-0000-4000-8000", ["differs"], "building_components"],
        [
          "8e200000-0000-4000-8000",
          ["cannot_tell", "cannot_tell"],
          "escalated_to_council",
        ],
      ] as const) {
        const t = await createReconcileFixture({
          store,
          idPrefix: prefix,
          slug: prefix.slice(0, 4),
        });
        await t.setting("dry_run", false);
        const v = await setupVisual(t);
        await t.evidence(
          v.nodeId,
          "ci_run",
          { conclusion: "success", pr: 7, changedPaths: HEAD_CHANGED_PATHS },
          { commitSha: HEAD },
        );
        const visual = createVisualComparisons({
          ...t.deps,
          screenshots: v.screenshots,
          repoFolders: v.repoFolders,
          png: pngCodec,
        });
        for (const result of results) {
          const run = await v.visualRun();
          expect(await visual.recordAnswer(run.id, answer(result))).toMatchObject({
            recorded: true,
          });
          await store.endRun(run.id, { ...ended, endedAt: t.clock.now() });
          await createRunReports(t.deps).requestReportedMove(run.id);
        }
        const node = await store.getNode(v.nodeId);
        expect(node?.state, state).toBe(state);
        expect(await store.getCounter(v.nodeId, "qa_round")).toBe(
          state === "building_components" ? 1 : 0,
        );
      }
    });
  },
);
