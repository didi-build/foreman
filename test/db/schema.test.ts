// Seam: database integration (docs/test-plan.md, ADR 0104). Applies db/migrations/ to an empty
// Postgres and checks the constraints the store relies on. Needs TEST_DATABASE_URL, a connection
// with the right to create databases; .github/workflows/db.yml provides one and sets
// FOREMAN_REQUIRE_DB=1 so the tests cannot be skipped there.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseModelEvalSettings } from "../../src/core/model-eval.ts";
import { runCostUsd } from "../../src/core/run-cost.ts";
import { chooseRoute, parseModelCatalog, runPriceOf } from "../../src/core/routing.ts";
import {
  CLOSE_ROUTES_POLICY,
  DEEPINFRA_MODEL_CATALOG,
  DEEPINFRA_ROUTING_POLICY,
  DEEPSEEK_FLASH,
  DEEPSEEK_FLASH_ENTRY,
  DEEPSEEK_PRO,
  DEEPSEEK_PRO_MODEL_CATALOG,
  deepSeekProRunPrice,
  FIRST_MODEL_CATALOG,
  FIRST_ROUTING_POLICY,
  KIMI,
  KIMI_ENTRY,
  QWEN_CODER,
  qwenCoderRunPrice,
  SEEDED_MODEL_CATALOG,
  SEEDED_MODEL_EVAL,
  SEEDED_OUTPUT_TOKEN_NEEDS,
  SEEDED_ROUTING_POLICY,
  seededRunPrice,
  SONNET_CACHE_MODEL_CATALOG,
} from "../../src/core/routing-testing.ts";
import type { AgentRole, Json } from "../../src/core/store.ts";
import {
  adminUrl,
  createTestDatabase,
  dbRequired,
  dropTestDatabase,
} from "./database.ts";

const dbName = `foreman_schema_test_${process.pid}`;
let testUrl = "";

interface Result {
  ok: boolean;
  out: string;
  err: string;
}

