// Seam: database integration (docs/test-plan.md, ADR 0118 slice 7, O-163). Didi's Set project
// secret form on the real Postgres store as the factory_runner role, with the fake deploy target
// and the fake short-lived variable: the name's record round-trips exactly through
// factory.project_secret_names (migration 0030), oldest first, the run's id kept as a UUID, a dry
// run records nothing, and the made-up value is in no table of the factory schema afterwards.
// Synthetic data only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeClusterTarget,
  createFakeStagingTarget,
} from "../../src/adapters/deploy/fake.ts";
import { createFakeShortLivedVariables } from "../../src/adapters/windmill/fake-short-lived-variables.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createSetProjectSecretForm } from "../../src/core/set-project-secret.ts";
import type { Store } from "../../src/core/store.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_set_project_secret_test_${process.pid}`;
const T0 = new Date("2026-11-21T12:00:00Z");
const PROJECT_ID = "78000000-0000-4000-8000-000000000001";
const RUN_ID = "0192f0a0-1234-4abc-8def-0123456789ab";
/** Obviously fake: never a real key. */
const VALUE = "test-only-secret-value-do-not-use-0123456789";

describe.skipIf(!adminUrl)(
  "the Set project secret form on Postgres (database integration, O-163)",
  () => {
    let owner: pg.Pool;
    let pool: pg.Pool;
    let store: Store;
    let n = 0;
    const ids = {
      next: () => `78000000-0000-4000-8000-${String(++n + 100).padStart(12, "0")}`,
    };
    const form = () =>
      createSetProjectSecretForm({
        store,
        clock: { now: () => new Date(T0.getTime() + n * 1000) },
        ids,
        targets: {
          cloudflare: createFakeStagingTarget(),
          cluster: createFakeClusterTarget(),
        },
        shortLivedVariables: createFakeShortLivedVariables(),
      });
    const dryRun = (value: boolean) =>
      store.setSetting({ key: "dry_run", value, updatedBy: "test", updatedAt: T0 });

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      pool = new pg.Pool({
        connectionString: url,
        max: 2,
        options: "-c role=factory_runner",
      });
      store = createPostgresStore(pool);
      await store.insertProject({
        id: PROJECT_ID,
        slug: "garden-notes",
        name: "Garden Notes",
        repo: "didi-build/garden-notes",
        linearProjectId: null,
        galleryPathOverride: null,
        privilegedPathsExtra: [],
        prodRequiresApproval: true,
        stagingUrl: "https://garden-notes.didi.build",
        deployTarget: "cloudflare",
        createdAt: T0,
      });
    });

    afterAll(async () => {
      await pool?.end();
      await owner?.end();
      dropTestDatabase(DB);
    });

    it("records nothing in dry run, then each set's name, time and run, oldest first", async () => {
      await dryRun(true);
      const input = { project: "garden-notes", name: "MODEL_API_KEY", value: VALUE };
      expect((await form().set({ ...input, runId: RUN_ID })).outcome).toBe("dry_run");
      expect(await store.listProjectSecretNames(PROJECT_ID)).toEqual([]);
      await dryRun(false);
      expect((await form().set({ ...input, runId: RUN_ID })).outcome).toBe("set");
      expect((await form().set({ ...input, name: "MAIL_API_KEY" })).outcome).toBe(
        "set",
      );
      const records = await store.listProjectSecretNames(PROJECT_ID);
      expect(records).toEqual([
        {
          id: expect.stringMatching(/^78000000-/),
          projectId: PROJECT_ID,
          name: "MODEL_API_KEY",
          setAt: expect.any(Date),
          windmillRunId: RUN_ID,
          recordedBy: "runner:set-project-secret",
        },
        {
          id: expect.stringMatching(/^78000000-/),
          projectId: PROJECT_ID,
          name: "MAIL_API_KEY",
          setAt: expect.any(Date),
          windmillRunId: null,
          recordedBy: "runner:set-project-secret",
        },
      ]);
      expect(records[0]?.setAt.getTime()).toBeLessThan(
        records[1]?.setAt.getTime() ?? 0,
      );
      expect(
        await store.listProjectSecretNames("78000000-0000-4000-8000-0000000000ff"),
      ).toEqual([]);
    });

    it("leaves the value in no table of the factory schema", async () => {
      const tables = (
        await owner.query<{ tablename: string }>(
          "select tablename from pg_tables where schemaname = 'factory' order by tablename",
        )
      ).rows.map((r) => r.tablename);
      expect(tables).toContain("project_secret_names");
      for (const table of tables) {
        const { rows } = await owner.query<{ found: number }>(
          `select count(*)::int as found from factory.${table} t where row_to_json(t)::text like $1`,
          [`%${VALUE}%`],
        );
        expect(rows[0]?.found, table).toBe(0);
      }
    });
  },
);
