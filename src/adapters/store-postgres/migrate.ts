// Applies db/migrations/*.sql in name order and records each one (ADR 0104). Each file runs in
// its own transaction together with its record, so a file is applied fully or not at all.
// Usage: MIGRATION_DATABASE_URL=... node src/adapters/store-postgres/migrate.ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import { readConfig, text } from "../../service-kit/config.ts";

export const MIGRATIONS_DIR = "db/migrations";

/** Any fixed number works; it only has to be the same for every run of this tool. */
const MIGRATION_LOCK = 7_104_001;

export interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") };
    });
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Applies every migration not yet recorded. Refuses to run if a recorded migration's file has
 * changed since it was applied, because an edited migration means the database and the repo
 * disagree. Returns the names it applied.
 */
export async function applyMigrations(
  pool: pg.Pool,
  files: MigrationFile[],
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      create schema if not exists factory_meta;
      create table if not exists factory_meta.schema_migrations (
        name text primary key,
        sha256 text not null,
        applied_at timestamptz not null default now()
      );
      revoke all on schema factory_meta from public;
    `);
    const applied = new Map(
      (
        await client.query("select name, sha256 from factory_meta.schema_migrations")
      ).rows.map((r: { name: string; sha256: string }) => [r.name, r.sha256]),
    );
    for (const name of applied.keys()) {
      if (!files.some((f) => f.name === name)) {
        throw new MigrationError(
          `${name} is recorded as applied but its file is missing`,
        );
      }
    }
    const done: string[] = [];
    for (const file of files) {
      const recorded = applied.get(file.name);
      if (recorded !== undefined) {
        if (recorded !== file.sha256) {
          throw new MigrationError(
            `${file.name} changed after it was applied. Add a new migration instead of editing it.`,
          );
        }
        continue;
      }
      try {
        await client.query("begin");
        await client.query(file.sql);
        await client.query(
          "insert into factory_meta.schema_migrations (name, sha256) values ($1, $2)",
          [file.name, file.sha256],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new MigrationError(
          `${file.name} failed and was rolled back: ${(error as Error).message}`,
        );
      }
      done.push(file.name);
    }
    return done;
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK])
      .catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const config = readConfig({ url: text("MIGRATION_DATABASE_URL") });
  const pool = new pg.Pool({ connectionString: config.url, max: 1 });
  try {
    const applied = await applyMigrations(pool, readMigrations());
    console.log(
      applied.length > 0 ? `Applied: ${applied.join(", ")}` : "Nothing to apply.",
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: Error) => {
    // The message names the migration or the setting; it never contains the connection string.
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  });
}
