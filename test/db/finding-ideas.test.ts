// Seam: database integration (docs/test-plan.md, D-244, O-65). The ideas the runner creates from
// the bugs a run reported outside its item, on the real Postgres store as the factory_runner
// role: one Submitted idea per finding, marked with the role, the item and the run, and two run
// ends for the same run at once create one set, since the item's row is locked first.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createFindingIdeas, FINDING_SOURCE } from "../../src/core/finding-ideas.ts";
import type { Store } from "../../src/core/store.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_finding_ideas_test_${process.pid}`;

const FOUND = [
  { title: "Login page answers 500", detail: "src/login.ts throws on an empty email." },
  { title: "Typo in the help page", detail: "docs/help.md says 'teh'." },
];

describe.skipIf(!adminUrl)(
  "ideas from a run's findings on Postgres (database integration, D-244)",
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

    it("creates one set of ideas when two run ends for the same run race", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f000000-0000-4000-8000",
        slug: "fi",
      });
      await t.setting("dry_run", false);
      const node = await t.node("in_qa_review");
      const qa = await t.run(node.id, "qa");
      const ideas = createFindingIdeas(t.deps);
      const structured = { verdict: "pass", outOfScopeFindings: FOUND };
      const [a, b] = await Promise.all([
        ideas.submit(qa.id, structured),
        ideas.submit(qa.id, structured),
      ]);
      expect([a.step, b.step].sort()).toEqual(["already_created", "created"]);
      const rows = await pool.query(
        "select type, track, state, owner_role, title, body from factory.nodes where project_id = $1 and type = 'idea' order by title",
        [t.projectId],
      );
      expect(rows.rows).toEqual(
        FOUND.map((f) => ({
          type: "idea",
          track: null,
          state: "submitted",
          owner_role: "runner",
          title: f.title,
          body: {
            source: FINDING_SOURCE,
            description: f.detail,
            foundBy: { role: "qa", nodeId: node.id, runId: qa.id },
          },
        })),
      );
      // The item is not moved: no transition is written by the ideas.
      const moves = await pool.query(
        "select count(*)::int as n from factory.transitions where node_id = $1",
        [node.id],
      );
      expect(moves.rows[0]).toEqual({ n: 0 });
      expect(await ideas.submit(qa.id, structured)).toEqual({
        step: "already_created",
        ideas: 2,
      });
    });

    it("writes nothing in dry run", async () => {
      const t = await createReconcileFixture({
        store,
        idPrefix: "8f100000-0000-4000-8000",
        slug: "fj",
      });
      const node = await t.node("in_development");
      const dev = await t.run(node.id, "developer");
      expect(
        await createFindingIdeas(t.deps).submit(dev.id, { outOfScopeFindings: FOUND }),
      ).toEqual({ step: "refused", reason: "dry_run" });
      const rows = await pool.query(
        "select count(*)::int as n from factory.nodes where project_id = $1 and type = 'idea'",
        [t.projectId],
      );
      expect(rows.rows[0]).toEqual({ n: 0 });
    });
  },
);
