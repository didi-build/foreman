// Seam: the deploy adapter's Cloudflare staging target (unit with a fake HTTP port, O-116). The
// exact requests of Cloudflare's direct upload for Workers static assets, in order: the upload
// session with the manifest and its hashes (the guide's SHA-256 form), each bucket as base64 file
// parts with their types and the session's JWT, then the Worker with only its metadata (the
// completion token and the asset config) and no module. Every refusal is fixed text and sends
// nothing more, a refused file set sends nothing at all, and no request ever names a route, a
// custom domain, a zone or DNS. Fake credentials only; no network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";

import { storedZip, type ZipFixtureEntry } from "../../../test/zip-fixture.ts";
import type { Project } from "../../core/store.ts";
import {
  ALLOWED_CALLS,
  assertAllowedCall,
  assetHash,
  CLOUDFLARE_REFUSALS,
  contentTypeOf,
  createCloudflareStagingTarget,
  STAGING_ASSET_CONFIG,
  STAGING_COMPATIBILITY_DATE,
  stagingWorkerName,
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

/** Every request any test sent, to check none ever leaves the three upload calls. */
const everySent: CloudflareRequest[] = [];

async function deploy(
  answers: (CloudflareAnswer | "throw")[],
  options: { archive?: Uint8Array; creds?: ReturnType<typeof credentials> } = {},
) {
  const cloudflare = fakeCloudflare(answers);
  const target = createCloudflareStagingTarget({
    credentials: options.creds ?? credentials(),
    http: cloudflare.http,
  });
  const result = await target.deploy({
    project: PROJECT,
    commitSha: COMMIT,
    archive: options.archive ?? ARCHIVE,
  });
  everySent.push(...cloudflare.sent);
  return { result, sent: cloudflare.sent };
}

const SESSION_PATH = `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/assets-upload-session`;
const UPLOAD_PATH = `/accounts/${ACCOUNT}/workers/assets/upload?base64=true`;
const WORKER_PATH = `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging`;

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
      expect(result, reason).toEqual({
        outcome: "refused",
        cause: "infrastructure",
        reason,
        text: CLOUDFLARE_REFUSALS[reason],
      });
      expect(sent).toHaveLength(1);
      // Cloudflare's own message is never kept.
      expect(JSON.stringify(result)).not.toContain("says no");
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

  it("never sends a request outside the three upload calls: no route, custom domain, zone or DNS", () => {
    expect(everySent.length).toBeGreaterThan(10);
    for (const request of everySent) {
      expect(() => assertAllowedCall(request), request.path).not.toThrow();
      expect(request.path).not.toMatch(/routes|domains|zones|dns|subdomain/);
    }
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
    ] as const) {
      expect(
        () =>
          assertAllowedCall({ ...base, method, path } as unknown as CloudflareRequest),
        `${method} ${path}`,
      ).toThrow(/may not send/);
    }
    expect(ALLOWED_CALLS).toHaveLength(3);
  });
});

describe("the staging Worker's name (unit: repo guard, O-112, O-116)", () => {
  it("is the name the infra stack's route invokes, for a slug the register form accepts", () => {
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
