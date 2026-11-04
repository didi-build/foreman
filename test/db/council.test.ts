// Seam: database integration (docs/test-plan.md, build plan M3.5, D-228, D-229). The Council's
// answers on the real Postgres store, as the factory_runner role: a Council run keeps its question
// (migration 0014); an escalation answer is recorded once per run, also when two calls race; a
// reversal answer, the question's gate request answered, the cleared flags and the question for
// Didi commit together, once; two reversal answers naming the same items in opposite orders both
// commit with no deadlock; a redo move commits with its cleared flag, reset counters and
// cancelled visual-approval request, once, also when two calls race (D-231); a merged item's
// rework item commits with its `reworks` edge and the original's cleared flag, once, also when
// two calls race (D-233, migration 0015); and a follow-up Council question after Didi's answer is
// opened once when two calls race (D-234).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { approvalDecision } from "../../src/core/approvals.ts";
import { createCouncil } from "../../src/core/council.ts";
import { createEscalations } from "../../src/core/escalations.ts";
import { visualApprovalTopic } from "../../src/core/guards/design.ts";
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

    it("records two reversal answers that name the same items in opposite orders without a deadlock", async () => {
      const t = await setup("94000000-0000-4000-8000", "council-d");
      // A deadlock needs both transactions to hold one item each, so repeat the race a few times.
      for (let round = 0; round < 8; round++) {
        const ownerA = await t.node("in_development");
        const ownerB = await t.node("in_development");
        const first = await t.node("in_development");
        const second = await t.node("in_development");
        const decide = (nodeId: string) =>
          t.library.recordDecision(
            {
              projectId: t.projectId,
              nodeId,
              kind: "approval",
              scope: {},
              textVerbatim: "Yes",
              byActor: "didi",
            },
            [first.id, second.id],
          );
        const decisionA = await decide(ownerA.id);
        const decisionB = await decide(ownerB.id);
        t.advanceMinutes(1);
        await t.library.reverseDecision(decisionA.id, "didi", "No");
        await t.library.reverseDecision(decisionB.id, "didi", "No");
        t.advanceMinutes(1);
        const runA = await t.run(ownerA.id, "council", 0, {
          questionTopic: reversalTopic(decisionA.id),
        });
        const runB = await t.run(ownerB.id, "council", 0, {
          questionTopic: reversalTopic(decisionB.id),
        });
        const verdict = (nodeId: string) => ({
          nodeId,
          verdict: "still_valid",
          note: "",
        });
        const results = await Promise.all([
          t.council.recordAnswer(runA.id, {
            verdicts: [verdict(first.id), verdict(second.id)],
            note: "",
          }),
          t.council.recordAnswer(runB.id, {
            verdicts: [verdict(second.id), verdict(first.id)],
            note: "",
          }),
        ]);
        expect(results.map((r) => r.recorded)).toEqual([true, true]);
      }
    });

    it("commits a redo move with its flag, counters and visual-approval request, once, also when two calls race", async () => {
      const t = await setup("93000000-0000-4000-8000", "council-c");
      const owner = await t.node("in_development");
      const item = await t.node("waiting_for_didi", { track: "design" });
      await store.setCounter(item.id, "failure", 2, t.clock.now());
      await store.setCounter(item.id, "qa_round", 1, t.clock.now());
      const approval = await t.openGate(item.id, visualApprovalTopic(item.id), {
        kind: "visual_approval",
        owner: "didi",
      });
      const decision = await t.library.recordDecision(
        {
          projectId: t.projectId,
          nodeId: owner.id,
          kind: "approval",
          scope: {},
          textVerbatim: "Yes",
          byActor: "didi",
        },
        [item.id],
      );
      t.advanceMinutes(1);
      await t.library.reverseDecision(decision.id, "didi", "No");
      t.advanceMinutes(1);
      const run = await t.run(owner.id, "council", 0, {
        questionTopic: reversalTopic(decision.id),
      });
      const answer = await t.council.recordAnswer(run.id, {
        verdicts: [{ nodeId: item.id, verdict: "redo", note: "" }],
        note: "Start over.",
      });
      expect(answer).toMatchObject({ verdicts: [{ result: "redo_move_due" }] });
      const linked = await pool.query(
        "select count(*)::int as n from factory.node_decisions where node_id = $1 and decision_id = $2",
        [item.id, answer.recorded ? answer.decisionId : null],
      );
      expect(linked.rows[0]?.n).toBe(1);
      t.advanceMinutes(1);
      const results = await Promise.all([
        t.council.redo(item.id),
        t.council.redo(item.id),
      ]);
      expect(
        results.filter((r) => r.step === "moved" && r.outcome === "applied"),
      ).toHaveLength(1);
      expect(await store.getNode(item.id)).toMatchObject({
        state: "ready_for_design_exploration",
        stale: false,
      });
      expect(await store.getCounter(item.id, "failure")).toBe(0);
      expect(await store.getCounter(item.id, "qa_round")).toBe(0);
      expect(await store.getGateRequest(approval.id)).toMatchObject({
        status: "cancelled",
      });
      expect((await store.listTransitions(item.id)).map((m) => m.triggerRef)).toEqual([
        `council_redo:${answer.recorded ? answer.decisionId : ""}`,
      ]);
    });

    it("commits a merged item's rework item with its edge and the cleared flag, once, also when two calls race", async () => {
      const t = await setup("95000000-0000-4000-8000", "council-e");
      // Repeat the race a few times: one round can pass by luck.
      for (let round = 0; round < 5; round++) {
        const owner = await t.node("in_development");
        const item = await t.node("done", { title: `Merged ${round}` });
        await t.evidence(
          item.id,
          "merge_commit",
          { pr: round },
          { commitSha: "c".repeat(40) },
        );
        const decision = await t.library.recordDecision(
          {
            projectId: t.projectId,
            nodeId: owner.id,
            kind: "approval",
            scope: {},
            textVerbatim: "Yes",
            byActor: "didi",
          },
          [item.id],
        );
        t.advanceMinutes(1);
        await t.library.reverseDecision(decision.id, "didi", "No");
        t.advanceMinutes(1);
        const run = await t.run(owner.id, "council", 0, {
          questionTopic: reversalTopic(decision.id),
        });
        const answer = await t.council.recordAnswer(run.id, {
          verdicts: [{ nodeId: item.id, verdict: "redo", note: "Undo it." }],
          note: "The change is wrong.",
        });
        expect(answer).toMatchObject({ verdicts: [{ result: "rework_due" }] });
        t.advanceMinutes(1);
        const results = await Promise.all([
          t.council.redo(item.id),
          t.council.redo(item.id),
        ]);
        const created = results.filter(
          (r) => r.step === "reworked" && r.outcome === "created",
        );
        expect(created, `round ${round}`).toHaveLength(1);
        const reworkId =
          created[0]?.step === "reworked" ? created[0].reworkNodeId : null;
        const edges = await pool.query(
          "select from_node from factory.edges where to_node = $1 and type = 'reworks'",
          [item.id],
        );
        expect(edges.rows).toEqual([{ from_node: reworkId }]);
        const reworks = await pool.query(
          "select count(*)::int as n from factory.nodes where title = $1",
          [`Rework: Merged ${round}`],
        );
        expect(reworks.rows[0]?.n).toBe(1);
        expect(await store.getNode(reworkId ?? "")).toMatchObject({
          state: "ready_for_dev",
          track: "code",
          stale: false,
          body: { rework: { originalNodeId: item.id, councilNote: "Undo it." } },
        });
        expect(await store.getNode(item.id)).toMatchObject({
          state: "done",
          stale: false,
        });
        // The other call waited on the original's lock, then found the item already opened or
        // the flag already cleared; or its unlocked check read the flag before the first call
        // committed and the opened rework after, so the episode read as settled. Either way it
        // wrote nothing.
        const other = results.find((r) => r !== created[0]);
        expect(
          other?.step === "not_stale" ||
            (other?.step === "not_due" && other.why === "settled") ||
            (other?.step === "reworked" && other.outcome === "already_created"),
          `round ${round}`,
        ).toBe(true);
      }
    });

    it("opens one follow-up Council question after Didi's answer when two calls race", async () => {
      const t = await setup("96000000-0000-4000-8000", "council-f");
      for (let round = 0; round < 5; round++) {
        const owner = await t.node("in_development");
        const first = await t.node("in_development");
        const second = await t.node("in_development");
        const decision = await t.library.recordDecision(
          {
            projectId: t.projectId,
            nodeId: owner.id,
            kind: "approval",
            scope: {},
            textVerbatim: "Yes",
            byActor: "didi",
          },
          [first.id, second.id],
        );
        t.advanceMinutes(1);
        await t.library.reverseDecision(decision.id, "didi", "No");
        t.advanceMinutes(1);
        const topic = reversalTopic(decision.id);
        const run = await t.run(owner.id, "council", 0, { questionTopic: topic });
        await t.council.recordAnswer(run.id, {
          verdicts: [
            { nodeId: first.id, verdict: "cannot_decide", note: "" },
            { nodeId: second.id, verdict: "cannot_decide", note: "" },
          ],
          note: "",
        });
        const gate = await store.findOpenGateRequest(t.projectId, topic);
        t.advanceMinutes(1);
        await t.library.answerGateRequest(
          gate!.id,
          approvalDecision(gate!, {
            choice: "changes_requested",
            words: "Redo both.",
            approvers: ["anonymous"],
          }),
        );
        t.advanceMinutes(1);
        const results = await Promise.all([
          t.council.followUp(topic),
          t.council.followUp(topic),
        ]);
        expect(
          results.filter((r) => r.step === "opened"),
          `round ${round}`,
        ).toHaveLength(1);
        const followUps = await pool.query(
          "select count(*)::int as n from factory.gate_requests where topic_key = $1 and kind = 'council_question' and payload ? 'didiDecisionId'",
          [topic],
        );
        expect(followUps.rows[0]?.n).toBe(1);
      }
    });
  },
);
