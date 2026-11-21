// Seam: the deploy adapter's Cloudflare staging target (unit with a fake HTTP port, O-116, O-159).
// The exact requests of Cloudflare's direct upload for Workers static assets, in order: the upload
// session with the manifest and its hashes (the guide's SHA-256 form), each bucket as base64 file
// parts with their types and the session's JWT, then the Worker. For a build in the old layout the
// Worker gets only its metadata (the completion token and the asset config) and no module, byte
// for byte as before slice 3; for a build in the new layout it also gets the module, with
// `main_module`, the manifest's date and flags, `keep_bindings` for secrets and
// `run_worker_first` for `/api`, and the project's `DB` inherited strictly (O-160). Every refusal
// is fixed text and sends nothing more, a refused file set sends nothing at all, and no deploy
// request ever names a route, a custom domain, a zone, DNS, D1 or a secret. For a build with a
// Worker, the core's `beforeWorkerUpload` is asked first, with the manifest's required names, and
// a refusal it gives is the answer, with no credential read and nothing sent (D-448, O-163). The
// setup, the placeholder and the secret calls (O-160) are in cloudflare-setup.test.ts. Fake
// credentials only; no network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";

import { storedZip, type ZipFixtureEntry } from "../../../test/zip-fixture.ts";
import { readDeployRefusal } from "../../core/guards/evidence.ts";
import type { StagingRefusal, WorkerDeploy } from "../../core/staging-deploy.ts";
import type { Project } from "../../core/store.ts";
import {
  assertAllowedCall,
  assetHash,
  CLOUDFLARE_REFUSALS,
  D1_ALLOWED_CALLS,
  contentTypeOf,
  createCloudflareStagingTarget,
  STAGING_ASSET_CONFIG,
  STAGING_COMPATIBILITY_DATE,
  STAGING_KEEP_BINDINGS,
  STAGING_RUN_WORKER_FIRST,
  stagingWorkerName,
  workerMetadata,
  type CloudflareAnswer,
  type CloudflareRequest,
} from "./cloudflare-staging.ts";
import { SITE_REFUSALS } from "./site-files.ts";

const COMMIT = "c".repeat(40);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
/** Not a real token: the shape the adapter accepts. */
const TOKEN = "fake-staging-token-for-tests-0123456789";
const SESSION_JWT = "fake.session.jwt";
const DONE_JWT = "fake.completion.jwt";
const PROJECT = { slug: "rehearsal", repo: "didi-build/rehearsal" } as Project;

const INDEX = "<!doctype html><title>x</title>";
const SCRIPT = "console.log('rehearsal')";
const FILES: ZipFixtureEntry[] = [
  { name: "foreman-commit.txt", data: `${COMMIT}\n` },
  { name: "index.html", data: INDEX, deflate: true },
  { name: "assets/index-1.js", data: SCRIPT },
];
const ARCHIVE = storedZip(FILES);

/** The guide's programmatic example, written out here on its own (developers.cloudflare.com). */
function guideHash(path: string, content: string): string {
  const extension = extname(path).substring(1);
  return createHash("sha256")
    .update(Buffer.from(content).toString("base64") + extension)
    .digest("hex")
    .slice(0, 32);
}

const HASHES = {
  marker: guideHash("foreman-commit.txt", `${COMMIT}\n`),
  index: guideHash("index.html", INDEX),
  script: guideHash("assets/index-1.js", SCRIPT),
};

/** A build in the new layout (O-159): the same site under assets/, a module and a migration. */
const MODULE =
  "export default { fetch() { return Response.json({ status: 'ok' }); } };";
const WORKER_MODULE_PART = "index.js";
const WORKER_MANIFEST = {
  schema: 1,
  compatibilityDate: "2026-11-02",
  compatibilityFlags: ["nodejs_compat"],
  requiredSecrets: ["MODEL_API_KEY"],
};
const workerArchive = (manifest = JSON.stringify(WORKER_MANIFEST)) =>
  storedZip([
    { name: "foreman-deploy.json", data: manifest },
    { name: "assets/foreman-commit.txt", data: `${COMMIT}\n` },
    { name: "assets/index.html", data: INDEX, deflate: true },
    { name: "worker/index.js", data: MODULE, deflate: true },
    { name: "migrations/0001_init.sql", data: "CREATE TABLE t (id INTEGER);" },
  ]);
