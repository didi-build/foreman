// The deploy adapter's staging target on Cloudflare (ADR 0111 section 2, `deploy`; D-353, O-116),
// the `cloudflare` deploy target (ADR 0118 appendix G, O-159). It checks CI's build
// (./site-files.ts) and, only when the set passes, uploads exactly those files to the project's
// Worker `<slug>-staging` with Cloudflare's direct upload for Workers static assets: assets only
// for a build in the old layout, with the build's Worker module for one in the new layout (below).
// Nothing from the project's repository runs in the runner: no Wrangler, no npm, no repository
// config. The route and the DNS name come from the infra stack (D-357, O-112): this adapter never
// creates a route, a custom domain or a DNS record. It holds one allow-list per token, checked
// before every send: `ALLOWED_CALLS` with the staging deploy token as it is (Workers Scripts:
// Edit, D-445), and `D1_ALLOWED_CALLS` with the D1 token (D1 Edit only, D-445). It also sets a
// new project up and puts its product secrets (ADR 0118 slice 4, O-160, below).
//
// Cloudflare's docs, read 2026-11-08: "Direct Uploads" (developers.cloudflare.com/workers/
// static-assets/direct-upload/, last updated 2026-08-10) and the API reference pages "Create
// Worker Assets Upload Session", "Upload Worker Assets" and "Upload Worker"
// (developers.cloudflare.com/api/resources/workers/...). The calls, in order:
//
// 1. The upload session: `POST /accounts/{account_id}/workers/scripts/{script_name}/
//    assets-upload-session` with the API token as a bearer token and the JSON body
//    `{"manifest": {"/<path>": {"hash", "size"}}}`. A path key starts with `/` ("/blog/hello-
//    world.html would be a valid path key"); `size` is the file's size in bytes; `hash` is "a 32
//    hexadecimal character hash of the file", made as the guide's programmatic example makes it:
//    SHA-256 of the file's contents in base64 followed by its extension without the dot (Node's
//    `extname`), in hex, the first 32 characters. The answer's `result` has `jwt`, valid one hour,
//    and `buckets`, lists of hashes to upload together; files Cloudflare already holds are left out,
//    and with nothing to upload `buckets` is empty and `jwt` is already the completion token.
// 2. Each bucket: `POST /accounts/{account_id}/workers/assets/upload?base64=true` as
//    `multipart/form-data`, with the session's JWT as the bearer token, one part per hash, named
//    by the hash, holding the file's contents in base64, with the file's `Content-Type`, which
//    Cloudflare attaches when it serves the file (`application/null` for none). Once every file is
//    uploaded the answer is 201 with the completion token in `result.jwt`, valid one hour.
// 3. The Worker: `PUT /accounts/{account_id}/workers/scripts/{script_name}` as
//    `multipart/form-data` with one `metadata` part and no module part, the shape Wrangler sends
//    for an assets-only Worker: `{"assets": {"jwt": <completion token>, "config":
//    {"not_found_handling": "single-page-application"}}, "compatibility_date": "2026-10-26"}`.
//    `not_found_handling` serves the root `index.html` for a path with no file, as Launchpad's
//    `wrangler.jsonc` and CI's preview check do (O-111); the date is that file's. No `main_module`,
//    `bindings` or `run_worker_first` is sent, so no code runs: requests to static assets are free
//    (Cloudflare's "Billing and Limitations" for static assets).
// The API reference names `Workers Scripts Write` as the permission each of the three calls
// accepts: the token's Workers Scripts: Edit (D-353). Wrangler, read in the installed package at
// 4.152.0, makes the same hash with BLAKE3 instead of SHA-256 and sends the same metadata for an
// assets-only Worker; the guide's example uses SHA-256, which this follows (a first real run
// check, runbook step 16).
//
// A Worker with code (ADR 0118 slice 3, D-439, O-159). A build in the new layout
// (./site-files.ts) carries the Worker's bundled ES module, and call 3 then sends it as well; calls
// 1 and 2 do not change, and a build in the old layout (the rehearsal's) sends exactly what is
// described above. Call 3 for a build with a module is the same `PUT`, with two parts: `metadata`,
// then the module as a file part named `index.js` with the type `application/javascript+module`.
// The metadata, in this order: `main_module: "index.js"`; `bindings: []`, so no binding comes from
// the build (appendix G; the inherited `DB` is slice 4); `compatibility_date` and
// `compatibility_flags` from the build's manifest, which passed its allow-list
// (./deploy-manifest.ts); `keep_bindings: ["secret_text", "secret_key"]`, so the product secrets
// set on the Worker by the Set project secret form survive each deploy (D-440, ADR 0118 appendix
// D); and `assets` with the completion token and the runner's asset config plus
// `run_worker_first: ["/api/*"]`, so `/api` requests go to the Worker before any asset. Every
// other request that matches a file, and every browser navigation, is a free asset request
// (D-439, ADR 0118 appendix H); a request outside `/api` that matches no file and is not a
// navigation still reaches the Worker, which answers it as it chooses (the SPA page below).
// Read 2026-11-21: the API reference "Upload Worker" (`main_module`, the module part's types,
// `compatibility_date`, `compatibility_flags`, `keep_bindings` as "binding types to keep from
// previous_upload", `assets.config.run_worker_first` as path rules, and `Workers Scripts Write`
// among the accepted permissions), "Multipart upload metadata" (last updated 2026-11-11),
// "Direct Uploads" (2026-11-12: `main_module` with the assets' completion token), "Static
// Assets: Worker script" (2026-11-12: `run_worker_first` as a list of paths) and "Single Page
// Application (SPA)" (2026-10-12: with a Worker, `not_found_handling` and a compatibility date
// from 2025-04-01, a navigation that matches no file is served `index.html`, not the Worker).
// Wrangler 4.160.0, read in the installed package (`createWorkerUploadForm`), sends the same
// shape: `main_module`, `bindings`, the dates and flags, `keep_bindings: ["secret_text",
// "secret_key"]` on every deploy, `assets`, and each ES module as
// `application/javascript+module`. Not yet seen on a real upload: Cloudflare accepting this
// exact request with the staging deploy token, and secrets surviving a deploy. The first Worker
// deploy (slice 5's template, then a secret set in slice 7) shows both.
//
// The project's database on later deploys (ADR 0118 appendix F, O-160). An upload with a module
// sends `bindings: [{"type": "inherit", "name": "DB"}]` and goes to the Worker's path with
// `?bindings_inherit=strict`: Cloudflare carries `DB` over from the Worker's latest version, and
// "the upload will fail with error 10057 if any `inherit` type bindings cannot be resolved ...
// Without this, unresolvable inherit bindings are silently dropped" (API reference "Upload
// Worker", read 2026-11-21). So no database id is kept anywhere, and a Worker without `DB` (one
// the New project form did not set up) fails loudly as `database_binding_missing`, an
// infrastructure refusal. Wrangler 4.160.0 sends the same `{"name", "type": "inherit"}` for a
// binding it has no id for, and `bindings_inherit=strict` on every upload (with `excludeScript`,
// which the reference does not list and this adapter does not send). A build in the old layout
// sends no binding and no query, exactly as before.
//
// A new project's setup (`setUp`, ADR 0118 appendix C steps 1 and 2, D-438, D-447, O-160), each
// step found before it is made, so running the New project form again makes nothing twice:
// 1. The database, with the D1 token: `GET /accounts/{account_id}/d1/database?name=<slug>-staging&
//    per_page=100` ("List D1 Databases": `name` is "a database name to search for", so only an
//    exact match of `result[].name` counts, and its `uuid` is the id), then only when none matches
//    `POST /accounts/{account_id}/d1/database` with `{"name": "<slug>-staging",
//    "primary_location_hint": "enam"}` ("Create D1 Database": the answer's `result.uuid`). Two
//    exact matches, or a full page with none, refuse (`database_ambiguous`): a later page could
//    hold it. The id goes only into the placeholder's binding: never logged, returned or kept.
// 2. The placeholder Worker, with the staging deploy token: `GET /accounts/{account_id}/workers/
//    scripts` ("List Worker Scripts": `result[].id` is "the name used to identify the script"). If
//    `<slug>-staging` is listed, nothing is uploaded, so a real build is never replaced. If not,
//    the three upload calls above send ./placeholder-site.ts: its page as the one asset, its module
//    as `index.js`, and `bindings: [{"type": "d1", "name": "DB", "database_id": <id>}]` (the API
//    reference's field; Wrangler 4.160.0 still sends the deprecated `id`), so the route has a
//    Worker to invoke (O-140) and the template's first deploy can inherit `DB`.
//
// Product secrets (`putSecret` and `listSecretNames`, ADR 0118 appendix D, D-440, O-160), with the
// staging deploy token, on `<slug>-staging` only: the allow-list admits the secrets path for a
// name ending in `-staging` and no other, and the name comes from the slug, never from the
// caller. `PUT /accounts/{account_id}/workers/scripts/<slug>-staging/secrets` with `{"name",
// "text", "type": "secret_text"}` ("Add a secret to a Worker script"), and `GET` on the same path
// ("List secrets bound to a Worker script": names and types). A name follows the manifest's rule
// (./deploy-manifest.ts), a value is 1 byte to 5 KiB of UTF-8 ("Workers platform limits": 5 KB a
// variable). The value is sent once and is never logged, kept, returned or put in an error, and
// Cloudflare's answer to the put is not read beyond `success`.
//
// Every refusal is infrastructure, with fixed text: the credential missing or malformed, Cloudflare
// refusing the token (401 or 403), refusing the request (another 4xx), failing (429 or 5xx), not
// answering, or answering in a shape the docs do not give. A refusal by Cloudflare also names the
// call it came from (`upload_session`, `asset_upload`, `worker_upload`, and from O-160
// `worker_list`, `secret_put`, `secret_list`, `database_list` and `database_create`), the HTTP
// status and Cloudflare's numeric error codes (`errors[].code`), so a refusal can be told apart
// without guessing (O-139). Cloudflare's own error messages are never kept, logged or returned,
// since they can name ids. The tokens, the JWTs, the database id and a secret's value are never
// logged or returned.
import { createHash } from "node:crypto";
import { posix } from "node:path";

