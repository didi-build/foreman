// Seam: database integration (docs/test-plan.md, build plan M3.3). The runner's merge on the real
// Postgres store, as the factory_runner role: the `merge_check` row migration 0010 allows, the
// `merge_commit` under the ingest key GitHub ingestion uses, the move, and a failure after the
// merge recovered by the merge pass without a second merge, evidence row or move.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mergeCommitKey } from "../../src/core/github-ingest.ts";
import type { Store } from "../../src/core/store.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { PR, setupMerge } from "../merge-fixture.ts";
import { HEAD, REPO } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_merge_test_${process.pid}`;

describe.skipIf(!adminUrl)("the merge on Postgres (database integration, M3.3)", () => {
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

  it("records the merge check, the merge commit under its ingest key and the move", async () => {
    const t = await setupMerge({
      store,
      idPrefix: "61000000-0000-4000-8000",
      slug: "a",
    });
    await t.passedOn(HEAD);

    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);

    expect(result).toMatchObject({ outcome: "applied" });
    expect((await t.kinds("merge_check"))[0]).toMatchObject({
      commitSha: HEAD,
      payload: { pr: PR, mergeable: true },
    });
    const merge = (await t.kinds("merge_commit"))[0];
    expect(merge?.commitSha).toBe(result.mergeCommitSha);
    const keyed = await pool.query(
      "select id from factory.evidence where ingest_key = $1",
      [mergeCommitKey(REPO, PR)],
    );
    expect(keyed.rows.map((r) => r.id)).toEqual([merge?.id]);
    expect((await store.getNode(t.node.id))?.state).toBe("verifying_on_staging");
  });

  it("recovers a failed move after the merge, writing each row once", async () => {
    const t = await setupMerge({
      store,
      idPrefix: "62000000-0000-4000-8000",
      slug: "b",
      pr: 8,
    });
    await t.passedOn(HEAD);
    let failOnce = true;
    const flaky: Store = {
      ...store,
      transaction: (work) =>
        store.transaction((tx) =>
          work({
            ...tx,
            changeNodeState: async (...args) => {
              if (failOnce) {
                failOnce = false;
                throw new Error("the database connection dropped");
              }
              return tx.changeNodeState(...args);
            },
          }),
        ),
    };
    await expect(t.merges(flaky).mergeOnPass(t.node.id, t.trigger)).rejects.toThrow(
      /connection dropped/,
    );
    // The transaction rolled back: no transition row, the node still in review.
    expect(await t.transitions(t.node.id)).toEqual([]);
    expect((await store.getNode(t.node.id))?.state).toBe("in_qa_review");

    expect((await t.merges().mergeReady()).map((r) => r.result.outcome)).toEqual([
      "applied",
    ]);
    expect(await t.merges().mergeReady()).toEqual([]);
    expect(t.github.merges).toHaveLength(1);
    expect(await t.kinds("merge_commit")).toHaveLength(1);
    expect(await t.transitions(t.node.id)).toHaveLength(1);
  });
});
