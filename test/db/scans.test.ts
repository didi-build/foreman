// Seam: database integration (docs/test-plan.md, D-300, O-92). The Scanner's stage 1 on the real
// Postgres store as the factory_runner role: the scan record of migration 0017 (insert, the latest
// per project, append-only, a ran scan names its commit, no access for factory_api), the project
// list and lock the filing needs, and two scans of the same project at once filing one set of
// ideas, since the project row is locked first. And D-301 (O-93, migration 0018): the two new
// evidence kinds the runner writes (each needs its commit, and the state API's role cannot write
// them), the latest scan that ran, and a fold-in, a withdrawal through the guarded move and a
// Council question for an idea further along, all as factory_runner.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import {
  createScanIdeas,
  SCANNER_SOURCE,
  scannerGoneTopic,
} from "../../src/core/scan-ideas.ts";
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
    notRun: [],
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

    it("folds in, withdraws through the guarded move and asks the Council as the runner's role (D-301)", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f500000-0000-4000-8000",
        slug: "sd",
      });
      await t.setting("dry_run", false);
      const scans = createScanIdeas(t.deps);
      const link = (path: string, target: string) => ({
        check: "doc_link_missing" as const,
        path,
        line: 1,
        target,
      });
      const at = (sha: string, findings: ReturnType<typeof link>[]): RepoScan => ({
        ...scanOf([]),
        commitSha: sha,
        counts: { ...scanOf([]).counts, doc_link_missing: findings.length },
        findings,
      });
      await scans.file(
        t.projectId,
        at(SHA, [
          link("docs/a.md", "docs/x.md"),
          link("docs/b.md", "docs/y.md"),
          link("docs/c.md", "docs/z.md"),
        ]),
      );
      const ideas = await pool.query(
        "select id, body->'evidence'->0->>'path' as path from factory.nodes where project_id = $1 and type = 'idea' order by path",
        [t.projectId],
      );
      const [a, b, c] = ideas.rows.map((r: { id: string }) => r.id);
      await store.changeNodeState(c, 0, {
        state: "triage",
        substate: null,
        ownerRole: "triage",
        blockedReason: null,
        stateSince: t.clock.now(),
        updatedAt: t.clock.now(),
      });
      t.advanceMinutes(24 * 60);
      const later = "d".repeat(40);
      const filed = await scans.file(
        t.projectId,
        at(later, [link("docs/a.md", "docs/w.md"), link("docs/a.md", "docs/x.md")]),
      );
      expect(filed).toMatchObject({
        step: "filed",
        summary: { merged: 1, folded: [{ nodeId: a }] },
        withdrawals: [{ nodeId: b, outcome: "applied" }],
      });
      const states = await pool.query(
        "select id, state from factory.nodes where id = any($1) order by id",
        [[a, b, c]],
      );
      expect(
        Object.fromEntries(
          states.rows.map((r: { id: string; state: string }) => [r.id, r.state]),
        ),
      ).toEqual({
        [a]: "submitted",
        [b]: "rejected",
        [c]: "triage",
      });
      const kinds = await pool.query(
        "select node_id, kind, commit_sha from factory.evidence where node_id = any($1) order by kind, node_id",
        [[a, b, c]],
      );
      expect(kinds.rows).toEqual(
        [
          { node_id: b, kind: "scan_not_found", commit_sha: later },
          { node_id: c, kind: "scan_not_found", commit_sha: later },
          { node_id: a, kind: "scan_scope_update", commit_sha: later },
        ].sort(
          (x, y) => x.kind.localeCompare(y.kind) || x.node_id.localeCompare(y.node_id),
        ),
      );
      expect(
        await store.findOpenGateRequest(t.projectId, scannerGoneTopic(c)),
      ).toMatchObject({ owner: "council", kind: "council_question", nodeId: c });
      // The latest scan that ran, past a failure recorded after it.
      t.advanceMinutes(10);
      await scans.recordFailure(t.projectId, "job");
      expect((await store.getLatestScan(t.projectId))?.outcome).toBe("failed");
      expect(await store.getLatestScan(t.projectId, "scanned")).toMatchObject({
        outcome: "scanned",
        commitSha: later,
      });
    });

    it("requires the commit on the two scan evidence kinds and lets the state API's role write neither (migration 0018)", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f600000-0000-4000-8000",
        slug: "se",
      });
      const node = await t.node("submitted", { type: "idea", track: null });
      const row = (
        id: string,
        kind: "scan_scope_update" | "scan_not_found",
        commitSha: string | null,
      ) => ({
        id,
        nodeId: node.id,
        runId: null,
        kind,
        ref: "scan:x",
        commitSha,
        payload: {},
        recordedBy: "runner:scanner",
        recordedAt: t.clock.now(),
        supersedesId: null,
      });
      await store.insertEvidence(
        row("8f600000-0000-4000-8000-0000000000c1", "scan_scope_update", SHA),
      );
      await store.insertEvidence(
        row("8f600000-0000-4000-8000-0000000000c2", "scan_not_found", SHA),
      );
      for (const kind of ["scan_scope_update", "scan_not_found"] as const) {
        await expect(
          store.insertEvidence(
            row(`8f600000-0000-4000-8000-000000000d${kind.length}`, kind, null),
          ),
        ).rejects.toThrow(/evidence_scan_commit/);
      }
      const api = new pg.Pool({
        connectionString: url,
        max: 1,
        options: "-c role=factory_api",
      });
      try {
        await expect(
          api.query(
            `insert into factory.evidence (id, node_id, kind, ref, commit_sha, payload, recorded_by, recorded_at)
             values ('8f600000-0000-4000-8000-0000000000e1', $1, 'scan_not_found', 'x', $2, '{}', 'api', now())`,
            [node.id, SHA],
          ),
        ).rejects.toThrow(/row-level security|permission denied|violates/);
      } finally {
        await api.end();
      }
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
