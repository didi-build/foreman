// Seam: database integration (docs/test-plan.md, build plan M3.5, D-228, D-229). The Council's
// answers on the real Postgres store, as the factory_runner role: a Council run keeps its question
// (migration 0014); an escalation answer is recorded once per run, also when two calls race; a
// reversal answer, the question's gate request answered, the cleared flags and the question for
// Didi commit together, once.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createCouncil } from "../../src/core/council.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import { createLibrary, reversalTopic } from "../../src/core/library.ts";
import type { Store } from "../../src/core/store.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_council_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "the Council's answers on Postgres (database integration, D-228, D-229)",
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

    async function setup(idPrefix: string, slug: string) {
      const f = await createReconcileFixture({ store, idPrefix, slug });
      await f.setting("dry_run", false);
      return { ...f, council: createCouncil(f.deps), library: createLibrary(f.deps) };
    }

    it("records an escalation answer once per run, also when two calls race", async () => {
      const t = await setup("91000000-0000-4000-8000", "council-a");
      const node = await t.node("in_development");
      await store.setCounter(node.id, "failure", 3, t.clock.now());
      t.advanceMinutes(1);
      await createEscalations(t.deps).escalate(
        node.id,
        { kind: "event", ref: "test:escalate" },
        "three failures",
      );
      t.advanceMinutes(1);
      const topic = escalationTopic(node.id);
      const run = await t.run(node.id, "council", 0, { questionTopic: topic });
      expect((await store.getRun(run.id))?.questionTopic).toBe(topic);
      const answer = {
        outcome: "resolve",
        note: "Retry with a smaller change.",
        changesProductDirection: false,
        passesGate: false,
      };
      const results = await Promise.all([
        t.council.recordAnswer(run.id, answer),
        t.council.recordAnswer(run.id, answer),
      ]);
      expect(results.map((r) => r.recorded).sort()).toEqual(["already_recorded", true]);
      const decisions = (await store.listDecisionsForNode(node.id)).filter(
        (d) => d.kind === "council_decision",
      );
      expect(decisions).toMatchObject([
        { scope: { topicKey: topic, runId: run.id, outcome: "resolve" } },
      ]);
    });

    it("commits a reversal answer with its gate request, the cleared flags and the question for Didi, once", async () => {
      const t = await setup("92000000-0000-4000-8000", "council-b");
      const owner = await t.node("in_development");
      const keep = await t.node("in_development");
      const undecided = await t.node("in_development");
      const decision = await t.library.recordDecision(
        {
          projectId: t.projectId,
          nodeId: owner.id,
          kind: "approval",
          scope: {},
          textVerbatim: "Yes",
          byActor: "didi",
        },
        [keep.id, undecided.id],
      );
      t.advanceMinutes(1);
      const question = await t.library.reverseDecision(decision.id, "didi", "No");
      t.advanceMinutes(1);
      const topic = reversalTopic(decision.id);
      const run = await t.run(owner.id, "council", 0, { questionTopic: topic });
      const answer = {
        verdicts: [
          { nodeId: keep.id, verdict: "still_valid", note: "" },
          { nodeId: undecided.id, verdict: "cannot_decide", note: "" },
        ],
        note: "Only one is affected.",
      };
      const results = await Promise.all([
        t.council.recordAnswer(run.id, answer),
        t.council.recordAnswer(run.id, answer),
      ]);
      expect(results.map((r) => r.recorded).sort()).toEqual(["already_recorded", true]);
      expect(await store.getGateRequest(question!.id)).toMatchObject({
        status: "answered",
      });
      expect((await store.getNode(keep.id))?.stale).toBe(false);
      expect((await store.getNode(undecided.id))?.stale).toBe(true);
      expect(await store.findOpenGateRequest(t.projectId, topic)).toMatchObject({
        owner: "didi",
        kind: "escalation",
        payload: { nodeIds: [undecided.id] },
      });
      const councilDecisions = await pool.query(
        "select count(*)::int as n from factory.decisions where kind = 'council_decision' and scope->>'topicKey' = $1",
        [topic],
      );
      expect(councilDecisions.rows[0]?.n).toBe(1);
    });
  },
);
