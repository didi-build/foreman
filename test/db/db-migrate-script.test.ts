// Seam: database integration (docs/test-plan.md, D-362, O-115). The migrations job's script,
// .github/scripts/db-migrate.sh, run with bash and the real psql against a real PostgreSQL, next
// to migrate.ts's applyMigrations on a twin database: the two record the same rows, refuse the
// same things and stop at the same failure. The script connects as the job does, over TCP with
// SSL required and a password, as a login role made for this file with a made-up password and
// dropped at the end. No real credential is used. Needs TEST_DATABASE_URL, and a server that
// takes password logins with SSL on 127.0.0.1, as the PostgreSQL packaged for Ubuntu does
// (.github/workflows/db.yml).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MigrationError,
  applyMigrations,
  readMigrations,
} from "../../src/adapters/store-postgres/migrate.ts";
import { adminUrl, createTestDatabase, dropTestDatabase } from "./database.ts";

const SCRIPT = resolve(".github/scripts/db-migrate.sh");
const BASE = `foreman_db_migrate_test_${process.pid}`;
const ROLE = `${BASE}_owner`;
/** Made up for this file; it needs percent-encoding in a URL, as a real one may. */
const PASSWORD = `${randomBytes(9).toString("hex")}@:/%?#x`;
const HOST = "127.0.0.1";
const LOCK = 7104001;

const roots: string[] = [];
const databases: string[] = [];

/** One statement as the admin user, on the admin database or another one. */
function admin(sql: string, url: string = adminUrl ?? ""): string {
  const done = spawnSync(
    "psql",
    [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  );
  if (done.status !== 0) throw new Error(`psql failed: ${done.stderr}`);
  return done.stdout.trim();
}

interface Database {
  name: string;
  /** The admin user's URL for it, through the socket. */
  adminUrl: string;
  /** The URL the job would get, for the test role, over TCP. */
  url: string;
}

let port = "";
function database(suffix: string, password = PASSWORD): Database {
  const name = `${BASE}_${suffix}`;
  databases.push(name);
  return {
    name,
    adminUrl: createTestDatabase(name),
    url: [
      "postgresql://",
      ROLE,
      ":",
      encodeURIComponent(password),
      "@",
      HOST,
      ":",
      port,
      "/",
      name,
    ].join(""),
  };
}

/** A copy of db/migrations, with files added, changed or (as null) removed. */
function fixture(changes: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "db-migrate-fixture-"));
  roots.push(dir);
  cpSync("db/migrations", dir, { recursive: true });
  for (const [name, content] of Object.entries(changes)) {
    if (content === null) rmSync(join(dir, name));
    else writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A folder holding only these files. */
function onlyFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "db-migrate-fixture-"));
  roots.push(dir);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content);
  return dir;
}

