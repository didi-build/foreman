// Test-only helpers for the database integration seam. TEST_DATABASE_URL is a connection with
// the right to create databases; each test file gets its own throwaway database.
import { spawnSync } from "node:child_process";

export const adminUrl = process.env.TEST_DATABASE_URL;
export const dbRequired = process.env.FOREMAN_REQUIRE_DB === "1";

/** Runs one statement outside a transaction (create and drop database need that). */
function admin(sql: string): void {
  const done = spawnSync(
    "psql",
    [adminUrl ?? "", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      encoding: "utf8",
    },
  );
  if (done.status !== 0) throw new Error(`psql failed: ${done.stderr}`);
}

/** Creates an empty database and returns its URL. Also creates Supabase's anon role if missing. */
export function createTestDatabase(name: string): string {
  admin(
    "do $$ begin if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if; exception when duplicate_object or unique_violation then null; end $$;",
  );
  admin(`drop database if exists ${name}`);
  admin(`create database ${name}`);
  const url = new URL(adminUrl ?? "");
  url.pathname = `/${name}`;
  return url.toString();
}

export function dropTestDatabase(name: string): void {
  if (adminUrl) admin(`drop database if exists ${name} with (force)`);
}
