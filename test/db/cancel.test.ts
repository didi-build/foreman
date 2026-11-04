// Seam: database integration (docs/test-plan.md, D-308, O-97). The cancel on the real Postgres
// store as the factory_runner role: the guard's reads (decisions, gate requests, transitions,
// runs), each work item's move into Cancelled with its open gate requests cancelled in the same
// transaction (gate requests read by node), the idea's move into Rejected, the request for Didi
// on a plan Didi approved, Didi's own cancel recorded as Didi's `answer`, and the "is this still
// needed?" question opened as the Council's request. No migration: the new state is a contract
// state, the store holds no list of states, and every row uses an existing kind.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import {
  cancelRequestTopic,
  createCancels,
  stillNeededTopic,
} from "../../src/core/cancel.ts";
import { createStillNeeded } from "../../src/core/still-needed.ts";
import { scannerGoneTopic } from "../../src/core/scan-ideas.ts";
import type { Store } from "../../src/core/store.ts";
import { createReconcileFixture } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_cancel_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "the cancel on Postgres (database integration, D-308)",
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

    async function stopped(
      prefix: string,
      slug: string,
      acceptedBy: "council" | "didi",
    ) {
      const t = await createReconcileFixture({ store, idPrefix: prefix, slug });
      await t.setting("dry_run", false);
      const idea = await t.node("handed_off", {
        type: "idea",
        track: null,
        ownerRole: "runner",
        body: { source: "scanner", check: "doc_link_missing" },
      });
      await store.insertDecision({
        id: t.deps.ids.next(),
        projectId: t.projectId,
        nodeId: idea.id,
        kind: "council_decision",
        scope: { kind: "plan_accepted", recordedBy: "runner", acceptedBy },
        textVerbatim: "Fix the link.",
        byActor: "council",
        recordedAt: t.clock.now(),
      });
      const item = await t.node("ready_for_dev", { title: "Fix the link" });
      await store.insertEdge({
        id: t.deps.ids.next(),
        fromNode: idea.id,
        toNode: item.id,
        type: "split_into",
        createdAt: t.clock.now(),
      });
      const open = await t.openGate(item.id, `scope:${item.id}`, {
        kind: "scope",
        owner: "didi",
        blocking: false,
      });
      t.advanceMinutes(1);
      await store.insertDecision({
        id: t.deps.ids.next(),
        projectId: t.projectId,
        nodeId: idea.id,
        kind: "council_decision",
        scope: { topicKey: scannerGoneTopic(idea.id), verdict: "stop" },
        textVerbatim: "Fixed elsewhere.",
        byActor: "council",
        recordedAt: t.clock.now(),
      });
      return { ...t, idea, item, open };
    }

    it("cancels the item with its open request, then rejects the idea, once, on a plan the Council accepted", async () => {
      const t = await stopped("8f300000-0000-4000-8000", "cs-a", "council");
      const step = await createCancels(t.deps).step(t.idea.id);
      expect(step).toMatchObject({
        step: "acted",
        items: [{ nodeId: t.item.id, result: "cancelled" }],
        idea: { outcome: "applied" },
      });
      expect((await store.getNode(t.item.id))?.state).toBe("cancelled");
      expect((await store.getNode(t.idea.id))?.state).toBe("rejected");
      expect((await store.getGateRequest(t.open.id))?.status).toBe("cancelled");
      expect(await createCancels(t.deps).step(t.idea.id)).toMatchObject({
        step: "not_due",
        why: "finished",
      });
      expect(
        (await store.listTransitions(t.item.id)).map((r) => [r.toState, r.mode]),
      ).toEqual([["cancelled", "applied"]]);
    });

    it("opens one request for Didi on a plan Didi approved, and cancels on Didi's Approve", async () => {
      const t = await stopped("8f310000-0000-4000-8000", "cs-b", "didi");
      const cancels = createCancels(t.deps);
      await cancels.step(t.idea.id);
      await cancels.step(t.idea.id);
      const requests = await store.listGateRequests(
        t.projectId,
        cancelRequestTopic(t.idea.id),
      );
      expect(requests).toMatchObject([
        { owner: "didi", kind: "scope", blocking: false, status: "open" },
      ]);
      expect((await store.getNode(t.item.id))?.state).toBe("ready_for_dev");
      const approval = t.deps.ids.next();
      await store.insertDecision({
        id: approval,
        projectId: t.projectId,
        nodeId: t.idea.id,
        kind: "approval",
        scope: {},
        textVerbatim: "Yes.",
        byActor: "didi",
        recordedAt: t.clock.now(),
      });
      await store.closeGateRequest(requests[0]!.id, {
        status: "answered",
        decisionId: approval,
        at: t.clock.now(),
      });
      await cancels.step(t.idea.id);
      expect((await store.getNode(t.item.id))?.state).toBe("cancelled");
      expect((await store.getNode(t.idea.id))?.state).toBe("rejected");
    });

    it("records Didi's own cancel and opens the Council's question as the runner role", async () => {
      const t = await stopped("8f320000-0000-4000-8000", "cs-c", "didi");
      const other = await t.node("ready_for_dev", { title: "Another" });
      expect(
        await createStillNeeded(t.deps).askByDidi(other.id, "Still needed?"),
      ).toMatchObject({ opened: true });
      expect(
        await store.findOpenGateRequest(t.projectId, stillNeededTopic(other.id)),
      ).toMatchObject({ owner: "council", kind: "council_question", blocking: false });
      expect(
        await createCancels(t.deps).cancelByDidi(other.id, "Not needed."),
      ).toMatchObject({
        recorded: true,
      });
      expect((await store.getNode(other.id))?.state).toBe("cancelled");
      expect((await store.listDecisionsForNode(other.id)).at(-1)).toMatchObject({
        kind: "answer",
        byActor: "didi",
        scope: { kind: "cancel" },
      });
      // The question closed with the item.
      expect(
        await store.findOpenGateRequest(t.projectId, stillNeededTopic(other.id)),
      ).toBeNull();
    });
  },
);
