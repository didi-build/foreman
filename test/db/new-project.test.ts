// Seam: database integration (docs/test-plan.md, ADR 0118 slice 6, O-161). Didi's New project
// form on the real Postgres store as the factory_runner role, with the fake deploy target and
// fakes of the settings, the workflow starts, the repositories, the DNS lookup and
// BOOTSTRAP_TOKEN's access and Bootstrap's runs: the project row round-trips exactly with its
// display name and `deploy_target` (migration 0028), two runs at once give one row and no
// refusal, and an insert the slug's unique constraint refuses (a run whose row was not visible
// yet) is read as the row this form recorded, which holds the constraint's name
// `projects_slug_key` to the one the core expects. Synthetic data only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeClusterTarget,
  createFakeStagingTarget,
} from "../../src/adapters/deploy/fake.ts";
import { createFakePublicNames } from "../../src/adapters/dns/fake.ts";
import { createFakeBootstrap } from "../../src/adapters/github/bootstrap-fake.ts";
import {
  createFakeProjectRepositories,
  createFakeProjectSettings,
  createFakeProjectWorkflows,
} from "../../src/adapters/github/new-project-fake.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createNewProjectForm, plannedProject } from "../../src/core/new-project.ts";
import type { Store } from "../../src/core/store.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_new_project_test_${process.pid}`;
const T0 = new Date("2026-11-21T12:00:00Z");
const input = (slug: string) => ({
  slug,
  displayName: "Garden Notes",
  purpose: "A small notes app for the garden club.",
  collectsPersonalData: true,
});

describe.skipIf(!adminUrl)(
  "the New project form on Postgres (database integration, O-161)",
  () => {
    let pool: pg.Pool;
    let store: Store;
    let n = 0;
    const ids = {
      next: () => `77000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    };

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
      await store.setSetting({
        key: "dry_run",
        value: false,
        updatedBy: "test",
        updatedAt: T0,
      });
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    /** One form over shared fakes, so two runs see the same GitHub and Cloudflare. */
    const form = (on: Store = store) => {
      const bootstrap = createFakeBootstrap();
      return createNewProjectForm({
        store: on,
        clock: { now: () => new Date(T0) },
        ids,
        targets: {
          cloudflare: createFakeStagingTarget(),
          cluster: createFakeClusterTarget(),
        },
        projectSettings: createFakeProjectSettings(),
        projectWorkflows: createFakeProjectWorkflows(),
        projectRepositories: createFakeProjectRepositories(),
        publicNames: createFakePublicNames(),
        bootstrapAccess: bootstrap,
        bootstrapRuns: bootstrap,
      });
    };

    it("records the row exactly, with the display name and the Cloudflare target, and reads it back", async () => {
      const result = await form().create(input("garden-notes"));
      expect(result.outcome).toBe("created");
      expect(await store.getProjectBySlug("garden-notes")).toEqual({
        id: expect.stringMatching(/^77000000-/) as string,
        ...plannedProject("garden-notes", "Garden Notes"),
        createdAt: T0,
      });
      const row = await pool.query(
        "select name, deploy_target from factory.projects where slug = 'garden-notes'",
      );
      expect(row.rows).toEqual([{ name: "Garden Notes", deploy_target: "cloudflare" }]);
    });

    it("gives one row and no refusal for two runs at once", async () => {
      const shared = form();
      const results = await Promise.all([
        shared.create(input("seed-swap")),
        shared.create(input("seed-swap")),
      ]);
      for (const result of results)
        expect(["created", "completed"], JSON.stringify(result)).toContain(
          result.outcome,
        );
      const rows = await pool.query(
        "select count(*)::int as n from factory.projects where slug = 'seed-swap'",
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("reads an insert the unique slug refuses as the row this form recorded", async () => {
      await store.insertProject({
        ...plannedProject("tool-library", "Garden Notes"),
        id: ids.next(),
        createdAt: T0,
      });
      // As if the other run's row were not visible yet: only the constraint stops the insert.
      let hidden = true;
      const raced: Store = {
        ...store,
        getProjectBySlug: async (slug) =>
          hidden ? null : store.getProjectBySlug(slug),
        transaction: (work) =>
          store.transaction(async (tx) => {
            try {
              return await work({ ...tx, getProjectBySlug: async () => null });
            } finally {
              hidden = false;
            }
          }),
      };
      const result = await form(raced).create(input("tool-library"));
      expect(result.steps.find((l) => l.step === "record")).toMatchObject({
        outcome: "found",
      });
      const rows = await pool.query(
        "select count(*)::int as n from factory.projects where slug = 'tool-library'",
      );
      expect(rows.rows[0].n).toBe(1);
    });
  },
);
