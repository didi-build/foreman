// Seam: the deploy adapter's Cloudflare target (./cloudflare-staging.ts), the D1 migrations a
// staging deploy applies before it uploads (unit with a fake Cloudflare account behind the HTTP
// port, ADR 0118 slice 8, D-445, O-165). For a build with a Worker and migration files, after the
// core's required-secret check and before the upload: the database by the setup's exact-name
// lookup, then Wrangler's `d1_migrations` table, the names it records, and each file it does not
// record, in name order, one query each with its record, exactly as Wrangler sends it, all with
// the D1 token on `D1_ALLOWED_CALLS`. Applied twice, nothing is applied the second time. A
// migration D1 refuses as SQL is the build's own failure (`file_set`, `migration_failed`), naming
// the file, the call, the status and the codes and nothing else, unless another deploy recorded it
// meanwhile; every other refusal is infrastructure and sends nothing after it. A held deploy, and
// a build with no migration file, make no D1 call. No SQL text, row or D1 message reaches a
// result or a log. Fake tokens, ids and SQL only.
import { afterEach, describe, expect, it, vi } from "vitest";

import { storedZip, type ZipFixtureEntry } from "../../../test/zip-fixture.ts";
import { readDeployRefusal } from "../../core/guards/evidence.ts";
import type { StagingRefusal } from "../../core/staging-deploy.ts";
import type { Project } from "../../core/store.ts";
import {
  ALLOWED_CALLS,
  assertAllowedCall,
  CLOUDFLARE_REFUSALS,
  CREATE_MIGRATIONS_TABLE,
  createCloudflareStagingTarget,
  D1_ALLOWED_CALLS,
  LIST_MIGRATIONS,
  migrationFailedText,
  type CloudflareAnswer,
  type CloudflareRequest,
} from "./cloudflare-staging.ts";
import { SITE_REFUSALS } from "./site-files.ts";

const COMMIT = "c".repeat(40);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
/** Not real tokens: the shape the adapter accepts, one per allow-list. */
const STAGING_TOKEN = "fake-staging-token-for-tests-0123456789";
const D1_TOKEN = "fake-d1-token-for-tests-0123456789";
const SESSION_JWT = "fake.session.jwt";
/** A made-up database id, as D1 gives `uuid`. */
const DB_ID = "11111111-2222-4333-8444-555555555555";
const PROJECT = { slug: "demo", repo: "didi-build/demo" } as Project;
const DATABASE = "demo-staging";
const QUERY = `/d1/database/${DB_ID}/query`;

/** Made-up row data and D1 words that must never leave the fake account. */
const ROW_DATA = "row-data-never-shown-0123456789";
const D1_MESSAGE = 'near "CREAT": syntax error at offset 0: SQLITE_ERROR';

const INIT = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);";
const MORE =
  "-- a comment first: adds a tag to each note\nALTER TABLE notes ADD tag TEXT;";
const THIRD = "CREATE INDEX notes_tag ON notes (tag);";
/** A migration the fake database refuses as SQL. */
const BROKEN = "CREAT TABLE broken (id INTEGER);";

const MANIFEST = JSON.stringify({
  schema: 1,
  compatibilityDate: "2026-11-02",
  compatibilityFlags: [],
  requiredSecrets: [],
});

/** A build in the new layout with these migration files, named in the zip in any order. */
const build = (migrations: Record<string, string | Uint8Array>) =>
  storedZip([
    { name: "foreman-deploy.json", data: MANIFEST },
    { name: "assets/foreman-commit.txt", data: `${COMMIT}\n` },
    { name: "assets/index.html", data: "<!doctype html><title>demo</title>" },
    { name: "worker/index.js", data: "export default { fetch() {} };" },
    ...Object.entries(migrations).map(([name, data]): ZipFixtureEntry => ({
      name: `migrations/${name}`,
      data,
    })),
  ]);