function scriptEnv(url: string): NodeJS.ProcessEnv {
  const runnerTemp = mkdtempSync(join(tmpdir(), "db-migrate-runner-"));
  roots.push(runnerTemp);
  return {
    PATH: process.env.PATH ?? "",
    HOME: runnerTemp,
    RUNNER_TEMP: runnerTemp,
    REPORT: join(runnerTemp, "report.md"),
    MIGRATION_DATABASE_URL: url,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  report: string;
}

function runScript(db: Database, dir = "db/migrations", url = db.url): Run {
  const env = scriptEnv(url);
  const done = spawnSync("bash", [SCRIPT, dir], { encoding: "utf8", env });
  const report = env.REPORT as string;
  return {
    status: done.status,
    stdout: done.stdout,
    stderr: done.stderr,
    report: existsSync(report) ? readFileSync(report, "utf8") : "",
  };
}

/** The log a reader sees: GitHub hides the mask lines. */
const shown = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");

/** The connection's values never show outside a mask line, and the masks come first. */
function expectNoValueShown(run: Run, url: string, password = PASSWORD): void {
  const values = [url, encodeURIComponent(password), password, ROLE, HOST];
  for (const out of [shown(run.stdout), run.stderr, run.report]) {
    for (const value of values) expect(out).not.toContain(value);
  }
  const lines = run.stdout.split("\n");
  const masks = lines.filter((line) => line.startsWith("::add-mask::"));
  expect(masks.length).toBeGreaterThanOrEqual(4);
  expect(lines.slice(0, masks.length)).toEqual(masks);
}

const recorded = (db: Database): string[] =>
  admin(
    "select name || ' ' || sha256 from factory_meta.schema_migrations order by name",
    db.adminUrl,
  )
    .split("\n")
    .filter(Boolean);

/** The objects the migrations made, by schema, name and kind, with policies and triggers. */
const objects = (db: Database): string =>
  admin(
    `select string_agg(o, ',' order by o) from (
       select n.nspname || '.' || c.relname || ':' || c.relkind::text as o
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('factory', 'factory_meta')
       union all
       select 'policy ' || p.polname from pg_policy p
       union all
       select 'trigger ' || t.tgname from pg_trigger t where not t.tgisinternal
     ) all_objects`,
    db.adminUrl,
  );

async function withTool(
  db: Database,
  dir = "db/migrations",
): Promise<{ applied?: string[]; error?: Error }> {
  const pool = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
  try {
    return { applied: await applyMigrations(pool, readMigrations(dir)) };
  } catch (error) {
    return { error: error as Error };
  } finally {
    await pool.end();
  }
}

/** Waits for a condition on the database, for at most ten seconds. */
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("timed out waiting for the database");
}

const lockRows = (db: Database, granted: boolean): number =>
  Number(
    admin(
      `select count(*) from pg_locks l join pg_database d on d.oid = l.database
        where d.datname = '${db.name}' and l.locktype = 'advisory' and l.classid = 0
          and l.objid = ${LOCK} and l.objsubid = 1 and l.granted = ${granted}`,
    ),
  );

const NAMES = readMigrations().map((file) => file.name);