const WORKER_ARCHIVE = workerArchive();

const ok = (result: unknown, status = 200): CloudflareAnswer => ({
  status,
  body: { success: true, errors: [], messages: [], result },
});

/** A fake Cloudflare: it answers each request in turn and keeps every request it was sent. */
function fakeCloudflare(answers: (CloudflareAnswer | "throw")[]) {
  const sent: CloudflareRequest[] = [];
  return {
    sent,
    http: {
      async send(request: CloudflareRequest): Promise<CloudflareAnswer> {
        sent.push(structuredClone(request));
        const next = answers.shift();
        if (next === undefined || next === "throw") throw new Error("no answer");
        return next;
      },
    },
  };
}

const credentials = (accountId = ACCOUNT, token = TOKEN) => ({
  read: async () => ({ accountId, token }),
});

/** Every request any test sent, to check none ever leaves the upload calls. */
const everySent: CloudflareRequest[] = [];

/** The D1 token's port: a deploy never reads it (O-160). */
let d1Reads = 0;
const d1Credentials = {
  read: async () => {
    d1Reads++;
    return { accountId: ACCOUNT, token: "fake-d1-token-for-tests-0123456789" };
  },
};

async function deploy(
  answers: (CloudflareAnswer | "throw")[],
  options: {
    archive?: Uint8Array;
    creds?: ReturnType<typeof credentials>;
    beforeWorkerUpload?: (worker: WorkerDeploy) => Promise<StagingRefusal | null>;
  } = {},
) {
  const cloudflare = fakeCloudflare(answers);
  const target = createCloudflareStagingTarget({
    credentials: options.creds ?? credentials(),
    d1Credentials,
    http: cloudflare.http,
  });
  const result = await target.deploy({
    project: PROJECT,
    commitSha: COMMIT,
    archive: options.archive ?? ARCHIVE,
    ...(options.beforeWorkerUpload
      ? { beforeWorkerUpload: options.beforeWorkerUpload }
      : {}),
  });
  everySent.push(...cloudflare.sent);
  return { result, sent: cloudflare.sent };
}

const SESSION_PATH = `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/assets-upload-session`;
const UPLOAD_PATH = `/accounts/${ACCOUNT}/workers/assets/upload?base64=true`;
const WORKER_PATH = `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging`;
/** The upload of a build with a Worker, whose `DB` must be carried over (O-160). */
const STRICT_WORKER_PATH = `${WORKER_PATH}?bindings_inherit=strict`;