const ok = (result: unknown, status = 200): CloudflareAnswer => ({
  status,
  body: { success: true, errors: [], messages: [], result },
});
const refused = (status: number, ...codes: number[]): CloudflareAnswer => ({
  status,
  body: {
    success: false,
    errors: codes.map((code) => ({
      code,
      message: `${D1_MESSAGE} ${ROW_DATA} ${DB_ID}`,
    })),
    messages: [],
    result: [],
  },
});
/** One statement's entry in a query's `result`, with meta and rows the adapter never returns. */
const statement = (results: unknown[] = []) => ({
  results,
  success: true,
  meta: { changes: 1, rows_read: 1, rows_written: 1, served_by_region: "ENAM" },
});

/** Wrangler's record of one migration, the last two lines of each apply query. */
const record = (name: string) =>
  `\nINSERT INTO "d1_migrations" (name)\nvalues ('${name}');`;

/**
 * A fake Cloudflare account with one D1 database of the project's name, as the API reference
 * answers: the list by name, the query (Wrangler's table, its names, and each migration with its
 * record, a statement whose text holds `CREAT TABLE` refused as SQL with code 7500 and nothing
 * recorded), and the three upload calls. `override` answers a request instead. Every request is
 * kept.
 */
function fakeAccount(
  state: { databases?: { name: string; uuid: string }[]; recorded?: string[] } = {},
  override?: (request: CloudflareRequest) => CloudflareAnswer | "throw" | undefined,
) {
  const databases = state.databases ?? [{ name: DATABASE, uuid: DB_ID }];
  let table: string[] | null = state.recorded ? [...state.recorded] : null;
  const sent: CloudflareRequest[] = [];
  const http = {
    async send(request: CloudflareRequest): Promise<CloudflareAnswer> {
      sent.push(structuredClone(request));
      const answer = override?.(request);
      if (answer === "throw") throw new Error(`fetch failed ${ROW_DATA}`);
      if (answer) return answer;
      const path = request.path.replace(`/accounts/${ACCOUNT}`, "");
      if (request.method === "GET" && path.startsWith("/d1/database?")) {
        const name =
          new URL(`https://api.example${path}`).searchParams.get("name") ?? "";
        return ok(databases.filter((d) => d.name.includes(name)));
      }
      if (path === QUERY) {
        const { sql } = request.json as { sql: string };
        if (sql === CREATE_MIGRATIONS_TABLE) {
          table ??= [];
          return ok([statement()]);
        }
        if (sql === LIST_MIGRATIONS) {
          if (table === null) return refused(400, 7500);
          // Every column and a stray one, which the adapter must not read or return.
          return ok([
            statement(
              table.map((name, i) => ({
                id: i + 1,
                name,
                applied_at: "2026-11-22 10:00:00",
                note: ROW_DATA,
              })),
            ),
          ]);
        }
        const name =
          /\nINSERT INTO "d1_migrations" \(name\)\nvalues \('([^']+)'\);$/.exec(
            sql,
          )?.[1];
        if (!name || table === null) return { status: 400, body: null };
        if (sql.includes("CREAT TABLE") || table.includes(name))
          return refused(400, 7500);
        table.push(name);
        return ok([statement([{ note: ROW_DATA }]), statement()]);
      }
      if (path.endsWith("/assets-upload-session"))
        return ok({ jwt: SESSION_JWT, buckets: [] });
      if (path.startsWith("/workers/scripts/")) return ok({ id: "demo-staging" });
      return { status: 404, body: null };
    },
  };
  return {
    sent,
    http,
    /** What the database records now. */
    recorded: () => table,
  };
}

/** Every request any test here sent, for the allow-list check at the end. */
const everySent: CloudflareRequest[] = [];

