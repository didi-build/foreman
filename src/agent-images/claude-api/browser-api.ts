// The browser host's tool API (ADR 0119 slice 5b, D-476), for slice 5c's browser tools in QA's
// agent pod. It listens on the browser pod's own IP address, which only that agent pod may reach
// (the run's NetworkPolicies). Three endpoints, each a POST of a JSON object with exactly its
// fields:
//
//   POST /open {path, viewport: "desktop" | "mobile"}
//   POST /act  {action, ref?, value?}   (ref: an aria-ref from the last snapshot)
//   POST /read {view: "snapshot" | "text" | "console" | "network"}
//
// A web page cannot call it: only `content-type: application/json` is taken, so a page's
// cross-origin request needs a preflight, and every OPTIONS (like every method but POST) gets 405
// with no CORS header; a request that carries an `Origin` header, as a browser's POST always does,
// is refused too. Bodies are bounded, one request runs at a time, and each has a time limit. Every
// refusal is a fixed text. The log has one line per request: the endpoint, the status, the size
// of the answer and the time, and nothing the request or the page held.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import type { Logger } from "../../service-kit/logger.ts";
import {
  ACTIONS,
  BROWSER_LIMITS,
  KEYS,
  VIEWPORT_NAMES,
  VIEWS,
  ActionError,
  NoPageError,
  PathError,
  type ActInput,
  type BrowserSession,
  type OpenInput,
  type PageAnswer,
  type ReadInput,
} from "./browser-session.ts";

/** The largest request body taken. A path and a value at their bounds fit with room to spare. */
export const MAX_BODY_BYTES = 8 * 1024;

/** How long one request may take before the host answers 504. */
export const REQUEST_TIME_LIMIT_MS = 14_000;

export const ENDPOINTS = ["/open", "/act", "/read"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/** An `aria-ref` as the snapshot writes it: `e2`, or `f1e3` inside a frame. */
export const REF_PATTERN = /^(?:f\d{1,6})?e\d{1,9}$/;

/** The actions that act on an element and take no value. */
const NO_VALUE: readonly string[] = ["click", "check", "uncheck", "hover"];

export const BROWSER_API_ERRORS = {
  notFound: "No such endpoint. The endpoints are POST /open, /act and /read.",
  method: "Only POST is allowed.",
  origin: "A request from a web page is refused.",
  contentType: "The body must be application/json.",
  tooLarge: `The body is larger than ${MAX_BODY_BYTES} bytes.`,
  notJson: "The body is not a JSON object.",
  openFields: "/open takes exactly path and viewport.",
  path: `path must start with one /, stay on the site and hold at most ${BROWSER_LIMITS.pathChars} characters, with no space, backslash or control character.`,
  viewport: "viewport must be desktop or mobile.",
  actFields: "/act takes action, ref and value only.",
  action: `action must be one of ${ACTIONS.join(", ")}.`,
  ref: "ref must be an aria-ref from the last snapshot, such as e2 or f1e3. back takes none.",
  value: `value is needed for fill, select and press only, as text of at most ${BROWSER_LIMITS.valueChars} characters.`,
  key: `press takes one of these keys as its value: ${KEYS.join(", ")}.`,
  readFields: "/read takes exactly view.",
  view: `view must be one of ${VIEWS.join(", ")}.`,
  busy: "The browser is busy with another request.",
  noPage: "No page is open yet. Open one first.",
  timeLimit: "The browser did not answer in time.",
  failed: "The browser host failed.",
} as const;

type Parsed<T> = { input: T } | { error: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

/** A path on the site: starts with one `/`, no space, backslash or control character. */
export function isSitePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > BROWSER_LIMITS.pathChars) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || char === "\\") return false;
  }
  // Whatever follows, it resolves on the origin it is given: no scheme, host or port of its own.
  const base = "http://127.0.0.1:1";
  try {
    return new URL(path, base).origin === base;
  } catch {
    return false;
  }
}

export function parseOpen(body: unknown): Parsed<OpenInput> {
  if (!isObject(body) || !hasOnly(body, ["path", "viewport"]) || !("path" in body)) {
    return { error: BROWSER_API_ERRORS.openFields };
  }
  if (!isSitePath(body.path)) return { error: BROWSER_API_ERRORS.path };
  const viewport = VIEWPORT_NAMES.find((name) => name === body.viewport);
  if (viewport === undefined) return { error: BROWSER_API_ERRORS.viewport };
  return { input: { path: body.path, viewport } };
}