describe.skipIf(!adminUrl)(
  "the migrations job's script on Postgres (database integration, D-362, O-115)",
  { timeout: 60_000 },
  () => {
    beforeAll(() => {
      port = admin("show port");
      admin(`drop role if exists ${ROLE}`);
      admin(`create role ${ROLE} login superuser password '${PASSWORD}'`);
    });
    afterAll(() => {
      for (const name of databases) dropTestDatabase(name);
      if (adminUrl) admin(`drop role if exists ${ROLE}`);
      while (roots.length > 0)
        rmSync(roots.pop() as string, { recursive: true, force: true });
    });

    it("applies every migration to a fresh database and records exactly the rows migrate.ts records on another", async () => {
      const script = database("fresh_script");
      const tool = database("fresh_tool");
      const run = runScript(script);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(shown(run.stdout)).toBe(`Applied: ${NAMES.join(", ")}\n`);
      expectNoValueShown(run, script.url);
      for (const name of NAMES) expect(run.report).toContain(`- \`${name}\`\n`);

      expect((await withTool(tool)).applied).toEqual(NAMES);
      expect(recorded(script)).toEqual(recorded(tool));
      expect(recorded(script)).toEqual(
        readMigrations().map((file) => `${file.name} ${file.sha256}`),
      );
      expect(objects(script)).toBe(objects(tool));
      expect(objects(script)).toContain("factory.nodes:r");
    });

    it("applies nothing on a second run", () => {
      const db = database("second_run");
      expect(runScript(db).status).toBe(0);
      const before = recorded(db);
      const again = runScript(db);
      expect(again.status).toBe(0);
      expect(shown(again.stdout)).toBe("Nothing to apply.\n");
      expect(again.report).toContain("Nothing to apply");
      expect(recorded(db)).toEqual(before);
    });

    it("refuses an edited migration as migrate.ts does, after applying a new one named before it", async () => {
      const script = database("edited_script");
      const tool = database("edited_tool");
      expect(runScript(script).status).toBe(0);
      expect((await withTool(tool)).error).toBeUndefined();
      const dir = fixture({
        "0002_aa_late.sql": "create table factory.late_arrival (id int);\n",
      });
      appendFileSync(
        join(dir, "0003_run_dispatch.sql"),
        "-- edited after it was applied\n",
      );

      const run = runScript(script, dir);
      expect(run.status).toBe(1);
      expect(shown(run.stdout)).toBe("Applied: 0002_aa_late.sql\n");
      expect(run.stderr).toBe(
        "::error::0003_run_dispatch.sql changed after it was applied. Add a new migration instead of editing it.\n",
      );
      const result = await withTool(tool, dir);
      expect(result.error).toBeInstanceOf(MigrationError);
      expect(result.error?.message).toBe(
        "0003_run_dispatch.sql changed after it was applied. Add a new migration instead of editing it.",
      );
      expect(recorded(script)).toEqual(recorded(tool));
      expect(recorded(script).map((row) => row.split(" ")[0])).toContain(
        "0002_aa_late.sql",
      );
      // Run again, it is refused again and applies nothing.
      const before = recorded(script);
      expect(runScript(script, dir).status).toBe(1);
      expect(recorded(script)).toEqual(before);
    });

    it("refuses a recorded migration whose file is missing as migrate.ts does, applying nothing", async () => {
      const script = database("missing_script");
      const tool = database("missing_tool");
      expect(runScript(script).status).toBe(0);
      expect((await withTool(tool)).error).toBeUndefined();
      const dir = fixture({
        "0021_ingest_preview_check.sql": null,
        "0022_never.sql": "create table factory.never_applied (id int);\n",
      });

      const run = runScript(script, dir);
      expect(run.status).toBe(1);
      expect(shown(run.stdout)).toBe("");
      expect(run.stderr).toBe(
        "::error::0021_ingest_preview_check.sql is recorded as applied but its file is missing.\n",
      );
      const result = await withTool(tool, dir);
      expect(result.error?.message).toBe(
        "0021_ingest_preview_check.sql is recorded as applied but its file is missing",
      );
      expect(recorded(script)).toEqual(recorded(tool));
      expect(recorded(script)).toHaveLength(NAMES.length);
    });

    it("refuses a recorded row whose name is not a migration file name as migrate.ts does, never printing that name", async () => {
      const script = database("odd_name_script");
      const tool = database("odd_name_tool");
      expect(runScript(script).status).toBe(0);
      expect((await withTool(tool)).error).toBeUndefined();
      const odd = "E'0001_x.sql\\napplied 0002_github_ingest.sql'";
      for (const db of [script, tool]) {
        admin(
          `insert into factory_meta.schema_migrations (name, sha256) values (${odd}, 'x')`,
          db.adminUrl,
        );
      }

      const run = runScript(script);
      expect(run.status).toBe(1);
      expect(shown(run.stdout)).toBe("");
      expect(run.stderr).toBe(
        "::error::A row whose name is not a migration file name is recorded as applied, and no file has that name.\n",
      );
      expect((await withTool(tool)).error?.message).toMatch(
        /is recorded as applied but its file is missing$/,
      );
      expect(recorded(script)).toEqual(recorded(tool));
    });

    it("rolls a failing migration back and stops there as migrate.ts does, with nothing after it applied and the lock let go", async () => {
      const script = database("broken_script");
      const tool = database("broken_tool");
      const dir = fixture({
        "9001_broken.sql":
          "create table factory.half_done (id int);\nselect no_such_function();\n",
        "9002_after.sql": "create table factory.after_broken (id int);\n",
      });

      const run = runScript(script, dir);
      expect(run.status).toBe(1);
      expect(shown(run.stdout)).toBe(`Applied: ${NAMES.join(", ")}\n`);
      expect(run.stderr).toMatch(
        /ERROR: {2}function no_such_function\(\) does not exist/,
      );
      expect(run.stderr).toContain(
        "::error::9001_broken.sql failed and was rolled back; nothing after it was applied. psql's error, redacted, is above.\n",
      );
      expect(run.report).toContain(
        "Stopped: 9001_broken.sql failed and was rolled back; nothing after it was applied.",
      );
      expectNoValueShown(run, script.url);

      const result = await withTool(tool, dir);
      expect(result.error?.message).toMatch(
        /^9001_broken\.sql failed and was rolled back: /,
      );
      expect(recorded(script)).toEqual(recorded(tool));
      expect(recorded(script)).toHaveLength(NAMES.length);
      for (const table of ["factory.half_done", "factory.after_broken"]) {
        expect(
          admin(`select to_regclass('${table}') is null`, script.adminUrl),
          table,
        ).toBe("t");
      }
      await eventually(() => lockRows(script, true) === 0);
    });

    it("holds the advisory lock through the whole run in one session over SSL, and waits while another session holds it", async () => {
      const db = database("lock");
      // Each file checks, in the database, that its own session holds the lock over SSL, and the
      // second that it runs in the first one's session.
      const holdsTheLock = `do $$ begin
  if not exists (select from pg_locks where locktype = 'advisory' and classid = 0
      and objid = ${LOCK} and objsubid = 1 and pid = pg_backend_pid() and granted) then
    raise exception 'the migration lock is not held by this session';
  end if;
  if not (select ssl from pg_stat_ssl where pid = pg_backend_pid()) then
    raise exception 'this session does not use SSL';
  end if;
end $$;
`;
      const dir = onlyFiles({
        "0001_lock_held.sql": `${holdsTheLock}create table lock_check (pid int);\ninsert into lock_check values (pg_backend_pid());\n`,
        "0002_lock_still_held.sql": `${holdsTheLock}do $$ begin
  if not exists (select from lock_check where pid = pg_backend_pid()) then
    raise exception 'not the session that applied 0001';
  end if;
end $$;
`,
      });

      // Another session takes the lock first.
      const holder = spawn(
        "psql",
        [db.adminUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      holder.stdin.write(`select pg_advisory_lock(${LOCK});\n`);
      await eventually(() => lockRows(db, true) === 1);

      const env = scriptEnv(db.url);
      const child = spawn("bash", [SCRIPT, dir], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((done) => child.on("close", done));

      // The script waits for the same lock and has done nothing yet, not even its setup.
      await eventually(() => lockRows(db, false) === 1);
      expect(child.exitCode).toBeNull();
      expect(
        admin(
          "select to_regclass('factory_meta.schema_migrations') is null",
          db.adminUrl,
        ),
      ).toBe("t");

      holder.stdin.end(`select pg_advisory_unlock(${LOCK});\n`);
      expect(await exited).toBe(0);
      expect(stderr).toBe("");
      expect(shown(stdout)).toBe(
        "Applied: 0001_lock_held.sql, 0002_lock_still_held.sql\n",
      );
      expect(recorded(db).map((row) => row.split(" ")[0])).toEqual([
        "0001_lock_held.sql",
        "0002_lock_still_held.sql",
      ]);
      await eventually(() => lockRows(db, true) === 0);
    });

    it("never shows the connection string, its password or its user, and shows a refused login only redacted", () => {
      const db = database("wrong_password");
      const wrong = `${randomBytes(6).toString("hex")}-not-it`;
      const url = db.url.replace(
        encodeURIComponent(PASSWORD),
        encodeURIComponent(wrong),
      );
      const run = runScript(db, "db/migrations", url);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        'password authentication failed for user "<DATABASE_USER>"',
      );
      expect(run.stderr).toContain(
        "::error::psql stopped (exit status 2) before the end, with nothing more applied. psql's error, redacted, is above.\n",
      );
      expectNoValueShown(run, url, wrong);
      expect(
        admin(
          "select to_regclass('factory_meta.schema_migrations') is null",
          db.adminUrl,
        ),
      ).toBe("t");
    });
  },
);