describe("Cloudflare's direct upload of the staging site (unit, fake HTTP, O-116)", () => {
  it("sends the session, each bucket and the Worker, exactly as Cloudflare's docs give them", async () => {
    const { result, sent } = await deploy([
      ok({
        jwt: SESSION_JWT,
        buckets: [[HASHES.index, HASHES.script], [HASHES.marker]],
      }),
      ok({}, 202),
      ok({ jwt: DONE_JWT }, 201),
      ok({ id: "rehearsal-staging" }),
    ]);
    expect(result).toEqual({ outcome: "deployed", files: 3 });
    expect(sent.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["POST", SESSION_PATH, TOKEN],
      ["POST", UPLOAD_PATH, SESSION_JWT],
      ["POST", UPLOAD_PATH, SESSION_JWT],
      ["PUT", WORKER_PATH, TOKEN],
    ]);
    // 1. The manifest: each path from the site's root with a leading slash, its hash and size.
    expect(sent[0]?.json).toEqual({
      manifest: {
        "/foreman-commit.txt": { hash: HASHES.marker, size: 41 },
        "/index.html": { hash: HASHES.index, size: Buffer.byteLength(INDEX) },
        "/assets/index-1.js": { hash: HASHES.script, size: Buffer.byteLength(SCRIPT) },
      },
    });
    expect(sent[0]?.form).toBeUndefined();
    // 2. Each bucket: one part per hash, named by it, base64 contents, the type it is served with.
    expect(sent[1]?.form).toEqual([
      {
        name: HASHES.index,
        filename: HASHES.index,
        contentType: "text/html; charset=utf-8",
        value: Buffer.from(INDEX).toString("base64"),
      },
      {
        name: HASHES.script,
        filename: HASHES.script,
        contentType: "text/javascript; charset=utf-8",
        value: Buffer.from(SCRIPT).toString("base64"),
      },
    ]);
    expect(sent[2]?.form).toEqual([
      {
        name: HASHES.marker,
        filename: HASHES.marker,
        contentType: "text/plain; charset=utf-8",
        value: Buffer.from(`${COMMIT}\n`).toString("base64"),
      },
    ]);
    // 3. The Worker: metadata only, with the completion token, and no module.
    expect(sent[3]?.form).toEqual([
      {
        name: "metadata",
        value: JSON.stringify({
          assets: {
            jwt: DONE_JWT,
            config: { not_found_handling: "single-page-application" },
          },
          compatibility_date: "2026-10-26",
        }),
      },
    ]);
    const metadata = JSON.parse((sent[3]?.form?.[0] as { value: string }).value);
    expect(Object.keys(metadata).sort()).toEqual(["assets", "compatibility_date"]);
    expect(metadata).not.toHaveProperty("main_module");
    expect(metadata).not.toHaveProperty("body_part");
    expect(metadata).not.toHaveProperty("bindings");
    expect(metadata.assets.config).not.toHaveProperty("run_worker_first");
    expect(STAGING_ASSET_CONFIG).toEqual({
      not_found_handling: "single-page-application",
    });
    expect(STAGING_COMPATIBILITY_DATE).toBe(
      /"compatibility_date": "([^"]+)"/.exec(
        readFileSync("wrangler.jsonc", "utf8"),
      )?.[1],
    );
  });

  it("sends today's assets-only upload byte for byte for a build in the old layout (pinned before O-159)", async () => {
    // The rehearsal's builds have no foreman-deploy.json, so they must deploy exactly as before
    // ADR 0118 slice 3: every request, its order, its fields and their values, serialized.
    const { sent } = await deploy([
      ok({
        jwt: SESSION_JWT,
        buckets: [[HASHES.index, HASHES.script], [HASHES.marker]],
      }),
      ok({}, 202),
      ok({ jwt: DONE_JWT }, 201),
      ok({ id: "rehearsal-staging" }),
    ]);
    const serialized = JSON.stringify(sent);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "743bc88bc18cc921fc458fabcd4008bf820f57ba6cd05768d5ac96af7f7b5a92",
    );
  });

  it("hashes as the guide's example does: SHA-256 of the base64 contents and the extension, 32 hex", () => {
    for (const [path, content] of [
      ["index.html", INDEX],
      ["assets/index-1.js", SCRIPT],
      ["no-extension", "x"],
      ["a.tar.gz", "y"],
    ] as const) {
      const hash = assetHash({ path, bytes: new Uint8Array(Buffer.from(content)) });
      expect(hash, path).toBe(guideHash(path, content));
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    }
    // The extension is part of the hash: the same bytes under two names differ.
    const bytes = new Uint8Array(Buffer.from("same"));
    expect(assetHash({ path: "a.css", bytes })).not.toBe(
      assetHash({ path: "a.js", bytes }),
    );
  });

  it("uploads no file when Cloudflare already holds them all, and uses the session's JWT for the Worker", async () => {
    const { result, sent } = await deploy([
      ok({ jwt: SESSION_JWT, buckets: [] }),
      ok({ id: "rehearsal-staging" }),
    ]);
    expect(result).toEqual({ outcome: "deployed", files: 3 });
    expect(sent.map((r) => r.path)).toEqual([SESSION_PATH, WORKER_PATH]);
    expect(JSON.parse((sent[1]?.form?.[0] as { value: string }).value).assets.jwt).toBe(
      SESSION_JWT,
    );
  });

  it("serves a known type with its type and anything else with none (application/null)", () => {
    expect(contentTypeOf("a/b.HTML")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("x.svg")).toBe("image/svg+xml");
    expect(contentTypeOf("x.woff2")).toBe("font/woff2");
    expect(contentTypeOf("no-extension")).toBe("application/null");
    expect(contentTypeOf("x.unknownext")).toBe("application/null");
  });

  it("refuses a file set that fails before anything is read or sent", async () => {
    let read = 0;
    const creds = { read: async () => (read++, { accountId: ACCOUNT, token: TOKEN }) };
    const { result, sent } = await deploy([], {
      archive: storedZip([...FILES, { name: "_worker.js", data: "export default {}" }]),
      creds,
    });
    expect(result).toEqual({
      outcome: "refused",
      cause: "file_set",
      reason: "worker_code",
      text: SITE_REFUSALS.worker_code,
    });
    expect(sent).toEqual([]);
    expect(read).toBe(0);
  });

  it("refuses as infrastructure, with fixed text and nothing sent, when the credential is missing or malformed", async () => {
    const missing = {
      read: async (): Promise<never> => {
        throw new Error("not built");
      },
    };
    for (const [creds, reason] of [
      [missing, "credential_unavailable"],
      [credentials("not-an-account"), "credential_malformed"],
      [credentials(ACCOUNT, "a token with spaces"), "credential_malformed"],
      [credentials(ACCOUNT, "short"), "credential_malformed"],
    ] as const) {
      const { result, sent } = await deploy([], { creds });
      expect(result, reason).toEqual({
        outcome: "refused",
        cause: "infrastructure",
        reason,
        text: CLOUDFLARE_REFUSALS[reason],
      });
      expect(sent).toEqual([]);
    }
  });

  it("refuses as infrastructure on each kind of answer Cloudflare gives, and sends nothing after it", async () => {
    const message = {
      success: false,
      errors: [{ code: 10000, message: "account 0123 says no" }],
    };
    for (const [answer, reason] of [
      [{ status: 401, body: message }, "credential_refused"],
      [{ status: 403, body: message }, "credential_refused"],
      [{ status: 400, body: message }, "cloudflare_refused"],
      [{ status: 404, body: message }, "cloudflare_refused"],
      [{ status: 429, body: message }, "cloudflare_unavailable"],
      [{ status: 503, body: null }, "cloudflare_unavailable"],
      [{ status: 200, body: { success: false } }, "unexpected_answer"],
      [
        {
          status: 200,
          body: { success: false, result: { jwt: SESSION_JWT, buckets: [] } },
        },
        "unexpected_answer",
      ],
      [{ status: 200, body: null }, "unexpected_answer"],
      [{ status: 302, body: null }, "unexpected_answer"],
      [ok({ buckets: [] }), "unexpected_answer"],
      [ok({ jwt: SESSION_JWT, buckets: [["f".repeat(32)]] }), "unexpected_answer"],
      [ok({ jwt: SESSION_JWT, buckets: [[]] }), "unexpected_answer"],
      [ok({ jwt: SESSION_JWT, buckets: "all" }), "unexpected_answer"],
      ["throw", "cloudflare_unreachable"],
    ] as const) {
      const { result, sent } = await deploy([answer]);
      expect(result, reason).toMatchObject({
        outcome: "refused",
        cause: "infrastructure",
        reason,
        text: CLOUDFLARE_REFUSALS[reason],
      });
      // The refusal names the call it came from, with Cloudflare's status and numeric codes
      // when it answered (O-139).
      const detail = result.outcome === "refused" ? result.detail : undefined;
      expect(detail?.call, reason).toBe("upload_session");
      if (answer === "throw") expect(detail).toEqual({ call: "upload_session" });
      else expect(detail?.status, reason).toBe(answer.status);
      if (answer !== "throw" && answer.body === message) {
        expect(detail?.codes).toEqual([10000]);
      }
      expect(sent).toHaveLength(1);
      // Cloudflare's own message is never kept.
      expect(JSON.stringify(result)).not.toContain("says no");
    }
  });

  it("names the refused call, its status and Cloudflare's numeric codes, never its words (O-139)", async () => {
    const denied = (code: unknown) => ({
      status: 403,
      body: { success: false, errors: [{ code, message: "account 0123 says no" }] },
    });
    const session = ok({ jwt: SESSION_JWT, buckets: [[HASHES.index]] });
    const upload = await deploy([session, denied(10001)]);
    expect(upload.result).toMatchObject({
      reason: "credential_refused",
      detail: { call: "asset_upload", status: 403, codes: [10001] },
    });
    const worker = await deploy([ok({ jwt: SESSION_JWT, buckets: [] }), denied(10000)]);
    expect(worker.result).toMatchObject({
      reason: "credential_refused",
      detail: { call: "worker_upload", status: 403, codes: [10000] },
    });
    // Codes that are not whole numbers are left out; at most five are kept.
    const odd = await deploy([
      {
        status: 401,
        body: {
          errors: [
            { code: "10000" },
            { code: 1.5 },
            { code: -1 },
            ...[1, 2, 3, 4, 5, 6].map((code) => ({ code })),
          ],
        },
      },
    ]);
    expect(odd.result).toMatchObject({
      detail: { call: "upload_session", status: 401, codes: [1, 2, 3, 4, 5] },
    });
    for (const { result } of [upload, worker, odd]) {
      expect(JSON.stringify(result)).not.toContain("says no");
      expect(JSON.stringify(result)).not.toContain("0123");
    }
  });

  it("refuses when an upload fails, or none gives a completion token, and then never uploads the Worker", async () => {
    const session = ok({
      jwt: SESSION_JWT,
      buckets: [[HASHES.index], [HASHES.marker]],
    });
    const failed = await deploy([session, { status: 500, body: null }]);
    expect(failed.result).toMatchObject({ reason: "cloudflare_unavailable" });
    expect(failed.sent.map((r) => r.path)).toEqual([SESSION_PATH, UPLOAD_PATH]);
    const unfinished = await deploy([session, ok({}, 202), ok({}, 202)]);
    expect(unfinished.result).toMatchObject({ reason: "unexpected_answer" });
    expect(unfinished.sent.map((r) => r.path)).toEqual([
      SESSION_PATH,
      UPLOAD_PATH,
      UPLOAD_PATH,
    ]);
    const worker = await deploy([
      ok({ jwt: SESSION_JWT, buckets: [] }),
      { status: 403, body: null },
    ]);
    expect(worker.result).toMatchObject({ reason: "credential_refused" });
  });

  it("uploads a build with a Worker: the assets from assets/, then the module with its metadata, exactly", async () => {
    const { result, sent } = await deploy(
      [
        ok({ jwt: SESSION_JWT, buckets: [[HASHES.index, HASHES.marker]] }),
        ok({ jwt: DONE_JWT }, 201),
        ok({ id: "rehearsal-staging" }),
      ],
      { archive: WORKER_ARCHIVE },
    );
    expect(result).toEqual({
      outcome: "deployed",
      files: 2,
      worker: { requiredSecrets: ["MODEL_API_KEY"] },
    });
    expect(sent.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["POST", SESSION_PATH, TOKEN],
      ["POST", UPLOAD_PATH, SESSION_JWT],
      ["PUT", STRICT_WORKER_PATH, TOKEN],
    ]);
    // The site is assets/ only: the manifest, the module and the migrations are no assets.
    expect(sent[0]?.json).toEqual({
      manifest: {
        "/foreman-commit.txt": { hash: HASHES.marker, size: 41 },
        "/index.html": { hash: HASHES.index, size: Buffer.byteLength(INDEX) },
      },
    });
    // The Worker: the metadata, then the module as an ES module part, with `DB` carried over
    // from the Worker's latest version and never bound by id (O-160).
    expect(sent[2]?.form).toEqual([
      {
        name: "metadata",
        value: JSON.stringify({
          main_module: "index.js",
          bindings: [{ type: "inherit", name: "DB" }],
          compatibility_date: "2026-11-02",
          compatibility_flags: ["nodejs_compat"],
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
        value: MODULE,
      },
    ]);
    const metadata = JSON.parse((sent[2]?.form?.[0] as { value: string }).value);
    expect(metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(metadata.assets.config.run_worker_first).toEqual(["/api/*"]);
    expect(STAGING_KEEP_BINDINGS).toEqual(["secret_text", "secret_key"]);
    expect(STAGING_RUN_WORKER_FIRST).toEqual(["/api/*"]);
    // Nothing of the build reaches Cloudflare but its assets and its module: no secret value, no
    // migration and no binding from the build; the only binding is Foreman's inherited `DB`.
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain("CREATE TABLE");
    expect(everything).not.toContain("foreman-deploy");
    expect(metadata.bindings).toEqual([{ type: "inherit", name: "DB" }]);
    expect(d1Reads).toBe(0);
  });

  it("asks the core's check once, with the manifest's names, before any credential is read or anything is sent (D-448, O-163)", async () => {
    const asked: WorkerDeploy[] = [];
    let read = 0;
    const creds = { read: async () => (read++, { accountId: ACCOUNT, token: TOKEN }) };
    const hold: StagingRefusal = {
      outcome: "refused",
      cause: "infrastructure",
      reason: "secrets_missing",
      text: "the build needs product secrets not set on the staging Worker: MODEL_API_KEY. Set each with the Set project secret form",
      missingSecrets: ["MODEL_API_KEY"],
    };
    const held = await deploy([], {
      archive: WORKER_ARCHIVE,
      creds,
      beforeWorkerUpload: async (worker) => (asked.push(worker), hold),
    });
    expect(held.result).toEqual(hold);
    expect(held.sent).toEqual([]);
    expect(read).toBe(0);
    expect(asked).toEqual([{ requiredSecrets: ["MODEL_API_KEY"] }]);
    // With no refusal, the upload goes on exactly as before.
    const passed = await deploy(
      [ok({ jwt: SESSION_JWT, buckets: [] }), ok({ id: "rehearsal-staging" })],
      {
        archive: WORKER_ARCHIVE,
        beforeWorkerUpload: async (worker) => (asked.push(worker), null),
      },
    );
    expect(passed.result).toMatchObject({ outcome: "deployed", files: 2 });
    expect(passed.sent.map((r) => r.path)).toEqual([SESSION_PATH, STRICT_WORKER_PATH]);
    expect(asked).toHaveLength(2);
    // A build without a Worker, and a refused file set, never ask.
    await deploy(
      [ok({ jwt: SESSION_JWT, buckets: [] }), ok({ id: "rehearsal-staging" })],
      { beforeWorkerUpload: async (worker) => (asked.push(worker), hold) },
    );
    await deploy([], {
      archive: workerArchive("not json"),
      beforeWorkerUpload: async (worker) => (asked.push(worker), hold),
    });
    expect(asked).toHaveLength(2);
  });

  it("fails loudly when the Worker has no DB to carry over, and refuses other codes as before (O-160)", async () => {
    // "the upload will fail with error 10057 if any inherit type bindings cannot be resolved"
    // (Upload Worker): a project the New project form did not set up.
    const missing = await deploy(
      [
        ok({ jwt: SESSION_JWT, buckets: [] }),
        { status: 400, body: { success: false, errors: [{ code: 10057 }] } },
      ],
      { archive: WORKER_ARCHIVE },
    );
    expect(missing.result).toEqual({
      outcome: "refused",
      cause: "infrastructure",
      reason: "database_binding_missing",
      text: CLOUDFLARE_REFUSALS.database_binding_missing,
      detail: { call: "worker_upload", status: 400, codes: [10057] },
    });
    expect(missing.sent.map((r) => r.path)).toEqual([SESSION_PATH, STRICT_WORKER_PATH]);
    // The core records and shows it as any refused deploy: a short code and plain text.
    expect(
      readDeployRefusal({
        reason: "database_binding_missing",
        text: CLOUDFLARE_REFUSALS.database_binding_missing,
      }),
    ).not.toBeNull();
    // Without the strict query nothing is inherited, so the old layout never reads 10057 so.
    const old = await deploy([
      ok({ jwt: SESSION_JWT, buckets: [] }),
      { status: 400, body: { success: false, errors: [{ code: 10057 }] } },
    ]);
    expect(old.result).toMatchObject({ reason: "cloudflare_refused" });
    expect(old.sent.map((r) => r.path)).toEqual([SESSION_PATH, WORKER_PATH]);
    expect(d1Reads).toBe(0);
  });

  it("sends the build's metadata with only the bindings it is given (O-160)", () => {
    const code = {
      module: MODULE,
      manifest: {
        compatibilityDate: "2026-11-02",
        compatibilityFlags: [],
        requiredSecrets: [],
      },
      migrations: [],
    };
    expect(workerMetadata("jwt", code)).toMatchObject({ bindings: [] });
    expect(
      workerMetadata("jwt", code, [{ type: "inherit", name: "DB" }]),
    ).toMatchObject({ bindings: [{ type: "inherit", name: "DB" }] });
    // Without a module, no binding is ever sent.
    expect(workerMetadata("jwt", undefined, [{ type: "inherit", name: "DB" }])).toEqual(
      workerMetadata("jwt"),
    );
  });

  it("keeps today's metadata for a build without a module, and sets the module's only with one", () => {
    expect(workerMetadata("jwt")).toEqual({
      assets: { jwt: "jwt", config: STAGING_ASSET_CONFIG },
      compatibility_date: STAGING_COMPATIBILITY_DATE,
    });
    expect(Object.keys(workerMetadata("jwt") as object)).toEqual([
      "assets",
      "compatibility_date",
    ]);
  });

  it("refuses a build whose manifest fails before anything is read or sent", async () => {
    let read = 0;
    const creds = { read: async () => (read++, { accountId: ACCOUNT, token: TOKEN }) };
    for (const [manifest, reason] of [
      ["not json", "manifest_malformed"],
      [{ ...WORKER_MANIFEST, compatibilityDate: "2021-11-02" }, "manifest_date"],
      [" ".repeat(16 * 1024 + 1), "manifest_too_large"],
    ] as const) {
      const { result, sent } = await deploy([], {
        archive: workerArchive(
          typeof manifest === "string" ? manifest : JSON.stringify(manifest),
        ),
        creds,
      });
      expect(result, reason).toEqual({
        outcome: "refused",
        cause: "file_set",
        reason,
        text: SITE_REFUSALS[reason],
      });
      expect(sent).toEqual([]);
    }
    expect(read).toBe(0);
  });

  it("refuses as infrastructure when Cloudflare refuses the upload with the module, naming the call", async () => {
    const { result, sent } = await deploy(
      [
        ok({ jwt: SESSION_JWT, buckets: [] }),
        { status: 400, body: { success: false, errors: [{ code: 10021 }] } },
      ],
      { archive: WORKER_ARCHIVE },
    );
    expect(result).toEqual({
      outcome: "refused",
      cause: "infrastructure",
      reason: "cloudflare_refused",
      text: CLOUDFLARE_REFUSALS.cloudflare_refused,
      detail: { call: "worker_upload", status: 400, codes: [10021] },
    });
    expect(sent.map((r) => r.path)).toEqual([SESSION_PATH, STRICT_WORKER_PATH]);
  });

  it("never sends a deploy request outside the upload calls: no route, custom domain, zone, DNS, D1 or secret", () => {
    expect(everySent.length).toBeGreaterThan(10);
    // Uploads with a module were among them.
    expect(
      everySent.some((r) => r.form?.some((part) => part.name === WORKER_MODULE_PART)),
    ).toBe(true);
    for (const request of everySent) {
      expect(() => assertAllowedCall(request), request.path).not.toThrow();
      // The D1 token's allow-list admits none of them.
      expect(() => assertAllowedCall(request, D1_ALLOWED_CALLS), request.path).toThrow(
        /may not send/,
      );
      expect(request.method, request.path).not.toBe("GET");
      expect(request.path).not.toMatch(/routes|domains|zones|dns|subdomain|d1|secrets/);
      // The only query a deploy adds is the strict inherit, and only with a module.
      if (request.path.includes("?bindings")) {
        expect(request.path).toBe(STRICT_WORKER_PATH);
        expect(request.form?.map((part) => part.name)).toContain(WORKER_MODULE_PART);
      }
    }
    expect(d1Reads).toBe(0);
    const base = { bearer: TOKEN, json: {} };
    for (const [method, path] of [
      ["PUT", `/accounts/${ACCOUNT}/workers/domains`],
      ["POST", `/zones/${ACCOUNT}/workers/routes`],
      ["POST", `/zones/${ACCOUNT}/dns_records`],
      ["POST", `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/subdomain`],
      ["POST", `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/routes`],
      ["PUT", `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/settings`],
      ["DELETE", WORKER_PATH],
      ["PUT", SESSION_PATH],
      ["POST", WORKER_PATH],
      ["POST", `/accounts/${ACCOUNT}/workers/assets/upload`],
      // A script read, other queries and the D1 calls: none with this token (O-160).
      ["GET", WORKER_PATH],
      ["GET", `${WORKER_PATH}/settings`],
      ["PUT", `${WORKER_PATH}?bindings_inherit=strict&excludeScript=true`],
      ["PUT", `${WORKER_PATH}?bindings_inherit=lax`],
      ["POST", `/accounts/${ACCOUNT}/d1/database`],
      ["GET", `/accounts/${ACCOUNT}/d1/database?name=rehearsal-staging&per_page=100`],
      ["PUT", `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/content`],
      [
        "PATCH",
        `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/script-settings`,
      ],
    ] as const) {
      expect(
        () =>
          assertAllowedCall({ ...base, method, path } as unknown as CloudflareRequest),
        `${method} ${path}`,
      ).toThrow(/may not send/);
    }
  });
});

