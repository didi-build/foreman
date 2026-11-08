// Seam: GitHub ingestion against Postgres (build plan M2.3, ADR 0113, migration 0002). The core's
// ingestion functions on the real Postgres store, connected as the factory_ingest role, so the
// role's grants and row level security back up the core's rules: it writes only deliveries and
// ingested evidence kinds under a key, changes nothing, and a replay is a no-op. Migration 0020
// (O-101): it reads the kill switch and dry run and no other setting, so capture's due check runs
// as this role before the receiver starts the option capture flow. The advance and staging checks
// run as this role too (O-104), with no new grant: the one read they could need beyond it, a
// decision on a design head QA already reported on, is refused, so the check fails closed.
// Migration 0021 (O-111): it also records CI's preview check, under its key.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkCompletedEvent,
  pullRequestEvent,
} from "../../src/adapters/github/fake.ts";
import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import {
  ciRunKey,
  ingestDelivery,
  mergeCommitKey,
  pollRepository,
  type IngestDeps,
} from "../../src/core/github-ingest.ts";
import { createAdvances } from "../../src/core/advances.ts";
import { GUARDS } from "../../src/core/guards/index.ts";
import {
  createCaptureReads,
  optionScreenshotRef,
} from "../../src/core/option-capture.ts";
import {
  PREVIEW_CHECK_JOB,
  PREVIEW_CHECK_WORKFLOW,
  PREVIEW_CHECK_WORKFLOW_FILE,
  previewCheckKey,
} from "../../src/core/preview-check.ts";
import { createStagingReads } from "../../src/core/staging.ts";
import { testRouteColumns } from "../../src/core/routing-testing.ts";
import { REHEARSAL_RUN_LIMITS } from "../../src/core/runs.ts";
import type { Evidence, Json, Node, Store } from "../../src/core/store.ts";
import {
  BRANCH,
  MERGE_SHA,
  PR,
  REPO,
  SHA_A,
  createIngestFixture,
  passing,
  type IngestFixture,
} from "../github-fixture.ts";
import { machines } from "../reconcile-fixture.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_ingest_test_${process.pid}`;

