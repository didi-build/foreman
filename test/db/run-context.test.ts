// Seam: database integration (docs/test-plan.md, ADR 0119 slice 3a). The short summary in each
// run's input, gathered from the real Postgres store as the factory_runner role, so a read the
// role's grants do not allow fails here: the project's newest decisions (`listProjectDecisions`,
// on `decisions_current`), its nodes, the decisions linked to an item, evidence, runs, moves and
// the active runs. The same seed as the memory store's unit tests (test/run-context.test.ts).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { DIRECTION_LABELS } from "../../src/core/planning-reads.ts";
import {
  contextSection,
  gatherRunContext,
  RUN_CONTEXT_LIMITS,
} from "../../src/core/run-context.ts";
import { createMemoryStore } from "../../src/core/memory-store.ts";
import type { AgentRole, Node, Store } from "../../src/core/store.ts";
import {
  NEVER_SHOWN,
  seedRunContext,
  type RunContextSeed,
} from "../run-context-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_run_context_test_${process.pid}`;

async function summary(
  seed: RunContextSeed,
  node: Node,
  role: AgentRole,
  taskType: string,
): Promise<string> {
  const context = await gatherRunContext(seed.f.store, {
    projectId: seed.f.projectId,
    node,
    role,
    taskType,
    contracts: seed.f.contracts,
  });
  if (!context) throw new Error(`no summary for ${taskType}`);
  return contextSection(context);
}

describe.skipIf(!adminUrl)(
  "the summary in each run's input on Postgres (database integration, ADR 0119 slice 3a)",
  () => {
    let pool: pg.Pool;
    let store: Store;

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      // Run as the runner's group role, so the reads have only the grants the migrations give.
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

    it("gathers the same summary for Triage, the Developer, the Designer and QA as the memory store does", async () => {
      const seed = await seedRunContext(store);
      const memory = await seedRunContext(createMemoryStore());
      for (const [role, taskType, pick] of [
        ["triage", "triage", (s: RunContextSeed) => s.idea],
        ["developer", "developer:code", (s: RunContextSeed) => s.item],
        ["designer", "designer", (s: RunContextSeed) => s.item],
        ["qa", "qa:review", (s: RunContextSeed) => s.item],
      ] as const) {
        const text = await summary(seed, pick(seed), role, taskType);
        expect(text, taskType).toBe(
          await summary(memory, pick(memory), role, taskType),
        );
        expect(text.length, taskType).toBeLessThanOrEqual(
          RUN_CONTEXT_LIMITS.totalChars[taskType],
        );
        for (const [what, marker] of Object.entries(NEVER_SHOWN)) {
          expect(text, `${taskType}: ${what}`).not.toContain(marker);
        }
      }
      const triage = await summary(seed, seed.idea, "triage", "triage");
      expect(triage).toContain(`(and ${seed.projectDecisions - 10} more)`);
      expect(triage).toContain(
        `Product direction (${DIRECTION_LABELS.approved}), by the planning chat, on the idea: Export the report as CSV`,
      );
      expect(triage).toContain(
        "- code, in_development, a Developer run is on it: Add the export button to the report page",
      );
    });
  },
);
