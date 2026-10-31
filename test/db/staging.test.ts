// Seam: database integration (docs/test-plan.md, build plan M3.4). Staging verification on the real
// Postgres store, as the factory_runner role: the staging deploy, check and no-result rows that
// migration 0011 allows, each under its key, the Done move with the counters reset and the move back
// with `failure` up by one in the same transaction, and a repeated call that writes nothing more.
// Migration 0012 (D-225): a later deploy covering two merge commits is keyed once for each, and a
// failed deploy is recorded once and takes the fail path once.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import {
  stagingCheckKey,
  stagingDeployFailedKey,
  stagingDeployKey,
} from "../../src/core/staging.ts";
import type { Store } from "../../src/core/store.ts";
import { REPO } from "../reconcile-fixture.ts";
import { setupStaging } from "../staging-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_staging_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "staging verification on Postgres (database integration, M3.4)",
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

    it("records the deploy and the check under their keys, then Done with the counters reset", async () => {
      const t = await setupStaging({
        store,
        idPrefix: "71000000-0000-4000-8000",
        slug: "a",
        pr: 11,
        mergeSha: "1".repeat(40),
      });
      await store.setCounter(t.node.id, "failure", 2, t.clock.now());
      t.deploy();

      const result = await t.staging().verify(t.node.id);
      await t.staging().verify(t.node.id);

      expect(result.move).toMatchObject({ toState: "done", outcome: "applied" });
      expect(await t.kind("staging_deploy")).toHaveLength(1);
      const keyed = await pool.query(
        "select id from factory.evidence where ingest_key = $1",
        [stagingCheckKey(REPO, t.mergeSha)],
      );
      expect(keyed.rows.map((r) => r.id)).toEqual([result.checkEvidenceId]);
      expect((await store.getNode(t.node.id))?.state).toBe("done");
      expect(await store.getCounter(t.node.id, "failure")).toBe(0);
      expect(t.checker.calls).toHaveLength(1);
    });

    it("moves back with the failure counter, and records a check without a result once per attempt", async () => {
      const t = await setupStaging({
        store,
        idPrefix: "72000000-0000-4000-8000",
        slug: "b",
        pr: 12,
        mergeSha: "2".repeat(40),
      });
      t.deploy();
      t.checker.answers.push(
        { result: "no_result", reason: "unreachable" },
        { result: "fail", servedCommitSha: t.mergeSha },
      );

      expect((await t.staging().verify(t.node.id)).step).toBe("no_result");
      expect(await t.kind("staging_no_result")).toHaveLength(1);
      const failed = await t.staging().verify(t.node.id);

      expect(failed.move).toMatchObject({
        toState: "in_development",
        outcome: "applied",
      });
      expect((await store.getNode(t.node.id))?.state).toBe("in_development");
      expect(await store.getCounter(t.node.id, "failure")).toBe(1);
      await t.staging().verifyReady();
      expect(await store.getCounter(t.node.id, "failure")).toBe(1);
    });

    it("records one later deploy that covers two merge commits under a key for each (D-225)", async () => {
      const first = await setupStaging({
        store,
        idPrefix: "73000000-0000-4000-8000",
        slug: "c",
        pr: 13,
        mergeSha: "3".repeat(40),
      });
      const second = await setupStaging({
        store,
        idPrefix: "74000000-0000-4000-8000",
        slug: "d",
        pr: 14,
        mergeSha: "4".repeat(40),
      });
      // Main: the first merge, then the second, then a later commit; only that one is deployed.
      const later = "5".repeat(40);
      const deployment = {
        id: 7300,
        sha: later,
        environment: "staging",
        state: "success" as const,
      };
      for (const t of [first, second]) {
        t.github.putCommit(REPO, second.mergeSha, [first.mergeSha]);
        t.github.putCommit(REPO, later, [second.mergeSha]);
        t.github.setBranchHead(REPO, "main", later);
        t.github.putDeployment(REPO, deployment);
      }

      for (const t of [first, second]) {
        expect((await t.staging().verify(t.node.id)).move).toMatchObject({
          toState: "done",
          outcome: "applied",
        });
        const keyed = await pool.query(
          "select payload from factory.evidence where ingest_key = $1",
          [stagingDeployKey(REPO, deployment.id, t.mergeSha)],
        );
        expect(keyed.rows.map((r) => r.payload)).toEqual([
          {
            environment: "staging",
            deploymentId: deployment.id,
            deployedSha: later,
            containment: "ahead",
            onMain: true,
            mainHeadSha: later,
          },
        ]);
      }
    });

    it("takes the fail path once for a failed staging deploy of the merge commit (D-225)", async () => {
      const t = await setupStaging({
        store,
        idPrefix: "75000000-0000-4000-8000",
        slug: "e",
        pr: 15,
        mergeSha: "6".repeat(40),
      });
      const deployment = t.deploy(t.mergeSha, "failure");

      const result = await t.staging().verify(t.node.id);
      await t.staging().verify(t.node.id);
      await t.staging().verifyReady();

      expect(result).toMatchObject({
        step: "deploy_failed",
        move: { toState: "in_development", outcome: "applied" },
      });
      const keyed = await pool.query(
        "select id from factory.evidence where ingest_key = $1",
        [stagingDeployFailedKey(REPO, deployment.id, t.mergeSha)],
      );
      expect(keyed.rows.map((r) => r.id)).toEqual([result.deployFailedEvidenceId]);
      expect(await store.getCounter(t.node.id, "failure")).toBe(1);
      expect(t.checker.calls).toEqual([]);
    });
  },
);