describe.skipIf(!adminUrl)(
  "GitHub ingestion on Postgres as factory_ingest (database integration, M2.3)",
  () => {
    let runnerPool: pg.Pool;
    let ingestPool: pg.Pool;
    let apiPool: pg.Pool;
    let runner: Store;
    let ingest: Store;
    let f: IngestFixture;
    let deps: IngestDeps;

    /** A ci_run row the ingest role may write, apart from what the test changes. */
    const ciRun = (overrides: Partial<Evidence> = {}): Evidence => ({
      id: deps.ids.next(),
      nodeId: f.nodeId,
      runId: null,
      kind: "ci_run",
      ref: "github:test",
      commitSha: SHA_A,
      payload: { conclusion: "pending", pr: PR },
      recordedBy: "github",
      recordedAt: deps.clock.now(),
      supersedesId: null,
      ...overrides,
    });

    async function refused(pool: pg.Pool, sql: string, pattern: RegExp): Promise<void> {
      await expect(pool.query(sql)).rejects.toThrow(pattern);
    }

    beforeAll(async () => {
      const url = createTestDatabase(DB);
      const owner = new pg.Pool({ connectionString: url, max: 1 });
      await applyMigrations(owner, readMigrations());
      await owner.end();
      const as = (role: string) =>
        new pg.Pool({ connectionString: url, max: 4, options: `-c role=${role}` });
      runnerPool = as("factory_runner");
      ingestPool = as("factory_ingest");
      apiPool = as("factory_api");
      runner = createPostgresStore(runnerPool);
      ingest = createPostgresStore(ingestPool);
      // The runner sets up the project, node and dispatch record; ingestion runs as its own role.
      f = await createIngestFixture({ store: runner });
      deps = { ...f.deps, store: ingest };
    });

    afterAll(async () => {
      await Promise.all([runnerPool?.end(), ingestPool?.end(), apiPool?.end()]);
      dropTestDatabase(DB);
    });

    it("runs as the factory_ingest role", async () => {
      const who = await ingestPool.query("select current_user as u");
      expect(who.rows[0].u).toBe("factory_ingest");
    });

    it("finds a node by its latest dispatch record's repository and branch", async () => {
      expect(await ingest.listDispatches({ repo: REPO, branch: BRANCH })).toEqual([
        { nodeId: f.nodeId, repo: REPO, branch: BRANCH },
      ]);
      expect(await ingest.listDispatches({ repo: REPO, branch: "other" })).toEqual([]);
      expect(await ingest.listDispatches({ repo: "didi-build/elsewhere" })).toEqual([]);
    });

    it("records one evidence row and one delivery when a delivery is replayed", async () => {
      const payload = pullRequestEvent("opened", await f.pr());
      const delivery = { id: "db-delivery-1", event: "pull_request", payload };
      expect((await ingestDelivery(deps, delivery)).outcome).toBe("recorded");
      expect((await ingestDelivery(deps, delivery)).outcome).toBe("duplicate");
      expect(await f.evidence("ci_run")).toHaveLength(1);
      expect(await runner.getGithubDelivery("db-delivery-1")).toMatchObject({
        eventType: "pull_request",
        repository: REPO,
        outcome: "recorded",
      });
      const rows = await runnerPool.query(
        "select count(*)::int as n from factory.github_deliveries where delivery_id = 'db-delivery-1'",
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("lets exactly one of two racing copies of a delivery record anything", async () => {
      const finished = passing("build");
      f.github.setCheckRuns(REPO, SHA_A, finished);
      const delivery = {
        id: "db-delivery-race",
        event: "check_suite",
        payload: checkCompletedEvent("check_suite", REPO, SHA_A, [PR]),
      };
      const outcomes = await Promise.all([
        ingestDelivery(deps, delivery),
        ingestDelivery(deps, delivery),
      ]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(["duplicate", "recorded"]);
      expect((await f.evidence("ci_run")).map((e) => e.ref)).toEqual([
        ciRunKey(REPO, PR, SHA_A, "pending"),
        ciRunKey(REPO, PR, SHA_A, "success", finished[0]!.id),
      ]);
    });

    it("adds nothing on a polling pass after the webhooks, then records the merge", async () => {
      await pollRepository(deps, REPO);
      expect(await f.evidence()).toHaveLength(2);
      f.github.merge(REPO, PR, MERGE_SHA);
      await pollRepository(deps, REPO);
      await pollRepository(deps, REPO);
      const merges = await f.evidence("merge_commit");
      expect(merges.map((e) => [e.ref, e.commitSha])).toEqual([
        [mergeCommitKey(REPO, PR), MERGE_SHA],
      ]);
    });

    it("treats a second insert under the same ingest key as a no-op", async () => {
      const key = "github:ci_run:db-test#1:key";
      expect(await ingest.insertEvidenceOnce(ciRun(), key)).toBe(true);
      expect(await ingest.insertEvidenceOnce(ciRun(), key)).toBe(false);
      const rows = await runnerPool.query(
        "select count(*)::int as n from factory.evidence where ingest_key = $1",
        [key],
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("cannot write any other evidence kind, evidence without a key, or evidence for a run", async () => {
      await expect(
        ingest.insertEvidenceOnce(
          ciRun({ kind: "docs_note", commitSha: null, payload: { impact: "none" } }),
          "github:docs",
        ),
      ).rejects.toThrow(/row-level security|evidence_ingest_key_kinds/);
      await expect(
        ingest.insertEvidenceOnce(
          ciRun({ kind: "qa_verdict", payload: {} }),
          "github:qa",
        ),
      ).rejects.toThrow(
        /row-level security|evidence_ingest_key_kinds|check constraint/,
      );
      for (const kind of ["preview_check", "staging_check", "agent_report"] as const) {
        await expect(
          ingest.insertEvidence(ciRun({ kind, payload: {} })),
        ).rejects.toThrow(/row-level security/);
      }
      await expect(ingest.insertEvidence(ciRun())).rejects.toThrow(
        /row-level security/,
      );
    });

    it("cannot update or delete evidence or deliveries", async () => {
      await refused(
        ingestPool,
        "update factory.evidence set ref = ref",
        /permission denied/,
      );
      await refused(ingestPool, "delete from factory.evidence", /permission denied/);
      await refused(
        ingestPool,
        "update factory.github_deliveries set reason = reason",
        /permission denied/,
      );
      await refused(
        ingestPool,
        "delete from factory.github_deliveries",
        /permission denied/,
      );
      await refused(
        ingestPool,
        "truncate factory.github_deliveries",
        /permission denied/,
      );
      // The owner cannot either: the table is append-only.
      await refused(
        runnerPool,
        "update factory.github_deliveries set reason = reason",
        /append-only|permission denied/,
      );
    });

    it("cannot move a node, write decisions or transitions, or read what it does not need", async () => {
      await refused(
        ingestPool,
        "update factory.nodes set hold = true",
        /permission denied/,
      );
      await refused(
        ingestPool,
        `insert into factory.decisions (id, project_id, kind, text_verbatim, by_actor, recorded_at)
         values ('${deps.ids.next()}', '${f.projectId}', 'approval', 'yes', 'didi', now())`,
        /permission denied/,
      );
      await refused(
        ingestPool,
        `insert into factory.transitions (id, node_id, from_state, to_state, trigger_kind, actor_kind,
           actor_id, guard_result, spec_version, mode, at)
         values ('${deps.ids.next()}', '${f.nodeId}', 'a', 'b', 'event', 'runner', 'x', '[]', 'v', 'applied', now())`,
        /permission denied/,
      );
      for (const table of [
        "github_deliveries",
        "projects",
        "settings_log",
        "gate_requests",
        "decisions",
        "run_tokens",
      ]) {
        await refused(
          ingestPool,
          `select * from factory.${table}`,
          /permission denied/,
        );
      }
    });

    it("reads the kill switch and dry run and no other setting, and changes none (migration 0020)", async () => {
      const visible = await ingestPool.query(
        "select key, value from factory.settings order by key",
      );
      expect(visible.rows).toEqual([
        { key: "dry_run", value: true },
        { key: "kill_switch", value: false },
      ]);
      expect(await ingest.getSetting("reconcile_interval_minutes")).toBeNull();
      await refused(
        ingestPool,
        "update factory.settings set value = 'false' where key = 'dry_run'",
        /permission denied/,
      );
      await refused(
        ingestPool,
        `insert into factory.settings (key, value, updated_by, updated_at)
         values ('kill_switch_extra', 'true', 'github', now())`,
        /permission denied/,
      );
      await refused(ingestPool, "delete from factory.settings", /permission denied/);
    });

    it("runs capture's due check as factory_ingest, reading only what the role may read (O-101)", async () => {
      const at = deps.clock.now();
      const nodeId = deps.ids.next();
      await runner.insertNode({
        id: nodeId,
        projectId: f.projectId,
        type: "work_item",
        track: "design",
        state: "in_design_exploration",
        substate: null,
        ownerRole: "designer",
        title: "A design item",
        body: {},
        hold: false,
        agentReady: true,
        stale: false,
        blockedReason: null,
        stateSince: at,
        linearIssueId: null,
        linearStatusSynced: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      });
      await runner.insertRun({
        id: deps.ids.next(),
        projectId: f.projectId,
        nodeId,
        bot: "designer",
        agentId: null,
        runtime: "opencode",
        model: "claude-sonnet-5-5",
        headSha: null,
        prNumber: null,
        botVersion: "v1",
        startedAt: at,
        endedAt: deps.clock.now(),
        outcome: "success",
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: { ...REHEARSAL_RUN_LIMITS.designer },
        parentRunId: null,
        transcriptRef: null,
        usageExhaustedCause: null,
        retryAfterSeconds: null,
        questionTopic: null,
        ...testRouteColumns("designer"),
      });
      const head = "d".repeat(40);
      await ingest.insertEvidenceOnce(
        ciRun({ nodeId, commitSha: head, payload: { conclusion: "success", pr: 8 } }),
        ciRunKey(REPO, 8, head, "success", 1),
      );
      const reads = createCaptureReads(machines());
      // Dry run is seeded on (0001), so nothing is due until it is turned off.
      expect(await reads.due(ingest, nodeId)).toEqual({
        due: false,
        reason: "dry_run",
      });
      const set = (key: string, value: boolean) =>
        runner.setSetting({
          key,
          value,
          updatedBy: "test",
          updatedAt: deps.clock.now(),
        });
      await set("dry_run", false);
      try {
        expect(await reads.due(ingest, nodeId)).toEqual({ due: true, headSha: head });
        await set("kill_switch", true);
        expect(await reads.due(ingest, nodeId)).toEqual({
          due: false,
          reason: "kill_switch",
        });
        await set("kill_switch", false);
        await runner.insertEvidence({
          id: deps.ids.next(),
          nodeId,
          runId: null,
          kind: "screenshot",
          ref: optionScreenshotRef(head, "a"),
          commitSha: head,
          payload: {},
          recordedBy: "runner",
          recordedAt: deps.clock.now(),
          supersedesId: null,
        });
        expect(await reads.due(ingest, nodeId)).toEqual({
          due: false,
          reason: "already_captured",
        });
      } finally {
        await set("dry_run", true);
      }
    });

    it("runs the advance and staging checks as factory_ingest with no new grant, and a decision read fails closed (O-104)", async () => {
      const at = deps.clock.now();
      const node = async (state: string, extra: Partial<Node> = {}): Promise<Node> => {
        const created: Node = {
          id: deps.ids.next(),
          projectId: f.projectId,
          type: "work_item",
          track: "code",
          state,
          substate: null,
          ownerRole: "developer",
          title: `An item in ${state}`,
          body: {},
          hold: false,
          agentReady: true,
          stale: false,
          blockedReason: null,
          stateSince: at,
          linearIssueId: null,
          linearStatusSynced: null,
          version: 0,
          createdAt: at,
          updatedAt: at,
          ...extra,
        };
        await runner.insertNode(created);
        return created;
      };
      const runnerEvidence = (
        nodeId: string,
        kind: Evidence["kind"],
        payload: Json,
        commitSha: string | null = null,
      ) =>
        runner.insertEvidence({
          id: deps.ids.next(),
          nodeId,
          runId: null,
          kind,
          ref: `${kind}/test`,
          commitSha,
          payload,
          recordedBy: "runner",
          recordedAt: deps.clock.now(),
          supersedesId: null,
        });
      const head = "e".repeat(40);
      // A code item In development with CI green on its head and the Developer's docs note.
      const code = await node("in_development");
      await ingest.insertEvidenceOnce(
        ciRun({
          nodeId: code.id,
          commitSha: head,
          payload: { conclusion: "success", pr: 31, changedPaths: [] },
        }),
        ciRunKey(REPO, 31, head, "success", 1),
      );
      await runnerEvidence(code.id, "docs_note", { impact: "none" }, head);
      // An item of the repository in Verifying on staging.
      const merged = await node("verifying_on_staging");
      await runnerEvidence(merged.id, "dispatch_record", {
        repo: REPO,
        branch: "foreman/merged",
      });
      // A design item back in Building components on a head QA passed, whose PR still carries
      // an option folder: the guard asks which option Didi approved.
      const design = await node("building_components", {
        track: "design",
        ownerRole: "designer",
      });
      await ingest.insertEvidenceOnce(
        ciRun({
          nodeId: design.id,
          commitSha: head,
          payload: {
            conclusion: "success",
            pr: 32,
            changedPaths: ["design/gallery/button/options/a/index.html"],
          },
        }),
        ciRunKey(REPO, 32, head, "success", 2),
      );
      await runner.insertRun({
        id: deps.ids.next(),
        projectId: f.projectId,
        nodeId: design.id,
        bot: "qa",
        agentId: null,
        runtime: "messages_api",
        model: "claude-opus-5-5",
        headSha: head,
        prNumber: 32,
        botVersion: "v1",
        startedAt: at,
        endedAt: deps.clock.now(),
        outcome: "success",
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: { ...REHEARSAL_RUN_LIMITS.qa },
        parentRunId: null,
        transcriptRef: null,
        usageExhaustedCause: null,
        retryAfterSeconds: null,
        questionTopic: null,
        ...testRouteColumns("qa"),
      });

      const advances = createAdvances({
        ...deps,
        contracts: machines(),
        guards: GUARDS,
      });
      const staging = createStagingReads(machines());
      const deploy = {
        repo: REPO,
        sha: MERGE_SHA,
        environment: "staging",
        state: "success" as const,
      };
      // Dry run is seeded on (0001): nothing is due until it is off.
      expect(await advances.due(code.id)).toMatchObject({
        due: false,
        reason: "dry_run",
      });
      expect(await staging.due(ingest, deploy)).toEqual({
        due: false,
        reason: "dry_run",
      });
      const set = (key: string, value: boolean) =>
        runner.setSetting({
          key,
          value,
          updatedBy: "test",
          updatedAt: deps.clock.now(),
        });
      await set("dry_run", false);
      try {
        expect(await advances.due(code.id)).toEqual({
          due: true,
          nodeId: code.id,
          toState: "in_qa_review",
        });
        expect(await staging.due(ingest, deploy)).toEqual({
          due: true,
          repo: REPO,
          sha: MERGE_SHA,
        });
        expect(await advances.due(merged.id)).toMatchObject({
          due: false,
          reason: "no_advance_move",
        });
        // The role cannot read decisions, and no grant is added: the check throws, and the
        // receiver starts nothing (src/github-receiver/flow-starts.ts).
        await expect(advances.due(design.id)).rejects.toThrow(/permission denied/);
        await set("kill_switch", true);
        expect(await advances.due(code.id)).toMatchObject({ reason: "kill_switch" });
        expect(await staging.due(ingest, deploy)).toMatchObject({
          reason: "kill_switch",
        });
      } finally {
        await set("kill_switch", false);
        await set("dry_run", true);
      }
    });

    it("keeps ingest keys on ingested kinds only, so no other writer can take one first", async () => {
      await refused(
        apiPool,
        `insert into factory.evidence (id, node_id, kind, ref, payload, recorded_by, recorded_at, ingest_key)
         values ('${deps.ids.next()}', '${f.nodeId}', 'docs_note', 'x', '{}', 'developer', now(),
                 '${ciRunKey(REPO, PR, "d".repeat(40), "success", 1)}')`,
        /evidence_ingest_key_kinds/,
      );
      await refused(
        runnerPool,
        `insert into factory.evidence (id, node_id, kind, ref, payload, recorded_by, recorded_at, ingest_key)
         values ('${deps.ids.next()}', '${f.nodeId}', 'agent_report', 'x', '{}', 'runner', now(), 'k')`,
        /evidence_ingest_key_kinds/,
      );
    });

    it("records CI's preview check as factory_ingest, once from the webhook and the poll (migration 0021, O-111)", async () => {
      const branch = "foreman/preview-check";
      const sha = "f".repeat(40);
      const number = 41;
      const nodeId = await f.dispatchNode(branch);
      f.github.putPullRequest({
        repo: REPO,
        number,
        state: "open",
        merged: false,
        mergeCommitSha: null,
        headSha: sha,
        headBranch: branch,
        headRepo: REPO,
        author: (await f.pr()).author,
      });
      f.github.setChangedPaths(REPO, number, []);
      f.github.setCheckRuns(REPO, sha, passing("check", PREVIEW_CHECK_JOB));
      f.github.setWorkflowRuns(REPO, PREVIEW_CHECK_WORKFLOW_FILE, sha, [
        {
          id: 701,
          path: PREVIEW_CHECK_WORKFLOW,
          event: "pull_request",
          headSha: sha,
          headRepo: REPO,
        },
      ]);
      f.github.setWorkflowJobs(REPO, 701, [
        {
          id: 7001,
          runId: 701,
          name: PREVIEW_CHECK_JOB,
          headSha: sha,
          status: "completed",
          conclusion: "success",
        },
      ]);
      const delivery = {
        id: "db-delivery-preview",
        event: "check_suite",
        payload: checkCompletedEvent("check_suite", REPO, sha, [number]),
      };
      expect((await ingestDelivery(deps, delivery)).outcome).toBe("recorded");
      await pollRepository(deps, REPO);
      const rows = await runner.listEvidence({ nodeId, kind: "preview_check" });
      expect(rows.map((e) => [e.commitSha, e.payload, e.recordedBy])).toEqual([
        [
          sha,
          {
            pass: true,
            conclusion: "success",
            pr: number,
            workflowRunId: 701,
            jobId: 7001,
          },
          "github",
        ],
      ]);
      const keys = await runnerPool.query(
        "select ingest_key from factory.evidence where id = $1",
        [rows[0]!.id],
      );
      expect(keys.rows[0].ingest_key).toBe(
        previewCheckKey(REPO, number, sha, {
          pass: true,
          conclusion: "success",
          workflowRunId: 701,
          jobId: 7001,
        }),
      );
    });
  },
);