function psql(url: string, sql: string, role?: string): Result {
  const script = role ? `set role ${role};\n${sql}` : sql;
  const run = spawnSync(
    "psql",
    [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"],
    { input: script, encoding: "utf8" },
  );
  return { ok: run.status === 0, out: run.stdout.trim(), err: run.stderr };
}

const sql = (text: string, role?: string): Result => psql(testUrl, text, role);

function expectRejected(result: Result, pattern: RegExp): void {
  expect(result.ok, `expected a rejection, got: ${result.out}`).toBe(false);
  expect(result.err).toMatch(pattern);
}

const ID = {
  project: "00000000-0000-4000-8000-000000000001",
  node: "00000000-0000-4000-8000-000000000002",
  node2: "00000000-0000-4000-8000-000000000003",
  run: "00000000-0000-4000-8000-000000000004",
  transition: "00000000-0000-4000-8000-000000000005",
  evidence: "00000000-0000-4000-8000-000000000006",
  decision: "00000000-0000-4000-8000-000000000007",
  decision2: "00000000-0000-4000-8000-000000000008",
  event: "00000000-0000-4000-8000-000000000009",
  record: "00000000-0000-4000-8000-00000000000a",
  outcome: "00000000-0000-4000-8000-00000000000b",
  scan: "00000000-0000-4000-8000-00000000000c",
  evalJob: "00000000-0000-4000-8000-00000000000d",
  evalResult: "00000000-0000-4000-8000-00000000000e",
};
const SHA = "a".repeat(40);
const AT = "'2026-10-29T00:00:00Z'";

/** The route columns every run carries (migration 0005), and a valid route for them. */
const ROUTE_COLUMNS =
  "task_type, provider, model_family, service_tier_requested, routing_policy_version, model_catalog_version";
const ROUTE_VALUES = "'qa:review', 'anthropic', 'claude', 'standard', 'p.1', 'c.1'";

const FIXTURES = `
insert into factory.projects (id, slug, name, repo, created_at)
  values ('${ID.project}', 'rehearsal', 'Rehearsal', 'didi-build/rehearsal', ${AT});
insert into factory.nodes (id, project_id, type, track, state, owner_role, title, state_since, created_at, updated_at)
  values ('${ID.node}', '${ID.project}', 'work_item', 'code', 'ready_for_dev', 'developer', 'Item', ${AT}, ${AT}, ${AT}),
         ('${ID.node2}', '${ID.project}', 'idea', null, 'submitted', 'council', 'Idea', ${AT}, ${AT}, ${AT});
insert into factory.spec_versions (version, content_hash, loaded_at) values ('${SHA}', 'h', ${AT});
insert into factory.transitions (id, node_id, from_state, to_state, trigger_kind, actor_kind, actor_id, guard_result, spec_version, mode, at)
  values ('${ID.transition}', '${ID.node}', 'triage', 'ready_for_dev', 'reconcile', 'runner', 'runner', '[]', '${SHA}', 'applied', ${AT});
insert into factory.runs (id, project_id, node_id, bot, runtime, model, head_sha, bot_version, started_at, budget,
    ${ROUTE_COLUMNS})
  values ('${ID.run}', '${ID.project}', '${ID.node}', 'qa', 'claude_code', 'model-a', '${SHA}', 'v1', ${AT}, '{}',
    ${ROUTE_VALUES});
insert into factory.evidence (id, node_id, run_id, kind, ref, commit_sha, recorded_by, recorded_at)
  values ('${ID.evidence}', '${ID.node}', null, 'ci_run', 'run/1', '${SHA}', 'runner', ${AT});
insert into factory.decisions (id, project_id, kind, text_verbatim, by_actor, recorded_at)
  values ('${ID.decision}', '${ID.project}', 'answer', 'yes', 'didi', ${AT}),
         ('${ID.decision2}', '${ID.project}', 'answer', 'no', 'didi', ${AT});
insert into factory.decision_events (id, decision_id, kind, by_decision_id, recorded_by, recorded_at)
  values ('${ID.event}', '${ID.decision}', 'superseded', '${ID.decision2}', 'runner', ${AT});
insert into factory.decision_point_records (id, project_id, decision_point, decider_id, input_hash, output, confidence, recorded_at)
  values ('${ID.record}', '${ID.project}', 'triage_track', 'rule-v1', '${"b".repeat(64)}', '{"track": "code"}', 0.9, ${AT});
insert into factory.decision_point_outcomes (id, record_id, outcome, recorded_by, recorded_at)
  values ('${ID.outcome}', '${ID.record}', '{"correct": true}', 'runner', ${AT});
insert into factory.github_deliveries (delivery_id, event_type, repository, received_at, outcome, reason)
  values ('delivery-1', 'pull_request', 'didi-build/rehearsal', ${AT}, 'ignored', 'fixture');
insert into factory.scans (id, project_id, commit_sha, outcome, summary, recorded_by, recorded_at)
  values ('${ID.scan}', '${ID.project}', '${SHA}', 'scanned', '{}', 'runner:scanner', ${AT});
insert into factory.model_eval_jobs (id, week_start, started_at, deadline_at, baseline, cap_usd,
    spent_before_usd, plan, recorded_by, ended_at, outcome, spent_usd)
  values ('${ID.evalJob}', '2026-10-25', ${AT}, '2026-10-29T12:00:00Z', false, 10, 0,
    '[{"model": "m"}]', 'runner:weekly-model-test', '2026-10-29T13:00:00Z', 'finished', 0.1);
insert into factory.model_eval_results (id, job_id, seq, case_id, case_version, role, model,
    provider, tier, baseline, outcome, reason, turns, tokens, cost_usd, minutes, facts,
    recorded_by, recorded_at)
  values ('${ID.evalResult}', '${ID.evalJob}', 1, 'qa-truncate-pass', 1, 'qa', 'm', 'deepinfra',
    'flex', false, 'correct', 'as_expected', 3, '{}', 0.1, 1.5,
    '{"verdict": "pass", "findingPaths": []}', 'runner:weekly-model-test', ${AT});
`;

const APPEND_ONLY = [
  "spec_versions",
  "transitions",
  "evidence",
  "decisions",
  "decision_events",
  "decision_point_records",
  "decision_point_outcomes",
  "settings_log",
  "github_deliveries",
  "scans",
  "model_eval_results",
];

describe("database integration (test environment guard)", () => {
  it("has a database when the CI database job requires one", () => {
    expect(!dbRequired || Boolean(adminUrl)).toBe(true);
  });
});

describe.skipIf(!adminUrl)(
  "state store schema (database integration, ADR 0104)",
  () => {
    beforeAll(() => {
      testUrl = createTestDatabase(dbName);
      const dir = "db/migrations";
      for (const file of readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        const applied = sql(readFileSync(join(dir, file), "utf8"));
        expect(applied.ok, `${file}: ${applied.err}`).toBe(true);
      }
      const fixtures = sql(FIXTURES, "factory_runner");
      expect(fixtures.ok, fixtures.err).toBe(true);
    });

    afterAll(() => dropTestDatabase(dbName));

    it("creates every table in the factory schema, with row level security on", () => {
      const tables = sql(
        "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'factory' and not rowsecurity;",
      );
      expect(tables.ok, tables.err).toBe(true);
      expect(tables.out).toBe("");
      const count = sql("select count(*) from pg_tables where schemaname = 'factory';");
      // 0017 adds factory.scans (O-92), and 0027 the weekly model test's two tables (O-156).
      expect(Number(count.out)).toBe(21);
    });

    /** A time column each append-only table has, for an UPDATE that touches every row. */
    const timeColumn = (table: string): string =>
      ({
        spec_versions: "loaded_at",
        transitions: "at",
        settings_log: "changed_at",
        github_deliveries: "received_at",
      })[table] ?? "recorded_at";

    it.each(APPEND_ONLY)(
      "never changes or removes a row in %s, even for the owner",
      (table) => {
        const column = timeColumn(table);
        expectRejected(
          sql(`update factory.${table} set ${column} = ${column};`),
          /append-only/,
        );
        expectRejected(sql(`delete from factory.${table};`), /append-only/);
        expectRejected(sql(`truncate factory.${table} cascade;`), /append-only/);
      },
    );

    it.each(APPEND_ONLY)(
      "rejects UPDATE, DELETE and TRUNCATE on %s for the runner role",
      (table) => {
        const column = timeColumn(table);
        expectRejected(
          sql(`update factory.${table} set ${column} = ${column};`, "factory_runner"),
          /permission denied|append-only/,
        );
        expectRejected(
          sql(`delete from factory.${table};`, "factory_runner"),
          /permission denied|append-only/,
        );
        expectRejected(
          sql(`truncate factory.${table};`, "factory_runner"),
          /permission denied|append-only/,
        );
      },
    );

    it("rejects an UPDATE of a transition with a real column change", () => {
      expectRejected(
        sql(
          `update factory.transitions set to_state = 'done' where id = '${ID.transition}';`,
          "factory_runner",
        ),
        /permission denied|append-only/,
      );
      expectRejected(
        sql(
          `update factory.transitions set to_state = 'done' where id = '${ID.transition}';`,
        ),
        /append-only/,
      );
    });

    it("gives no role DELETE on mutable tables", () => {
      expectRejected(
        sql(`delete from factory.nodes where id = '${ID.node2}';`, "factory_runner"),
        /permission denied/,
      );
      expectRejected(sql("delete from factory.settings;"), /append-only/);
    });

    it("logs every settings change", () => {
      const changed = sql(
        `update factory.settings set value = 'true', updated_by = 'didi', updated_at = ${AT} where key = 'kill_switch';
       select new_value::text || '|' || old_value::text || '|' || changed_by from factory.settings_log where key = 'kill_switch' order by id desc limit 1;`,
        "factory_runner",
      );
      expect(changed.ok, changed.err).toBe(true);
      expect(changed.out).toBe("true|false|didi");
    });

    it("seeds the loop interval from D-164 and the Windmill alert from D-167, with the Team plan's limit (D-369)", () => {
      const values = sql(
        "select string_agg(key || '=' || value::text, ',' order by key) from factory.settings where key in ('reconcile_interval_minutes', 'windmill_monthly_execution_limit', 'windmill_alert_percent');",
      );
      expect(values.out).toBe(
        "reconcile_interval_minutes=120,windmill_alert_percent=80,windmill_monthly_execution_limit=10000",
      );
      // 0022 changed 0001's seed, and the change is logged like any other.
      expect(
        sql(
          "select string_agg(coalesce(old_value::text, '-') || '>' || new_value::text || ' by ' || changed_by, ',' order by id) from factory.settings_log where key = 'windmill_monthly_execution_limit';",
        ).out,
      ).toBe("->1000 by migration,1000>10000 by migration");
    });

    it("moves only the seeded execution limit to the Team plan's, never one Didi set (migration 0022, D-369)", () => {
      const TEAM_PLAN = "db/migrations/0022_windmill_team_plan.sql";
      const limit = (): string =>
        sql(
          "select value::text from factory.settings where key = 'windmill_monthly_execution_limit';",
        ).out;
      const set = (value: string, by: string) =>
        sql(
          `update factory.settings set value = '${value}'::jsonb, updated_by = '${by}', updated_at = ${AT} where key = 'windmill_monthly_execution_limit';`,
        );
      try {
        expect(set("5000", "didi").ok).toBe(true);
        const kept = sql(readFileSync(TEAM_PLAN, "utf8"));
        expect(kept.ok, kept.err).toBe(true);
        expect(limit()).toBe("5000");
        expect(set("1000", "didi").ok).toBe(true);
        const moved = sql(readFileSync(TEAM_PLAN, "utf8"));
        expect(moved.ok, moved.err).toBe(true);
        expect(limit()).toBe("10000");
      } finally {
        expect(set("10000", "migration").ok).toBe(true);
      }
    });

    const ROUTING_KEYS =
      "'model_routing_policy', 'model_catalog', 'model_providers_approved', 'model_output_token_needs'";
    /** The four routing settings as the store holds them. */
    const settings = (): Record<string, Json> => {
      const read = sql(
        `select json_object_agg(key, value) from factory.settings where key in (${ROUTING_KEYS});`,
      );
      expect(read.ok, read.err).toBe(true);
      return JSON.parse(read.out) as Record<string, Json>;
    };
    /** The route the stored settings give, or `policy` in place of the stored policy. */
    const route = (role: AgentRole, taskType: string, policy?: Json) => {
      const s = settings();
      return chooseRoute({
        role,
        taskType,
        earlierRuns: [],
        settings: {
          policy: policy ?? s.model_routing_policy ?? null,
          catalog: s.model_catalog ?? null,
          providers: s.model_providers_approved ?? null,
          outputNeeds: s.model_output_token_needs ?? null,
        },
      });
    };
    /** Each migration change of a setting, as `old version>new version`, oldest first. */
    const versionsLogged = (key: string): string =>
      sql(
        `select string_agg((old_value ->> 'version') || '>' || (new_value ->> 'version'), ',' order by id) from factory.settings_log where key = '${key}' and changed_by = 'migration' and old_value is not null;`,
      ).out;
    /** Sets a routing setting by hand, as an operator would. */
    const setByHand = (key: string, value: Json) => {
      const done = sql(
        `update factory.settings set value = '${JSON.stringify(value)}'::jsonb, updated_by = 'didi', updated_at = ${AT} where key = '${key}';`,
      );
      expect(done.ok, done.err).toBe(true);
    };

    describe("the close runs' routes (migration 0019, D-318, D-324)", () => {
      const CLOSE_ROUTES = "db/migrations/0019_close_routes.sql";
      const logged = (): string =>
        sql(
          "select count(*) from factory.settings_log where key in ('model_routing_policy', 'model_output_token_needs');",
        ).out;

      it("gives both close task types their role's own route, logged, under a new policy version", () => {
        // The policy as 0019 wrote it, from its log row. 0024 has since moved the roles' own task
        // types to DeepInfra (D-421) and left the close task types as 0019 made them.
        const written = sql(
          "select new_value from factory.settings_log where key = 'model_routing_policy' and changed_by = 'migration' and new_value ->> 'version' = '2026-11-04.1';",
        );
        expect(written.ok, written.err).toBe(true);
        const policy0019 = JSON.parse(written.out) as Json;
        for (const [role, closeType, own] of [
          ["developer", "developer:close", "developer:code"],
          ["designer", "designer:close", "designer"],
        ] as const) {
          const close = route(role, closeType, policy0019);
          const theirs = route(role, own, policy0019);
          if (!close.routed || !theirs.routed) throw new Error("no route");
          expect(close.route).toEqual({ ...theirs.route, taskType: closeType });
          expect(close.route.policyVersion).toBe("2026-11-04.1");
          // Today's policy routes the close task type the same way.
          const today = route(role, closeType);
          if (!today.routed) throw new Error("no route");
          expect(today.route).toEqual({
            ...close.route,
            policyVersion: SEEDED_ROUTING_POLICY.version,
          });
        }
        const s = settings();
        expect(s.model_routing_policy).toEqual(SEEDED_ROUTING_POLICY);
        expect(s.model_output_token_needs).toEqual(SEEDED_OUTPUT_TOKEN_NEEDS);
        // 0019's change, then 0024's, then 0026's.
        expect(versionsLogged("model_routing_policy")).toBe(
          "2026-10-31.1>2026-11-04.1,2026-11-04.1>2026-11-18.1,2026-11-18.1>2026-11-18.2",
        );
      });

      it("changes nothing when it runs again", () => {
        const before = settings();
        const count = logged();
        const again = sql(readFileSync(CLOSE_ROUTES, "utf8"));
        expect(again.ok, again.err).toBe(true);
        expect(settings()).toEqual(before);
        expect(logged()).toBe(count);
      });

      it("never replaces an entry an operator set, and adds only what is missing", () => {
        const before = settings();
        const own = {
          candidates: [
            { provider: "anthropic", model: "claude-opus-5-5", tier: "standard" },
          ],
          onCapacity: "wait",
        };
        const changed = sql(
          `update factory.settings
             set value = jsonb_set(value #- '{taskTypes,designer:close}', '{taskTypes,developer:close}', '${JSON.stringify(own)}'::jsonb)
                         || '{"version": "operator.1"}'::jsonb,
                 updated_by = 'didi', updated_at = ${AT}
             where key = 'model_routing_policy';
           update factory.settings set value = value || '{"developer:close": 8000}'::jsonb,
                 updated_by = 'didi', updated_at = ${AT}
             where key = 'model_output_token_needs';`,
        );
        expect(changed.ok, changed.err).toBe(true);
        const migrated = sql(readFileSync(CLOSE_ROUTES, "utf8"));
        expect(migrated.ok, migrated.err).toBe(true);
        const policy = settings().model_routing_policy as {
          version: string;
          taskTypes: Record<string, Json>;
        };
        expect(policy.taskTypes["developer:close"]).toEqual(own);
        expect(policy.taskTypes["designer:close"]).toEqual(policy.taskTypes.designer);
        expect(policy.version).toBe("operator.1+d324");
        expect(settings().model_output_token_needs).toMatchObject({
          "developer:close": 8000,
          "designer:close": 16000,
        });
        // Back to the migrated values for the rest of the file.
        const restored = sql(
          `update factory.settings set value = '${JSON.stringify(before.model_routing_policy)}'::jsonb where key = 'model_routing_policy';
           update factory.settings set value = '${JSON.stringify(before.model_output_token_needs)}'::jsonb where key = 'model_output_token_needs';`,
        );
        expect(restored.ok, restored.err).toBe(true);
      });
    });

    describe("the Developer and the Designer on Qwen3 Coder at DeepInfra Flex (migration 0024, D-421)", () => {
      const MOVE = "db/migrations/0024_developer_designer_deepinfra.sql";
      const logged = (): string =>
        sql(
          "select count(*) from factory.settings_log where key in ('model_routing_policy', 'model_catalog');",
        ).out;
      /** Runs the migration again; returns what psql printed on stderr (the NOTICEs). */
      const migrate = (): string => {
        const again = sql(readFileSync(MOVE, "utf8"));
        expect(again.ok, again.err).toBe(true);
        return again.err;
      };
      type Policy = { version: string; taskTypes: Record<string, Json> };
      type Catalog = { version: string; models: Record<string, Record<string, Json>> };
      const MOVED = ["developer:code", "developer:infra", "designer"] as const;

      it("routes the three task types to Qwen3 Coder at Flex, priced at Flex, logged under new versions", () => {
        for (const [role, taskType] of [
          ["developer", "developer:code"],
          ["developer", "developer:infra"],
          ["designer", "designer"],
        ] as const) {
          const choice = route(role, taskType);
          if (!choice.routed) throw new Error(JSON.stringify(choice.noRoute));
          expect(choice.route).toEqual({
            taskType,
            provider: "deepinfra",
            model: QWEN_CODER,
            family: "qwen",
            tier: "flex",
            failFast: false,
            onCapacity: "wait",
            // 0026 has since moved QA, the Council and Triage (D-425), and the policy's version.
            policyVersion: SEEDED_ROUTING_POLICY.version,
            // 0025 has since changed Sonnet's cache read price (O-150), 0026 added DeepSeek V4
            // Pro (D-425) and 0027 the weekly test's two models (D-429), each with the catalog's
            // version.
            catalogVersion: SEEDED_MODEL_CATALOG.version,
            price: qwenCoderRunPrice(),
          });
          // A million of each token served at Flex: 0.24 + 0.08 + 0.24 (a cache write at the
          // input rate, as DeepInfra lists no cache-write price) + 0.80.
          const million = {
            uncachedInput: 1_000_000,
            cachedInput: 1_000_000,
            cacheWriteInput: 1_000_000,
            output: 1_000_000,
          };
          expect(runCostUsd(choice.route.price, million, "flex")).toBe(1.36);
        }
        // The policy and catalog as 0024 wrote them, from their log rows. 0026 has since moved QA,
        // the Council and Triage to DeepInfra (D-425).
        const written = sql(
          "select json_build_object('policy', (select new_value from factory.settings_log where key = 'model_routing_policy' and changed_by = 'migration' and new_value ->> 'version' = '2026-11-18.1' order by id limit 1), 'catalog', (select new_value from factory.settings_log where key = 'model_catalog' and changed_by = 'migration' and new_value ->> 'version' = '2026-11-18.1' order by id limit 1));",
        );
        expect(written.ok, written.err).toBe(true);
        const by0024 = JSON.parse(written.out) as { policy: Policy; catalog: Catalog };
        expect(by0024.policy).toEqual(DEEPINFRA_ROUTING_POLICY);
        expect(by0024.catalog).toEqual(DEEPINFRA_MODEL_CATALOG);
        // The close runs never call the model (D-324); QA, the Council and Triage stayed on
        // Anthropic until the Messages API image could reach DeepInfra (D-342, D-400).
        for (const taskType of [
          "developer:close",
          "designer:close",
          "qa:review",
          "council",
          "triage",
        ] as const) {
          expect(by0024.policy.taskTypes[taskType]).toEqual(
            CLOSE_ROUTES_POLICY.taskTypes[taskType],
          );
        }
        const s = settings();
        expect(s.model_routing_policy).toEqual(SEEDED_ROUTING_POLICY);
        expect(s.model_catalog).toEqual(SEEDED_MODEL_CATALOG);
        // Unchanged: 16000 for each task type, below the model's cap of 16,384.
        expect(s.model_output_token_needs).toEqual(SEEDED_OUTPUT_TOKEN_NEEDS);
        // 0024's change, then 0025's, then 0026's, then 0027's.
        expect(versionsLogged("model_catalog")).toBe(
          "2026-10-31.1>2026-11-18.1,2026-11-18.1>2026-11-18.2,2026-11-18.2>2026-11-18.3,2026-11-18.3>2026-11-19.1",
        );
      });

      it("changes nothing when it runs again", () => {
        const before = settings();
        const count = logged();
        expect(migrate()).not.toContain("NOTICE");
        expect(settings()).toEqual(before);
        expect(logged()).toBe(count);
      });

      it("moves only the entries 0005 seeded, names the others, and keeps an operator's catalog entry", () => {
        const before = settings();
        const policy = before.model_routing_policy as Policy;
        const catalog = before.model_catalog as Catalog;
        const own = {
          candidates: [
            { provider: "anthropic", model: "claude-opus-5-5", tier: "standard" },
          ],
          onCapacity: "wait",
        };
        // developer:code is back to the entry 0005 seeded, designer is the operator's own, and
        // developer:infra was removed.
        const kept = Object.fromEntries(
          Object.entries(policy.taskTypes).filter(([t]) => t !== "developer:infra"),
        );
        const byHand = {
          ...policy,
          version: "operator.1",
          taskTypes: {
            ...kept,
            "developer:code": FIRST_ROUTING_POLICY.taskTypes["developer:code"],
            designer: own,
          },
        };
        const qwen = catalog.models[QWEN_CODER] ?? {};
        const ownCatalog = {
          version: "operator.cat",
          models: {
            ...catalog.models,
            [QWEN_CODER]: {
              ...qwen,
              pricePerMTok: {
                standard: { input: 0.5, cachedInput: 0.2, output: 2 },
                flex: { input: 0.4, cachedInput: 0.16, output: 1.6 },
              },
            },
          },
        };
        try {
          setByHand("model_routing_policy", byHand);
          setByHand("model_catalog", ownCatalog);
          const notices = migrate();
          expect(settings().model_catalog).toEqual(ownCatalog);
          expect(settings().model_routing_policy).toEqual({
            ...byHand,
            version: "operator.1+d421",
            taskTypes: {
              ...byHand.taskTypes,
              "developer:code": SEEDED_ROUTING_POLICY.taskTypes["developer:code"],
            },
          });
          expect(notices).toContain("model_routing_policy.taskTypes.developer:infra");
          expect(notices).toContain("model_routing_policy.taskTypes.designer");
          expect(notices).not.toContain("developer:code");
        } finally {
          setByHand("model_routing_policy", before.model_routing_policy ?? null);
          setByHand("model_catalog", before.model_catalog ?? null);
        }
      });

      it("moves no task type while the catalog does not list the model under DeepInfra", () => {
        const before = settings();
        const policy = before.model_routing_policy as Policy;
        const catalog = before.model_catalog as Catalog;
        const seeded = Object.fromEntries(
          MOVED.map((t) => [t, FIRST_ROUTING_POLICY.taskTypes[t]]),
        );
        const onSeeded = { ...policy, taskTypes: { ...policy.taskTypes, ...seeded } };
        const elsewhere = {
          ...catalog,
          models: {
            ...catalog.models,
            [QWEN_CODER]: { ...(catalog.models[QWEN_CODER] ?? {}), provider: "other" },
          },
        };
        try {
          setByHand("model_routing_policy", onSeeded);
          setByHand("model_catalog", elsewhere);
          expect(migrate()).toContain("0024 moved no task type");
          expect(settings().model_routing_policy).toEqual(onSeeded);
          expect(settings().model_catalog).toEqual(elsewhere);
        } finally {
          setByHand("model_routing_policy", before.model_routing_policy ?? null);
          setByHand("model_catalog", before.model_catalog ?? null);
        }
      });
    });

    describe("Claude Sonnet 5.5's cache read price at 0.10 (migration 0025, O-150)", () => {
      const PRICE = "db/migrations/0025_sonnet_cache_read_price.sql";
      const SONNET = "claude-sonnet-5-5";
      const logged = (): string =>
        sql("select count(*) from factory.settings_log where key = 'model_catalog';")
          .out;
      const setCatalog = (value: Json) => {
        const done = sql(
          `update factory.settings set value = '${JSON.stringify(value)}'::jsonb, updated_by = 'didi', updated_at = ${AT} where key = 'model_catalog';`,
        );
        expect(done.ok, done.err).toBe(true);
      };
      const migrate = (): string => {
        const again = sql(readFileSync(PRICE, "utf8"));
        expect(again.ok, again.err).toBe(true);
        return again.err;
      };
      type Catalog = { version: string; models: Record<string, Record<string, Json>> };
      /** The catalog with Sonnet's cache read price set to `cachedInput`, under `version`. */
      const withSonnetCache = (
        catalog: Catalog,
        cachedInput: number,
        version: string,
      ) => {
        const sonnet = catalog.models[SONNET] ?? {};
        const prices = sonnet.pricePerMTok as { standard: Record<string, number> };
        return {
          ...catalog,
          version,
          models: {
            ...catalog.models,
            [SONNET]: {
              ...sonnet,
              pricePerMTok: { standard: { ...prices.standard, cachedInput } },
            },
          },
        };
      };

      it("sets the price where 0005 seeded 0.2, changes nothing else but the version, and is logged", () => {
        const written = sql(
          "select json_build_object('old', old_value, 'new', new_value) from factory.settings_log where key = 'model_catalog' and changed_by = 'migration' and new_value ->> 'version' = '2026-11-18.2';",
        );
        expect(written.ok, written.err).toBe(true);
        const change = JSON.parse(written.out) as { old: Catalog; new: Catalog };
        expect(change.old).toEqual(DEEPINFRA_MODEL_CATALOG);
        expect(change.new).toEqual(withSonnetCache(change.old, 0.1, "2026-11-18.2"));
        expect(change.new).toEqual(SONNET_CACHE_MODEL_CATALOG);
        // 0026 has since added DeepSeek V4 Pro (D-425) and left Sonnet's entry as 0025 set it.
        expect((settings().model_catalog as Catalog).models[SONNET]).toEqual(
          SONNET_CACHE_MODEL_CATALOG.models[SONNET],
        );
        // Opus 5.5 keeps its list price (docs/costs.md section 2): 4, 0.20 cached, 20.
        expect(SEEDED_MODEL_CATALOG.models["claude-opus-5-5"]).toEqual(
          FIRST_MODEL_CATALOG.models["claude-opus-5-5"],
        );
        // A close run is still routed to Sonnet, at the new price. The Council was too until 0026
        // moved it to DeepSeek V4 Pro (D-425).
        const close = route("developer", "developer:close");
        if (!close.routed) throw new Error(JSON.stringify(close.noRoute));
        expect(close.route).toMatchObject({
          model: SONNET,
          catalogVersion: SEEDED_MODEL_CATALOG.version,
          price: seededRunPrice(SONNET),
        });
        expect(close.route.price.pricePerMTok.standard?.cachedInput).toBe(0.1);
      });

      it("changes nothing when it runs again", () => {
        const before = settings();
        const count = logged();
        expect(migrate()).not.toContain("NOTICE");
        expect(settings()).toEqual(before);
        expect(logged()).toBe(count);
      });

      it("keeps an operator's own price with a NOTICE, and names its own version", () => {
        const before = settings().model_catalog as Catalog;
        try {
          const own = withSonnetCache(before, 0.15, "operator.cat");
          setCatalog(own);
          const notices = migrate();
          expect(notices).toContain("NOTICE");
          expect(notices).toContain("claude-sonnet-5-5");
          expect(settings().model_catalog).toEqual(own);
          // An operator's catalog that still has the seeded 0.2 is moved, its version marked.
          setCatalog(withSonnetCache(before, 0.2, "operator.cat"));
          expect(migrate()).not.toContain("NOTICE");
          expect(settings().model_catalog).toEqual(
            withSonnetCache(before, 0.1, "operator.cat+o150"),
          );
        } finally {
          setCatalog(before);
        }
      });

      it("names a catalog with no Sonnet entry and changes nothing", () => {
        const before = settings().model_catalog as Catalog;
        const withoutSonnet = {
          ...before,
          models: Object.fromEntries(
            Object.entries(before.models).filter(([model]) => model !== SONNET),
          ),
        };
        try {
          setCatalog(withoutSonnet);
          expect(migrate()).toContain("NOTICE");
          expect(settings().model_catalog).toEqual(withoutSonnet);
        } finally {
          setCatalog(before);
        }
      });
    });

    describe("QA, the Council and Triage on DeepSeek V4 Pro at DeepInfra Flex (migration 0026, D-425, O-153)", () => {
      const MOVE = "db/migrations/0026_qa_council_triage_deepinfra.sql";
      const logged = (): string =>
        sql(
          "select count(*) from factory.settings_log where key in ('model_routing_policy', 'model_catalog');",
        ).out;
      /** Runs the migration again; returns what psql printed on stderr (the NOTICEs). */
      const migrate = (): string => {
        const again = sql(readFileSync(MOVE, "utf8"));
        expect(again.ok, again.err).toBe(true);
        return again.err;
      };
      /**
       * The migration's change of `key`, from its log row: the value before and after. The first
       * row that wrote `version` is the migration's own; a test that later restores a value can
       * log the same version again.
       */
      const change = (key: string, version: string) => {
        const written = sql(
          `select json_build_object('old', old_value, 'new', new_value) from factory.settings_log where key = '${key}' and changed_by = 'migration' and new_value ->> 'version' = '${version}' order by id limit 1;`,
        );
        expect(written.ok, written.err).toBe(true);
        return JSON.parse(written.out) as { old: Json; new: Json };
      };
      type Policy = {
        version: string;
        qaIndependence: string;
        taskTypes: Record<string, Json>;
      };
      type Catalog = { version: string; models: Record<string, Record<string, Json>> };
      const MOVED = ["qa:review", "council", "triage"] as const;

      it("routes the three task types to DeepSeek V4 Pro at Flex, priced at Flex, logged under new versions", () => {
        for (const [role, taskType] of [
          ["qa", "qa:review"],
          ["council", "council"],
          ["triage", "triage"],
        ] as const) {
          const choice = route(role, taskType);
          if (!choice.routed) throw new Error(JSON.stringify(choice.noRoute));
          expect(choice.route).toEqual({
            taskType,
            provider: "deepinfra",
            model: DEEPSEEK_PRO,
            family: "deepseek",
            tier: "flex",
            failFast: false,
            onCapacity: "wait",
            policyVersion: "2026-11-18.2",
            catalogVersion: SEEDED_MODEL_CATALOG.version,
            price: deepSeekProRunPrice(),
          });
          // A million of each token served at Flex: 1.04 + 0.08 + 1.04 (a cache write at the
          // input rate, as DeepInfra lists no cache-write price) + 2.08.
          const million = {
            uncachedInput: 1_000_000,
            cachedInput: 1_000_000,
            cacheWriteInput: 1_000_000,
            output: 1_000_000,
          };
          expect(runCostUsd(choice.route.price, million, "flex")).toBe(4.24);
        }
        const s = settings();
        const policy = s.model_routing_policy as Policy;
        // Every other entry is as 0024 left it: the Developer and the Designer on Qwen3 Coder, the
        // close task types on Anthropic. The visual task types still have no route, and QA
        // independence is still by model id (D-209).
        for (const [taskType, entry] of Object.entries(
          DEEPINFRA_ROUTING_POLICY.taskTypes,
        )) {
          if (!(MOVED as readonly string[]).includes(taskType)) {
            expect(policy.taskTypes[taskType]).toEqual(entry);
          }
        }
        expect(policy.taskTypes["qa:visual"]).toBeUndefined();
        expect(policy.taskTypes["council:visual"]).toBeUndefined();
        expect(policy.qaIndependence).toBe("model_id");
        expect(s.model_routing_policy).toEqual(SEEDED_ROUTING_POLICY);
        expect(s.model_catalog).toEqual(SEEDED_MODEL_CATALOG);
        // Unchanged: 16000 for each task type, below the model's cap of 16,384.
        expect(s.model_output_token_needs).toEqual(SEEDED_OUTPUT_TOKEN_NEEDS);
        // Both changes logged, each from the value the migration before left.
        expect(change("model_routing_policy", "2026-11-18.2")).toEqual({
          old: DEEPINFRA_ROUTING_POLICY,
          new: SEEDED_ROUTING_POLICY,
        });
        expect(change("model_catalog", "2026-11-18.3")).toEqual({
          old: SONNET_CACHE_MODEL_CATALOG,
          new: DEEPSEEK_PRO_MODEL_CATALOG,
        });
      });

      it("routes QA after a Qwen3 Coder Developer run to DeepSeek V4 Pro: another model id and family", () => {
        const s = settings();
        const choice = chooseRoute({
          role: "qa",
          taskType: "qa:review",
          earlierRuns: [{ bot: "developer", model: QWEN_CODER, modelFamily: "qwen" }],
          settings: {
            policy: s.model_routing_policy ?? null,
            catalog: s.model_catalog ?? null,
            providers: s.model_providers_approved ?? null,
            outputNeeds: s.model_output_token_needs ?? null,
          },
        });
        if (!choice.routed) throw new Error(JSON.stringify(choice.noRoute));
        expect(choice.route).toMatchObject({ model: DEEPSEEK_PRO, family: "deepseek" });
      });

      it("changes nothing when it runs again", () => {
        const before = settings();
        const count = logged();
        expect(migrate()).not.toContain("NOTICE");
        expect(settings()).toEqual(before);
        expect(logged()).toBe(count);
      });

      it("moves only the entries 0005 seeded, names the others, and keeps an operator's catalog entry", () => {
        const before = settings();
        const policy = before.model_routing_policy as Policy;
        const catalog = before.model_catalog as Catalog;
        const own = {
          candidates: [
            { provider: "anthropic", model: "claude-opus-5-5", tier: "standard" },
          ],
          onCapacity: "wait",
        };
        // qa:review is back to the entry 0005 seeded, council is the operator's own, and triage
        // was removed.
        const kept = Object.fromEntries(
          Object.entries(policy.taskTypes).filter(([t]) => t !== "triage"),
        );
        const byHand = {
          ...policy,
          version: "operator.1",
          taskTypes: {
            ...kept,
            "qa:review": FIRST_ROUTING_POLICY.taskTypes["qa:review"],
            council: own,
          },
        };
        const deepseek = catalog.models[DEEPSEEK_PRO] ?? {};
        const ownCatalog = {
          version: "operator.cat",
          models: {
            ...catalog.models,
            [DEEPSEEK_PRO]: {
              ...deepseek,
              pricePerMTok: {
                standard: { input: 2, cachedInput: 0.2, output: 4 },
                flex: { input: 1.6, cachedInput: 0.16, output: 3.2 },
              },
            },
          },
        };
        try {
          setByHand("model_routing_policy", byHand);
          setByHand("model_catalog", ownCatalog);
          const notices = migrate();
          expect(settings().model_catalog).toEqual(ownCatalog);
          expect(settings().model_routing_policy).toEqual({
            ...byHand,
            version: "operator.1+d425",
            taskTypes: {
              ...byHand.taskTypes,
              "qa:review": SEEDED_ROUTING_POLICY.taskTypes["qa:review"],
            },
          });
          expect(notices).toContain("model_routing_policy.taskTypes.council");
          expect(notices).toContain("model_routing_policy.taskTypes.triage");
          expect(notices).not.toContain("qa:review");
        } finally {
          setByHand("model_routing_policy", before.model_routing_policy ?? null);
          setByHand("model_catalog", before.model_catalog ?? null);
        }
      });

      it("adds the entry to a catalog without it under the catalog's own version, marked", () => {
        const before = settings();
        const catalog = before.model_catalog as Catalog;
        const withoutDeepSeek = {
          version: "operator.cat",
          models: Object.fromEntries(
            Object.entries(catalog.models).filter(([model]) => model !== DEEPSEEK_PRO),
          ),
        };
        try {
          setByHand("model_catalog", withoutDeepSeek);
          expect(migrate()).not.toContain("NOTICE");
          expect(settings().model_catalog).toEqual({
            version: "operator.cat+d425",
            models: {
              ...withoutDeepSeek.models,
              [DEEPSEEK_PRO]: catalog.models[DEEPSEEK_PRO],
            },
          });
          // The policy already routes the three task types there, so it is left as it is.
          expect(settings().model_routing_policy).toEqual(before.model_routing_policy);
        } finally {
          setByHand("model_catalog", before.model_catalog ?? null);
        }
      });

      it("moves no task type while the catalog does not list the model under DeepInfra", () => {
        const before = settings();
        const policy = before.model_routing_policy as Policy;
        const catalog = before.model_catalog as Catalog;
        const seeded = Object.fromEntries(
          MOVED.map((t) => [t, FIRST_ROUTING_POLICY.taskTypes[t]]),
        );
        const onSeeded = { ...policy, taskTypes: { ...policy.taskTypes, ...seeded } };
        const elsewhere = {
          ...catalog,
          models: {
            ...catalog.models,
            [DEEPSEEK_PRO]: {
              ...(catalog.models[DEEPSEEK_PRO] ?? {}),
              provider: "other",
            },
          },
        };
        try {
          setByHand("model_routing_policy", onSeeded);
          setByHand("model_catalog", elsewhere);
          expect(migrate()).toContain("0026 moved no task type");
          expect(settings().model_routing_policy).toEqual(onSeeded);
          expect(settings().model_catalog).toEqual(elsewhere);
        } finally {
          setByHand("model_routing_policy", before.model_routing_policy ?? null);
          setByHand("model_catalog", before.model_catalog ?? null);
        }
      });
    });

    describe("the weekly model test's records, setting and models (migration 0027, D-429, D-430, D-433, O-156)", () => {
      const EVAL = "db/migrations/0027_model_eval.sql";
      const JOB = "00000000-0000-4000-8000-0000000000e1";
      /** Runs the setting and catalog part again (the tables are made once, by the first run). */
      const migrate = (): string => {
        const text = readFileSync(EVAL, "utf8");
        const rest = text.slice(
          text.indexOf("-- The setting and the catalog entries."),
        );
        expect(rest).toMatch(/^-- The setting/);
        const again = sql(rest);
        expect(again.ok, again.err).toBe(true);
        return again.err;
      };
      const evalSetting = (): Json =>
        JSON.parse(
          sql("select value::text from factory.settings where key = 'model_eval';").out,
        ) as Json;
      const logged = (): string =>
        sql(
          "select count(*) from factory.settings_log where key in ('model_eval', 'model_catalog', 'model_routing_policy');",
        ).out;
      const insertJob = (id: string, week = "2026-11-22", end = "") =>
        sql(
          `insert into factory.model_eval_jobs (id, week_start, started_at, deadline_at, baseline,
             cap_usd, spent_before_usd, plan, recorded_by${end === "" ? "" : ", ended_at, outcome, reason"})
           values ('${id}', '${week}', '2026-11-22T07:17:00Z', '2026-11-22T20:00:00Z', true, 10, 0,
             '[{"model": "m"}]', 'runner:weekly-model-test'${end})`,
          "factory_runner",
        );
      const insertResult = (seq: number, fields: string, values: string) =>
        sql(
          `insert into factory.model_eval_results (id, job_id, seq, case_id, case_version, role,
             model, provider, tier, baseline, outcome, reason${fields}, turns, tokens, cost_usd,
             minutes, recorded_by, recorded_at)
           values (gen_random_uuid(), '${ID.evalJob}', ${seq}, 'qa-slugify-pass', 1, 'qa', 'm',
             'deepinfra', 'flex', false, ${values}, 2, '{}', 0.01, 1, 'runner', ${AT})`,
          "factory_runner",
        );

      it("lets the runner record a Job, end it once, and never change or delete anything else", () => {
        const made = insertJob(JOB);
        expect(made.ok, made.err).toBe(true);
        // One Job without an end at a time.
        expectRejected(
          insertJob("00000000-0000-4000-8000-0000000000e2"),
          /model_eval_jobs_one_open/,
        );
        expectRejected(
          sql(
            `update factory.model_eval_jobs set cap_usd = 20 where id = '${JOB}';`,
            "factory_runner",
          ),
          /permission denied/,
        );
        expectRejected(
          sql(
            `update factory.model_eval_jobs set ended_at = now(), outcome = 'finished' where id = '${JOB}';`,
            "factory_runner",
          ),
          /model_eval_jobs_check/,
        );
        const ended = sql(
          `update factory.model_eval_jobs set ended_at = '2026-11-23T07:17:00Z', outcome = 'finished', spent_usd = 0.31 where id = '${JOB}' and ended_at is null;`,
          "factory_runner",
        );
        expect(ended.ok, ended.err).toBe(true);
        expectRejected(
          sql(
            `delete from factory.model_eval_jobs where id = '${JOB}';`,
            "factory_runner",
          ),
          /permission denied|append-only/,
        );
        expectRejected(
          sql(`delete from factory.model_eval_jobs where id = '${JOB}';`),
          /append-only/,
        );
      });

      it("keeps a Job's week on a Sunday and a failed end's reason to the fixed codes", () => {
        expectRejected(
          insertJob("00000000-0000-4000-8000-0000000000e3", "2026-11-23"),
          /week_start/,
        );
        expectRejected(
          insertJob(
            "00000000-0000-4000-8000-0000000000e4",
            "2026-11-22",
            ", now(), 'failed', 'out_of_coffee'",
          ),
          /model_eval_jobs_reason_check/,
        );
        expectRejected(
          insertJob(
            "00000000-0000-4000-8000-0000000000e5",
            "2026-11-22",
            ", now(), 'failed', null",
          ),
          /model_eval_jobs_check/,
        );
        const failed = insertJob(
          "00000000-0000-4000-8000-0000000000e6",
          "2026-11-22",
          ", now(), 'failed', 'start_failed'",
        );
        expect(failed.ok, failed.err).toBe(true);
      });

      it("takes a result row only with facts for a usable answer, bounded, and a provider error only for one", () => {
        expectRejected(
          insertResult(2, "", "'correct', 'as_expected'"),
          /model_eval_results_check/,
        );
        expectRejected(
          insertResult(2, ", facts", "'error', 'max_turns', '{\"x\": 1}'"),
          /model_eval_results_check/,
        );
        expectRejected(
          insertResult(2, "", "'error', 'provider_error'"),
          /model_eval_results_check/,
        );
        expectRejected(
          insertResult(
            2,
            ", facts",
            `'wrong', 'wrong_verdict', '{"verdict": "pass", "findingPaths": ["${"a".repeat(2100)}"]}'`,
          ),
          /model_eval_results_facts_check/,
        );
        const ok = insertResult(
          2,
          ", provider_error",
          `'error', 'provider_error', '{"status": 429, "type": "rate_limit"}'`,
        );
        expect(ok.ok, ok.err).toBe(true);
        expectRejected(insertResult(2, "", "'skipped', 'cap_reached'"), /unique/);
      });

      it("gives the state API's and the receiver's roles no access", () => {
        for (const role of ["factory_api", "factory_ingest"]) {
          for (const table of ["model_eval_jobs", "model_eval_results"]) {
            expectRejected(
              sql(`select count(*) from factory.${table};`, role),
              /permission denied/,
            );
          }
        }
      });

      it("seeds the setting: the weekly cap, D-429's models and baseline, and the weekly test's own key paths", () => {
        expect(evalSetting()).toEqual(SEEDED_MODEL_EVAL);
        const problems: string[] = [];
        const read = parseModelEvalSettings(evalSetting(), problems);
        expect(problems).toEqual([]);
        expect(read?.capUsd).toBe(10);
        expect(read?.keyPaths).toEqual({
          deepinfra: "eval/models/deepinfra",
          anthropic: "eval/models/anthropic",
        });
      });

      it("adds the two models to the catalog at the prices read on 2026-11-19, under a new version, and routes nothing to them", () => {
        const s = settings();
        const catalog = s.model_catalog as {
          version: string;
          models: Record<string, Json>;
        };
        expect(catalog.version).toBe("2026-11-19.1");
        expect(catalog.models[DEEPSEEK_FLASH]).toEqual(DEEPSEEK_FLASH_ENTRY);
        expect(catalog.models[KIMI]).toEqual(KIMI_ENTRY);
        expect(s.model_catalog).toEqual(SEEDED_MODEL_CATALOG);
        // The routing policy is the one 0026 left: no task type is routed to either model.
        expect(s.model_routing_policy).toEqual(SEEDED_ROUTING_POLICY);
        expect(JSON.stringify(s.model_routing_policy)).not.toMatch(/Flash-1017|Kimi/);
        // Each prices a run at Flex from the catalog, as the weekly plan takes it.
        const problems: string[] = [];
        const parsed = parseModelCatalog(s.model_catalog, problems);
        expect(problems).toEqual([]);
        const million = {
          uncachedInput: 1_000_000,
          cachedInput: 1_000_000,
          cacheWriteInput: 0,
          output: 1_000_000,
        };
        const flash = parsed?.models[DEEPSEEK_FLASH];
        const kimi = parsed?.models[KIMI];
        if (!flash || !kimi) throw new Error("the catalog lacks a model");
        expect(runCostUsd(runPriceOf(flash), million, "flex")).toBe(0.6448);
        expect(runCostUsd(runPriceOf(kimi), million, "flex")).toBe(3.52);
      });

      it("changes nothing when it runs again", () => {
        const before = settings();
        const setting = evalSetting();
        const count = logged();
        expect(migrate()).not.toContain("NOTICE");
        expect(settings()).toEqual(before);
        expect(evalSetting()).toEqual(setting);
        expect(logged()).toBe(count);
      });

      it("keeps an operator's own setting and catalog entries, and marks another catalog version", () => {
        const before = settings();
        const catalog = before.model_catalog as {
          version: string;
          models: Record<string, Json>;
        };
        const ownSetting = { ...SEEDED_MODEL_EVAL, capUsd: 5 };
        const withoutFlash = {
          version: "operator.cat",
          models: Object.fromEntries(
            Object.entries(catalog.models).filter(([m]) => m !== DEEPSEEK_FLASH),
          ),
        };
        try {
          const set = sql(
            `update factory.settings set value = '${JSON.stringify(ownSetting)}'::jsonb, updated_by = 'didi', updated_at = ${AT} where key = 'model_eval';`,
          );
          expect(set.ok, set.err).toBe(true);
          setByHand("model_catalog", withoutFlash);
          migrate();
          expect(evalSetting()).toEqual(ownSetting);
          expect(settings().model_catalog).toEqual({
            version: "operator.cat+d429",
            models: { ...withoutFlash.models, [DEEPSEEK_FLASH]: DEEPSEEK_FLASH_ENTRY },
          });
          // Kimi was already there, the operator's own: it is left as it is.
          expect(
            (settings().model_catalog as { models: Record<string, Json> }).models[KIMI],
          ).toEqual(catalog.models[KIMI]);
        } finally {
          sql(
            `update factory.settings set value = '${JSON.stringify(SEEDED_MODEL_EVAL)}'::jsonb, updated_by = 'migration', updated_at = ${AT} where key = 'model_eval';`,
          );
          setByHand("model_catalog", before.model_catalog ?? null);
        }
      });
    });

    it("seeds the usage-exhausted wait (migration 0003) and the cluster run limit of two (migration 0023, D-372)", () => {
      const values = sql(
        "select string_agg(key || '=' || value::text, ',' order by key) from factory.settings where key in ('usage_exhausted_wait_minutes', 'agent_cluster_max_active_runs');",
      );
      expect(values.out).toBe(
        "agent_cluster_max_active_runs=2,usage_exhausted_wait_minutes=30",
      );
      const index = sql("select to_regclass('factory.runs_active') is not null;");
      expect(index.out).toBe("t");
    });

    it("never replaces a cluster run limit already set (migration 0023, D-372)", () => {
      const RUN_LIMIT = "db/migrations/0023_cluster_run_limit.sql";
      const limit = (): string =>
        sql(
          "select value::text from factory.settings where key = 'agent_cluster_max_active_runs';",
        ).out;
      const set = (value: string, by: string) =>
        sql(
          `update factory.settings set value = '${value}'::jsonb, updated_by = '${by}', updated_at = ${AT} where key = 'agent_cluster_max_active_runs';`,
        );
      try {
        expect(set("3", "didi").ok).toBe(true);
        const again = sql(readFileSync(RUN_LIMIT, "utf8"));
        expect(again.ok, again.err).toBe(true);
        expect(limit()).toBe("3");
      } finally {
        expect(set("2", "migration").ok).toBe(true);
      }
    });

    it("keeps a usage-exhausted cause and retry-after on usage_exhausted ends only", () => {
      const end = (fields: string) =>
        sql(
          `update factory.runs set ${fields} where id = '${ID.run}';`,
          "factory_runner",
        );
      const at = `ended_at = ${AT}`;
      expectRejected(
        end(`${at}, outcome = 'usage_exhausted'`),
        /runs_usage_exhausted_detail/,
      );
      expectRejected(
        end(`${at}, outcome = 'success', usage_exhausted_cause = 'rate_limit'`),
        /runs_usage_exhausted_detail/,
      );
      expectRejected(
        end("usage_exhausted_cause = 'rate_limit'"),
        /runs_usage_exhausted_detail/,
      );
      expectRejected(
        end(`${at}, outcome = 'fail', retry_after_seconds = 60`),
        /runs_usage_exhausted_detail/,
      );
      expectRejected(
        end(`${at}, outcome = 'usage_exhausted', usage_exhausted_cause = 'tired'`),
        /check constraint/,
      );
      expectRejected(end("pr_number = 0"), /check constraint/);
      const ok = sql(
        `update factory.runs set ${at}, outcome = 'usage_exhausted', usage_exhausted_cause = 'out_of_credit',
           retry_after_seconds = 120, pr_number = 7 where id = '${ID.run}' returning usage_exhausted_cause;`,
        "factory_runner",
      );
      expect(ok.ok, ok.err).toBe(true);
      expect(ok.out).toBe("out_of_credit");
    });

    it("requires a commit on evidence a head-commit guard reads", () => {
      expectRejected(
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, recorded_by, recorded_at)
         values (gen_random_uuid(), '${ID.node}', 'ci_run', 'run/2', 'runner', ${AT});`,
          "factory_runner",
        ),
        /check constraint/,
      );
    });

    it("allows merge_check evidence only with its commit (migration 0010)", () => {
      const check = (sha: string) =>
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, payload, recorded_by, recorded_at)
         values (gen_random_uuid(), '${ID.node}', 'merge_check', 'm', ${sha}, '{"pr": 7, "mergeable": true}', 'runner', ${AT});`,
          "factory_runner",
        );
      expectRejected(check("null"), /evidence_merge_check_commit/);
      const ok = check(`'${SHA}'`);
      expect(ok.ok, ok.err).toBe(true);
      expectRejected(
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at)
         values (gen_random_uuid(), '${ID.node}', 'merge_check', 'm', '${SHA}', 'developer', ${AT});`,
          "factory_api",
        ),
        /row-level security/,
      );
    });

    it("allows the staging kinds only with their commit, keyed by the runner and never by ingestion (migration 0011)", () => {
      for (const kind of ["staging_deploy", "staging_no_result"]) {
        const insert = (sha: string, key: string) =>
          sql(
            `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', '${kind}', 's', ${sha}, 'runner', ${AT}, ${key});`,
            "factory_runner",
          );
        expectRejected(insert("null", "null"), /evidence_staging_commit/);
        const ok = insert(`'${SHA}'`, `'runner:${kind}:1'`);
        expect(ok.ok, ok.err).toBe(true);
        expectRejected(insert(`'${SHA}'`, `'runner:${kind}:1'`), /unique/);
        expectRejected(
          sql(
            `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', '${kind}', 's', '${SHA}', 'github', ${AT}, 'github:${kind}:2');`,
            "factory_ingest",
          ),
          /row-level security/,
        );
      }
      const keyedCheck = sql(
        `insert into factory.evidence (id, node_id, kind, ref, commit_sha, payload, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', 'staging_check', 's', '${SHA}', '{"pass": true}', 'runner', ${AT}, 'runner:staging_check:1');`,
        "factory_runner",
      );
      expect(keyedCheck.ok, keyedCheck.err).toBe(true);
      expectRejected(
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', 'test_report', 's', '${SHA}', 'runner', ${AT}, 'runner:test_report:1');`,
          "factory_runner",
        ),
        /evidence_ingest_key_kinds/,
      );
    });

    it("lets ingestion record CI's preview check under a key, with its commit and no run, and nothing more (migration 0021)", () => {
      const preview = (role: string, key: string, sha = `'${SHA}'`, run = "null") =>
        sql(
          `insert into factory.evidence (id, node_id, run_id, kind, ref, commit_sha, payload, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', ${run}, 'preview_check', 'p', ${sha}, '{"pass": true}', 'github', ${AT}, ${key});`,
          role,
        );
      const ok = preview("factory_ingest", "'github:preview_check:0021:1'");
      expect(ok.ok, ok.err).toBe(true);
      expectRejected(
        preview("factory_ingest", "'github:preview_check:0021:1'"),
        /unique/,
      );
      expectRejected(preview("factory_ingest", "null"), /row-level security/);
      expectRejected(
        preview(
          "factory_ingest",
          "'github:preview_check:0021:2'",
          `'${SHA}'`,
          `'${ID.run}'`,
        ),
        /row-level security/,
      );
      expectRejected(
        preview("factory_ingest", "'github:preview_check:0021:3'", "null"),
        /check constraint/,
      );
      expectRejected(
        preview("factory_api", "'github:preview_check:0021:4'"),
        /row-level security/,
      );
      for (const kind of ["staging_check", "test_report", "qa_verdict"]) {
        expectRejected(
          sql(
            `insert into factory.evidence (id, node_id, kind, ref, commit_sha, payload, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', '${kind}', 'p', '${SHA}', '{}', 'github', ${AT}, 'github:${kind}:0021');`,
            "factory_ingest",
          ),
          /row-level security|evidence_ingest_key_kinds|check constraint/,
        );
      }
    });

    it("allows a failed staging deploy only with its commit, keyed by the runner and never by ingestion (migration 0012)", () => {
      const insert = (sha: string, key: string) =>
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', 'staging_deploy_failed', 's', ${sha}, 'runner', ${AT}, ${key});`,
          "factory_runner",
        );
      expectRejected(insert("null", "null"), /evidence_staging_commit/);
      const ok = insert(`'${SHA}'`, `'github:staging_deploy_failed:1'`);
      expect(ok.ok, ok.err).toBe(true);
      expectRejected(insert(`'${SHA}'`, `'github:staging_deploy_failed:1'`), /unique/);
      expectRejected(
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', 'staging_deploy_failed', 's', '${SHA}', 'github', ${AT}, 'github:staging_deploy_failed:2');`,
          "factory_ingest",
        ),
        /row-level security/,
      );
      // The 0011 kinds keep their rules.
      expectRejected(
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at)
         values (gen_random_uuid(), '${ID.node}', 'staging_deploy', 's', null, 'runner', ${AT});`,
          "factory_runner",
        ),
        /evidence_staging_commit/,
      );
    });

    it("allows a failure count only with its run, keyed by the runner and never by the API or ingestion (migration 0013)", () => {
      const insert = (runId: string, key: string) =>
        sql(
          `insert into factory.evidence (id, node_id, run_id, kind, ref, payload, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', ${runId}, 'failure_count', 'f', '{"cause": "report_refused"}', 'runner', ${AT}, ${key});`,
          "factory_runner",
        );
      expectRejected(
        insert("null", "'runner:failure_count:report_refused:run-0'"),
        /evidence_failure_count_run/,
      );
      const ok = insert(`'${ID.run}'`, "'runner:failure_count:report_refused:run-1'");
      expect(ok.ok, ok.err).toBe(true);
      expectRejected(
        insert(`'${ID.run}'`, "'runner:failure_count:report_refused:run-1'"),
        /unique/,
      );
      for (const role of ["factory_api", "factory_ingest"]) {
        expectRejected(
          sql(
            `insert into factory.evidence (id, node_id, run_id, kind, ref, recorded_by, recorded_at, ingest_key)
         values (gen_random_uuid(), '${ID.node}', '${ID.run}', 'failure_count', 'f', 'developer', ${AT}, 'runner:failure_count:x:${role}');`,
            role,
          ),
          /row-level security/,
        );
      }
    });

    it("keeps a question topic only on a Council run, in the topic key's shape (migration 0014, D-228)", () => {
      const insert = (bot: string, topic: string) =>
        sql(
          `insert into factory.runs (id, project_id, node_id, bot, runtime, model, bot_version, started_at, budget,
             ${ROUTE_COLUMNS}, question_topic)
           values (gen_random_uuid(), '${ID.project}', '${ID.node}', '${bot}', 'claude_api', 'model-a', 'v1', ${AT}, '{}',
             ${ROUTE_VALUES}, ${topic});`,
          "factory_runner",
        );
      const ok = insert("council", `'escalation:${ID.node}'`);
      expect(ok.ok, ok.err).toBe(true);
      const reversal = insert("council", `'decision-reversed:${ID.decision}'`);
      expect(reversal.ok, reversal.err).toBe(true);
      expect(insert("developer", "null").ok).toBe(true);
      expectRejected(
        insert("developer", `'escalation:${ID.node}'`),
        /runs_question_topic_council/,
      );
      expectRejected(
        insert("council", "'escalation:not an id'"),
        /question_topic_check/,
      );
    });

    it("seeds the staging deploy wait at one hour (migration 0012, D-225)", () => {
      const value = sql(
        "select value::text from factory.settings where key = 'staging_deploy_attention_after_minutes';",
      );
      expect(value.out).toBe("60");
    });

    it("allows one QA verdict per run, and only with a run", () => {
      const verdict = (id: string) =>
        `insert into factory.evidence (id, node_id, run_id, kind, ref, commit_sha, recorded_by, recorded_at)
       values (gen_random_uuid(), '${ID.node}', ${id}, 'qa_verdict', 'v', '${SHA}', 'qa', ${AT});`;
      expectRejected(sql(verdict("null"), "factory_runner"), /check constraint/);
      expectRejected(
        sql(verdict(`'${ID.run}'`) + verdict(`'${ID.run}'`), "factory_runner"),
        /evidence_one_verdict_per_run/,
      );
    });

    it("lets the API role write only agent evidence kinds (essential 6)", () => {
      const write = (kind: string, sha: string) =>
        sql(
          `insert into factory.evidence (id, node_id, kind, ref, commit_sha, recorded_by, recorded_at)
         values (gen_random_uuid(), '${ID.node}', '${kind}', 'x', ${sha}, 'developer', ${AT});`,
          "factory_api",
        );
      expectRejected(write("ci_run", `'${SHA}'`), /row-level security/);
      expectRejected(write("preview_check", `'${SHA}'`), /row-level security/);
      const ok = write("agent_report", "null");
      expect(ok.ok, ok.err).toBe(true);
    });

    it("does not let the API role move a node or read run budgets it has no grant for", () => {
      expectRejected(
        sql(
          `update factory.nodes set state = 'done' where id = '${ID.node}';`,
          "factory_api",
        ),
        /permission denied/,
      );
      expectRejected(
        sql(
          "insert into factory.transitions select * from factory.transitions limit 0;",
          "factory_api",
        ),
        /permission denied/,
      );
    });

    it("keeps one open gate request per topic", () => {
      const open = (id: string) =>
        `insert into factory.gate_requests (id, project_id, topic_key, kind, owner, blocking, status, created_at)
       values ('${id}', '${ID.project}', 'spend:windmill', 'spend', 'didi', true, 'open', ${AT});`;
      expectRejected(
        sql(
          open("00000000-0000-4000-8000-0000000000c1") +
            open("00000000-0000-4000-8000-0000000000c2"),
          "factory_runner",
        ),
        /gate_requests_one_open_per_topic/,
      );
    });

    it("lets a newer gate request supersede the open one, checking the reference at commit (migration 0016, O-88)", () => {
      const [older, newer] = [
        "00000000-0000-4000-8000-0000000000d1",
        "00000000-0000-4000-8000-0000000000d2",
      ];
      const open = (id: string) =>
        `insert into factory.gate_requests (id, project_id, topic_key, kind, owner, blocking, status, created_at)
       values ('${id}', '${ID.project}', 'scope:supersede', 'scope', 'didi', true, 'open', ${AT});`;
      const supersede = (by: string) =>
        `update factory.gate_requests set status = 'superseded', superseded_by = '${by}'
       where id = '${older}' and status = 'open';`;
      const first = sql(open(older), "factory_runner");
      expect(first.ok, first.err).toBe(true);
      // A reference to a request no transaction inserts still fails, at commit.
      expectRejected(
        sql(supersede("00000000-0000-4000-8000-0000000000d9"), "factory_runner"),
        /gate_requests_superseded_by_fkey/,
      );
      // The library's order: close the open one naming the newer, then insert the newer.
      const both = sql(supersede(newer) + open(newer), "factory_runner");
      expect(both.ok, both.err).toBe(true);
      const statuses = sql(
        `select string_agg(status, ',' order by id) from factory.gate_requests
       where topic_key = 'scope:supersede';`,
      );
      expect(statuses.out).toBe("superseded,open");
    });

    it("rejects self edges", () => {
      expectRejected(
        sql(
          `insert into factory.edges (id, from_node, to_node, type, created_at)
         values (gen_random_uuid(), '${ID.node}', '${ID.node}', 'blocks', ${AT});`,
          "factory_runner",
        ),
        /check constraint/,
      );
    });

    it("accepts the reworks edge type and refuses an unknown one (migration 0015, D-233)", () => {
      const insert = (type: string) =>
        sql(
          `insert into factory.edges (id, from_node, to_node, type, created_at)
         values (gen_random_uuid(), '${ID.node2}', '${ID.node}', '${type}', ${AT});`,
          "factory_runner",
        );
      const ok = insert("reworks");
      expect(ok.ok, ok.err).toBe(true);
      expectRejected(insert("undoes"), /edges_type_check/);
    });

    it("derives a decision's status from its events, and allows one event per decision", () => {
      const status = sql(
        `select status || '|' || replaced_by_id from factory.decisions_current where id = '${ID.decision}';`,
        "factory_api",
      );
      expect(status.ok, status.err).toBe(true);
      expect(status.out).toBe(`superseded|${ID.decision2}`);
      expectRejected(
        sql(
          `insert into factory.decision_events (id, decision_id, kind, recorded_by, recorded_at)
         values (gen_random_uuid(), '${ID.decision}', 'reversed', 'runner', ${AT});`,
          "factory_runner",
        ),
        /duplicate key/,
      );
    });

    it("gives Supabase's anon role no access to the factory schema", () => {
      expectRejected(sql("select * from factory.nodes;", "anon"), /permission denied/);
    });

    it("keeps decision-point confidence between 0 and 1", () => {
      expectRejected(
        sql(
          `insert into factory.decision_point_records (id, project_id, decision_point, decider_id, input_hash, output, confidence, recorded_at)
         values (gen_random_uuid(), '${ID.project}', 'severity', 'rule-v1', '${"c".repeat(64)}', '{}', 1.5, ${AT});`,
          "factory_runner",
        ),
        /check constraint/,
      );
    });

    it("keeps the route columns well formed: tiers, task type, and counts of at least 0 (migration 0005)", () => {
      const set = (fields: string) =>
        sql(
          `update factory.runs set ${fields} where id = '${ID.run}';`,
          "factory_runner",
        );
      for (const bad of [
        "service_tier_requested = 'turbo'",
        "service_tier_requested = null",
        "service_tier_served = 'cheap'",
        "task_type = 'Developer Code'",
        "provider = 'Anthropic Inc'",
        "model_family = ''",
        "routing_policy_version = ''",
        "model_catalog_version = null",
        "capacity_retries = -1",
        "capacity_wait_seconds = -1",
        "first_token_ms = -1",
        "reported_cost_usd = -0.01",
      ]) {
        expectRejected(set(bad), /check constraint|not-null constraint/);
      }
      const ok = sql(
        `update factory.runs set service_tier_requested = 'flex', service_tier_served = 'mixed', capacity_retries = 2,
           capacity_wait_seconds = 90, first_token_ms = 0, reported_cost_usd = 0.5 where id = '${ID.run}'
         returning service_tier_served;`,
        "factory_runner",
      );
      expect(ok.ok, ok.err).toBe(true);
      expect(ok.out).toBe("mixed");
    });

    it("refuses a run without a route (migration 0005)", () => {
      expectRejected(
        sql(
          `insert into factory.runs (id, project_id, bot, runtime, model, bot_version, started_at, budget)
           values (gen_random_uuid(), '${ID.project}', 'developer', 'claude_code', 'model-a', 'v1', ${AT}, '{}');`,
          "factory_runner",
        ),
        /not-null constraint/,
      );
    });
  },
);

