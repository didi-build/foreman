// Seam: the deploy adapter's Cloudflare target (./cloudflare-staging.ts), its setup of a new
// project and its secret calls (unit with a fake Cloudflare account behind the HTTP port, ADR 0118
// slice 4, D-438, D-440, D-445, D-447, O-160). The setup finds before it creates: the database by
// its exact name with the D1 token, made with the `enam` hint only when absent, then the Worker
// by Cloudflare's list with the staging deploy token, the placeholder uploaded only when absent,
// with its exact multipart body and `DB` bound to that database's id. Running it again makes
// nothing twice. The secret calls go to `<slug>-staging` only, with the staging deploy token; a
// bad name or value sends nothing; a value is never in a result, an error or a log. Each token
// has its own allow-list, and no other call is possible with either. Fake tokens and ids only.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSetUpRequest } from "../../core/deploy-target.ts";
import {
  ALLOWED_CALLS,
  assertAllowedCall,
  D1_ALLOWED_CALLS,
  createCloudflareStagingTarget,
  DATABASE_LIST_PAGE,
  SECRET_REFUSALS,
  SECRET_VALUE_MAX_BYTES,
  SETUP_REFUSALS,
  stagingDatabaseName,
  type CloudflareAnswer,
  type CloudflareRequest,
} from "./cloudflare-staging.ts";
import { PLACEHOLDER_MODULE, placeholderPage } from "./placeholder-site.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
/** Not real tokens: the shape the adapter accepts, one per allow-list. */
const STAGING_TOKEN = "fake-staging-token-for-tests-0123456789";
const D1_TOKEN = "fake-d1-token-for-tests-0123456789";
const SESSION_JWT = "fake.session.jwt";
const DONE_JWT = "fake.completion.jwt";
/** Made-up database ids, as D1 gives `uuid`. */
const DB_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
const CREATED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const PROJECT: ProjectSetUpRequest = {
  slug: "demo",
  displayName: 'Demo <App> & "Co"',
  purpose: "Tries 'things' out for the factory.",
};
const NAME = "demo-staging";
/** A made-up secret value that must never leave the one request that carries it. */
const VALUE = "sk-fake-secret-value-never-shown-0123456789";

const ok = (result: unknown, status = 200): CloudflareAnswer => ({
  status,
  body: { success: true, errors: [], messages: [], result },
});
const refused = (status: number, code: number): CloudflareAnswer => ({
  status,
  body: { success: false, errors: [{ code, message: `id ${DB_ID} says no` }] },
});

/** A request as the fake account reads it: its route, its search and its Worker name. */
function route(request: CloudflareRequest): string {
  const path = request.path.replace(`/accounts/${ACCOUNT}`, "");
  return `${request.method} ${path.split("?")[0]?.replace(/scripts\/[^/]+/, "scripts/:w")}`;
}

/**
 * A fake Cloudflare account: D1 databases and Workers it answers from, changed by the calls that
 * make them, as the API reference gives each answer. `override` answers a request instead (a
 * refusal, a throw or an odd shape). Every request is kept. The put's answer echoes the value, as
 * the reference's `result` allows, to show the adapter drops it.
 */
