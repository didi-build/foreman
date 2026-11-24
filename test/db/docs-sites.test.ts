// Seam: database integration (docs/test-plan.md, ADR 0119 slice 4c, D-473 to D-475). The store
// reads and the row lock the documentation site requests use, and the requests and Didi's answer
// on the real Postgres store as the factory_runner role, with no new grant: the requests on one
// topic across projects, oldest first, exact or by prefix; the trusted list's row lock and its
// logged changes; two run ends in two projects asking for one host at once open one request; two
// approvals of different hosts at once both land, and one approval answered twice at once adds
// its host once. Migration 0033's seed is in test/db/schema.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { approvalDecision } from "../../src/core/approvals.ts";
import {
  createDocsSites,
  DOCS_SITE_PREFIX,
  docsSiteTopic,
  TRUSTED_DOCS_HOSTS,
} from "../../src/core/docs-sites.ts";
import { createLibrary } from "../../src/core/library.ts";
import type { GateRequest, Store } from "../../src/core/store.ts";
import { createReconcileFixture, type ReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_docs_sites_test_${process.pid}`;
const LISTED = ["nodejs.org", "vitest.dev"];

const asks = (...hosts: string[]) => ({
  siteRequests: hosts.map((host) => ({ host, reason: `The ${host} reference.` })),
});

describe.skipIf(!adminUrl)(
  "documentation site requests on Postgres (database integration, ADR 0119 slice 4c)",
  () => {
    let pool: pg.Pool;
    let store: Store;
    let a: ReconcileFixture;
    let b: ReconcileFixture;

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
      a = await createReconcileFixture({
        store,
        idPrefix: "9d000000-0000-4000-8000",
        slug: "docs-a",
      });
      b = await createReconcileFixture({
        store,
        idPrefix: "9e000000-0000-4000-8000",
        slug: "docs-b",
      });
      await a.setting("dry_run", false);
    });

    afterAll(async () => {
      await pool?.end();
      dropTestDatabase(DB);
    });

    const openOn = (t: ReconcileFixture, topicKey: string, kind: GateRequest["kind"]) =>
      createLibrary(t.deps).openGateRequest({
        projectId: t.projectId,
        topicKey,
        kind,
        owner: "didi",
        blocking: false,
      });

    const approve = (t: ReconcileFixture, gate: GateRequest) =>
      createLibrary(t.deps).answerGateRequest(
        gate.id,
        approvalDecision(gate, {
          choice: "approve",
          words: null,
          approvers: ["anonymous"],
        }),
      );

    async function developerRun(t: ReconcileFixture) {
      const node = await t.node("in_development");
      return t.run(node.id, "developer");
    }

    it("lists one topic's requests in every project, oldest first, exactly or by prefix", async () => {
      const first = await openOn(a, "docs-site:list.example.dev", "new_credentials");
      b.advanceMinutes(1);
      const second = await openOn(b, "docs-site:list.example.dev", "new_credentials");
      const lookalike = await openOn(
        b,
        "docs-sitex:list.example.dev",
        "new_credentials",
      );
      const other = await openOn(a, "docs-site:other.example.dev", "new_credentials");
      expect(
        (await store.listGateRequestsByTopic("docs-site:list.example.dev")).map((g) => [
          g.id,
          g.projectId,
        ]),
      ).toEqual([
        [first.id, a.projectId],
        [second.id, b.projectId],
      ]);
      const prefixed = (
        await store.listGateRequestsByTopic(DOCS_SITE_PREFIX, { prefix: true })
      ).map((g) => g.id);
      expect(prefixed).toEqual(expect.arrayContaining([first.id, second.id, other.id]));
      expect(prefixed).not.toContain(lookalike.id);
      // A closed request is listed too.
      await store.closeGateRequest(first.id, { status: "expired", at: a.clock.now() });
      expect(
        (await store.listGateRequestsByTopic("docs-site:list.example.dev")).map(
          (g) => g.status,
        ),
      ).toEqual(["expired", "open"]);
      expect(await store.listGateRequestsByTopic("docs-site:none.example.dev")).toEqual(
        [],
      );
      for (const g of [second, lookalike, other]) {
        await store.closeGateRequest(g.id, { status: "cancelled", at: a.clock.now() });
      }
    });

    it("locks the list's row until the transaction ends, and lists its logged changes oldest first", async () => {
      // Migration 0033 seeded the row; the fixture's write is logged after it.
      await a.setting(TRUSTED_DOCS_HOSTS, LISTED);
      const changes = await store.listSettingChanges(TRUSTED_DOCS_HOSTS);
      expect(changes[0]).toMatchObject({ oldValue: null, changedBy: "migration" });
      expect(changes.at(-1)).toMatchObject({
        key: TRUSTED_DOCS_HOSTS,
        newValue: LISTED,
        changedBy: "test",
        changedAt: a.clock.now(),
      });
      expect(await store.transaction((tx) => tx.lockSetting("no_such_setting"))).toBe(
        false,
      );
      const order: string[] = [];
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = () => {};
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const first = store.transaction(async (tx) => {
        expect(await tx.lockSetting(TRUSTED_DOCS_HOSTS)).toBe(true);
        order.push("first locked");
        locked();
        await held;
        order.push("first done");
      });
      await firstLocked;
      const second = store.transaction(async (tx) => {
        await tx.lockSetting(TRUSTED_DOCS_HOSTS);
        order.push("second locked");
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(order).toEqual(["first locked"]);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first locked", "first done", "second locked"]);
    });

    it("opens one request when two runs in two projects ask for the same host at once", async () => {
      await b.setting("dry_run", false);
      await a.setting(TRUSTED_DOCS_HOSTS, LISTED);
      const [runA, runB] = [await developerRun(a), await developerRun(b)];
      const results = await Promise.all([
        createDocsSites(a.deps).submit(runA, asks("race.example.dev")),
        createDocsSites(b.deps).submit(runB, asks("race.example.dev")),
      ]);
      expect(results.map((r) => ("opened" in r ? r.opened : -1)).sort()).toEqual([
        0, 1,
      ]);
      const requests = await store.listGateRequestsByTopic(
        docsSiteTopic("race.example.dev"),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        nodeId: null,
        kind: "new_credentials",
        owner: "didi",
        blocking: false,
        status: "open",
      });
    });

    it("adds both hosts when two approvals are answered at once, and one approval answered twice at once adds its host once", async () => {
      await a.setting(TRUSTED_DOCS_HOSTS, LISTED);
      const run = await developerRun(a);
      const sites = createDocsSites(a.deps);
      await sites.submit(run, asks("one.example.dev", "two.example.dev"));
      const [one] = await store.listGateRequestsByTopic(
        docsSiteTopic("one.example.dev"),
      );
      const [two] = await store.listGateRequestsByTopic(
        docsSiteTopic("two.example.dev"),
      );
      if (!one || !two) throw new Error("no site requests");
      await approve(a, one);
      await approve(a, two);
      const added = await Promise.all([
        sites.afterAnswer(one),
        sites.afterAnswer(two),
        sites.afterAnswer(one),
      ]);
      expect(added.map((r) => r.step).sort()).toEqual([
        "added",
        "added",
        "already_listed",
      ]);
      expect((await store.getSetting(TRUSTED_DOCS_HOSTS))?.value).toEqual([
        "nodejs.org",
        "one.example.dev",
        "two.example.dev",
        "vitest.dev",
      ]);
      const runnerWrites = await pool.query(
        "select count(*)::int as n from factory.settings_log where key = $1 and changed_by = 'runner'",
        [TRUSTED_DOCS_HOSTS],
      );
      expect(runnerWrites.rows[0].n).toBe(2);
      expect(await sites.pending()).toEqual([]);
    });
  },
);