import type {
  DatabaseStep,
  DeployTarget,
  ProjectSetUp,
  ProjectSetUpRequest,
  SecretNames,
  SecretPut,
  TargetRefusal,
} from "../../core/deploy-target.ts";
import {
  isProjectDisplayName,
  isProjectEntrySlug,
  isProjectPurpose,
} from "../../core/project-entry.ts";
import { PROJECT_SLUG } from "../../core/project-repository.ts";
import type { Project } from "../../core/store.ts";
import type { DeployRefusalDetail, StagingUpload } from "../../core/staging-deploy.ts";
import { isProductSecretName } from "./deploy-manifest.ts";
import {
  PLACEHOLDER_MODULE,
  PLACEHOLDER_PAGE_FILE,
  placeholderPage,
} from "./placeholder-site.ts";
import { readSiteFiles, type SiteFile, type SiteWorker } from "./site-files.ts";

/** Cloudflare's API, under which every path below is sent. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The asset configuration the runner sets on every staging Worker (see the header). */
export const STAGING_ASSET_CONFIG = { not_found_handling: "single-page-application" };

/** The compatibility date sent with the Worker: the date in Launchpad's `wrangler.jsonc`. */
export const STAGING_COMPATIBILITY_DATE = "2026-10-26";

/** The module's name in an upload with code, and the type of its part (see the header). */
export const WORKER_MAIN_MODULE = "index.js";
export const WORKER_MODULE_TYPE = "application/javascript+module";