function fakeAccount(
  state: { databases?: { name: string; uuid: string }[]; workers?: string[] } = {},
  override?: (request: CloudflareRequest) => CloudflareAnswer | "throw" | undefined,
) {
  const databases = [...(state.databases ?? [])];
  const workers = new Set(state.workers ?? []);
  const secrets = new Map<string, string[]>();
  const sent: CloudflareRequest[] = [];
  let made = 0;
  const http = {
    async send(request: CloudflareRequest): Promise<CloudflareAnswer> {
      sent.push(structuredClone(request));
      const answer = override?.(request);
      if (answer === "throw") throw new Error(`fetch failed for ${VALUE} ${DB_ID}`);
      if (answer) return answer;
      const url = new URL(`https://api.example${request.path}`);
      const worker = /\/workers\/scripts\/([^/?]+)/.exec(url.pathname)?.[1] ?? "";
      switch (route(request)) {
        case "GET /d1/database": {
          // A search: every name holding the one asked for.
          const name = url.searchParams.get("name") ?? "";
          return ok(
            databases
              .filter((d) => d.name.includes(name))
              .map((d) => ({
                ...d,
                created_at: "2026-11-20T00:00:00Z",
                version: "production",
              })),
          );
        }
        case "POST /d1/database": {
          const { name } = request.json as { name: string };
          const uuid = made++ === 0 ? CREATED_ID : OTHER_ID;
          databases.push({ name, uuid });
          return ok({ name, uuid, version: "production", file_size: 0 });
        }
        case "GET /workers/scripts":
          return ok([...workers].map((id) => ({ id, handlers: ["fetch"], tags: [] })));
        case "POST /workers/scripts/:w/assets-upload-session": {
          const manifest = (
            request.json as { manifest: Record<string, { hash: string }> }
          ).manifest;
          return ok({
            jwt: SESSION_JWT,
            buckets: [Object.values(manifest).map((m) => m.hash)],
          });
        }
        case "POST /workers/assets/upload":
          return ok({ jwt: DONE_JWT }, 201);
        case "PUT /workers/scripts/:w":
          workers.add(worker);
          return ok({ id: worker, startup_time_ms: 1 });
        case "PUT /workers/scripts/:w/secrets": {
          const { name, text, type } = request.json as Record<string, string>;
          secrets.set(worker, [...(secrets.get(worker) ?? []), name as string]);
          return ok({ name, text, type });
        }
        case "GET /workers/scripts/:w/secrets":
          return ok(
            (secrets.get(worker) ?? []).map((name) => ({ name, type: "secret_text" })),
          );
        default:
          return { status: 404, body: null };
      }
    },
  };
  return { sent, databases, workers, http };
}

/** Every request any test here sent, for the allow-list checks at the end. */
const everySent: CloudflareRequest[] = [];

function targetFor(
  account: ReturnType<typeof fakeAccount>,
  creds: { staging?: () => Promise<unknown>; d1?: () => Promise<unknown> } = {},
) {
  const reads = { staging: 0, d1: 0 };
  const target = createCloudflareStagingTarget({
    credentials: {
      read: async () => {
        reads.staging++;
        return (creds.staging?.() ?? {
          accountId: ACCOUNT,
          token: STAGING_TOKEN,
        }) as never;
      },
    },
    d1Credentials: {
      read: async () => {
        reads.d1++;
        return (creds.d1?.() ?? { accountId: ACCOUNT, token: D1_TOKEN }) as never;
      },
    },
    http: {
      send: async (request) => {
        try {
          return await account.http.send(request);
        } finally {
          everySent.push(structuredClone(request));
        }
      },
    },
  });
  return { target, reads };
}

/** The calls in order, without the account: method, path and which token or JWT they carried. */
const calls = (sent: CloudflareRequest[]) =>
  sent.map((r) => [
    r.method,
    r.path.replace(`/accounts/${ACCOUNT}`, ""),
    { [STAGING_TOKEN]: "staging", [D1_TOKEN]: "d1", [SESSION_JWT]: "jwt" }[r.bearer] ??
      "?",
  ]);

const guideHash = (path: string, content: string) =>
  createHash("sha256")
    .update(Buffer.from(content).toString("base64") + path.split(".").pop())
    .digest("hex")
    .slice(0, 32);

const LIST_DB = `/d1/database?name=${NAME}&per_page=100`;

afterEach(() => vi.restoreAllMocks());

