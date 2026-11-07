// Seam: database integration (docs/test-plan.md, O-88). Option capture on the real Postgres
// store, as the factory_runner role: the role may record the option screenshots and open,
// supersede and list the visual-approval requests, and two captures of the same head that race
// open one request, since the item's row is locked before the check. A refusal the Designer
// caused records its `failure_count` row under its once-per-head key and adds one to `failure`,
// and a repeat on the head adds nothing (O-89). Synthetic images in a fake screenshot port; no
// network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { visualApprovalTopic } from "../../src/core/guards/design.ts";
import { captureRefusalKey } from "../../src/core/failures.ts";
import { createOptionCaptures } from "../../src/core/option-capture.ts";
import type { Store } from "../../src/core/store.ts";
import { createReconcileFixture, HEAD } from "../reconcile-fixture.ts";
import { setupCapture } from "../option-capture-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_option_capture_test_${process.pid}`;
const NEXT = "d".repeat(40);

describe.skipIf(!adminUrl)(
  "option capture on Postgres (database integration, O-88)",
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
      const c = await setupCapture(f);
      const captures = createOptionCaptures({
        ...f.deps,
        screenshots: c.screenshots,
      });
      const gates = () =>
        store.listGateRequests(f.projectId, visualApprovalTopic(c.nodeId));
      const shots = () => store.listEvidence({ nodeId: c.nodeId, kind: "screenshot" });
      return { f, c, captures, gates, shots };
    }

    it("records the screenshots and opens one request when two captures of the same head race", async () => {
      const t = await setup("8f200000-0000-4000-8000", "capture-a");
      const steps = await Promise.all([
        t.captures.capture(t.c.nodeId),
        t.captures.capture(t.c.nodeId),
      ]);
      expect(steps.map((s) => s.step).sort()).toEqual(["already_captured", "opened"]);
      expect(await t.gates()).toMatchObject([
        {
          kind: "visual_approval",
          owner: "didi",
          status: "open",
          payload: { options: ["a", "b"], captureCommitSha: HEAD },
        },
      ]);
      expect((await t.shots()).map((e) => [e.commitSha, e.recordedBy])).toEqual([
        [HEAD, "runner"],
        [HEAD, "runner"],
      ]);
    });

    it("counts a refusal the Designer caused once per head, as factory_runner (O-89)", async () => {
      const f = await createReconcileFixture({
        store,
        idPrefix: "8f400000-0000-4000-8000",
        slug: "capture-c",
      });
      await f.setting("dry_run", false);
      const c = await setupCapture(f, { names: ["a"] });
      const captures = createOptionCaptures({
        ...f.deps,
        screenshots: c.screenshots,
      });
      const steps = await Promise.all([
        captures.capture(c.nodeId),
        captures.capture(c.nodeId),
      ]);
      expect(
        steps
          .map((s) => (s.step === "refused" ? s.failureCount?.counted : null))
          .sort(),
      ).toEqual(["already_counted", true]);
      expect(await store.getCounter(c.nodeId, "failure")).toBe(1);
      expect(
        (await store.listEvidence({ nodeId: c.nodeId, kind: "failure_count" })).map(
          (e) => [e.ref, e.commitSha, e.runId],
        ),
      ).toEqual([
        [captureRefusalKey(c.nodeId, HEAD, c.designerRun.id), HEAD, c.designerRun.id],
      ]);
    });

    it("supersedes the older open request for a newer head", async () => {
      const t = await setup("8f300000-0000-4000-8000", "capture-b");
      await t.captures.capture(t.c.nodeId);
      t.f.advanceMinutes(5);
      await t.c.ciAt(NEXT, ["a", "b"]);
      t.c.putOptions(["a", "b"], { sha: NEXT });
      expect(await t.captures.capture(t.c.nodeId)).toMatchObject({ step: "opened" });
      const all = await t.gates();
      expect(all.map((g) => g.status)).toEqual(["superseded", "open"]);
      expect(all[0]?.supersededBy).toBe(all[1]?.id);
      expect(await t.shots()).toHaveLength(4);
    });
  },
);