/** The binding types each upload with code keeps from the Worker's last version (D-440). */
export const STAGING_KEEP_BINDINGS: readonly string[] = ["secret_text", "secret_key"];

/** The paths that go to the Worker's code before any asset (D-439); the rest are assets first. */
export const STAGING_RUN_WORKER_FIRST: readonly string[] = ["/api/*"];

/** The project's database binding, the one binding Foreman sets (ADR 0118 appendix E, O-160). */
export const DATABASE_BINDING_NAME = "DB";

/** What an upload with code binds: `DB` carried over, or by id on the placeholder only (O-160). */
export type WorkerBinding =
  { type: "inherit"; name: string } | { type: "d1"; name: string; database_id: string };

/** Every upload of a build with a Worker inherits the database binding strictly (O-160). */
export const INHERITED_DATABASE_BINDING: WorkerBinding = {
  type: "inherit",
  name: DATABASE_BINDING_NAME,
};

/** The query that makes an inherited binding that cannot be carried over fail the upload. */
export const BINDINGS_INHERIT_STRICT = "?bindings_inherit=strict";

/** Cloudflare's error for an `inherit` binding it cannot resolve (API reference "Upload Worker"). */
export const INHERIT_UNRESOLVED_CODE = 10057;

/** Where a project's staging database is made: Eastern North America (D-447). */
export const STAGING_DATABASE_LOCATION = "enam";

/** The size of the one page of databases read by name; a full page without the name refuses. */
export const DATABASE_LIST_PAGE = 100;

/** The largest product secret value, in UTF-8 bytes ("Workers platform limits": 5 KB). */
export const SECRET_VALUE_MAX_BYTES = 5 * 1024;

/** The secret binding types a list of the Worker's secrets reports. */
const SECRET_TYPES: readonly unknown[] = ["secret_text", "secret_key"];

/** Cloudflare's longest Worker name. */
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{32}$/;
/** A D1 database id: a UUID, as "List D1 Databases" and "Create D1 Database" give `uuid`. */
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Cloudflare API token as the runner reads it: printable, no space, a sane length. */
const API_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** The project's staging Worker, as the infra stack's route names it (O-112). */
export function stagingWorkerName(slug: string): string | null {
  if (!PROJECT_SLUG.test(slug)) return null;
  const name = `${slug}-staging`;
  return WORKER_NAME.test(name) ? name : null;
}

/**
 * The project's staging D1 database, named as its Worker (D-447, ADR 0118 appendix E item 8), for
 * a slug that follows the project file's rule (the New project form's).
 */
export function stagingDatabaseName(slug: string): string | null {
  return isProjectEntrySlug(slug) ? stagingWorkerName(slug) : null;
}

/** A Cloudflare credential: the account and one API token. */
export interface CloudflareCredentials {
  /** The account the staging Workers live in, 32 hex characters (an id, kept as a secret, D-361). */
  accountId: string;
  token: string;
}

/**
 * The deploy credential (D-353): one Cloudflare API token with Workers Scripts: Edit only. Read
 * each time it is needed. Refuses with `NotBuiltError` until it exists.
 */
export interface StagingDeployCredentials {
  read(): Promise<CloudflareCredentials>;
}

/**
 * The D1 credential (D-445): one account-owned token with D1 Edit only, for the databases (this
 * slice) and their migrations (slice 8). Read only by `setUp`, each time.
 */
export interface D1Credentials {
  read(): Promise<CloudflareCredentials>;
}

/** A plain form field, or a file part with its name and type. */
export type CloudflareFormPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; value: string };

/** One request to Cloudflare's API. `path` is under `CLOUDFLARE_API`, never a full URL. */
export interface CloudflareRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  /** The API token, or the upload session's JWT. Never logged. */
  bearer: string;
  json?: unknown;
  form?: CloudflareFormPart[];
}

/** Cloudflare's answer: its status, and its body parsed as JSON (null when it is not JSON). */
export interface CloudflareAnswer {
  status: number;
  body: unknown;
}

/** The HTTP port. The real one is `createCloudflareHttp`; tests pass a fake. */
export interface CloudflareHttp {
  send(request: CloudflareRequest): Promise<CloudflareAnswer>;
}

/** One request an allow-list admits, by method and path. */
export interface AllowedCall {
  method: string;
  path: RegExp;
}