async function deploy(
  account: ReturnType<typeof fakeAccount>,
  archive: Uint8Array,
  options: {
    d1?: () => Promise<unknown>;
    beforeWorkerUpload?: () => Promise<StagingRefusal | null>;
  } = {},
) {
  const reads = { staging: 0, d1: 0 };
  const log: string[] = [];
  const target = createCloudflareStagingTarget({
    credentials: {
      read: async () => (reads.staging++, { accountId: ACCOUNT, token: STAGING_TOKEN }),
    },
    d1Credentials: {
      read: async () => {
        reads.d1++;
        log.push("d1 credential");
        return (options.d1?.() ?? { accountId: ACCOUNT, token: D1_TOKEN }) as never;
      },
    },
    http: {
      send: async (request) => {
        log.push(request.path.includes("/d1/") ? "d1" : "upload");
        try {
          return await account.http.send(request);
        } finally {
          everySent.push(structuredClone(request));
        }
      },
    },
  });
  const before = account.sent.length;
  const result = await target.deploy({
    project: PROJECT,
    commitSha: COMMIT,
    archive,
    beforeWorkerUpload: async () => {
      log.push("required secrets");
      return (await options.beforeWorkerUpload?.()) ?? null;
    },
  });
  return { result, reads, log, sent: account.sent.slice(before) };
}

/** The calls in order, without the account: method, path, which token, and the SQL sent to D1. */
const calls = (sent: CloudflareRequest[]) =>
  sent.map((r) => {
    const token =
      { [STAGING_TOKEN]: "staging", [D1_TOKEN]: "d1", [SESSION_JWT]: "jwt" }[
        r.bearer
      ] ?? "?";
    const path = r.path.replace(`/accounts/${ACCOUNT}`, "");
    return path === QUERY
      ? `${r.method} query ${token} ${(r.json as { sql: string }).sql.split("\n")[0]}`
      : `${r.method} ${path} ${token}`;
  });

const LIST_DB = `GET /d1/database?name=${DATABASE}&per_page=100 d1`;
const TABLE = 'POST query d1 CREATE TABLE IF NOT EXISTS "d1_migrations"(';
const LIST = 'POST query d1 SELECT name FROM "d1_migrations" ORDER BY id';
const UPLOAD = [
  `POST /workers/scripts/${DATABASE}/assets-upload-session staging`,
  `PUT /workers/scripts/${DATABASE}?bindings_inherit=strict staging`,
];

afterEach(() => vi.restoreAllMocks());

