// Seam: database integration (D-364, O-117). The TLS builder against the real local PostgreSQL
// that CI and development use: the explicit local opt-out reaches it over its Unix socket without
// TLS, and without the opt-out the same connection string asks for TLS, which a Unix socket never
// offers, so it is refused and never retried in plain text.
import pg from "pg";
import { describe, expect, it } from "vitest";

import {
  LOCAL_WITHOUT_TLS_ENV,
  databasePoolConfig,
} from "../../src/adapters/store-postgres/tls.ts";
import { adminUrl } from "./database.ts";

async function sslInUse(config: pg.PoolConfig): Promise<unknown> {
  const pool = new pg.Pool({ ...config, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => undefined);
  try {
    const result = await pool.query(
      "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
    );
    return (result.rows[0] as { ssl: boolean }).ssl;
  } finally {
    await pool.end();
  }
}

describe.skipIf(!adminUrl)(
  "database TLS on the local database (database integration, O-117)",
  () => {
    it("connects without TLS only through the explicit local opt-out", async () => {
      const config = databasePoolConfig(adminUrl ?? "", {
        max: 1,
        env: { [LOCAL_WITHOUT_TLS_ENV]: "1" },
      });
      expect(config.ssl).toBe(false);
      expect(await sslInUse(config)).toBe(false);
    });

    it("asks for verified TLS without the opt-out, and gets no plain-text connection", async () => {
      const config = databasePoolConfig(adminUrl ?? "", { max: 1, env: {} });
      expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
      await expect(sslInUse(config)).rejects.toThrow();
    });
  },
);
