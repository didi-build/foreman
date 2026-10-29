// Seam: GitHub ingestion against Postgres (build plan M2.3, ADR 0113, migration 0002). The core's
// ingestion functions on the real Postgres store, connected as the factory_ingest role, so the
// role's grants and row level security back up the core's rules: it writes only deliveries and
// ingested evidence kinds under a key, changes nothing, and a replay is a no-op.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkCompletedEvent,
  pullRequestEvent,
} from "../../src/adapters/github/fake.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import {
  ciRunKey,
  ingestDelivery,
  mergeCommitKey,
  pollRepository,
  type IngestDeps,
} from "../../src/core/github-ingest.ts";
import type { Evidence, Store } from "../../src/core/store.ts";
import {
  BRANCH,
  MERGE_SHA,
  PR,
  REPO,
  SHA_A,
  createIngestFixture,
  passing,
  type IngestFixture,
} from "../github-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_ingest_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "GitHub ingestion on Postgres as factory_ingest (database integration, M2.3)",
  () => {
    let runnerPool: pg.Pool;
    let ingestPool: pg.Pool;
    let apiPool: pg.Pool;
    let runner: Store;
    let ingest: Store;
    let f: IngestFixture;
    let deps: IngestDeps;

    /** A ci_run row the ingest role may write, apart from what the test changes. */
    const ciRun = (overrides: Partial<Evidence> = {}): Evidence => ({
      id: deps.ids.next(),
      nodeId: f.nodeId,
      runId: null,
      kind: "ci_run",
      ref: "github:test",
      commitSha: SHA_A,
      payload: { conclusion: "pending", pr: PR },
      recordedBy: "github",
      recordedAt: deps.clock.now(),
      supersedesId: null,
      ...overrides,
    });

    async function refused(pool: pg.Pool, sql: string, pattern: RegExp): Promise<void> {
      await expect(pool.query(sql)).rejects.toThrow(pattern);
    }

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      const as = (role: string) =>
        new pg.Pool({ connectionString: url, max: 4, options: `-c role=${role}` });
      runnerPool = as("factory_runner");
      ingestPool = as("factory_ingest");
      apiPool = as("factory_api");
      runner = createPostgresStore(runnerPool);
      ingest = createPostgresStore(ingestPool);
      // The runner sets up the project, node and dispatch record; ingestion runs as its own role.
      f = await createIngestFixture({ store: runner });
      deps = { ...f.deps, store: ingest };
    });

    afterAll(async () => {
      await Promise.all([runnerPool?.end(), ingestPool?.end(), apiPool?.end()]);
      dropTestDatabase(DB);
    });

    it("runs as the factory_ingest role", async () => {
      const who = await ingestPool.query("select current_user as u");
      expect(who.rows[0].u).toBe("factory_ingest");
    });

    it("finds a node by its latest dispatch record's repository and branch", async () => {
      expect(await ingest.listDispatches({ repo: REPO, branch: BRANCH })).toEqual([
        { nodeId: f.nodeId, repo: REPO, branch: BRANCH },
      ]);
      expect(await ingest.listDispatches({ repo: REPO, branch: "other" })).toEqual([]);
      expect(await ingest.listDispatches({ repo: "didi-build/elsewhere" })).toEqual([]);
    });

    it("records one evidence row and one delivery when a delivery is replayed", async () => {
      const payload = pullRequestEvent("opened", await f.pr());
      const delivery = { id: "db-delivery-1", event: "pull_request", payload };
      expect((await ingestDelivery(deps, delivery)).outcome).toBe("recorded");
      expect((await ingestDelivery(deps, delivery)).outcome).toBe("duplicate");
      expect(await f.evidence("ci_run")).toHaveLength(1);
      expect(await runner.getGithubDelivery("db-delivery-1")).toMatchObject({
        eventType: "pull_request",
        repository: REPO,
        outcome: "recorded",
      });
      const rows = await runnerPool.query(
        "select count(*)::int as n from factory.github_deliveries where delivery_id = 'db-delivery-1'",
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("lets exactly one of two racing copies of a delivery record anything", async () => {
      f.github.setCheckRuns(REPO, SHA_A, passing("build"));
      const delivery = {
        id: "db-delivery-race",
        event: "check_suite",
        payload: checkCompletedEvent("check_suite", REPO, SHA_A, [PR]),
      };
      const outcomes = await Promise.all([
        ingestDelivery(deps, delivery),
        ingestDelivery(deps, delivery),
      ]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(["duplicate", "recorded"]);
      expect((await f.evidence("ci_run")).map((e) => e.ref)).toEqual([
        ciRunKey(REPO, PR, SHA_A, "pending"),
        ciRunKey(REPO, PR, SHA_A, "success"),
      ]);
    });

    it("adds nothing on a polling pass after the webhooks, then records the merge", async () => {
      await pollRepository(deps, REPO);
      expect(await f.evidence()).toHaveLength(2);
      f.github.merge(REPO, PR, MERGE_SHA);
      await pollRepository(deps, REPO);
      await pollRepository(deps, REPO);
      const merges = await f.evidence("merge_commit");
      expect(merges.map((e) => [e.ref, e.commitSha])).toEqual([
        [mergeCommitKey(REPO, PR), MERGE_SHA],
      ]);
    });

    it("treats a second insert under the same ingest key as a no-op", async () => {
      const key = "github:ci_run:db-test#1:key";
      expect(await ingest.insertEvidenceOnce(ciRun(), key)).toBe(true);
      expect(await ingest.insertEvidenceOnce(ciRun(), key)).toBe(false);
      const rows = await runnerPool.query(
        "select count(*)::int as n from factory.evidence where ingest_key = $1",
        [key],
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("cannot write any other evidence kind, evidence without a key, or evidence for a run", async () => {
      await expect(
        ingest.insertEvidenceOnce(
          ciRun({ kind: "docs_note", commitSha: null, payload: { impact: "none" } }),
          "github:docs",
        ),
      ).rejects.toThrow(/row-level security|evidence_ingest_key_kinds/);
      await expect(
        ingest.insertEvidenceOnce(
          ciRun({ kind: "qa_verdict", payload: {} }),
          "github:qa",
        ),
      ).rejects.toThrow(
        /row-level security|evidence_ingest_key_kinds|check constraint/,
      );
      for (const kind of ["preview_check", "staging_check", "agent_report"] as const) {
        await expect(
          ingest.insertEvidence(ciRun({ kind, payload: {} })),
        ).rejects.toThrow(/row-level security/);
      }
      await expect(ingest.insertEvidence(ciRun())).rejects.toThrow(
        /row-level security/,
      );
    });

    it("cannot update or delete evidence or deliveries", async () => {
      await refused(
        ingestPool,
        "update factory.evidence set ref = ref",
        /permission denied/,
      );
      await refused(ingestPool, "delete from factory.evidence", /permission denied/);
      await refused(
        ingestPool,
        "update factory.github_deliveries set reason = reason",
        /permission denied/,
      );
      await refused(
        ingestPool,
        "delete from factory.github_deliveries",
        /permission denied/,
      );
      await refused(
        ingestPool,
        "truncate factory.github_deliveries",
        /permission denied/,
      );
      // The owner cannot either: the table is append-only.
      await refused(
        runnerPool,
        "update factory.github_deliveries set reason = reason",
        /append-only|permission denied/,
      );
    });

    it("cannot move a node, write decisions or transitions, or read what it does not need", async () => {
      await refused(
        ingestPool,
        "update factory.nodes set hold = true",
        /permission denied/,
      );
      await refused(
        ingestPool,
        `insert into factory.decisions (id, project_id, kind, text_verbatim, by_actor, recorded_at)
         values ('${deps.ids.next()}', '${f.projectId}', 'approval', 'yes', 'didi', now())`,
        /permission denied/,
      );
      await refused(
        ingestPool,
        `insert into factory.transitions (id, node_id, from_state, to_state, trigger_kind, actor_kind,
           actor_id, guard_result, spec_version, mode, at)
         values ('${deps.ids.next()}', '${f.nodeId}', 'a', 'b', 'event', 'runner', 'x', '[]', 'v', 'applied', now())`,
        /permission denied/,
      );
      for (const table of [
        "github_deliveries",
        "projects",
        "settings",
        "decisions",
        "run_tokens",
      ]) {
        await refused(
          ingestPool,
          `select * from factory.${table}`,
          /permission denied/,
        );
      }
    });

    it("keeps ingest keys on ingested kinds only, so no other writer can take one first", async () => {
      await refused(
        apiPool,
        `insert into factory.evidence (id, node_id, kind, ref, payload, recorded_by, recorded_at, ingest_key)
         values ('${deps.ids.next()}', '${f.nodeId}', 'docs_note', 'x', '{}', 'developer', now(),
                 '${ciRunKey(REPO, PR, "d".repeat(40), "success")}')`,
        /evidence_ingest_key_kinds/,
      );
      await refused(
        runnerPool,
        `insert into factory.evidence (id, node_id, kind, ref, payload, recorded_by, recorded_at, ingest_key)
         values ('${deps.ids.next()}', '${f.nodeId}', 'agent_report', 'x', '{}', 'runner', now(), 'k')`,
        /evidence_ingest_key_kinds/,
      );
    });
  },
);
