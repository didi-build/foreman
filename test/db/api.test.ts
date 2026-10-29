// Seam: API against the database (docs/test-plan.md, build plan M1.4). The state API on the real
// Postgres store, connected as the factory_api role, so ADR 0104's grants and row level security
// back up the API's own checks (ADR 0102, essentials 1 and 6).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { createPostgresStore } from "../../src/adapters/store-postgres/store.ts";
import { hashToken } from "../../src/api/auth.ts";
import { ENTRY_CONTRACTS } from "../../src/api/entry.ts";
import { createApiHandler } from "../../src/api/routes.ts";
import { createLibrary } from "../../src/core/library.ts";
import type { AgentRole, Store } from "../../src/core/store.ts";
import { createLogger } from "../../src/service-kit/logger.ts";
import { startService, type RunningService } from "../../src/service-kit/server.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const DB = `foreman_api_test_${process.pid}`;
const NOW = new Date("2026-10-29T12:00:00Z");
const HEAD = "c".repeat(40);
const PROJECT = "00000000-0000-4000-8000-0000000000b1";
const OTHER_PROJECT = "00000000-0000-4000-8000-0000000000b2";

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

describe.skipIf(!adminUrl)(
  "state API on Postgres as factory_api (database integration, M1.4)",
  () => {
    let runnerPool: pg.Pool;
    let apiPool: pg.Pool;
    let runner: Store;
    let service: RunningService;
    let base: string;
    const item = nextId();
    const foreignItem = nextId();
    const ciEvidence = nextId();

    async function issue(
      role: AgentRole,
      options: { nodeId?: string | null; projectId?: string; expiresAt?: Date } = {},
    ): Promise<string> {
      const runId = nextId();
      const token = `db-test-token-${runId.replaceAll("-", "")}`;
      const projectId = options.projectId ?? PROJECT;
      await runner.insertRun({
        id: runId,
        projectId,
        nodeId: options.nodeId ?? null,
        bot: role,
        agentId: null,
        runtime: "claude_code",
        model: "model-a",
        headSha: role === "qa" ? HEAD : null,
        botVersion: "v1",
        startedAt: NOW,
        endedAt: null,
        outcome: null,
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: {},
        parentRunId: null,
        transcriptRef: null,
      });
      await runner.insertRunToken({
        tokenHash: hashToken(token),
        runId,
        role,
        projectId,
        // Far enough ahead that the real clock in the API never passes it during the test.
        expiresAt: options.expiresAt ?? new Date("2099-01-01T00:00:00Z"),
        revokedAt: null,
      });
      return token;
    }

    async function call(method: string, path: string, token: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
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
      for (const [id, slug] of [
        [PROJECT, "rehearsal"],
        [OTHER_PROJECT, "elsewhere"],
      ] as const) {
        await runner.insertProject({
          id,
          slug,
          name: slug,
          repo: `didi-build/${slug}`,
          linearProjectId: null,
          galleryPathOverride: null,
          privilegedPathsExtra: [],
          prodRequiresApproval: false,
          stagingUrl: null,
          createdAt: NOW,
        });
      }
      for (const [id, projectId] of [
        [item, PROJECT],
        [foreignItem, OTHER_PROJECT],
      ] as const) {
        await runner.insertNode({
          id,
          projectId,
          type: "work_item",
          track: "code",
          state: "in_qa_review",
          substate: null,
          ownerRole: "qa",
          title: "An item",
          body: {},
          hold: false,
          agentReady: true,
          stale: false,
          blockedReason: null,
          stateSince: NOW,
          linearIssueId: null,
          linearStatusSynced: null,
          version: 0,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      await runner.insertEvidence({
        id: ciEvidence,
        nodeId: item,
        runId: null,
        kind: "ci_run",
        ref: "ci/1",
        commitSha: HEAD,
        payload: { conclusion: "success" },
        recordedBy: "runner",
        recordedAt: NOW,
        supersedesId: null,
      });

      const store = createPostgresStore(apiPool);
      const clock = { now: () => new Date() };
      const library = createLibrary({
        store,
        contracts: ENTRY_CONTRACTS,
        guards: {},
        clock,
        ids: { next: nextId },
      });
      service = await startService({
        name: "state-api-db-test",
        port: 0,
        logger: createLogger("state-api-db-test", () => undefined),
        handle: createApiHandler({ store, library, clock }),
      });
      base = `http://127.0.0.1:${service.port}`;
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

    it("lets the Council submit an idea and record a decision with only the API's grants", async () => {
      const token = await issue("council");
      expect((await call("POST", "/ideas", token, { title: "An idea" })).status).toBe(
        201,
      );
      expect(
        (
          await call("POST", "/decisions", token, {
            kind: "council_decision",
            text: "Go",
          })
        ).status,
      ).toBe(201);
      expect((await call("GET", "/attention", token)).status).toBe(200);
    });

    it("lets a Developer report on its node, and stores the report without a commit", async () => {
      const token = await issue("developer", { nodeId: item });
      const result = await call("POST", "/reports", token, {
        nodeId: item,
        kind: "agent_report",
        ref: "pr/1",
      });
      expect(result.status).toBe(201);
    });

    it("stores one QA verdict per run against the run's commit", async () => {
      const token = await issue("qa", { nodeId: item });
      const body = {
        nodeId: item,
        verdict: "pass",
        evidenceIds: [ciEvidence],
        findings: [],
      };
      const ok = await call("POST", "/qa-verdicts", token, body);
      expect(ok.status).toBe(201);
      expect(ok.body.commitSha).toBe(HEAD);
      expect((await call("POST", "/qa-verdicts", token, body)).status).toBe(409);
      const other = await issue("qa", { nodeId: item });
      expect(
        (
          await call("POST", "/qa-verdicts", other, {
            ...body,
            commitSha: "d".repeat(40),
          })
        ).status,
      ).toBe(422);
    });

    it("refuses an expired token and hides another project's node", async () => {
      const expired = await issue("council", {
        expiresAt: new Date("2026-01-01T00:00:00Z"),
      });
      expect((await call("GET", `/nodes/${item}`, expired)).status).toBe(401);
      const token = await issue("council");
      expect((await call("GET", `/nodes/${foreignItem}`, token)).status).toBe(404);
    });

    it("is backed by the database: factory_api cannot write a ci_run or move a node", async () => {
      await expect(
        apiPool.query(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at)
         values ($1, $2, 'ci_run', 'forged', $3, 'developer', now())`,
          [nextId(), item, HEAD],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        apiPool.query("update factory.nodes set state = 'done' where id = $1", [item]),
      ).rejects.toThrow(/permission denied/);
    });
  },
);
