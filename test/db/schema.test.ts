// Seam: database integration (docs/test-plan.md, ADR 0104). Applies db/migrations/ to an empty
// Postgres and checks the constraints the store relies on. Needs TEST_DATABASE_URL, a connection
// with the right to create databases; .github/workflows/db.yml provides one and sets
// FOREMAN_REQUIRE_DB=1 so the tests cannot be skipped there.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      expect(Number(count.out)).toBe(18);
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

    it("seeds the loop interval from D-164 and the Windmill alert from D-167", () => {
      const values = sql(
        "select string_agg(key || '=' || value::text, ',' order by key) from factory.settings where key in ('reconcile_interval_minutes', 'windmill_monthly_execution_limit', 'windmill_alert_percent');",
      );
      expect(values.out).toBe(
        "reconcile_interval_minutes=120,windmill_alert_percent=80,windmill_monthly_execution_limit=1000",
      );
    });

    it("seeds the usage-exhausted wait and leaves the cluster run limit to be set (migration 0003)", () => {
      const values = sql(
        "select string_agg(key || '=' || value::text, ',' order by key) from factory.settings where key in ('usage_exhausted_wait_minutes', 'agent_cluster_max_active_runs');",
      );
      expect(values.out).toBe("usage_exhausted_wait_minutes=30");
      const index = sql("select to_regclass('factory.runs_active') is not null;");
      expect(index.out).toBe("t");
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
