// Seam: database integration (docs/test-plan.md, D-300, O-92). The Scanner's stage 1 on the real
// Postgres store as the factory_runner role: the scan record of migration 0017 (insert, the latest
// per project, append-only, a ran scan names its commit, no access for factory_api), the project
// list and lock the filing needs, and two scans of the same project at once filing one set of
// ideas, since the project row is locked first.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createScanIdeas, SCANNER_SOURCE } from "../../src/core/scan-ideas.ts";
import { SCAN_CHECKS, type RepoScan } from "../../src/core/scan.ts";
import type { Store } from "../../src/core/store.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_scans_test_${process.pid}`;
const SHA = "c".repeat(40);

function scanOf(targets: string[]): RepoScan {
  const counts = Object.fromEntries(
    SCAN_CHECKS.map((c) => [c, 0]),
  ) as RepoScan["counts"];
  counts.doc_link_missing = targets.length;
  return {
    commitSha: SHA,
    counts,
    findings: targets.map((target, i) => ({
      check: "doc_link_missing",
      path: "docs/guide.md",
      line: i + 1,
      target,
    })),
  };
}

describe.skipIf(!adminUrl)(
  "the Scanner's records on Postgres (database integration, O-92)",
  () => {
    let url: string;
    let pool: pg.Pool;
    let store: Store;

    beforeAll(async () => {
      url = createTestDatabase(DB);
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

    it("files one set of ideas when two scans of the same project race, and records both scans", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f200000-0000-4000-8000",
        slug: "sa",
      });
      await t.setting("dry_run", false);
      const scans = createScanIdeas(t.deps);
      const scan = scanOf(["docs/a.md", "docs/b.md"]);
      const [a, b] = await Promise.all([
        scans.file(t.projectId, scan),
        scans.file(t.projectId, scan),
      ]);
      const merged = [a, b]
        .map((r) => (r.step === "filed" ? r.summary.merged : -1))
        .sort();
      expect(merged).toEqual([0, 2]);
      const ideas = await pool.query(
        "select state, owner_role, body->>'source' as source, body->>'dedupeKey' as key from factory.nodes where project_id = $1 and type = 'idea' order by key",
        [t.projectId],
      );
      expect(ideas.rows).toEqual([
        {
          state: "submitted",
          owner_role: "runner",
          source: SCANNER_SOURCE,
          key: "scanner:doc_link_missing:docs/guide.md -> docs/a.md",
        },
        {
          state: "submitted",
          owner_role: "runner",
          source: SCANNER_SOURCE,
          key: "scanner:doc_link_missing:docs/guide.md -> docs/b.md",
        },
      ]);
      const recorded = await pool.query(
        "select count(*)::int as n from factory.scans where project_id = $1",
        [t.projectId],
      );
      expect(recorded.rows[0]).toEqual({ n: 2 });
    });

    it("reads the latest scan of a project, lists projects by slug and locks only a project that exists", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f300000-0000-4000-8000",
        slug: "sb",
      });
      expect(await store.getLatestScan(t.projectId)).toBeNull();
      const at = t.clock.now();
      for (const [id, minutes, outcome] of [
        ["8f300000-0000-4000-8000-0000000000a1", 0, "scanned"],
        ["8f300000-0000-4000-8000-0000000000a2", 10, "failed"],
      ] as const) {
        await store.insertScan({
          id,
          projectId: t.projectId,
          commitSha: outcome === "scanned" ? SHA : null,
          outcome,
          summary: outcome === "failed" ? { failure: "job" } : { findings: 0 },
          recordedBy: "runner:scanner",
          recordedAt: new Date(at.getTime() + minutes * 60_000),
        });
      }
      expect(await store.getLatestScan(t.projectId)).toEqual({
        id: "8f300000-0000-4000-8000-0000000000a2",
        projectId: t.projectId,
        commitSha: null,
        outcome: "failed",
        summary: { failure: "job" },
        recordedBy: "runner:scanner",
        recordedAt: new Date(at.getTime() + 10 * 60_000),
      });
      const slugs = (await store.listProjects()).map((p) => p.slug);
      expect(slugs).toEqual([...slugs].sort());
      expect(slugs).toEqual(expect.arrayContaining(["sa", "sb"]));
      expect(await store.transaction((tx) => tx.lockProject(t.projectId))).toBe(true);
      expect(
        await store.transaction((tx) =>
          tx.lockProject("8f300000-0000-4000-8000-999999999999"),
        ),
      ).toBe(false);
    });

    it("keeps scans append-only, requires a ran scan's commit, and gives the state API's role no access", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f400000-0000-4000-8000",
        slug: "sc",
      });
      const row = {
        id: "8f400000-0000-4000-8000-0000000000b1",
        projectId: t.projectId,
        commitSha: SHA,
        outcome: "scanned" as const,
        summary: {},
        recordedBy: "runner:scanner",
        recordedAt: t.clock.now(),
      };
      await store.insertScan(row);
      await expect(
        pool.query("update factory.scans set summary = '{}' where id = $1", [row.id]),
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(
        pool.query("delete from factory.scans where id = $1", [row.id]),
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(
        store.insertScan({
          ...row,
          id: "8f400000-0000-4000-8000-0000000000b2",
          commitSha: null,
        }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        store.insertScan({
          ...row,
          id: "8f400000-0000-4000-8000-0000000000b3",
          commitSha: "abc",
        }),
      ).rejects.toThrow(/check constraint/);
      const api = new pg.Pool({
        connectionString: url,
        max: 1,
        options: "-c role=factory_api",
      });
      try {
        await expect(api.query("select * from factory.scans")).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await api.end();
      }
    });
  },
);