/**
 * The only requests this adapter can send with the staging deploy token (and the upload session's
 * JWT). Anything else is refused before it is sent.
 */
export const ALLOWED_CALLS: readonly AllowedCall[] = [
  // The staging upload (O-116, O-159), also the placeholder's (O-160).
  {
    method: "POST",
    path: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}\/assets-upload-session$/,
  },
  {
    method: "POST",
    path: /^\/accounts\/[0-9a-f]{32}\/workers\/assets\/upload\?base64=true$/,
  },
  {
    method: "PUT",
    path: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}$/,
  },
  // The upload of a build with a Worker, `DB` inherited strictly (O-160).
  {
    method: "PUT",
    path: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}\?bindings_inherit=strict$/,
  },
  // Whether the Worker exists, before the placeholder (O-160).
  { method: "GET", path: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts$/ },
  // A product secret, on a staging Worker only (D-440, O-160).
  {
    method: "PUT",
    path: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,54}-staging\/secrets$/,
  },
  {
    method: "GET",
    path: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,54}-staging\/secrets$/,
  },
];

/**
 * The only requests this adapter can send with the D1 token (D-445, O-160): a staging database
 * looked up by name, and a database made. No query, export, delete or other D1 call (slice 8 adds
 * the migrations' query).
 */
export const D1_ALLOWED_CALLS: readonly AllowedCall[] = [
  {
    method: "GET",
    path: /^\/accounts\/[0-9a-f]{32}\/d1\/database\?name=[a-z0-9][a-z0-9-]{0,54}-staging&per_page=100$/,
  },
  { method: "POST", path: /^\/accounts\/[0-9a-f]{32}\/d1\/database$/ },
];

/**
 * Throws unless the request is one of the allow-list's calls (the staging deploy token's unless
 * another is given), by method and path. Checked before every send, so no code path can reach a
 * route, a custom domain, a zone or DNS, or use a token for another's calls.
 */
export function assertAllowedCall(
  request: Pick<CloudflareRequest, "method" | "path">,
  allowed: readonly AllowedCall[] = ALLOWED_CALLS,
): void {
  if (!allowed.some((c) => c.method === request.method && c.path.test(request.path))) {
    throw new Error("the deploy adapter may not send this request");
  }
}

/** The fixed text of each refusal of a deploy. None names an id, a token or Cloudflare's message. */
export const CLOUDFLARE_REFUSALS = {
  bad_project: "the project's slug does not make a staging Worker name",
  credential_unavailable: "the staging deploy credential is not available",
  credential_malformed: "the staging deploy credential is not in the expected shape",
  credential_refused: "Cloudflare refused the staging deploy credential",
  cloudflare_refused: "Cloudflare refused the staging upload",
  cloudflare_unavailable:
    "Cloudflare failed or limited the staging upload; it is tried again",
  cloudflare_unreachable: "Cloudflare did not answer the staging upload",
  unexpected_answer:
    "Cloudflare answered the staging upload in a shape its docs do not give",
  database_binding_missing:
    "the staging Worker has no DB binding to carry over; the New project form sets the project's database up",
} as const;

export type CloudflareRefusal = keyof typeof CLOUDFLARE_REFUSALS;

/** The fixed text of each refusal of a project's setup (O-160). None names an id or a token. */
export const SETUP_REFUSALS = {
  bad_project: "the project's slug does not make a staging Worker and database name",
  bad_placeholder:
    "the project's display name or purpose does not follow the project file's rules",
  credential_unavailable: CLOUDFLARE_REFUSALS.credential_unavailable,
  credential_malformed: CLOUDFLARE_REFUSALS.credential_malformed,
  credential_refused: CLOUDFLARE_REFUSALS.credential_refused,
  database_credential_unavailable: "the D1 credential is not available",
  database_credential_malformed: "the D1 credential is not in the expected shape",
  database_credential_refused: "Cloudflare refused the D1 credential",
  database_ambiguous:
    "Cloudflare lists more than one D1 database of the project's name, or too many like it to tell",
  cloudflare_refused: "Cloudflare refused a step of the project's setup",
  cloudflare_unavailable:
    "Cloudflare failed or limited a step of the project's setup; running it again tries again",
  cloudflare_unreachable: "Cloudflare did not answer a step of the project's setup",
  unexpected_answer:
    "Cloudflare answered a step of the project's setup in a shape its docs do not give",
} as const;

/** The fixed text of each refusal of a secret call (O-160). None names a value or a token. */
export const SECRET_REFUSALS = {
  bad_project: CLOUDFLARE_REFUSALS.bad_project,
  bad_secret_name:
    "the secret's name is not 1 to 64 uppercase letters, digits or underscores starting with a letter, or it is DB or ASSETS",
  bad_secret_value: "the secret's value is empty or larger than 5 KiB",
  credential_unavailable: CLOUDFLARE_REFUSALS.credential_unavailable,
  credential_malformed: CLOUDFLARE_REFUSALS.credential_malformed,
  credential_refused: CLOUDFLARE_REFUSALS.credential_refused,
  cloudflare_refused: "Cloudflare refused the call on the staging Worker's secrets",
  cloudflare_unavailable:
    "Cloudflare failed or limited the call on the staging Worker's secrets",
  cloudflare_unreachable:
    "Cloudflare did not answer the call on the staging Worker's secrets",
  unexpected_answer:
    "Cloudflare answered the call on the staging Worker's secrets in a shape its docs do not give",
} as const;