describe("a new project's setup on Cloudflare (unit, fake account, ADR 0118 appendix C, O-160)", () => {
  it("creates the database with the enam hint, then uploads the placeholder bound to it, exactly", async () => {
    const account = fakeAccount();
    const { target } = targetFor(account);
    expect(await target.setUp(PROJECT)).toEqual({
      outcome: "set_up",
      database: "created",
      placeholder: "uploaded",
    });
    expect(calls(account.sent)).toEqual([
      ["GET", LIST_DB, "d1"],
      ["POST", "/d1/database", "d1"],
      ["GET", "/workers/scripts", "staging"],
      ["POST", `/workers/scripts/${NAME}/assets-upload-session`, "staging"],
      ["POST", "/workers/assets/upload?base64=true", "jwt"],
      ["PUT", `/workers/scripts/${NAME}`, "staging"],
    ]);
    const [, create, , session, upload, worker] = account.sent;
    // The create body: the name and the location hint (D-447), nothing else.
    expect(create?.json).toEqual({ name: NAME, primary_location_hint: "enam" });
    expect(create?.form).toBeUndefined();
    // The placeholder's one asset: its page, escaped (./placeholder-site.ts).
    const page = placeholderPage(PROJECT.displayName, PROJECT.purpose);
    const hash = guideHash("index.html", page);
    expect(session?.json).toEqual({
      manifest: { "/index.html": { hash, size: Buffer.byteLength(page) } },
    });
    expect(upload?.form).toEqual([
      {
        name: hash,
        filename: hash,
        contentType: "text/html; charset=utf-8",
        value: Buffer.from(page).toString("base64"),
      },
    ]);
    // The Worker: its metadata with `DB` bound by the new database's id, then the module.
    expect(worker?.form).toEqual([
      {
        name: "metadata",
        value: JSON.stringify({
          main_module: "index.js",
          bindings: [{ type: "d1", name: "DB", database_id: CREATED_ID }],
          compatibility_date: "2026-10-26",
          compatibility_flags: [],
          keep_bindings: ["secret_text", "secret_key"],
          assets: {
            jwt: DONE_JWT,
            config: {
              not_found_handling: "single-page-application",
              run_worker_first: ["/api/*"],
            },
          },
        }),
      },
      {
        name: "index.js",
        filename: "index.js",
        contentType: "application/javascript+module",
        value: PLACEHOLDER_MODULE,
      },
    ]);
    // The id goes into that binding only: not into the result, the path or any other request.
    const others = account.sent.filter((r) => r !== worker);
    expect(JSON.stringify(others)).not.toContain(CREATED_ID);
    expect(stagingDatabaseName("demo")).toBe(NAME);
  });

  it("reuses the database Cloudflare lists under the exact name, and never one with a name like it", async () => {
    const account = fakeAccount({
      databases: [
        { name: "demo-staging-old", uuid: OTHER_ID },
        { name: "old-demo-staging", uuid: OTHER_ID },
        { name: NAME, uuid: DB_ID },
      ],
    });
    const { target } = targetFor(account);
    expect(await target.setUp(PROJECT)).toEqual({
      outcome: "set_up",
      database: "found",
      placeholder: "uploaded",
    });
    expect(account.sent.map((r) => r.method + " " + r.path)).not.toContain(
      `POST /accounts/${ACCOUNT}/d1/database`,
    );
    const metadata = JSON.parse(
      (account.sent.at(-1)?.form?.[0] as { value: string }).value,
    );
    expect(metadata.bindings).toEqual([{ type: "d1", name: "DB", database_id: DB_ID }]);
    expect(JSON.stringify(account.sent)).not.toContain(OTHER_ID);
  });

  it("creates the database when Cloudflare lists only names like it, and binds the new one", async () => {
    const account = fakeAccount({
      databases: [
        { name: "demo-staging-old", uuid: OTHER_ID },
        { name: "xdemo-staging", uuid: OTHER_ID },
      ],
    });
    const { target } = targetFor(account);
    expect(await target.setUp(PROJECT)).toMatchObject({ database: "created" });
    const metadata = JSON.parse(
      (account.sent.at(-1)?.form?.[0] as { value: string }).value,
    );
    expect(metadata.bindings).toEqual([
      { type: "d1", name: "DB", database_id: CREATED_ID },
    ]);
    expect(JSON.stringify(account.sent)).not.toContain(OTHER_ID);
  });

  it("refuses when two databases have the exact name, or a full page has none of it, creating nothing", async () => {
    for (const databases of [
      [
        { name: NAME, uuid: DB_ID },
        { name: NAME, uuid: OTHER_ID },
      ],
      Array.from({ length: DATABASE_LIST_PAGE }, (_, i) => ({
        name: `demo-staging-${i}`,
        uuid: OTHER_ID,
      })),
    ]) {
      const account = fakeAccount({ databases });
      const { target, reads } = targetFor(account);
      expect(await target.setUp(PROJECT)).toEqual({
        outcome: "refused",
        step: "database",
        reason: "database_ambiguous",
        text: SETUP_REFUSALS.database_ambiguous,
        detail: { call: "database_list", status: 200 },
      });
      expect(calls(account.sent)).toEqual([["GET", LIST_DB, "d1"]]);
      expect(reads.staging).toBe(0);
    }
  });

  it("keeps a Worker that exists, so a re-run never replaces a real build, and makes nothing twice", async () => {
    // A Worker already there: a real build, or an earlier run's placeholder.
    const existing = fakeAccount({
      databases: [{ name: NAME, uuid: DB_ID }],
      workers: [NAME],
    });
    expect(await targetFor(existing).target.setUp(PROJECT)).toEqual({
      outcome: "set_up",
      database: "found",
      placeholder: "kept",
    });
    expect(calls(existing.sent)).toEqual([
      ["GET", LIST_DB, "d1"],
      ["GET", "/workers/scripts", "staging"],
    ]);
    // A second run after a first that made both finds both and sends no create or upload.
    const account = fakeAccount({ workers: ["other-staging", "demo"] });
    const { target } = targetFor(account);
    expect(await target.setUp(PROJECT)).toMatchObject({
      database: "created",
      placeholder: "uploaded",
    });
    const first = account.sent.length;
    expect(await target.setUp(PROJECT)).toEqual({
      outcome: "set_up",
      database: "found",
      placeholder: "kept",
    });
    expect(calls(account.sent.slice(first))).toEqual([
      ["GET", LIST_DB, "d1"],
      ["GET", "/workers/scripts", "staging"],
    ]);
    expect(account.databases).toHaveLength(1);
  });

  it("completes the placeholder on a re-run after the database step passed and the upload failed", async () => {
    let failUpload = true;
    const account = fakeAccount({}, (request) =>
      failUpload && request.method === "PUT" ? refused(500, 10013) : undefined,
    );
    const { target } = targetFor(account);
    expect(await target.setUp(PROJECT)).toEqual({
      outcome: "refused",
      step: "placeholder",
      database: "created",
      reason: "cloudflare_unavailable",
      text: SETUP_REFUSALS.cloudflare_unavailable,
      detail: { call: "worker_upload", status: 500, codes: [10013] },
    });
    failUpload = false;
    expect(await target.setUp(PROJECT)).toEqual({
      outcome: "set_up",
      database: "found",
      placeholder: "uploaded",
    });
    expect(account.databases).toEqual([{ name: NAME, uuid: CREATED_ID }]);
  });

  it("in a dry run only reads, and says what each step would do", async () => {
    for (const [state, expected] of [
      [{}, { database: "would_create", placeholder: "would_upload" }],
      [
        { databases: [{ name: NAME, uuid: DB_ID }] },
        { database: "found", placeholder: "would_upload" },
      ],
      [{ workers: [NAME] }, { database: "would_create", placeholder: "kept" }],
    ] as const) {
      const account = fakeAccount(state as never);
      const { target } = targetFor(account);
      expect(await target.setUp({ ...PROJECT, dryRun: true })).toEqual({
        outcome: "dry_run",
        ...expected,
      });
      expect(account.sent.every((r) => r.method === "GET")).toBe(true);
      expect(account.sent.length).toBeLessThanOrEqual(2);
    }
  });

  it("refuses with fixed text and the call's status and codes at each Cloudflare refusal, sending nothing after it", async () => {
    for (const [failing, answer, step, reason, sentCount] of [
      [
        "GET /d1/database",
        refused(403, 10000),
        "database",
        "database_credential_refused",
        1,
      ],
      [
        "GET /d1/database",
        refused(401, 10001),
        "database",
        "database_credential_refused",
        1,
      ],
      ["GET /d1/database", refused(429, 971), "database", "cloudflare_unavailable", 1],
      ["POST /d1/database", refused(400, 7502), "database", "cloudflare_refused", 2],
      ["POST /d1/database", "throw", "database", "cloudflare_unreachable", 2],
      [
        "GET /workers/scripts",
        refused(403, 10000),
        "placeholder",
        "credential_refused",
        3,
      ],
      [
        "GET /workers/scripts",
        refused(404, 7003),
        "placeholder",
        "cloudflare_refused",
        3,
      ],
      [
        "PUT /workers/scripts/:w",
        refused(400, 10021),
        "placeholder",
        "cloudflare_refused",
        6,
      ],
    ] as const) {
      const account = fakeAccount({}, (request) =>
        route(request) === failing ? answer : undefined,
      );
      const result = await targetFor(account).target.setUp(PROJECT);
      expect(result, `${failing} ${reason}`).toMatchObject({
        outcome: "refused",
        step,
        reason,
        text: SETUP_REFUSALS[reason],
      });
      if (step === "placeholder") expect(result).toMatchObject({ database: "created" });
      const detail = result.outcome === "refused" ? result.detail : undefined;
      if (answer === "throw") expect(detail).toEqual({ call: "database_create" });
      else {
        expect(detail?.status).toBe(answer.status);
        expect(detail?.codes).toEqual([
          (answer.body as { errors: { code: number }[] }).errors[0]?.code,
        ]);
      }
      expect(account.sent, `${failing} ${reason}`).toHaveLength(sentCount);
      // Cloudflare's words and the ids never reach the result.
      expect(JSON.stringify(result)).not.toMatch(/says no|1111|aaaa|fetch failed/);
    }
  });

  it("refuses an answer in a shape the docs do not give, and never reads one as an absent Worker", async () => {
    for (const [failing, answer, call] of [
      ["GET /d1/database", ok({ name: NAME }), "database_list"],
      ["GET /d1/database", ok([{ uuid: DB_ID }]), "database_list"],
      ["GET /d1/database", ok([{ name: NAME, uuid: "not-a-uuid" }]), "database_list"],
      ["GET /d1/database", { status: 200, body: { success: false } }, "database_list"],
      [
        "POST /d1/database",
        ok({ name: "other-staging", uuid: CREATED_ID }),
        "database_create",
      ],
      ["POST /d1/database", ok({ name: NAME }), "database_create"],
      ["GET /workers/scripts", ok([{ id: "other" }, { name: NAME }]), "worker_list"],
      ["GET /workers/scripts", ok([{ id: "" }]), "worker_list"],
      ["GET /workers/scripts", ok({ id: NAME }), "worker_list"],
      ["GET /workers/scripts", { status: 200, body: null }, "worker_list"],
    ] as const) {
      const account = fakeAccount({}, (request) =>
        route(request) === failing ? answer : undefined,
      );
      const result = await targetFor(account).target.setUp(PROJECT);
      expect(result, `${failing} ${JSON.stringify(answer.body)}`).toMatchObject({
        outcome: "refused",
        reason: "unexpected_answer",
        detail: { call, status: 200 },
      });
      // Nothing was uploaded after an answer that could hide a Worker or name another database.
      expect(account.sent.some((r) => r.method === "PUT")).toBe(false);
    }
  });

  it("refuses before anything is read or sent for a bad slug, display name or purpose", async () => {
    for (const [request, reason] of [
      [{ ...PROJECT, slug: "Demo" }, "bad_project"],
      [{ ...PROJECT, slug: "a--b" }, "bad_project"],
      [{ ...PROJECT, slug: "a".repeat(48) }, "bad_project"],
      [{ ...PROJECT, displayName: "" }, "bad_placeholder"],
      [{ ...PROJECT, displayName: "x".repeat(61) }, "bad_placeholder"],
      [{ ...PROJECT, displayName: "two\nlines" }, "bad_placeholder"],
      [{ ...PROJECT, purpose: " padded " }, "bad_placeholder"],
      [{ ...PROJECT, purpose: "x".repeat(201) }, "bad_placeholder"],
    ] as const) {
      const account = fakeAccount();
      const { target, reads } = targetFor(account);
      expect(await target.setUp(request), reason).toEqual({
        outcome: "refused",
        step: "check",
        reason,
        text: SETUP_REFUSALS[reason],
      });
      expect(account.sent).toEqual([]);
      expect(reads).toEqual({ staging: 0, d1: 0 });
    }
  });

  it("refuses on either credential, missing or malformed, sending nothing with it", async () => {
    const missing = () => Promise.reject(new Error(`not built ${D1_TOKEN}`));
    for (const [creds, step, reason, sentCount] of [
      [{ d1: missing }, "database", "database_credential_unavailable", 0],
      [
        { d1: async () => ({ accountId: "x", token: D1_TOKEN }) },
        "database",
        "database_credential_malformed",
        0,
      ],
      [
        { d1: async () => ({ accountId: ACCOUNT, token: "a token" }) },
        "database",
        "database_credential_malformed",
        0,
      ],
      [{ staging: missing }, "placeholder", "credential_unavailable", 2],
      [
        { staging: async () => ({ accountId: ACCOUNT, token: "short" }) },
        "placeholder",
        "credential_malformed",
        2,
      ],
    ] as const) {
      const account = fakeAccount();
      const result = await targetFor(account, creds).target.setUp(PROJECT);
      expect(result, reason).toEqual({
        outcome: "refused",
        step,
        reason,
        text: SETUP_REFUSALS[reason],
        ...(step === "placeholder" ? { database: "created" } : {}),
      });
      expect(account.sent).toHaveLength(sentCount);
      expect(JSON.stringify(result)).not.toContain(D1_TOKEN);
    }
  });
});