describe.skipIf(!adminUrl)(
  "migration 0005 on a table that already holds runs (database integration, ADR 0114)",
  () => {
    const name = `foreman_route_migration_test_${process.pid}`;
    let url = "";
    beforeAll(() => {
      url = createTestDatabase(name);
    });
    afterAll(() => dropTestDatabase(name));

    it("stops with a named reason and changes nothing, rather than inventing routes", () => {
      const dir = "db/migrations";
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const route = files.indexOf("0005_run_route.sql");
      expect(route).toBeGreaterThan(0);
      for (const file of files.slice(0, route)) {
        const applied = psql(url, readFileSync(join(dir, file), "utf8"));
        expect(applied.ok, `${file}: ${applied.err}`).toBe(true);
      }
      const seeded = psql(
        url,
        `insert into factory.projects (id, slug, name, repo, created_at)
           values ('${ID.project}', 'rehearsal', 'Rehearsal', 'didi-build/rehearsal', ${AT});
         insert into factory.runs (id, project_id, bot, runtime, model, bot_version, started_at, budget)
           values ('${ID.run}', '${ID.project}', 'developer', 'claude_code', 'model-a', 'v1', ${AT}, '{}');`,
      );
      expect(seeded.ok, seeded.err).toBe(true);
      const migrated = psql(url, readFileSync(join(dir, files[route] ?? ""), "utf8"));
      expect(migrated.ok).toBe(false);
      expect(migrated.err).toMatch(/0005 needs an empty factory\.runs/);
      const unchanged = psql(
        url,
        "select count(*) from information_schema.columns where table_schema = 'factory' and table_name = 'runs' and column_name = 'task_type';",
      );
      expect(unchanged.out).toBe("0");
      const settings = psql(
        url,
        "select count(*) from factory.settings where key like 'model_%';",
      );
      expect(settings.out).toBe("0");
    });
  },
);
