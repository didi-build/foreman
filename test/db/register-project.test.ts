// Seam: database integration (docs/test-plan.md, D-345, O-109, O-114). Didi's register-project
// form on the real Postgres store as the factory_runner role, with fakes of the settings file, of
// GitHub's repository calls and of BOOTSTRAP_TOKEN's access and Bootstrap's runs: the project row round-trips exactly, two runs at once give one row
// and one `registered`, and an insert the slug's unique constraint refuses (a run whose
// row was not visible yet) is read as `already_registered`, which holds the constraint's name
// `projects_slug_key` to the one the core expects. No migration: the store already reads a
// project by slug, and the runner role already inserts projects. Synthetic data only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeBootstrap } from "../../src/adapters/github/bootstrap-fake.ts";
import {
  createFakeProjectRepositories,
  createFakeProjectSettings,
} from "../../src/adapters/github/project-registration-fake.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import {
  createProjectRegistration,
  plannedProject,
} from "../../src/core/register-project.ts";
import type { Store } from "../../src/core/store.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_register_project_test_${process.pid}`;
const T0 = new Date("2026-11-07T12:00:00Z");
const DESCRIPTION = "A small notes app for the garden club.";

/** The fake of BOOTSTRAP_TOKEN's access and Bootstrap's runs, one object for both ports (O-114). */
function bootstrapPorts() {
  const bootstrap = createFakeBootstrap();
  return { bootstrapAccess: bootstrap, bootstrapRuns: bootstrap };
}

describe.skipIf(!adminUrl)(
  "the register-project form on Postgres (database integration, D-345)",
  () => {
    let pool: pg.Pool;
    let store: Store;
    let n = 0;
    const ids = {
      next: () => `72000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
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

    const registration = (slugs: string[], on: Store = store) =>
      createProjectRegistration({
        store: on,
        clock: { now: () => new Date(T0) },
        ids,
        projectSettings: createFakeProjectSettings(slugs),
        projectRepositories: createFakeProjectRepositories(),
        ...bootstrapPorts(),
      });

    it("records the project row exactly, and reads it back by slug", async () => {
      const result = await registration(["garden-notes"]).register({
        slug: "garden-notes",
        description: DESCRIPTION,
      });
      expect(result.outcome).toBe("registered");
      const stored = await store.getProjectBySlug("garden-notes");
      expect(stored).toEqual({
        id: expect.stringMatching(/^72000000-/) as string,
        ...plannedProject("garden-notes"),
        createdAt: T0,
      });
      expect(result.outcome === "registered" && result.project).toEqual(stored);
    });

    it("gives one row and one registered for two runs at once", async () => {
      const form = registration(["seed-swap"]);
      const input = { slug: "seed-swap", description: DESCRIPTION };
      const results = await Promise.all([form.register(input), form.register(input)]);
      const outcomes = results.map((r) =>
        r.outcome === "refused" ? r.reason : r.outcome,
      );
      expect(outcomes.filter((o) => o === "registered")).toHaveLength(1);
      // The other run, by timing (O-114): its insert refused by the unique slug, or it finds the
      // first run's row and so its setup, running already or not started yet.
      expect(["already_registered", "bootstrap_running", "setup_restarted"]).toContain(
        outcomes.find((o) => o !== "registered"),
      );
      const rows = await pool.query(
        "select count(*)::int as n from factory.projects where slug = 'seed-swap'",
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("reads an insert the unique slug refuses as already_registered", async () => {
      await store.insertProject({
        ...plannedProject("tool-library"),
        id: ids.next(),
        createdAt: T0,
      });
      // As if the other run's row were not visible yet: only the constraint stops the insert.
      const raced: Store = {
        ...store,
        getProjectBySlug: async () => null,
        transaction: (work) =>
          store.transaction((tx) =>
            work({ ...tx, getProjectBySlug: async () => null }),
          ),
      };
      expect(
        await registration(["tool-library"], raced).register({
          slug: "tool-library",
          description: DESCRIPTION,
        }),
      ).toEqual({
        outcome: "already_registered",
        slug: "tool-library",
        repo: "didi-build/tool-library",
      });
      const rows = await pool.query(
        "select count(*)::int as n from factory.projects where slug = 'tool-library'",
      );
      expect(rows.rows[0].n).toBe(1);
    });
  },
);