describe("a staging deploy's D1 migrations (unit, fake account, ADR 0118 slice 8, O-165)", () => {
  it("applies the new files in name order, each with its record, after the secrets and before the upload, exactly", async () => {
    const account = fakeAccount();
    // Named in the zip out of order: the deploy applies them by name.
    const { result, reads, log, sent } = await deploy(
      account,
      build({ "0002_more.sql": MORE, "0001_init.sql": INIT }),
    );
    expect(result).toEqual({
      outcome: "deployed",
      files: 2,
      worker: { requiredSecrets: [] },
      migrationsApplied: ["0001_init.sql", "0002_more.sql"],
    });
    expect(calls(sent)).toEqual([
      LIST_DB,
      TABLE,
      LIST,
      "POST query d1 CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);",
      "POST query d1 -- a comment first: adds a tag to each note",
      ...UPLOAD,
    ]);
    // The order of a deploy: the required secrets, then D1, then the upload.
    expect(log).toEqual([
      "required secrets",
      "d1 credential",
      "d1",
      "d1",
      "d1",
      "d1",
      "d1",
      "upload",
      "upload",
    ]);
    expect(reads).toEqual({ staging: 1, d1: 1 });
    // Wrangler 4.160.1's table, byte for byte (`getCreateMigrationsTableQuery`), its names only,
    // and each file with Wrangler's record (`buildMigrationQuery`): one JSON body of `sql` alone.
    expect(sent[1]?.json).toEqual({
      sql: 'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);',
    });
    expect(sent[2]?.json).toEqual({
      sql: 'SELECT name FROM "d1_migrations" ORDER BY id',
    });
    expect(sent[3]?.json).toEqual({ sql: `${INIT}${record("0001_init.sql")}` });
    expect(sent[4]?.json).toEqual({ sql: `${MORE}${record("0002_more.sql")}` });
    for (const request of sent.slice(1, 5)) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe(`/accounts/${ACCOUNT}${QUERY}`);
      expect(Object.keys(request.json as object)).toEqual(["sql"]);
      expect(request.form).toBeUndefined();
    }
    expect(account.recorded()).toEqual(["0001_init.sql", "0002_more.sql"]);
    // The upload carries no migration: the SQL goes to D1 only.
    expect(JSON.stringify(sent.slice(5))).not.toContain("CREATE TABLE");
  });

  it("applies nothing the second time, and only a new file after that, skipping names it does not hold", async () => {
    // A name Wrangler recorded by hand, which the build does not hold, is left alone.
    const account = fakeAccount({ recorded: ["0000_by_hand.sql"] });
    const files = { "0001_init.sql": INIT, "0002_more.sql": MORE };
    expect((await deploy(account, build(files))).result).toMatchObject({
      migrationsApplied: ["0001_init.sql", "0002_more.sql"],
    });
    const again = await deploy(account, build(files));
    expect(again.result).toMatchObject({ outcome: "deployed", migrationsApplied: [] });
    expect(calls(again.sent)).toEqual([LIST_DB, TABLE, LIST, ...UPLOAD]);
    const next = await deploy(account, build({ ...files, "0003_index.sql": THIRD }));
    expect(next.result).toMatchObject({ migrationsApplied: ["0003_index.sql"] });
    expect(calls(next.sent)).toEqual([
      LIST_DB,
      TABLE,
      LIST,
      "POST query d1 CREATE INDEX notes_tag ON notes (tag);",
      ...UPLOAD,
    ]);
    expect(account.recorded()).toEqual([
      "0000_by_hand.sql",
      "0001_init.sql",
      "0002_more.sql",
      "0003_index.sql",
    ]);
  });

  it("applies no migration and reads no D1 credential for a deploy the required-secret check holds", async () => {
    const account = fakeAccount();
    const hold: StagingRefusal = {
      outcome: "refused",
      cause: "infrastructure",
      reason: "secrets_missing",
      text: "the build needs product secrets not set on the staging Worker: MODEL_API_KEY. Set each with the Set project secret form",
      missingSecrets: ["MODEL_API_KEY"],
    };
    const held = await deploy(account, build({ "0001_init.sql": INIT }), {
      beforeWorkerUpload: async () => hold,
    });
    expect(held.result).toEqual(hold);
    expect(held.sent).toEqual([]);
    expect(held.reads).toEqual({ staging: 0, d1: 0 });
    expect(account.recorded()).toBeNull();
  });

  it("refuses a migration D1 refuses as SQL as the build's own failure, naming the file only, and applies and uploads nothing after it", async () => {
    const account = fakeAccount();
    const files = {
      "0001_init.sql": INIT,
      "0002_broken.sql": BROKEN,
      "0003_index.sql": THIRD,
    };
    const { result, sent } = await deploy(account, build(files));
    expect(result).toEqual({
      outcome: "refused",
      cause: "file_set",
      reason: "migration_failed",
      text: "the migration 0002_broken.sql failed on the staging database; nothing after it was applied or uploaded",
      detail: { call: "migration_apply", status: 400, codes: [7500] },
    });
    // The names read again before it is called a failure; nothing after it, and no upload.
    expect(calls(sent)).toEqual([
      LIST_DB,
      TABLE,
      LIST,
      "POST query d1 CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);",
      "POST query d1 CREAT TABLE broken (id INTEGER);",
      LIST,
    ]);
    expect(account.recorded()).toEqual(["0001_init.sql"]);
    // The core records it and shows it as any refused deploy: a short code and plain text.
    expect(readDeployRefusal(result as never)).toEqual({
      reason: "migration_failed",
      text: (result as StagingRefusal).text,
    });
    expect(JSON.stringify(result)).not.toMatch(/CREAT|SQLITE|syntax|row-data|11111111/);

    // The builder fixes the file; the next deploy applies it and the one after it, then uploads.
    const fixed = await deploy(
      account,
      build({ ...files, "0002_broken.sql": "CREATE TABLE fixed (id INTEGER);" }),
    );
    expect(fixed.result).toMatchObject({
      outcome: "deployed",
      migrationsApplied: ["0002_broken.sql", "0003_index.sql"],
    });
    expect(account.recorded()).toEqual([
      "0001_init.sql",
      "0002_broken.sql",
      "0003_index.sql",
    ]);
  });

  it("keeps every text within what the daily check shows, a failed migration's for the longest name a build may hold", () => {
    const name = `${"a".repeat(96)}.sql`;
    const text = migrationFailedText(name);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(readDeployRefusal({ reason: "migration_failed", text })).toEqual({
      reason: "migration_failed",
      text,
    });
    for (const [reason, fixed] of Object.entries(CLOUDFLARE_REFUSALS)) {
      expect(readDeployRefusal({ reason, text: fixed }), reason).toEqual({
        reason,
        text: fixed,
      });
    }
  });

  it("goes on when another deploy recorded the file meanwhile, so a race is no failure", async () => {
    // Another deploy applies 0002 between this one's list and its apply: D1 then refuses the
    // second record as SQL (its name is unique), and rolls the whole query back.
    let raced = false;
    const account = fakeAccount({}, (request) => {
      const sql = (request.json as { sql?: string } | undefined)?.sql ?? "";
      if (!raced && sql.endsWith(record("0002_more.sql"))) {
        raced = true;
        account.recorded()?.push("0002_more.sql");
      }
      return undefined;
    });
    const { result, sent } = await deploy(
      account,
      build({ "0001_init.sql": INIT, "0002_more.sql": MORE, "0003_index.sql": THIRD }),
    );
    expect(result).toMatchObject({
      outcome: "deployed",
      migrationsApplied: ["0001_init.sql", "0003_index.sql"],
    });
    expect(calls(sent).filter((c) => c === LIST)).toHaveLength(2);
    expect(account.recorded()).toEqual([
      "0001_init.sql",
      "0002_more.sql",
      "0003_index.sql",
    ]);
  });

  it("refuses as infrastructure, naming the call, its status and codes, at every other refusal of a D1 call, sending nothing after it", async () => {
    const files = { "0001_init.sql": INIT, "0002_more.sql": MORE };
    // Which request to refuse: the database list, the table, the names, or the first apply.
    const at = {
      database_list: (r: CloudflareRequest) => r.method === "GET",
      migrations_table: (r: CloudflareRequest) =>
        (r.json as { sql?: string } | undefined)?.sql === CREATE_MIGRATIONS_TABLE,
      migrations_list: (r: CloudflareRequest) =>
        (r.json as { sql?: string } | undefined)?.sql === LIST_MIGRATIONS,
      migration_apply: (r: CloudflareRequest) =>
        (r.json as { sql?: string } | undefined)?.sql?.startsWith(INIT) === true,
    };
    const cases: [
      keyof typeof at,
      CloudflareAnswer | "throw",
      string,
      number | undefined,
      number[]?,
    ][] = [
      [
        "database_list",
        refused(401, 10000),
        "database_credential_refused",
        401,
        [10000],
      ],
      ["database_list", refused(429, 7429), "cloudflare_unavailable", 429, [7429]],
      ["database_list", "throw", "cloudflare_unreachable", undefined],
      [
        "migrations_table",
        refused(403, 7403),
        "database_credential_refused",
        403,
        [7403],
      ],
      ["migrations_table", refused(400, 7500), "cloudflare_refused", 400, [7500]],
      ["migrations_table", refused(500, 7500), "cloudflare_unavailable", 500, [7500]],
      ["migrations_list", refused(400, 7500), "cloudflare_refused", 400, [7500]],
      ["migrations_list", refused(503), "cloudflare_unavailable", 503, []],
      ["migration_apply", refused(404, 7404), "cloudflare_refused", 404, [7404]],
      [
        "migration_apply",
        refused(400, 7500, 7429),
        "cloudflare_refused",
        400,
        [7500, 7429],
      ],
      ["migration_apply", refused(400, 7406), "cloudflare_refused", 400, [7406]],
      ["migration_apply", refused(422, 7500), "cloudflare_refused", 422, [7500]],
      ["migration_apply", refused(500, 7500), "cloudflare_unavailable", 500, [7500]],
      [
        "migration_apply",
        refused(401, 10000),
        "database_credential_refused",
        401,
        [10000],
      ],
      ["migration_apply", "throw", "cloudflare_unreachable", undefined],
    ];
    for (const [call, answer, reason, status, codes] of cases) {
      const account = fakeAccount({}, (r) => (at[call](r) ? answer : undefined));
      const { result, sent } = await deploy(account, build(files));
      const label = `${call} ${reason} ${status}`;
      expect(result, label).toEqual({
        outcome: "refused",
        cause: "infrastructure",
        reason,
        text: CLOUDFLARE_REFUSALS[reason as keyof typeof CLOUDFLARE_REFUSALS],
        detail: {
          call,
          ...(status === undefined ? {} : { status }),
          ...(codes?.length ? { codes } : {}),
        },
      });
      // The refused request was the last one sent: no name read again, no upload.
      expect(at[call](sent.at(-1) as CloudflareRequest), label).toBe(true);
      expect(
        sent.some((r) => !r.path.includes("/d1/")),
        label,
      ).toBe(false);
      expect(JSON.stringify(result), label).not.toMatch(
        /SQLITE|syntax|row-data|11111111/,
      );
    }
  });

  it("refuses answers in a shape the docs do not give as infrastructure, never as the build's failure", async () => {
    const files = { "0001_init.sql": INIT };
    const isQuery = (r: CloudflareRequest) => r.path.endsWith("/query");
    const sqlOf = (r: CloudflareRequest) =>
      (r.json as { sql?: string } | undefined)?.sql;
    for (const [label, override, call] of [
      [
        "no result list",
        (r: CloudflareRequest) => (isQuery(r) ? ok({}) : undefined),
        "migrations_table",
      ],
      [
        "an empty result list",
        (r: CloudflareRequest) => (isQuery(r) ? ok([]) : undefined),
        "migrations_table",
      ],
      [
        "a statement that did not succeed",
        (r: CloudflareRequest) =>
          sqlOf(r)?.startsWith(INIT)
            ? ok([{ ...statement(), success: false }])
            : undefined,
        "migration_apply",
      ],
      [
        "names that are no rows",
        (r: CloudflareRequest) =>
          sqlOf(r) === LIST_MIGRATIONS ? ok([statement(["0001_init.sql"])]) : undefined,
        "migrations_list",
      ],
      [
        "no rows at all",
        (r: CloudflareRequest) =>
          sqlOf(r) === LIST_MIGRATIONS ? ok([{ success: true }]) : undefined,
        "migrations_list",
      ],
      [
        "success false with 200",
        (r: CloudflareRequest) =>
          sqlOf(r)?.startsWith(INIT)
            ? { status: 200, body: { success: false, errors: [{ code: 7500 }] } }
            : undefined,
        "migration_apply",
      ],
    ] as const) {
      const account = fakeAccount({}, override);
      const { result, sent } = await deploy(account, build(files));
      expect(result, label).toMatchObject({
        outcome: "refused",
        cause: "infrastructure",
        reason: "unexpected_answer",
        detail: { call },
      });
      expect(
        sent.some((r) => !r.path.includes("/d1/")),
        label,
      ).toBe(false);
    }
  });

  it("holds as infrastructure, sending nothing more, when the database or the D1 credential is missing, ambiguous or malformed", async () => {
    const files = { "0001_init.sql": INIT };
    const none = await deploy(fakeAccount({ databases: [] }), build(files));
    expect(none.result).toEqual({
      outcome: "refused",
      cause: "infrastructure",
      reason: "database_missing",
      text: CLOUDFLARE_REFUSALS.database_missing,
      detail: { call: "database_list" },
    });
    expect(none.result).toMatchObject({
      text: expect.stringContaining("New project form"),
    });
    expect(calls(none.sent)).toEqual([LIST_DB]);
    // A database whose name only holds the project's is no match.
    const like = await deploy(
      fakeAccount({ databases: [{ name: `${DATABASE}-old`, uuid: DB_ID }] }),
      build(files),
    );
    expect(like.result).toMatchObject({ reason: "database_missing" });
    const two = await deploy(
      fakeAccount({
        databases: [
          { name: DATABASE, uuid: DB_ID },
          { name: DATABASE, uuid: "99999999-8888-4777-8666-555555555555" },
        ],
      }),
      build(files),
    );
    expect(two.result).toMatchObject({
      cause: "infrastructure",
      reason: "database_ambiguous",
      text: CLOUDFLARE_REFUSALS.database_ambiguous,
    });
    expect(calls(two.sent)).toEqual([LIST_DB]);
    for (const [d1, reason] of [
      [
        () => Promise.reject(new Error(`no token ${ROW_DATA}`)),
        "database_credential_unavailable",
      ],
      [
        async () => ({ accountId: ACCOUNT, token: "short" }),
        "database_credential_malformed",
      ],
    ] as const) {
      const { result, sent, reads } = await deploy(fakeAccount(), build(files), { d1 });
      expect(result).toEqual({
        outcome: "refused",
        cause: "infrastructure",
        reason,
        text: CLOUDFLARE_REFUSALS[reason],
      });
      expect(sent).toEqual([]);
      expect(reads.staging).toBe(0);
    }
  });

  it("refuses a migration over D1's statement length, a set over the runner's bound, or one not UTF-8, before anything is read or sent", async () => {
    for (const [files, reason] of [
      [{ "0001_big.sql": `-- ${"x".repeat(100_000)}` }, "migration_too_large"],
      [
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [
            `${String(i).padStart(4, "0")}_m.sql`,
            `-- ${"x".repeat(99_990)}`,
          ]),
        ),
        "migrations_too_large",
      ],
      [
        { "0001_bytes.sql": new Uint8Array([0x2d, 0x2d, 0x20, 0xff, 0xfe]) },
        "migration_not_text",
      ],
    ] as const) {
      const account = fakeAccount();
      const { result, sent, reads } = await deploy(account, build(files));
      expect(result, reason).toEqual({
        outcome: "refused",
        cause: "file_set",
        reason,
        text: SITE_REFUSALS[reason],
      });
      expect(sent).toEqual([]);
      expect(reads).toEqual({ staging: 0, d1: 0 });
    }
  });

  it("never puts SQL, a row or D1's message in a result or a log, whatever D1 answers", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
    }
    const writes = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => (logged.push(String(chunk)), true));
    const files = { "0001_init.sql": INIT, "0002_broken.sql": BROKEN };
    const results: unknown[] = [];
    for (const override of [
      undefined,
      () => refused(400, 7500),
      () => refused(500, 7500),
      () => "throw" as const,
    ]) {
      const account = fakeAccount({ recorded: [] }, override);
      results.push((await deploy(account, build(files))).result);
    }
    writes.mockRestore();
    expect(logged).toEqual([]);
    const shown = JSON.stringify(results);
    for (const secret of [
      INIT,
      BROKEN,
      "CREATE TABLE",
      "INSERT",
      "d1_migrations",
      ROW_DATA,
      "SQLITE",
      DB_ID,
      D1_TOKEN,
    ]) {
      expect(shown, secret).not.toContain(secret);
    }
  });

  it("sent every D1 request with the D1 token on D1_ALLOWED_CALLS, and every other with the staging token on its own", () => {
    expect(everySent.some((r) => r.path.endsWith("/query"))).toBe(true);
    for (const request of everySent) {
      const d1 = request.path.includes("/d1/");
      expect(request.bearer, request.path).toBe(
        d1
          ? D1_TOKEN
          : request.path.includes("/assets/upload")
            ? SESSION_JWT
            : STAGING_TOKEN,
      );
      expect(() =>
        assertAllowedCall(request, d1 ? D1_ALLOWED_CALLS : ALLOWED_CALLS),
      ).not.toThrow();
      expect(
        () => assertAllowedCall(request, d1 ? ALLOWED_CALLS : D1_ALLOWED_CALLS),
        request.path,
      ).toThrow(/may not send/);
      // A query carries `sql` alone: no `params` and no batch.
      if (request.path.endsWith("/query")) {
        expect(Object.keys(request.json as object)).toEqual(["sql"]);
      }
    }
  });
});