type Reason =
  CloudflareRefusal | keyof typeof SETUP_REFUSALS | keyof typeof SECRET_REFUSALS;

/** The calls, by the fixed names a refusal reports (O-139). */
export type CloudflareCall =
  | "upload_session"
  | "asset_upload"
  | "worker_upload"
  | "worker_list"
  | "secret_put"
  | "secret_list"
  | "database_list"
  | "database_create";

/** The most of Cloudflare's numeric error codes a refusal keeps. */
const MAX_ERROR_CODES = 5;

class Refused extends Error {
  readonly reason: Reason;
  readonly detail: DeployRefusalDetail | undefined;
  constructor(reason: Reason, detail?: DeployRefusalDetail) {
    super(reason);
    this.name = "Refused";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The refusal an operation returns for a thrown `Refused`, with the text from its own table.
 * Anything else, a reason included that the operation cannot give, is a fault of this code and is
 * thrown again.
 */
function refusalOf(
  table: Readonly<Record<string, string>>,
  error: unknown,
): TargetRefusal {
  if (!(error instanceof Refused) || !Object.hasOwn(table, error.reason)) throw error;
  return {
    outcome: "refused",
    reason: error.reason,
    text: table[error.reason] as string,
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

/** Cloudflare's numeric error codes from its answer, never its messages. */
function errorCodes(body: unknown): number[] {
  if (!isRecord(body) || !Array.isArray(body.errors)) return [];
  return body.errors
    .flatMap((error) => {
      const code = isRecord(error) ? error.code : undefined;
      return typeof code === "number" &&
        Number.isInteger(code) &&
        code >= 0 &&
        code <= 9_999_999
        ? [code]
        : [];
    })
    .slice(0, MAX_ERROR_CODES);
}

/** The types Cloudflare attaches when it serves a file, by extension; text types are UTF-8. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

/** The file's extension without its dot, as Node's `extname` gives it ("" for none). */
const extensionOf = (path: string): string => posix.extname(path).slice(1);

/** The type Cloudflare serves the file with; `application/null` asks for none (the guide). */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extensionOf(path).toLowerCase()] ?? "application/null";
}

/** The manifest hash: SHA-256 of the base64 contents and the extension, first 32 hex characters. */
export function assetHash(file: SiteFile): string {
  const base64 = Buffer.from(file.bytes).toString("base64");
  return createHash("sha256")
    .update(base64 + extensionOf(file.path))
    .digest("hex")
    .slice(0, 32);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The calls made with the D1 token, whose 401 or 403 is that token's refusal. */
const DATABASE_CALLS: readonly CloudflareCall[] = ["database_list", "database_create"];

/** The answer's `result`, when Cloudflare says it succeeded; a refusal naming the call otherwise. */
function resultOf(
  call: CloudflareCall,
  answer: CloudflareAnswer,
  accepted: readonly number[],
): unknown {
  const { status, body } = answer;
  const codes = errorCodes(body);
  const detail: DeployRefusalDetail = {
    call,
    status,
    ...(codes.length ? { codes } : {}),
  };
  if (status === 401 || status === 403) {
    throw new Refused(
      DATABASE_CALLS.includes(call)
        ? "database_credential_refused"
        : "credential_refused",
      detail,
    );
  }
  if (status === 429 || status >= 500) {
    throw new Refused("cloudflare_unavailable", detail);
  }
  if (!accepted.includes(status)) {
    throw new Refused(
      status >= 400 ? "cloudflare_refused" : "unexpected_answer",
      detail,
    );
  }
  if (!isRecord(body) || body.success !== true) {
    throw new Refused("unexpected_answer", detail);
  }
  return body.result;
}

const jwtOf = (result: unknown): string | null =>
  isRecord(result) &&
  typeof result.jwt === "string" &&
  result.jwt !== "" &&
  result.jwt.length <= 8192
    ? result.jwt
    : null;

export interface CloudflareStagingTargetOptions {
  credentials: StagingDeployCredentials;
  /** The D1 token, read only by `setUp` (D-445, O-160). */
  d1Credentials: D1Credentials;
  http: CloudflareHttp;
}

/**
 * The Worker upload's metadata: today's assets-only shape without code, or the module's shape
 * with it (see the header). Bindings never come from the build: only those given here, `DB`
 * inherited on a deploy or bound by id on the placeholder (O-160).
 */
export function workerMetadata(
  completion: string,
  code?: SiteWorker,
  bindings: readonly WorkerBinding[] = [],
): unknown {
  if (!code) {
    return {
      assets: { jwt: completion, config: STAGING_ASSET_CONFIG },
      compatibility_date: STAGING_COMPATIBILITY_DATE,
    };
  }
  return {
    main_module: WORKER_MAIN_MODULE,
    bindings,
    compatibility_date: code.manifest.compatibilityDate,
    compatibility_flags: code.manifest.compatibilityFlags,
    keep_bindings: STAGING_KEEP_BINDINGS,
    assets: {
      jwt: completion,
      config: { ...STAGING_ASSET_CONFIG, run_worker_first: STAGING_RUN_WORKER_FIRST },
    },
  };
}

/** The placeholder's site and module (./placeholder-site.ts), as a build would carry them. */
function placeholderBuild(
  displayName: string,
  purpose: string,
): { files: SiteFile[]; code: SiteWorker } {
  return {
    files: [
      {
        path: PLACEHOLDER_PAGE_FILE,
        bytes: new Uint8Array(Buffer.from(placeholderPage(displayName, purpose))),
      },
    ],
    code: {
      module: PLACEHOLDER_MODULE,
      manifest: {
        compatibilityDate: STAGING_COMPATIBILITY_DATE,
        compatibilityFlags: [],
        requiredSecrets: [],
      },
      migrations: [],
    },
  };
}

export function createCloudflareStagingTarget({
  credentials,
  d1Credentials,
  http,
}: CloudflareStagingTargetOptions): DeployTarget {
  /** Sends one request after checking it is one of the allow-list's calls. */
  async function sendWith(
    allowed: readonly AllowedCall[],
    call: CloudflareCall,
    request: CloudflareRequest,
  ): Promise<CloudflareAnswer> {
    assertAllowedCall(request, allowed);
    try {
      return await http.send(request);
    } catch {
      throw new Refused("cloudflare_unreachable", { call });
    }
  }
  /** With the staging deploy token (or the session's JWT). */
  const send = (call: CloudflareCall, request: CloudflareRequest) =>
    sendWith(ALLOWED_CALLS, call, request);
  /** With the D1 token. */
  const sendD1 = (call: CloudflareCall, request: CloudflareRequest) =>
    sendWith(D1_ALLOWED_CALLS, call, request);

  async function readCredentials(
    port: StagingDeployCredentials | D1Credentials,
    which: "staging" | "database",
  ): Promise<CloudflareCredentials> {
    let read: CloudflareCredentials;
    try {
      read = await port.read();
    } catch {
      throw new Refused(
        which === "staging"
          ? "credential_unavailable"
          : "database_credential_unavailable",
      );
    }
    if (!ACCOUNT_ID.test(read.accountId) || !API_TOKEN.test(read.token)) {
      throw new Refused(
        which === "staging" ? "credential_malformed" : "database_credential_malformed",
      );
    }
    return read;
  }

  async function upload(
    { accountId, token }: CloudflareCredentials,
    worker: string,
    files: SiteFile[],
    code: SiteWorker | undefined,
    bindings: readonly WorkerBinding[],
  ): Promise<void> {
    const account = `/accounts/${accountId}`;
    const byHash = new Map<string, SiteFile>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const file of files) {
      const hash = assetHash(file);
      byHash.set(hash, file);
      manifest[`/${file.path}`] = { hash, size: file.bytes.length };
    }

    // 1. The upload session.
    const sessionAnswer = await send("upload_session", {
      method: "POST",
      path: `${account}/workers/scripts/${worker}/assets-upload-session`,
      bearer: token,
      json: { manifest },
    });
    const session = resultOf("upload_session", sessionAnswer, [200, 201]);
    const sessionJwt = jwtOf(session);
    const buckets = isRecord(session) ? (session.buckets ?? []) : null;
    if (
      sessionJwt === null ||
      !Array.isArray(buckets) ||
      !buckets.every(
        (b) =>
          Array.isArray(b) &&
          b.length > 0 &&
          b.every((h) => typeof h === "string" && HASH.test(h) && byHash.has(h)),
      )
    ) {
      throw new Refused("unexpected_answer", {
        call: "upload_session",
        status: sessionAnswer.status,
      });
    }

    // 2. The buckets. With none, the session's JWT is already the completion token.
    let completion: string | null = buckets.length === 0 ? sessionJwt : null;
    for (const bucket of buckets as string[][]) {
      const answer = await send("asset_upload", {
        method: "POST",
        path: `${account}/workers/assets/upload?base64=true`,
        bearer: sessionJwt,
        form: [...new Set(bucket)].map((hash) => {
          const file = byHash.get(hash) as SiteFile;
          return {
            name: hash,
            filename: hash,
            contentType: contentTypeOf(file.path),
            value: Buffer.from(file.bytes).toString("base64"),
          };
        }),
      });
      completion =
        jwtOf(resultOf("asset_upload", answer, [200, 201, 202])) ?? completion;
    }
    if (completion === null) {
      throw new Refused("unexpected_answer", { call: "asset_upload" });
    }

    // 3. The Worker: the assets and their config, and the build's module when it has one, with
    // `DB` inherited strictly when a binding is (O-160).
    const form: CloudflareFormPart[] = [
      {
        name: "metadata",
        value: JSON.stringify(workerMetadata(completion, code, bindings)),
      },
    ];
    if (code) {
      form.push({
        name: WORKER_MAIN_MODULE,
        filename: WORKER_MAIN_MODULE,
        contentType: WORKER_MODULE_TYPE,
        value: code.module,
      });
    }
    const strict = code !== undefined && bindings.some((b) => b.type === "inherit");
    try {
      resultOf(
        "worker_upload",
        await send("worker_upload", {
          method: "PUT",
          path: `${account}/workers/scripts/${worker}${strict ? BINDINGS_INHERIT_STRICT : ""}`,
          bearer: token,
          form,
        }),
        [200, 201],
      );
    } catch (error) {
      if (
        strict &&
        error instanceof Refused &&
        error.reason === "cloudflare_refused" &&
        error.detail?.codes?.includes(INHERIT_UNRESOLVED_CODE)
      ) {
        throw new Refused("database_binding_missing", error.detail);
      }
      throw error;
    }
  }

  /**
   * Step 1 of the setup: the database by its exact name, made with the location hint only when
   * Cloudflare lists none (see the header). The id is only for the placeholder's binding.
   */
  async function findOrCreateDatabase(
    name: string,
    dryRun: boolean,
  ): Promise<{ step: DatabaseStep; id: string | null }> {
    const { accountId, token } = await readCredentials(d1Credentials, "database");
    const account = `/accounts/${accountId}`;
    const listAnswer = await sendD1("database_list", {
      method: "GET",
      path: `${account}/d1/database?name=${name}&per_page=${DATABASE_LIST_PAGE}`,
      bearer: token,
    });
    const listed = resultOf("database_list", listAnswer, [200]);
    if (
      !Array.isArray(listed) ||
      !listed.every((d) => isRecord(d) && typeof d.name === "string")
    ) {
      throw new Refused("unexpected_answer", {
        call: "database_list",
        status: listAnswer.status,
      });
    }
    // Only the exact name counts: a search can list names like it, each with its own id.
    const matches = (listed as Record<string, unknown>[]).filter(
      (d) => d.name === name,
    );
    if (
      matches.length > 1 ||
      (matches.length === 0 && listed.length >= DATABASE_LIST_PAGE)
    ) {
      throw new Refused("database_ambiguous", {
        call: "database_list",
        status: listAnswer.status,
      });
    }
    const [found] = matches;
    if (found) {
      if (typeof found.uuid !== "string" || !DATABASE_ID.test(found.uuid)) {
        throw new Refused("unexpected_answer", {
          call: "database_list",
          status: listAnswer.status,
        });
      }
      return { step: "found", id: found.uuid };
    }
    if (dryRun) return { step: "would_create", id: null };

    const createAnswer = await sendD1("database_create", {
      method: "POST",
      path: `${account}/d1/database`,
      bearer: token,
      json: { name, primary_location_hint: STAGING_DATABASE_LOCATION },
    });
    const created = resultOf("database_create", createAnswer, [200, 201]);
    if (
      !isRecord(created) ||
      created.name !== name ||
      typeof created.uuid !== "string" ||
      !DATABASE_ID.test(created.uuid)
    ) {
      throw new Refused("unexpected_answer", {
        call: "database_create",
        status: createAnswer.status,
      });
    }
    return { step: "created", id: created.uuid };
  }

  /** Whether Cloudflare lists the Worker, read before the placeholder (see the header). */
  async function workerExists(
    { accountId, token }: CloudflareCredentials,
    worker: string,
  ): Promise<boolean> {
    const answer = await send("worker_list", {
      method: "GET",
      path: `/accounts/${accountId}/workers/scripts`,
      bearer: token,
    });
    const listed = resultOf("worker_list", answer, [200]);
    // Every entry must name its Worker: an answer that could hide one never reads as absent.
    if (
      !Array.isArray(listed) ||
      !listed.every((w) => isRecord(w) && typeof w.id === "string" && w.id !== "")
    ) {
      throw new Refused("unexpected_answer", {
        call: "worker_list",
        status: answer.status,
      });
    }
    return (listed as Record<string, unknown>[]).some((w) => w.id === worker);
  }

  /** The secrets path of the project's staging Worker, the only Worker it names (D-440). */
  async function secretsPath(worker: string): Promise<{ path: string; token: string }> {
    const { accountId, token } = await readCredentials(credentials, "staging");
    return { path: `/accounts/${accountId}/workers/scripts/${worker}/secrets`, token };
  }

  const checkRefusal = (reason: keyof typeof SETUP_REFUSALS): ProjectSetUp => ({
    outcome: "refused",
    step: "check",
    reason,
    text: SETUP_REFUSALS[reason],
  });
  const secretRefusal = (reason: keyof typeof SECRET_REFUSALS): TargetRefusal => ({
    outcome: "refused",
    reason,
    text: SECRET_REFUSALS[reason],
  });

  return {
    name: "cloudflare",
    async deploy({
      project,
      commitSha,
      archive,
    }: {
      project: Project;
      commitSha: string;
      archive: Uint8Array;
    }): Promise<StagingUpload> {
      const worker = stagingWorkerName(project.slug);
      if (worker === null) {
        return {
          outcome: "refused",
          cause: "infrastructure",
          reason: "bad_project",
          text: CLOUDFLARE_REFUSALS.bad_project,
        };
      }
      const set = readSiteFiles(archive, commitSha);
      if (!set.ok) {
        return {
          outcome: "refused",
          cause: set.cause,
          reason: set.reason,
          text: set.text,
        };
      }
      try {
        // A build with a Worker carries the project's database over (O-160); one without, none.
        await upload(
          await readCredentials(credentials, "staging"),
          worker,
          set.files,
          set.worker,
          set.worker ? [INHERITED_DATABASE_BINDING] : [],
        );
      } catch (error) {
        // Anything but a refusal is a fault of this code: thrown, so the core records it as the
        // target's error (`target_error`) instead of as Cloudflare's answer.
        const { reason, text, detail } = refusalOf(CLOUDFLARE_REFUSALS, error);
        return {
          outcome: "refused",
          cause: "infrastructure",
          reason,
          text,
          ...(detail ? { detail } : {}),
        };
      }
      // The required secret names ride along for slice 7's check (D-448); nothing holds yet.
      return {
        outcome: "deployed",
        files: set.files.length,
        ...(set.worker
          ? { worker: { requiredSecrets: [...set.worker.manifest.requiredSecrets] } }
          : {}),
      };
    },

    async setUp({
      slug,
      displayName,
      purpose,
      dryRun = false,
    }: ProjectSetUpRequest): Promise<ProjectSetUp> {
      const name = stagingDatabaseName(slug);
      if (name === null) return checkRefusal("bad_project");
      if (!isProjectDisplayName(displayName) || !isProjectPurpose(purpose)) {
        return checkRefusal("bad_placeholder");
      }
      let database: { step: DatabaseStep; id: string | null };
      try {
        database = await findOrCreateDatabase(name, dryRun);
      } catch (error) {
        return { ...refusalOf(SETUP_REFUSALS, error), step: "database" };
      }
      const outcome = dryRun ? "dry_run" : "set_up";
      try {
        // The Worker has the database's name, `<slug>-staging`.
        const staging = await readCredentials(credentials, "staging");
        if (await workerExists(staging, name)) {
          return { outcome, database: database.step, placeholder: "kept" };
        }
        if (dryRun || database.id === null) {
          return { outcome, database: database.step, placeholder: "would_upload" };
        }
        const { files, code } = placeholderBuild(displayName, purpose);
        await upload(staging, name, files, code, [
          { type: "d1", name: DATABASE_BINDING_NAME, database_id: database.id },
        ]);
      } catch (error) {
        return {
          ...refusalOf(SETUP_REFUSALS, error),
          step: "placeholder",
          database: database.step,
        };
      }
      return { outcome, database: database.step, placeholder: "uploaded" };
    },

    async putSecret(slug: string, name: string, value: string): Promise<SecretPut> {
      const worker = stagingWorkerName(slug);
      if (worker === null) return secretRefusal("bad_project");
      if (!isProductSecretName(name)) return secretRefusal("bad_secret_name");
      if (
        typeof value !== "string" ||
        value === "" ||
        Buffer.byteLength(value, "utf8") > SECRET_VALUE_MAX_BYTES
      ) {
        return secretRefusal("bad_secret_value");
      }
      try {
        const { path, token } = await secretsPath(worker);
        // Only `success` is read: the answer's `result` may echo the value, and is dropped.
        resultOf(
          "secret_put",
          await send("secret_put", {
            method: "PUT",
            path,
            bearer: token,
            json: { name, text: value, type: "secret_text" },
          }),
          [200, 201],
        );
      } catch (error) {
        return refusalOf(SECRET_REFUSALS, error);
      }
      return { outcome: "put", name };
    },

    async listSecretNames(slug: string): Promise<SecretNames> {
      const worker = stagingWorkerName(slug);
      if (worker === null) return secretRefusal("bad_project");
      let listed: unknown;
      try {
        const { path, token } = await secretsPath(worker);
        const answer = await send("secret_list", {
          method: "GET",
          path,
          bearer: token,
        });
        listed = resultOf("secret_list", answer, [200]);
        if (
          !Array.isArray(listed) ||
          !listed.every(
            (s) =>
              isRecord(s) && typeof s.name === "string" && typeof s.type === "string",
          )
        ) {
          throw new Refused("unexpected_answer", {
            call: "secret_list",
            status: answer.status,
          });
        }
      } catch (error) {
        return refusalOf(SECRET_REFUSALS, error);
      }
      // Names only, of secret bindings that follow the form's rule: the only names a build can
      // require (./deploy-manifest.ts). Any other field of the answer is never read.
      const names = (listed as { name: string; type: string }[])
        .filter((s) => SECRET_TYPES.includes(s.type) && isProductSecretName(s.name))
        .map((s) => s.name);
      return { outcome: "listed", names: [...new Set(names)].sort() };
    },
  };
}

/** The time one request to Cloudflare may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Cloudflare's answers here are small JSON documents. */
const MAX_ANSWER_BYTES = 1024 * 1024;

/**
 * The real HTTP port: Cloudflare's API with the bearer token, no redirect followed, a time limit and
 * a bounded answer read as JSON. Not used in tests.
 */
export function createCloudflareHttp(): CloudflareHttp {
  return {
    async send({ method, path, bearer, json, form }) {
      if (!path.startsWith("/")) throw new Error("a Cloudflare path must start with /");
      let body: string | FormData | undefined;
      const headers: Record<string, string> = {
        authorization: `Bearer ${bearer}`,
        "user-agent": "foreman-runner",
      };
      if (json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(json);
      } else if (form !== undefined) {
        const data = new FormData();
        for (const part of form) {
          if ("filename" in part) {
            data.append(
              part.name,
              new Blob([part.value], { type: part.contentType }),
              part.filename,
            );
          } else data.append(part.name, part.value);
        }
        body = data;
      }
      const response = await fetch(`${CLOUDFLARE_API}${path}`, {
        method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await boundedText(response, MAX_ANSWER_BYTES);
      let parsed: unknown = null;
      try {
        parsed = text === null ? null : (JSON.parse(text) as unknown);
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
  };
}

/** The answer's text, or null when it is longer than `maxBytes`. */
async function boundedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader?.read();
    if (!next || next.done) break;
    size += next.value.length;
    if (size > maxBytes) {
      await reader?.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
