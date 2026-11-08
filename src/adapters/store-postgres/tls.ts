// How every connection to the state store is encrypted and verified (D-364, O-117). The state
// API, the receiver, the runner and `npm run db:migrate` build their pool's config here and
// nowhere else. TLS is always on, the server's certificate must chain to Supabase's root CA
// (committed at SUPABASE_CA_PATH, never fetched) and must match the host name, and nothing in the
// connection string or the environment can weaken that: `pg` 8.23.1 lets a parsed `ssl`,
// `sslmode`, `sslrootcert`, `sslcert` or `sslkey` parameter replace an explicit `ssl` object, so
// every parameter whose name starts with `ssl`, and `uselibpqcompat`, is dropped from the string,
// and the result is checked with `pg`'s own parsing before it is used. A connection that cannot
// verify fails; `pg` never retries it in plain text.
//
// The one way without TLS is the local opt-out for development and tests: it needs
// LOCAL_WITHOUT_TLS_ENV set to 1, and then the host must be localhost, 127.0.0.1, ::1 or a Unix
// socket, or the config is refused. Every refusal is fixed text that carries no part of the
// connection string.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";
import pg from "pg";

import type { Setting } from "../../service-kit/config.ts";

/**
 * Supabase's root CA certificate ("Supabase Root 2021 CA", from the project's SSL Configuration
 * panel). Relative to the working directory, as the contracts are: `/app` in the state API's and
 * the receiver's images, which copy this folder, and the bundle's root in Windmill, whose bundle
 * carries this file (`bundle_files` in flows/windmill.yaml).
 */
export const SUPABASE_CA_PATH = "src/adapters/store-postgres/supabase-ca.crt";

/** Set to 1 to reach a local Postgres without TLS. Never set in a deployment. */
export const LOCAL_WITHOUT_TLS_ENV = "FOREMAN_LOCAL_DATABASE_WITHOUT_TLS";

/** Hosts the local opt-out accepts, besides a Unix socket directory (a path starting with /). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;

/** A refusal with fixed text: it never quotes the connection string, a host or a password. */
export class DatabaseTlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTlsError";
  }
}

/**
 * Reads the CA certificate file: one or more PEM certificates, each a CA, and nothing else. A
 * missing file or any other content is refused.
 */
export function readDatabaseCa(path: string = SUPABASE_CA_PATH): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DatabaseTlsError(`The database CA certificate is missing at ${path}.`);
  }
  const notCa = new DatabaseTlsError(
    `The database CA certificate at ${path} is not a PEM CA certificate.`,
  );
  const blocks = text.match(PEM_CERTIFICATE) ?? [];
  if (blocks.length === 0 || text.replace(PEM_CERTIFICATE, "").trim() !== "")
    throw notCa;
  for (const block of blocks) {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      throw notCa;
    }
    if (!certificate.ca) throw notCa;
  }
  return text;
}

/** Whether a query parameter is one `pg` reads for TLS, matched by its decoded name. */
function isTlsParameter(pair: string): boolean {
  const [name = ""] = new URLSearchParams(pair).keys();
  const lower = name.toLowerCase();
  return lower.startsWith("ssl") || lower === "uselibpqcompat";
}

/**
 * The connection string without its TLS parameters. Everything else is kept byte for byte, so
 * the user name and password reach `pg` exactly as pasted.
 */
export function withoutTlsParameters(connectionString: string): string {
  // `pg` reads no parameters from the "<socket directory> <database>" form.
  if (connectionString.startsWith("/")) return connectionString;
  const fragment = connectionString.indexOf("#");
  const end = fragment === -1 ? connectionString.length : fragment;
  const query = connectionString.indexOf("?");
  if (query === -1 || query > end) return connectionString;
  const kept = connectionString
    .slice(query + 1, end)
    .split("&")
    .filter((pair) => !isTlsParameter(pair));
  return (
    connectionString.slice(0, query) +
    (kept.length > 0 ? `?${kept.join("&")}` : "") +
    connectionString.slice(end)
  );
}

/** The host and TLS settings `pg` will use for this config. Opens no connection. */
function asPgReadsIt(config: pg.PoolConfig): { host: string; ssl: unknown } {
  try {
    const client = new pg.Client(config);
    return { host: client.host, ssl: client.ssl as unknown };
  } catch {
    throw new DatabaseTlsError("The database connection string cannot be read.");
  }
}

function localWithoutTls(env: NodeJS.ProcessEnv): boolean {
  const raw = env[LOCAL_WITHOUT_TLS_ENV];
  if (raw === undefined || raw === "") return false;
  if (raw === "1") return true;
  throw new DatabaseTlsError(`${LOCAL_WITHOUT_TLS_ENV} must be 1 or unset.`);
}

function isLocalHost(host: string): boolean {
  return host.startsWith("/") || LOCAL_HOSTS.has(host.toLowerCase());
}

export interface DatabasePoolOptions {
  /** The pool's size. */
  max: number;
  /** The CA certificate file. Only tests pass another one. */
  caPath?: string;
  /** Where the local opt-out is read. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The `pg` pool config for a connection string: TLS verified against the CA file and the host
 * name, or, only under the local opt-out and only for a local host, no TLS.
 */
export function databasePoolConfig(
  connectionString: string,
  options: DatabasePoolOptions,
): pg.PoolConfig {
  const cleaned = withoutTlsParameters(connectionString);
  if (localWithoutTls(options.env ?? process.env)) {
    const local: pg.PoolConfig = {
      connectionString: cleaned,
      max: options.max,
      ssl: false,
    };
    if (!isLocalHost(asPgReadsIt(local).host)) {
      throw new DatabaseTlsError(
        `${LOCAL_WITHOUT_TLS_ENV} is set, but the database host is not localhost, 127.0.0.1, ::1 or a Unix socket.`,
      );
    }
    return local;
  }
  const ssl = Object.freeze({
    ca: readDatabaseCa(options.caPath),
    rejectUnauthorized: true,
    checkServerIdentity,
  });
  const config: pg.PoolConfig = { connectionString: cleaned, max: options.max, ssl };
  // The check that matters: `pg` itself keeps exactly these TLS settings for this string.
  if (asPgReadsIt(config).ssl !== ssl) {
    throw new DatabaseTlsError(
      "The database connection string overrides the TLS settings.",
    );
  }
  return config;
}

/**
 * A service's database setting (ADR 0111): the connection string in `env`, built into its pool
 * config at start, so a refusal stops the service and names the setting, never its value.
 */
export function databaseSetting(env: string, max: number): Setting<pg.PoolConfig> {
  return {
    env,
    parse: (raw) => {
      if (raw.trim() === "") throw new Error("is empty");
      try {
        return databasePoolConfig(raw, { max });
      } catch (error) {
        throw new Error(
          `cannot be used. ${error instanceof DatabaseTlsError ? error.message : "The database settings cannot be read."}`,
        );
      }
    },
  };
}
