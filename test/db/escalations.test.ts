// Seam: database integration (docs/test-plan.md, build plan M3.5). The P-03 counts with no move
// and the escalation moves on the real Postgres store, as the factory_runner role: a refused done
// report's `failure_count` row (migration 0013) and its count commit together, once under its key;
// a repeated failed start counts once; the Council's return resets both counters in its own
// transaction; a "cannot resolve" opens one gate request for Didi; a reversed decision marks its
// dependents stale once.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { createFailures, failureCountKey } from "../../src/core/failures.ts";
import { escalationTopic } from "../../src/core/guards/escalation.ts";
import { createLibrary } from "../../src/core/library.ts";
import { createRunReports } from "../../src/core/run-reports.ts";
import type { AgentRole, Run, Store } from "../../src/core/store.ts";
import { createReconcileFixture, HEAD } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_escalation_test_${process.pid}`;
const KEEPS = { changesProductDirection: false, passesGate: false };

describe.skipIf(!adminUrl)(
  "escalation on Postgres (database integration, M3.5)",
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
      async function ended(nodeId: string, role: AgentRole, outcome: Run["outcome"]) {
        f.advanceMinutes(5);
        const run = await f.run(nodeId, role);
        f.advanceMinutes(5);
        await store.endRun(run.id, {
          endedAt: f.clock.now(),
          outcome: outcome ?? "success",
          turns: null,
          minutes: null,
          costUsd: null,
          tokens: null,
          transcriptRef: null,
          usageExhaustedCause: null,
          retryAfterSeconds: null,
          serviceTierServed: null,
          capacityRetries: null,
          capacityWaitSeconds: null,
          firstTokenMs: null,
          reportedCostUsd: null,
        });
        return run;
      }
      return { ...f, ended };
    }

    it("counts a refused done report once, with its row under its key, and escalates at the threshold", async () => {
      const t = await setup("81000000-0000-4000-8000", "a");
      const node = await t.node("in_development");
      await store.setCounter(node.id, "failure", 2, t.clock.now());
      await t.evidence(
        node.id,
        "ci_run",
        { conclusion: "failure", pr: 7, changedPaths: ["src/a.ts"] },
        { commitSha: HEAD },
      );
      const dev = await t.ended(node.id, "developer", "success");
      const reports = createRunReports(t.deps);
      expect(await reports.requestReportedMove(dev.id)).toMatchObject({
        failureCount: {
          counted: true,
          failures: 3,
          escalation: { outcome: "applied", toState: "escalated_to_council" },
        },
      });
      expect(await reports.requestReportedMove(dev.id)).toMatchObject({
        requested: true,
      });
      const rows = await pool.query(
        "select run_id, commit_sha from factory.evidence where ingest_key = $1",
        [failureCountKey("report_refused", dev.id)],
      );
      expect(rows.rows).toEqual([{ run_id: dev.id, commit_sha: HEAD }]);
      expect(await store.getCounter(node.id, "failure")).toBe(3);
      expect((await store.getNode(node.id))?.state).toBe("escalated_to_council");
    });

    it("counts a repeated failed start once per run", async () => {
      const t = await setup("82000000-0000-4000-8000", "b");
      const node = await t.node("ready_for_dev");
      const failures = createFailures(t.deps);
      await t.ended(node.id, "developer", "fail");
      const second = await t.ended(node.id, "developer", "fail");
      expect(await failures.dispatchFailed(second.id)).toMatchObject({
        counted: true,
        failures: 1,
      });
      expect(await failures.dispatchFailed(second.id)).toMatchObject({
        counted: "already_counted",
      });
      expect(await store.getCounter(node.id, "failure")).toBe(1);
    });

    it("returns a resolved item with both counters reset, and sends 'cannot resolve' to Didi with one gate request", async () => {
      const t = await setup("83000000-0000-4000-8000", "c");
      const escalations = createEscalations(t.deps);
      const library = createLibrary(t.deps);
      const escalate = async () => {
        const node = await t.node("in_development");
        await store.setCounter(node.id, "failure", 3, t.clock.now());
        await store.setCounter(node.id, "qa_round", 1, t.clock.now());
        await escalations.escalate(
          node.id,
          { kind: "event", ref: "test" },
          "three failures",
        );
        t.advanceMinutes(1);
        return node;
      };
      const decide = (nodeId: string, scope: object) =>
        library.recordDecision({
          projectId: t.projectId,
          nodeId,
          kind: "council_decision",
          scope: { ...scope },
          textVerbatim: "Decided.",
          byActor: "council",
        });

      const resolved = await escalate();
      await decide(resolved.id, KEEPS);
      expect(await escalations.resolve(resolved.id)).toMatchObject({
        step: "returned",
        move: { outcome: "applied" },
      });
      expect((await store.getNode(resolved.id))?.state).toBe("in_development");
      expect(await store.getCounter(resolved.id, "failure")).toBe(0);
      expect(await store.getCounter(resolved.id, "qa_round")).toBe(0);

      const stuck = await escalate();
      await decide(stuck.id, { ...KEEPS, outcome: "cannot_resolve" });
      await escalations.resolve(stuck.id);
      await escalations.resolve(stuck.id);
      expect((await store.getNode(stuck.id))?.state).toBe("escalated_to_didi");
      const gates = await pool.query(
        "select kind, owner, status from factory.gate_requests where topic_key = $1",
        [escalationTopic(stuck.id)],
      );
      expect(gates.rows).toEqual([
        { kind: "escalation", owner: "didi", status: "open" },
      ]);
    });

    it("marks a reversed decision's dependents stale and opens one Council question, once", async () => {
      const t = await setup("84000000-0000-4000-8000", "d");
      const library = createLibrary(t.deps);
      const node = await t.node("ready_for_dev");
      const decision = await library.recordDecision(
        {
          projectId: t.projectId,
          nodeId: null,
          kind: "approval",
          scope: {},
          textVerbatim: "Yes",
          byActor: "didi",
        },
        [node.id],
      );
      const question = await library.reverseDecision(decision.id, "didi", "No");
      expect((await library.reverseDecision(decision.id, "didi", "No"))?.id).toBe(
        question?.id,
      );
      expect((await store.getNode(node.id))?.stale).toBe(true);
      const events = await pool.query(
        "select count(*)::int as n from factory.decision_events where decision_id = $1",
        [decision.id],
      );
      expect(events.rows[0]?.n).toBe(1);
    });
  },
);