export function parseAct(body: unknown): Parsed<ActInput> {
  if (!isObject(body) || !hasOnly(body, ["action", "ref", "value"])) {
    return { error: BROWSER_API_ERRORS.actFields };
  }
  const action = ACTIONS.find((name) => name === body.action);
  if (action === undefined) return { error: BROWSER_API_ERRORS.action };
  if (action === "back") {
    if ("ref" in body) return { error: BROWSER_API_ERRORS.ref };
    if ("value" in body) return { error: BROWSER_API_ERRORS.value };
    return { input: { action } };
  }
  const ref = body.ref;
  if (
    typeof ref !== "string" ||
    ref.length > BROWSER_LIMITS.refChars ||
    !REF_PATTERN.test(ref)
  ) {
    return { error: BROWSER_API_ERRORS.ref };
  }
  if (NO_VALUE.includes(action)) {
    if ("value" in body) return { error: BROWSER_API_ERRORS.value };
    return { input: { action, ref } };
  }
  const value = body.value;
  if (typeof value !== "string" || value.length > BROWSER_LIMITS.valueChars) {
    return { error: BROWSER_API_ERRORS.value };
  }
  if (action === "press" && !(KEYS as readonly string[]).includes(value)) {
    return { error: BROWSER_API_ERRORS.key };
  }
  if (action === "select" && value === "") return { error: BROWSER_API_ERRORS.value };
  return { input: { action, ref, value } };
}

export function parseRead(body: unknown): Parsed<ReadInput> {
  if (!isObject(body) || !hasOnly(body, ["view"])) {
    return { error: BROWSER_API_ERRORS.readFields };
  }
  const view = VIEWS.find((name) => name === body.view);
  if (view === undefined) return { error: BROWSER_API_ERRORS.view };
  return { input: { view } };
}

/** `application/json`, with no parameter but an optional UTF-8 charset. */
export function isJsonType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type, ...params] = header.split(";").map((part) => part.trim().toLowerCase());
  if (type !== "application/json") return false;
  return params.every((param) => param === "charset=utf-8");
}

class TooLarge extends Error {}

/** The body, or TooLarge once it passes the bound; what is past the bound is not kept. */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** The session call for an endpoint's body, or the fixed text of why the body is refused. */
function workFor(
  session: BrowserSession,
  endpoint: Endpoint,
  body: unknown,
): { work: () => Promise<PageAnswer> } | { error: string } {
  if (endpoint === "/open") {
    const parsed = parseOpen(body);
    return "error" in parsed ? parsed : { work: () => session.open(parsed.input) };
  }
  if (endpoint === "/act") {
    const parsed = parseAct(body);
    return "error" in parsed ? parsed : { work: () => session.act(parsed.input) };
  }
  const parsed = parseRead(body);
  return "error" in parsed ? parsed : { work: () => session.read(parsed.input) };
}

class TimeLimit extends Error {}

function withTimeLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeLimit()), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** The API's request handler over a browser session. */
export function browserApi(
  session: BrowserSession,
  logger: Logger,
  options: { timeLimitMs?: number; now?: () => number } = {},
): RequestListener {
  const timeLimitMs = options.timeLimitMs ?? REQUEST_TIME_LIMIT_MS;
  const now = options.now ?? (() => performance.now());
  let busy = false;

  return (request: IncomingMessage, response: ServerResponse) => {
    const started = now();
    const endpoint = ENDPOINTS.find((name) => name === request.url);
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      const text = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(text)),
        ...headers,
      });
      response.end(text);
      logger.info("browser request", {
        endpoint: endpoint ?? "other",
        status,
        bytes: Buffer.byteLength(text),
        durationMs: Math.round(now() - started),
      });
    };
    const refuse = (
      status: number,
      error: string,
      headers?: Record<string, string>,
    ) => {
      // Read and drop what the request sends, unless it is past the bound.
      request.resume();
      send(status, { error }, headers);
    };

    if (endpoint === undefined) return refuse(404, BROWSER_API_ERRORS.notFound);
    if (request.method !== "POST") {
      return refuse(405, BROWSER_API_ERRORS.method, { allow: "POST" });
    }
    if (request.headers.origin !== undefined)
      return refuse(403, BROWSER_API_ERRORS.origin);
    if (!isJsonType(request.headers["content-type"])) {
      return refuse(415, BROWSER_API_ERRORS.contentType);
    }
    // Past the bound: the answer, then the connection closes, so nothing more is read.
    const tooLarge = () => {
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      send(413, { error: BROWSER_API_ERRORS.tooLarge });
    };
    const length = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return tooLarge();

    void (async () => {
      let body: unknown;
      try {
        body = JSON.parse((await readBody(request)).toString("utf8"));
      } catch (error) {
        if (error instanceof TooLarge) return tooLarge();
        return send(400, { error: BROWSER_API_ERRORS.notJson });
      }
      const call = workFor(session, endpoint, body);
      if ("error" in call) return send(400, { error: call.error });
      if (busy) return send(409, { error: BROWSER_API_ERRORS.busy });
      busy = true;
      const running = call.work().finally(() => {
        busy = false;
      });
      // A request past its time limit keeps the browser busy until it ends.
      running.catch(() => {});
      try {
        send(200, await withTimeLimit(running, timeLimitMs));
      } catch (error) {
        if (error instanceof TimeLimit)
          send(504, { error: BROWSER_API_ERRORS.timeLimit });
        else if (error instanceof NoPageError)
          send(409, { error: BROWSER_API_ERRORS.noPage });
        else if (error instanceof PathError)
          send(400, { error: BROWSER_API_ERRORS.path });
        else if (error instanceof ActionError) send(422, { error: error.message });
        else send(500, { error: BROWSER_API_ERRORS.failed });
      }
    })();
  };
}