describe("product secrets on the staging Worker only (unit, fake account, ADR 0118 appendix D, D-440, O-160)", () => {
  it("puts a secret on <slug>-staging with the staging deploy token, and returns only its name", async () => {
    const account = fakeAccount({ workers: ["rehearsal-staging"] });
    const { target, reads } = targetFor(account);
    expect(await target.putSecret("rehearsal", "MODEL_API_KEY", VALUE)).toEqual({
      outcome: "put",
      name: "MODEL_API_KEY",
    });
    expect(calls(account.sent)).toEqual([
      ["PUT", "/workers/scripts/rehearsal-staging/secrets", "staging"],
    ]);
    expect(account.sent[0]?.json).toEqual({
      name: "MODEL_API_KEY",
      text: VALUE,
      type: "secret_text",
    });
    expect(reads).toEqual({ staging: 1, d1: 0 });
    expect(await target.putSecret("rehearsal", "SESSION_KEY", VALUE)).toMatchObject({
      outcome: "put",
    });
    expect(await target.listSecretNames("rehearsal")).toEqual({
      outcome: "listed",
      names: ["MODEL_API_KEY", "SESSION_KEY"],
    });
    expect(calls(account.sent).at(-1)).toEqual([
      "GET",
      "/workers/scripts/rehearsal-staging/secrets",
      "staging",
    ]);
  });

  it("lists names only, of secret bindings that follow the form's rule, sorted and once each", async () => {
    const listed = [
      { name: "ZED", type: "secret_text" },
      { name: "SIGNING", type: "secret_key", algorithm: { name: "HMAC" } },
      { name: "ZED", type: "secret_text" },
      { name: "lower_case", type: "secret_text" },
      { name: "PLAIN", type: "plain_text", text: VALUE },
      { name: "WITH_TEXT", type: "secret_text", text: VALUE },
    ];
    const account = fakeAccount({}, (request) =>
      request.method === "GET" ? ok(listed) : undefined,
    );
    const result = await targetFor(account).target.listSecretNames("demo");
    expect(result).toEqual({
      outcome: "listed",
      names: ["SIGNING", "WITH_TEXT", "ZED"],
    });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    for (const body of [
      ok({ name: "X" }),
      ok([{ name: 1, type: "secret_text" }]),
      ok([{ name: "X" }]),
    ]) {
      const odd = fakeAccount({}, () => body);
      expect(await targetFor(odd).target.listSecretNames("demo")).toEqual({
        outcome: "refused",
        reason: "unexpected_answer",
        text: SECRET_REFUSALS.unexpected_answer,
        detail: { call: "secret_list", status: 200 },
      });
    }
  });

  it("refuses a bad name, a bad value or a bad slug before any credential is read or anything sent", async () => {
    for (const [slug, name, value, reason] of [
      ["Not A Slug", "MODEL_API_KEY", VALUE, "bad_project"],
      ["demo", "", VALUE, "bad_secret_name"],
      ["demo", "model_api_key", VALUE, "bad_secret_name"],
      ["demo", "1KEY", VALUE, "bad_secret_name"],
      ["demo", "_KEY", VALUE, "bad_secret_name"],
      ["demo", "KEY-1", VALUE, "bad_secret_name"],
      ["demo", "K".repeat(65), VALUE, "bad_secret_name"],
      ["demo", "DB", VALUE, "bad_secret_name"],
      ["demo", "ASSETS", VALUE, "bad_secret_name"],
      ["demo", "MODEL_API_KEY", "", "bad_secret_value"],
      [
        "demo",
        "MODEL_API_KEY",
        "x".repeat(SECRET_VALUE_MAX_BYTES + 1),
        "bad_secret_value",
      ],
      [
        "demo",
        "MODEL_API_KEY",
        "é".repeat(SECRET_VALUE_MAX_BYTES / 2 + 1),
        "bad_secret_value",
      ],
    ] as const) {
      const account = fakeAccount();
      const { target, reads } = targetFor(account);
      const result = await target.putSecret(slug, name, value);
      expect(result, `${slug} ${name} ${reason}`).toEqual({
        outcome: "refused",
        reason,
        text: SECRET_REFUSALS[reason],
      });
      expect(account.sent).toEqual([]);
      expect(reads).toEqual({ staging: 0, d1: 0 });
    }
    const account = fakeAccount();
    expect(await targetFor(account).target.listSecretNames("Not A Slug")).toMatchObject(
      {
        reason: "bad_project",
      },
    );
    expect(account.sent).toEqual([]);
    // At the bound, the value is sent.
    const bound = fakeAccount();
    expect(
      await targetFor(bound).target.putSecret(
        "demo",
        "K".repeat(64),
        "x".repeat(SECRET_VALUE_MAX_BYTES),
      ),
    ).toMatchObject({ outcome: "put" });
  });

  it("never puts the value in a result, an error, a refusal's detail or a log, whatever Cloudflare answers", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
    }
    const writes = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => (logged.push(String(chunk)), true));
    const echo = {
      success: false,
      errors: [{ code: 10007, message: `the secret ${VALUE} was refused` }],
      result: { name: "MODEL_API_KEY", text: VALUE },
    };
    const results: unknown[] = [];
    for (const answer of [
      undefined,
      { status: 400, body: echo },
      { status: 403, body: echo },
      { status: 404, body: echo },
      { status: 500, body: echo },
      { status: 200, body: echo },
      { status: 200, body: { success: true, result: { text: VALUE } } },
      "throw",
    ] as const) {
      const account = fakeAccount({}, () => answer);
      results.push(
        await targetFor(account).target.putSecret("demo", "MODEL_API_KEY", VALUE),
      );
      // The value goes out once, in the put's body, and nowhere else.
      expect(account.sent).toHaveLength(1);
      expect(JSON.stringify({ ...account.sent[0], json: undefined })).not.toContain(
        VALUE,
      );
    }
    const missing = targetFor(fakeAccount(), {
      staging: () => Promise.reject(new Error(`no token, value ${VALUE}`)),
    });
    results.push(await missing.target.putSecret("demo", "MODEL_API_KEY", VALUE));
    writes.mockRestore();
    expect(results.map((r) => (r as { reason?: string }).reason ?? "put")).toEqual([
      "put",
      "cloudflare_refused",
      "credential_refused",
      "cloudflare_refused",
      "cloudflare_unavailable",
      "unexpected_answer",
      "put",
      "cloudflare_unreachable",
      "credential_unavailable",
    ]);
    expect(results[1]).toEqual({
      outcome: "refused",
      reason: "cloudflare_refused",
      text: SECRET_REFUSALS.cloudflare_refused,
      detail: { call: "secret_put", status: 400, codes: [10007] },
    });
    expect(JSON.stringify(results)).not.toContain(VALUE);
    expect(JSON.stringify(results)).not.toMatch(/was refused|no token/);
    expect(JSON.stringify(logged)).not.toContain(VALUE);
    expect(logged).toEqual([]);
  });
});

