// The deploy adapter's staging target on Cloudflare (ADR 0111 section 2, `deploy`; D-353, O-116).
// It checks CI's build (./site-files.ts) and, only when the set passes, uploads exactly those files
// to the project's assets-only Worker `<slug>-staging` with Cloudflare's direct upload for Workers
// static assets. Nothing from the project's repository runs: no Wrangler, no npm, no repository
// config. The route and the DNS name come from the infra stack (D-357, O-112): this adapter never
// creates a route, a custom domain or a DNS record, and it can send only the three requests below
// (`ALLOWED_CALLS`, checked before every send).
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
// Every refusal is infrastructure, with fixed text: the credential missing or malformed, Cloudflare
// refusing the token (401 or 403), refusing the request (another 4xx), failing (429 or 5xx), not
// answering, or answering in a shape the docs do not give. Cloudflare's own error messages are
// never kept, logged or returned, since they can name ids. The token and the JWTs are never logged
// or returned.
import { createHash } from "node:crypto";
import { posix } from "node:path";

import { PROJECT_SLUG } from "../../core/register-project.ts";
import type { Project } from "../../core/store.ts";
import type { StagingTarget, StagingUpload } from "../../core/staging-deploy.ts";
import { readSiteFiles, type SiteFile } from "./site-files.ts";

/** Cloudflare's API, under which every path below is sent. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The asset configuration the runner sets on every staging Worker (see the header). */
export const STAGING_ASSET_CONFIG = { not_found_handling: "single-page-application" };

/** The compatibility date sent with the Worker: the date in Launchpad's `wrangler.jsonc`. */
export const STAGING_COMPATIBILITY_DATE = "2026-10-26";

/** Cloudflare's longest Worker name. */
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{32}$/;
/** A Cloudflare API token as the runner reads it: printable, no space, a sane length. */
const API_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** The project's staging Worker, as the infra stack's route names it (O-112). */
export function stagingWorkerName(slug: string): string | null {
  if (!PROJECT_SLUG.test(slug)) return null;
  const name = `${slug}-staging`;
  return WORKER_NAME.test(name) ? name : null;
}

/** The deploy credential (D-353): one Cloudflare API token with Workers Scripts: Edit only. */
export interface CloudflareCredentials {
  /** The account the staging Workers live in, 32 hex characters (an id, kept as a secret, D-361). */
  accountId: string;
  token: string;
}

/** Reads the credential each time it is needed. Refuses with `NotBuiltError` until it exists. */
export interface StagingDeployCredentials {
  read(): Promise<CloudflareCredentials>;
}

/** A plain form field, or a file part with its name and type. */
export type CloudflareFormPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; value: string };

/** One request to Cloudflare's API. `path` is under `CLOUDFLARE_API`, never a full URL. */
export interface CloudflareRequest {
  method: "POST" | "PUT";
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

/** The only requests this adapter can send. Anything else is refused before it is sent. */
export const ALLOWED_CALLS: readonly { method: string; path: RegExp }[] = [
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
];

/**
 * Throws unless the request is one of `ALLOWED_CALLS`, by method and path. Checked before every
 * send, so no code path can reach a route, a custom domain, a zone or DNS.
 */
export function assertAllowedCall(
  request: Pick<CloudflareRequest, "method" | "path">,
): void {
  if (
    !ALLOWED_CALLS.some((c) => c.method === request.method && c.path.test(request.path))
  ) {
    throw new Error("the deploy adapter may not send this request");
  }
}

/** The fixed text of each refusal. None names an id, a token or Cloudflare's message. */
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
} as const;

export type CloudflareRefusal = keyof typeof CLOUDFLARE_REFUSALS;

class Refused extends Error {
  readonly reason: CloudflareRefusal;
  constructor(reason: CloudflareRefusal) {
    super(CLOUDFLARE_REFUSALS[reason]);
    this.name = "Refused";
    this.reason = reason;
  }
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

/** The answer's `result`, when Cloudflare says it succeeded; a refusal otherwise. */
function resultOf(answer: CloudflareAnswer, accepted: readonly number[]): unknown {
  const { status, body } = answer;
  if (status === 401 || status === 403) throw new Refused("credential_refused");
  if (status === 429 || status >= 500) throw new Refused("cloudflare_unavailable");
  if (!accepted.includes(status)) {
    throw new Refused(status >= 400 ? "cloudflare_refused" : "unexpected_answer");
  }
  if (!isRecord(body) || body.success !== true) throw new Refused("unexpected_answer");
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
  http: CloudflareHttp;
}

export function createCloudflareStagingTarget({
  credentials,
  http,
}: CloudflareStagingTargetOptions): StagingTarget {
  /** Sends one request after checking it is one of the three this adapter may send. */
  async function send(request: CloudflareRequest): Promise<CloudflareAnswer> {
    assertAllowedCall(request);
    try {
      return await http.send(request);
    } catch {
      throw new Refused("cloudflare_unreachable");
    }
  }

  async function readCredentials(): Promise<CloudflareCredentials> {
    let read: CloudflareCredentials;
    try {
      read = await credentials.read();
    } catch {
      throw new Refused("credential_unavailable");
    }
    if (!ACCOUNT_ID.test(read.accountId) || !API_TOKEN.test(read.token)) {
      throw new Refused("credential_malformed");
    }
    return read;
  }

  async function upload(worker: string, files: SiteFile[]): Promise<void> {
    const { accountId, token } = await readCredentials();
    const account = `/accounts/${accountId}`;
    const byHash = new Map<string, SiteFile>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const file of files) {
      const hash = assetHash(file);
      byHash.set(hash, file);
      manifest[`/${file.path}`] = { hash, size: file.bytes.length };
    }

    // 1. The upload session.
    const session = resultOf(
      await send({
        method: "POST",
        path: `${account}/workers/scripts/${worker}/assets-upload-session`,
        bearer: token,
        json: { manifest },
      }),
      [200, 201],
    );
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
      throw new Refused("unexpected_answer");
    }

    // 2. The buckets. With none, the session's JWT is already the completion token.
    let completion: string | null = buckets.length === 0 ? sessionJwt : null;
    for (const bucket of buckets as string[][]) {
      const answer = await send({
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
      completion = jwtOf(resultOf(answer, [200, 201, 202])) ?? completion;
    }
    if (completion === null) throw new Refused("unexpected_answer");

    // 3. The Worker: the assets and their config, and no code module.
    resultOf(
      await send({
        method: "PUT",
        path: `${account}/workers/scripts/${worker}`,
        bearer: token,
        form: [
          {
            name: "metadata",
            value: JSON.stringify({
              assets: { jwt: completion, config: STAGING_ASSET_CONFIG },
              compatibility_date: STAGING_COMPATIBILITY_DATE,
            }),
          },
        ],
      }),
      [200, 201],
    );
  }

  return {
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
        await upload(worker, set.files);
      } catch (error) {
        // Anything but a refusal is a fault of this code: thrown, so the core records it as the
        // target's error (`target_error`) instead of as Cloudflare's answer.
        if (!(error instanceof Refused)) throw error;
        return {
          outcome: "refused",
          cause: "infrastructure",
          reason: error.reason,
          text: CLOUDFLARE_REFUSALS[error.reason],
        };
      }
      return { outcome: "deployed", files: set.files.length };
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
