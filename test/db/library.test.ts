// Seam: database integration (docs/test-plan.md, build plan M1.3). The state library on the real
// Postgres store, running as the factory_runner role: the version check, the retry after a lost
// race, rollback and dry run, against the database the runner will use.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Contracts } from "../../src/core/contracts.ts";
import { createLibrary, type Clock, type IdSource } from "../../src/core/library.ts";
import type { Store } from "../../src/core/store.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_library_test_${process.pid}`;
const PROJECT = "00000000-0000-4000-8000-000000000001";

const CONTRACTS: Contracts = {
  version: "f".repeat(40),
  contentHash: "test-machine",
  states: {
    triage: { initial: true },
    ready: {},
    blocked: { requiresBlockedReason: true },
  },
  transitions: [
    { from: "triage", to: "ready", guards: [] },
    { from: "ready", to: "blocked", guards: [] },
  ],
};

let tick = 0;
const clock: Clock = { now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, 0, tick++)) };
let counter = 1;
const ids: IdSource = {
  next: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
};

describe.skipIf(!adminUrl)(
  "state library on Postgres (database integration, build plan M1.3)",
  () => {
    let pool: pg.Pool;
    let store: Store;

    const setDryRun = (value: boolean) =>
      store.setSetting({
        key: "dry_run",
        value,
        updatedBy: "test",
        updatedAt: clock.now(),
      });

    const newItem = (library: ReturnType<typeof createLibrary>) =>
      library.createNode({
        projectId: PROJECT,
        type: "work_item",
        track: "code",
        state: "triage",
        ownerRole: "triage",
        title: "Item",
      });

    const toReady = (nodeId: string) => ({
      nodeId,
      toState: "ready",
      trigger: { kind: "reconcile" as const, ref: null },
      actor: { kind: "runner" as const, id: "runner" },
    });

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      pool = new pg.Pool({
        connectionString: url,
        max: 6,
        options: "-c role=factory_runner",
      });
      store = createPostgresStore(pool);
      await store.insertProject({
        id: PROJECT,
        slug: "rehearsal",
        name: "Rehearsal",
        repo: "didi-build/rehearsal",
        linearProjectId: null,
        galleryPathOverride: null,
        privilegedPathsExtra: [],
        prodRequiresApproval: false,
        stagingUrl: null,
        createdAt: clock.now(),
      });
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    it("lets one of two parallel requests win and the other retry cleanly, every time", async () => {
      await setDryRun(false);
      const library = createLibrary({
        store,
        contracts: CONTRACTS,
        guards: {},
        clock,
        ids,
      });
      for (let round = 0; round < 30; round++) {
        const node = await newItem(library);
        const results = await Promise.all([
          library.requestTransition(toReady(node.id)),
          library.requestTransition(toReady(node.id)),
        ]);
        expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "noop"]);
        expect(await store.listTransitions(node.id)).toHaveLength(1);
        expect((await store.getNode(node.id))?.version).toBe(1);
      }
    });

    it("rolls back the transition row when another writer changed the node first", async () => {
      await setDryRun(false);
      const library = createLibrary({
        store,
        contracts: CONTRACTS,
        guards: {},
        clock,
        ids,
      });
      const node = await newItem(library);
      const racing: Store = {
        ...store,
        getNode: async (id) => {
          const read = await store.getNode(id);
          await store.changeNodeState(id, read!.version, {
            state: read!.state,
            substate: null,
            ownerRole: read!.ownerRole,
            blockedReason: null,
            stateSince: read!.stateSince,
            updatedAt: read!.updatedAt,
          });
          return read;
        },
      };
      const raced = createLibrary({
        store: racing,
        contracts: CONTRACTS,
        guards: {},
        clock,
        ids,
      });
      expect(await raced.requestTransition(toReady(node.id))).toMatchObject({
        outcome: "refused",
        reason: "too_much_contention",
      });
      expect(await store.listTransitions(node.id)).toEqual([]);
      expect((await store.getNode(node.id))?.state).toBe("triage");
    });

    it("in dry run, records a planned transition and leaves the node unchanged", async () => {
      await setDryRun(true);
      const library = createLibrary({
        store,
        contracts: CONTRACTS,
        guards: {},
        clock,
        ids,
      });
      const node = await newItem(library);
      expect((await library.requestTransition(toReady(node.id))).outcome).toBe(
        "planned",
      );
      expect((await store.listTransitions(node.id)).map((t) => t.mode)).toEqual([
        "dry_run",
      ]);
      expect(await store.getNode(node.id)).toMatchObject({
        state: "triage",
        version: 0,
      });
    });
  },
);