describe("one allow-list per token (unit: no other call is possible, D-445, O-160)", () => {
  it("sent every D1 request with the D1 token on its list, and every other with the staging token or the JWT on its own", () => {
    expect(everySent.length).toBeGreaterThan(40);
    for (const request of everySent) {
      const d1 = request.bearer === D1_TOKEN;
      expect([D1_TOKEN, STAGING_TOKEN, SESSION_JWT], request.path).toContain(
        request.bearer,
      );
      expect(() =>
        assertAllowedCall(request, d1 ? D1_ALLOWED_CALLS : ALLOWED_CALLS),
      ).not.toThrow();
      expect(
        () => assertAllowedCall(request, d1 ? ALLOWED_CALLS : D1_ALLOWED_CALLS),
        request.path,
      ).toThrow(/may not send/);
      expect(request.path.includes("/d1/"), request.path).toBe(d1);
      // Secrets only ever on a staging Worker.
      if (request.path.includes("/secrets")) {
        expect(request.path).toMatch(
          /\/workers\/scripts\/[a-z0-9-]+-staging\/secrets$/,
        );
      }
    }
    expect(ALLOWED_CALLS).toHaveLength(7);
    // The list, the create, and a deploy's migration query (O-165, cloudflare-migrations.test.ts).
    expect(D1_ALLOWED_CALLS).toHaveLength(3);
  });

  it("admits a query on one database by its id with the D1 token only, the migrations' one call (O-165)", () => {
    const query = {
      method: "POST",
      path: `/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`,
    } as CloudflareRequest;
    expect(() => assertAllowedCall(query, D1_ALLOWED_CALLS)).not.toThrow();
    expect(() => assertAllowedCall(query, ALLOWED_CALLS)).toThrow(/may not send/);
  });

  it("refuses every call outside the lists with either token: other Workers' secrets, D1 queries and reads, routes and DNS", () => {
    const a = `/accounts/${ACCOUNT}`;
    for (const [method, path] of [
      // Secrets on a Worker that is not a staging Worker (D-440), or other secret calls.
      ["PUT", `${a}/workers/scripts/demo/secrets`],
      ["PUT", `${a}/workers/scripts/demo-preview/secrets`],
      ["PUT", `${a}/workers/scripts/demo-staging-pr-3/secrets`],
      ["PUT", `${a}/workers/scripts/-staging/secrets`],
      ["GET", `${a}/workers/scripts/demo/secrets`],
      ["GET", `${a}/workers/scripts/demo-staging/secrets/MODEL_API_KEY`],
      ["DELETE", `${a}/workers/scripts/demo-staging/secrets/MODEL_API_KEY`],
      ["PATCH", `${a}/workers/scripts/demo-staging/secrets`],
      ["PUT", `${a}/workers/scripts/demo-staging/secrets?x=1`],
      // D1: no query but a POST on a database id, no raw query, export, import, delete, read by
      // id, or list by another name or page.
      ["GET", `${a}/d1/database/${DB_ID}/query`],
      ["PUT", `${a}/d1/database/${DB_ID}/query`],
      ["POST", `${a}/d1/database/${DB_ID}/query?x=1`],
      ["POST", `${a}/d1/database/${CREATED_ID.toUpperCase()}/query`],
      ["POST", `${a}/d1/database/demo-staging/query`],
      ["POST", `${a}/d1/database/${DB_ID}/query/`],
      ["POST", `${a}/d1/database/${DB_ID}/raw`],
      ["POST", `${a}/d1/database/${DB_ID}/export`],
      ["POST", `${a}/d1/database/${DB_ID}/import`],
      ["DELETE", `${a}/d1/database/${DB_ID}`],
      ["GET", `${a}/d1/database/${DB_ID}`],
      ["PUT", `${a}/d1/database/${DB_ID}`],
      ["GET", `${a}/d1/database`],
      ["GET", `${a}/d1/database?name=demo&per_page=100`],
      ["GET", `${a}/d1/database?name=demo-staging`],
      ["GET", `${a}/d1/database?name=demo-staging&per_page=100&page=2`],
      ["POST", `${a}/d1/database?name=demo-staging`],
      // Worker reads beyond the list, and everything a route or a name would need.
      ["GET", `${a}/workers/scripts/demo-staging`],
      ["GET", `${a}/workers/scripts?tags=x:yes`],
      ["GET", `${a}/workers/scripts/demo-staging/settings`],
      ["DELETE", `${a}/workers/scripts/demo-staging`],
      ["PUT", `${a}/workers/domains`],
      ["POST", `/zones/${ACCOUNT}/workers/routes`],
      ["POST", `/zones/${ACCOUNT}/dns_records`],
      ["POST", `${a}/workers/scripts/demo-staging/subdomain`],
    ] as const) {
      for (const allowed of [ALLOWED_CALLS, D1_ALLOWED_CALLS]) {
        expect(
          () =>
            assertAllowedCall(
              { method, path } as unknown as CloudflareRequest,
              allowed,
            ),
          `${method} ${path}`,
        ).toThrow(/may not send/);
      }
    }
  });
});
