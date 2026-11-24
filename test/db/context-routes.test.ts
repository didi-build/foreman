// Seam: API against the database (docs/test-plan.md, ADR 0119 slice 3b, D-470). The state API's
// three context routes on the real Postgres store, connected as the factory_api role, so a read
// the role's grants do not allow fails here: the item history reads `factory.transitions` through
// migration 0032's grant, and the role still cannot write a transition. The records are written as
// factory_runner, with the same seed as the memory store's API tests (test/context-routes.test.ts).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { ENTRY_CONTRACTS } from "../../src/api/entry.ts";
import { createApiHandler } from "../../src/api/routes.ts";
import {
  CONTEXT_DATA_NOTICE,
  type DecisionSearchData,
  type ItemHistoryData,
  type SimilarItemsData,
} from "../../src/core/context-reads.ts";
import { createLibrary } from "../../src/core/library.ts";
import type { Store } from "../../src/core/store.ts";
import { createLogger } from "../../src/service-kit/logger.ts";
import { startService, type RunningService } from "../../src/service-kit/server.ts";
import {
  at,
  FORBIDDEN_KEY,
  HEAD,
  idsOf,
  issueToken,
  keysOf,
  NEVER_SHOWN,
  nextId,
  OTHER_PROJECT,
  seedContextRoutes,
  SPEC,
  type ContextSeed,
} from "../context-routes-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_context_routes_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "the context routes on Postgres as factory_api (database integration, ADR 0119 slice 3b)",
  () => {
    let runnerPool: pg.Pool;
    let apiPool: pg.Pool;
    let runner: Store;
    let service: RunningService;
    let seed: ContextSeed;
    const answers: string[] = [];

    async function get<D>(path: string, token: string) {
      const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      if (response.status === 200) answers.push(text);
      return {
        status: response.status,
        body: JSON.parse(text) as { notice?: string; data?: D; truncated?: boolean },
      };
    }

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      runnerPool = new pg.Pool({
        connectionString: url,
        max: 2,
        options: "-c role=factory_runner",
      });
      apiPool = new pg.Pool({
        connectionString: url,
        max: 4,
        options: "-c role=factory_api",
      });
      runner = createPostgresStore(runnerPool);
      seed = await seedContextRoutes(runner);
      const store = createPostgresStore(apiPool);
      const clock = { now: () => new Date() };
      service = await startService({
        name: "context-routes-db-test",
        port: 0,
        logger: createLogger("context-routes-db-test", () => undefined),
        handle: createApiHandler({
          store,
          library: createLibrary({
            store,
            contracts: ENTRY_CONTRACTS,
            guards: {},
            clock,
            ids: { next: nextId },
          }),
          clock,
        }),
      });
    });

    afterAll(async () => {
      await service?.stop();
      await apiPool?.end();
      await runnerPool?.end();
      dropTestDatabase(DB);
    });

    it("connects as factory_api", async () => {
      expect((await apiPool.query("select current_user as u")).rows[0].u).toBe(
        "factory_api",
      );
    });

    it("reads an item's history, its state moves included, with only the API's grants (D-470)", async () => {
      const token = await issueToken(runner, "developer");
      const result = await get<ItemHistoryData>(
        `/context/items/${seed.item.id}/history`,
        token,
      );
      expect(result.status).toBe(200);
      expect(result.body.notice).toBe(CONTEXT_DATA_NOTICE);
      const data = result.body.data as ItemHistoryData;
      expect(data.item).toMatchObject({
        id: seed.item.id,
        title: "Export the report as CSV",
        acceptanceCriteria: [
          "A CSV file downloads",
          "The header row names each column",
        ],
      });
      // Applied moves only, newest first, the move back from QA with its reason.
      expect(data.transitions.map((t) => [t.from, t.to])).toEqual([
        ["in_qa_review", "in_development"],
        ["in_development", "in_qa_review"],
        ["ready_for_dev", "in_development"],
        ["triage", "ready_for_dev"],
      ]);
      expect(data.transitions[0]).toEqual({
        at: at(23).toISOString(),
        from: "in_qa_review",
        to: "in_development",
        trigger: "bot_report",
        actor: "runner",
        reason: "QA failed the head: the CSV misses quotes.",
        failedGuards: ["ci_green_on_head"],
      });
      expect(data.runs.map((r) => [r.role, r.outcome])).toEqual([
        ["developer", null],
        ["qa", "fail"],
        ["developer", "success"],
      ]);
      expect(data.evidence.find((e) => e.kind === "qa_verdict")).toEqual({
        kind: "qa_verdict",
        recordedAt: at(23).toISOString(),
        commitSha: HEAD,
        recordedBy: "qa",
        summary: { verdict: "fail", findings: 1 },
      });
      const d = seed.decisions;
      expect(idsOf(data.decisions)).toEqual([d.council.id, d.answer.id, d.approval.id]);
      expect(data.gateRequests.map((g) => [g.kind, g.status])).toEqual([
        ["escalation", "open"],
        ["visual_approval", "answered"],
      ]);
      expect(data.totals).toEqual({
        transitions: 4,
        runs: 3,
        evidence: 8,
        decisions: 3,
        gateRequests: 2,
      });
      // A QA run never sees the builder's report or docs note (ADR 0112).
      const qa = await issueToken(runner, "qa");
      const qaData = (
        await get<ItemHistoryData>(`/context/items/${seed.item.id}/history`, qa)
      ).body.data as ItemHistoryData;
      expect(qaData.evidence.map((e) => e.kind)).not.toContain("agent_report");
      expect(qaData.evidence.map((e) => e.kind)).not.toContain("docs_note");
    });

    it("searches the decisions and finds similar items on Postgres", async () => {
      const token = await issueToken(runner, "triage");
      const search = await get<DecisionSearchData>(
        "/context/decisions?q=CSV+export",
        token,
      );
      expect(search.status).toBe(200);
      const d = seed.decisions;
      expect(idsOf((search.body.data as DecisionSearchData).decisions)).toEqual([
        d.unknownActor.id,
        d.direction.id,
        d.council.id,
        d.answer.id,
        d.approval.id,
        d.superseded.id,
      ]);
      expect((search.body.data as DecisionSearchData).decisions[4]).toMatchObject({
        gateKind: "visual_approval",
        outcome: "approved",
      });
      const designer = await issueToken(runner, "designer", { nodeId: seed.design.id });
      const similar = await get<SimilarItemsData>(
        "/context/similar-items?path=src/report",
        designer,
      );
      expect(similar.status).toBe(200);
      expect((similar.body.data as SimilarItemsData).items.map((i) => i.id)).toEqual([
        seed.item.id,
        seed.similar.id,
      ]);
    });

    it("hides another project's item, and refuses a Council run token", async () => {
      const token = await issueToken(runner, "developer");
      expect(
        (await get(`/context/items/${seed.foreign.id}/history`, token)).status,
      ).toBe(404);
      const foreign = await issueToken(runner, "developer", {
        projectId: OTHER_PROJECT,
      });
      expect(
        (await get(`/context/items/${seed.item.id}/history`, foreign)).status,
      ).toBe(404);
      const council = await issueToken(runner, "council");
      expect((await get("/context/decisions?q=csv", council)).status).toBe(403);
      const expired = await issueToken(runner, "triage", {
        expiresAt: new Date("2026-01-01T00:00:00Z"),
      });
      expect((await get("/context/decisions?q=csv", expired)).status).toBe(401);
    });

    it("never returns a scope, an approval link, a token hash, a budget, a cost, a payload or a marker", () => {
      expect(answers.length).toBeGreaterThan(2);
      for (const text of answers) {
        for (const key of keysOf(JSON.parse(text)))
          expect(key).not.toMatch(FORBIDDEN_KEY);
        for (const marker of Object.values(NEVER_SHOWN))
          expect(text).not.toContain(marker);
      }
    });

    it("lets factory_api read transitions but never write, change or remove one (migration 0032)", async () => {
      const read = await apiPool.query(
        "select count(*)::int as n from factory.transitions where node_id = $1",
        [seed.item.id],
      );
      // Four applied moves and one dry run.
      expect(read.rows[0].n).toBe(5);
      await expect(
        apiPool.query(
          `insert into factory.transitions (id, node_id, from_state, to_state, trigger_kind, actor_kind,
             actor_id, guard_result, spec_version, mode, at)
           values ($1, $2, 'in_development', 'done', 'bot_report', 'bot', 'developer', '[]', $3,
             'applied', now())`,
          [nextId(), seed.item.id, SPEC],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        apiPool.query(
          "update factory.transitions set reason = 'x' where node_id = $1",
          [seed.item.id],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        apiPool.query("delete from factory.transitions where node_id = $1", [
          seed.item.id,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(apiPool.query("truncate factory.transitions")).rejects.toThrow(
        /permission denied/,
      );
      // Nothing changed.
      expect((await runner.listTransitions(seed.item.id)).length).toBe(5);
    });
  },
);
