// Seam: unit, the database TLS builder (D-364, O-117), and a real TLS handshake through `pg`
// against a fake Postgres on localhost. The fake answers the SSLRequest, does TLS with a
// certificate from a CA made for this test with openssl, then answers the startup message with
// "authentication ok, ready". No database, no network beyond localhost, no real credential.
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, createSecureContext, TLSSocket } from "node:tls";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError, readConfig } from "../../service-kit/config.ts";
import {
  DatabaseTlsError,
  LOCAL_WITHOUT_TLS_ENV,
  SUPABASE_CA_PATH,
  databasePoolConfig,
  databaseSetting,
  readDatabaseCa,
  withoutTlsParameters,
} from "./tls.ts";

/** Made up for these tests. */
const PASSWORD = "not-a-real-password";
const REMOTE = `postgresql://tester.example:${PASSWORD}@pooler.example.test:5432/postgres`;

const OPENSSL_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = Foreman throwaway test CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[localhost]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
[elsewhere]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:db.example.test
`;

interface Identity {
  key: string;
  cert: string;
}

/** Two throwaway CAs and server certificates signed by the first one or the second one. */
interface TestPki {
  dir: string;
  caPath: string;
  ca: string;
  /** For localhost, from the trusted CA. */
  localhost: Identity;
  /** For another host name, from the trusted CA. */
  elsewhere: Identity;
  /** For localhost, from a CA the client does not trust. */
  untrusted: Identity;
  /** A file holding the server's private key, which is never a CA certificate. */
  keyPath: string;
}

function makePki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "foreman-db-tls-"));
  const at = (name: string) => join(dir, name);
  writeFileSync(at("openssl.cnf"), OPENSSL_CONFIG);
  const openssl = (args: string[]) =>
    execFileSync("openssl", args, { stdio: "ignore" });
  const newKey = [
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
  ];
  const makeCa = (name: string) =>
    openssl([
      "req", "-x509", "-config", at("openssl.cnf"), "-extensions", "ca", ...newKey,
      "-days", "1", "-keyout", at(`${name}.key`), "-out", at(`${name}.crt`),
    ]); // prettier-ignore
  const makeServer = (name: string, ca: string, section: string): Identity => {
    openssl([
      "req", "-new", "-config", at("openssl.cnf"), ...newKey, "-subj", `/CN=${name}`,
      "-keyout", at(`${name}.key`), "-out", at(`${name}.csr`),
    ]); // prettier-ignore
    openssl([
      "x509", "-req", "-in", at(`${name}.csr`), "-CA", at(`${ca}.crt`), "-CAkey", at(`${ca}.key`),
      "-set_serial", "4660", "-days", "1", "-extfile", at("openssl.cnf"),
      "-extensions", section, "-out", at(`${name}.crt`),
    ]); // prettier-ignore
    return {
      key: readFileSync(at(`${name}.key`), "utf8"),
      cert: readFileSync(at(`${name}.crt`), "utf8"),
    };
  };
  makeCa("trusted");
  makeCa("other");
  return {
    dir,
    caPath: at("trusted.crt"),
    ca: readFileSync(at("trusted.crt"), "utf8"),
    localhost: makeServer("localhost", "trusted", "localhost"),
    elsewhere: makeServer("elsewhere", "trusted", "elsewhere"),
    untrusted: makeServer("untrusted", "other", "localhost"),
    keyPath: at("localhost.key"),
  };
}

const SSL_REQUEST_CODE = 80877103;
/** AuthenticationOk, then ReadyForQuery (idle). */
const READY = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

interface FakePostgres {
  port: number;
  /** Startup messages received over TLS: each one means the handshake was accepted. */
  readonly tlsStartups: number;
  /** Bytes received in plain text after the SSLRequest, or with none: never expected. */
  readonly plaintextBytes: number;
  close(): Promise<void>;
}

/** A fake Postgres that speaks TLS with `identity`, or refuses TLS ("N") when it is null. */
async function fakePostgres(identity: Identity | null): Promise<FakePostgres> {
  const state = { tlsStartups: 0, plaintextBytes: 0 };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", (first) => {
      const sslRequest =
        first.length === 8 && first.readInt32BE(4) === SSL_REQUEST_CODE;
      if (!sslRequest || identity === null) {
        if (!sslRequest) state.plaintextBytes += first.length;
        socket.on("data", (more) => (state.plaintextBytes += more.length));
        if (sslRequest) socket.write("N");
        return;
      }
      socket.write("S");
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: createSecureContext(identity),
      });
      secure.on("error", () => undefined);
      secure.once("data", () => {
        state.tlsStartups += 1;
        secure.write(READY);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get tlsStartups() {
      return state.tlsStartups;
    },
    get plaintextBytes() {
      return state.plaintextBytes;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Connects once through a pool built from `config`, then ends the pool. */
async function connectOnce(config: pg.PoolConfig): Promise<void> {
  const pool = new pg.Pool({ ...config, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => undefined);
  try {
    const client = await pool.connect();
    client.release();
  } finally {
    await pool.end();
  }
}

let pki: TestPki;
beforeAll(() => {
  pki = makePki();
});
afterAll(() => rmSync(pki.dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const NO_OPT_OUT = {};
const OPT_OUT = { [LOCAL_WITHOUT_TLS_ENV]: "1" };

describe("database TLS builder (unit: store-postgres adapter, D-364, O-117)", () => {
  describe("the committed CA certificate", () => {
    it("is Supabase's root CA, with the fingerprint and expiry recorded in O-117", () => {
      const certificate = new X509Certificate(readDatabaseCa());
      expect(certificate.fingerprint256).toBe(
        "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
      );
      expect(certificate.subject).toContain("CN=Supabase Root 2021 CA");
      expect(certificate.ca).toBe(true);
      expect(new Date(certificate.validTo).toISOString().slice(0, 10)).toBe(
        "2031-04-26",
      );
    });

    it("is read from the fixed path every production connection uses", () => {
      expect(SUPABASE_CA_PATH).toBe("src/adapters/store-postgres/supabase-ca.crt");
      const config = databasePoolConfig(REMOTE, { max: 1, env: NO_OPT_OUT });
      expect((config.ssl as { ca: string }).ca).toBe(
        readFileSync(SUPABASE_CA_PATH, "utf8"),
      );
    });
  });

  describe("refuses a CA file that is missing or not a PEM CA certificate", () => {
    const write = (name: string, text: string) => {
      const path = join(pki.dir, name);
      writeFileSync(path, text);
      return path;
    };

    it("a missing file", () => {
      const path = join(pki.dir, "nowhere.crt");
      expect(() => readDatabaseCa(path)).toThrow(
        new DatabaseTlsError(`The database CA certificate is missing at ${path}.`),
      );
      expect(() =>
        databasePoolConfig(REMOTE, { max: 1, caPath: path, env: {} }),
      ).toThrow(DatabaseTlsError);
    });

    it.each([
      ["an empty file", () => ""],
      ["plain text", () => "not a certificate\n"],
      ["a private key", () => readFileSync(pki.keyPath, "utf8")],
      [
        "a certificate followed by its key",
        () => pki.ca + readFileSync(pki.keyPath, "utf8"),
      ],
      ["text around the certificate", () => `subject=whatever\n${pki.ca}`],
      [
        "a broken certificate",
        () => "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
      ],
      ["a server certificate that is not a CA", () => pki.localhost.cert],
    ])("%s", (name, text) => {
      const path = write(`${name.replaceAll(" ", "-")}.crt`, text());
      expect(() => readDatabaseCa(path)).toThrow(
        new DatabaseTlsError(
          `The database CA certificate at ${path} is not a PEM CA certificate.`,
        ),
      );
    });

    it("accepts two CA certificates in one file, for a switch to a new root", () => {
      const path = write(
        "two.crt",
        `${pki.ca}${readFileSync(SUPABASE_CA_PATH, "utf8")}`,
      );
      expect(readDatabaseCa(path)).toContain(pki.ca);
    });
  });

  describe("turns TLS on and verifies the CA and the host name", () => {
    it("for a connection string as Supabase's Connect panel gives it", () => {
      const config = databasePoolConfig(REMOTE, { max: 7, env: NO_OPT_OUT });
      expect(config).toEqual({
        connectionString: REMOTE,
        max: 7,
        ssl: {
          ca: readDatabaseCa(),
          rejectUnauthorized: true,
          checkServerIdentity,
        },
      });
      expect(Object.isFrozen(config.ssl)).toBe(true);
    });

    it("for a local host too, without the opt-out", () => {
      const config = databasePoolConfig("postgresql://tester@localhost/postgres", {
        max: 1,
        env: { [LOCAL_WITHOUT_TLS_ENV]: "" },
      });
      expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
    });

    it.each([
      "sslmode=disable",
      "sslmode=allow",
      "sslmode=prefer",
      "sslmode=require",
      "sslmode=verify-ca",
      "sslmode=no-verify",
      "ssl=false",
      "ssl=0",
      "ssl=no-verify",
      "uselibpqcompat=true&sslmode=require",
      "sslrootcert=%2Fetc%2Fssl%2Fcerts%2Fca-certificates.crt",
      "sslcert=%2Ftmp%2Fclient.crt&sslkey=%2Ftmp%2Fclient.key",
      "sslnegotiation=direct",
      "SSLMODE=disable",
      "ssl%6Dode=disable",
    ])("whatever the string says: %s", (parameters) => {
      const config = databasePoolConfig(`${REMOTE}?${parameters}`, {
        max: 1,
        env: NO_OPT_OUT,
      });
      expect(config.connectionString).toBe(REMOTE);
      // `pg` itself keeps the builder's TLS settings for this config.
      const client = new pg.Client(config);
      expect(client.ssl as unknown).toBe(config.ssl);
      expect(client.ssl).toMatchObject({
        rejectUnauthorized: true,
        ca: readDatabaseCa(),
      });
    });

    it("keeps every other parameter and the password byte for byte", () => {
      const pasted =
        "postgresql://tester.example:p%40ss%2Fw0rd@pooler.example.test:5432/postgres" +
        "?sslmode=require&application_name=foreman&options=-c%20search_path%3Dfactory#x";
      const config = databasePoolConfig(pasted, { max: 1, env: NO_OPT_OUT });
      expect(config.connectionString).toBe(
        "postgresql://tester.example:p%40ss%2Fw0rd@pooler.example.test:5432/postgres" +
          "?application_name=foreman&options=-c%20search_path%3Dfactory#x",
      );
      const client = new pg.Client(config);
      expect(client.password).toBe("p@ss/w0rd");
      expect(client.host).toBe("pooler.example.test");
    });

    it("whatever the environment says", () => {
      vi.stubEnv("PGSSLMODE", "disable");
      const config = databasePoolConfig(REMOTE, { max: 1, env: NO_OPT_OUT });
      expect(new pg.Client(config).ssl as unknown).toBe(config.ssl);
    });

    it("refuses when `pg` would not keep the TLS settings, as a later version might", () => {
      vi.spyOn(pg, "Client").mockImplementation(function (this: { ssl: boolean }) {
        this.ssl = false;
        return this;
      } as unknown as () => pg.Client);
      expect(() => databasePoolConfig(REMOTE, { max: 1, env: NO_OPT_OUT })).toThrow(
        new DatabaseTlsError(
          "The database connection string overrides the TLS settings.",
        ),
      );
    });

    it("refuses a string `pg` cannot read, without quoting it", () => {
      const broken = `postgresql://tester:${PASSWORD}@[::1/postgres`;
      let message = "";
      try {
        databasePoolConfig(broken, { max: 1, env: NO_OPT_OUT });
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseTlsError);
        message = (error as Error).message;
      }
      expect(message).toBe("The database connection string cannot be read.");
    });
  });

  describe("the local opt-out", () => {
    it.each([
      ["localhost", "postgresql://tester@localhost:5432/postgres"],
      ["127.0.0.1", "postgresql://tester@127.0.0.1/postgres"],
      ["::1", "postgresql://tester@[::1]:5432/postgres"],
      [
        "a Unix socket",
        "postgresql://tester@localhost/postgres?host=/var/run/postgresql",
      ],
      ["a socket directory string", "/var/run/postgresql postgres"],
    ])("connects to %s without TLS", (_, url) => {
      const config = databasePoolConfig(url, { max: 1, env: OPT_OUT });
      expect(config.ssl).toBe(false);
      expect(new pg.Client(config).ssl).toBe(false);
    });

    it.each([
      ["a remote host", REMOTE],
      ["a look-alike name", "postgresql://tester@localhost.example.test/postgres"],
      [
        "another loopback-looking name",
        "postgresql://tester@127.0.0.1.example.test/postgres",
      ],
      ["any address", "postgresql://tester@0.0.0.0/postgres"],
      [
        "a host parameter that points elsewhere",
        "postgresql://tester@localhost/postgres?host=db.example.test",
      ],
    ])("refuses %s", (_, url) => {
      expect(() => databasePoolConfig(url, { max: 1, env: OPT_OUT })).toThrow(
        new DatabaseTlsError(
          `${LOCAL_WITHOUT_TLS_ENV} is set, but the database host is not localhost, 127.0.0.1, ::1 or a Unix socket.`,
        ),
      );
    });

    it("judges the host `pg` will use, PGHOST included", () => {
      vi.stubEnv("PGHOST", "db.example.test");
      expect(() =>
        databasePoolConfig("postgresql:///postgres", { max: 1, env: OPT_OUT }),
      ).toThrow(DatabaseTlsError);
    });

    it.each(["true", "yes", "0", " 1"])("refuses the value %j", (value) => {
      expect(() =>
        databasePoolConfig("postgresql://tester@localhost/postgres", {
          max: 1,
          env: { [LOCAL_WITHOUT_TLS_ENV]: value },
        }),
      ).toThrow(new DatabaseTlsError(`${LOCAL_WITHOUT_TLS_ENV} must be 1 or unset.`));
    });
  });

  describe("the services' setting", () => {
    it("stops the start with the setting's name and the reason, never the value", () => {
      vi.stubEnv(LOCAL_WITHOUT_TLS_ENV, "1");
      let problems: readonly string[] = [];
      try {
        readConfig(
          { database: databaseSetting("DATABASE_URL", 5) },
          { DATABASE_URL: REMOTE },
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        problems = (error as ConfigError).problems;
      }
      expect(problems).toEqual([
        `DATABASE_URL cannot be used. ${LOCAL_WITHOUT_TLS_ENV} is set, but the database host is not localhost, 127.0.0.1, ::1 or a Unix socket.`,
      ]);
      expect(problems.join()).not.toContain(PASSWORD);
    });

    it("refuses an empty value and builds a verified config from a good one", () => {
      expect(() =>
        readConfig(
          { database: databaseSetting("DATABASE_URL", 5) },
          { DATABASE_URL: " " },
        ),
      ).toThrow("DATABASE_URL is empty");
      const { database } = readConfig(
        { database: databaseSetting("DATABASE_URL", 5) },
        { DATABASE_URL: `${REMOTE}?sslmode=disable` },
      );
      expect(database).toMatchObject({ max: 5, ssl: { rejectUnauthorized: true } });
    });
  });

  describe("a real TLS handshake through pg", () => {
    const url = (port: number, parameters = "") =>
      `postgresql://tester:${PASSWORD}@localhost:${port}/postgres${parameters}`;
    const verified = (port: number, parameters = "") =>
      databasePoolConfig(url(port, parameters), {
        max: 1,
        caPath: pki.caPath,
        env: NO_OPT_OUT,
      });

    it("connects to a server whose certificate chains to the CA and names the host", async () => {
      const server = await fakePostgres(pki.localhost);
      try {
        await connectOnce(verified(server.port));
        expect(server.tlsStartups).toBe(1);
        expect(server.plaintextBytes).toBe(0);
      } finally {
        await server.close();
      }
    });

    it.each([
      "",
      "?sslmode=disable",
      "?sslmode=no-verify",
      "?uselibpqcompat=true&sslmode=require",
    ])("refuses a certificate from another CA (string %j)", async (parameters) => {
      const server = await fakePostgres(pki.untrusted);
      try {
        await expect(
          connectOnce(verified(server.port, parameters)),
        ).rejects.toMatchObject({
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        });
        expect(server.tlsStartups).toBe(0);
        expect(server.plaintextBytes).toBe(0);
      } finally {
        await server.close();
      }
    });

    it("refuses a certificate for another host name", async () => {
      const server = await fakePostgres(pki.elsewhere);
      try {
        await expect(connectOnce(verified(server.port))).rejects.toMatchObject({
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        });
        expect(server.tlsStartups).toBe(0);
      } finally {
        await server.close();
      }
    });

    it("refuses an unverified certificate even with NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
      const server = await fakePostgres(pki.untrusted);
      try {
        await expect(connectOnce(verified(server.port))).rejects.toMatchObject({
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        });
        expect(server.tlsStartups).toBe(0);
      } finally {
        await server.close();
      }
    });

    it("refuses a server without TLS and never retries in plain text", async () => {
      const server = await fakePostgres(null);
      try {
        await expect(connectOnce(verified(server.port))).rejects.toThrow(
          "The server does not support SSL connections",
        );
        expect(server.plaintextBytes).toBe(0);
      } finally {
        await server.close();
      }
    });
  });
});

describe("dropping the TLS parameters (unit: store-postgres adapter, O-117)", () => {
  it.each([
    ["no query", REMOTE, REMOTE],
    ["only TLS parameters", `${REMOTE}?sslmode=require&ssl=true`, REMOTE],
    [
      "TLS parameters among others",
      `${REMOTE}?application_name=a&sslmode=require&connect_timeout=5`,
      `${REMOTE}?application_name=a&connect_timeout=5`,
    ],
    [
      "a fragment before any query",
      `${REMOTE}#x?sslmode=disable`,
      `${REMOTE}#x?sslmode=disable`,
    ],
    [
      "the socket directory form",
      "/var/run/postgresql postgres",
      "/var/run/postgresql postgres",
    ],
  ])("%s", (_, input, output) => {
    expect(withoutTlsParameters(input)).toBe(output);
  });
});