describe("the staging Worker's name (unit: repo guard, O-112, O-116)", () => {
  it("is the name the infra stack's route invokes, for a slug the project-slug pattern accepts", () => {
    const projects = readFileSync(
      "infra/modules/platform/cloudflare/projects.tf",
      "utf8",
    );
    expect(projects).toContain('script   = "${each.value}-staging"');
    expect(stagingWorkerName("rehearsal")).toBe("rehearsal-staging");
    expect(stagingWorkerName("a".repeat(55))).toBe(`${"a".repeat(55)}-staging`);
    for (const slug of ["", "Rehearsal", "-x", "a b", "a".repeat(56)]) {
      expect(stagingWorkerName(slug), slug).toBeNull();
    }
  });

  it("refuses a project whose slug makes no Worker name, sending nothing", async () => {
    const cloudflare = fakeCloudflare([]);
    const target = createCloudflareStagingTarget({
      credentials: credentials(),
      d1Credentials,
      http: cloudflare.http,
    });
    expect(
      await target.deploy({
        project: { ...PROJECT, slug: "Not A Slug" },
        commitSha: COMMIT,
        archive: ARCHIVE,
      }),
    ).toEqual({
      outcome: "refused",
      cause: "infrastructure",
      reason: "bad_project",
      text: CLOUDFLARE_REFUSALS.bad_project,
    });
    expect(cloudflare.sent).toEqual([]);
  });
});
