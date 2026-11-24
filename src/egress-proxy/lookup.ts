// The documentation lookup route (ADR 0119 slice 4a, D-460, D-471 to D-475, ADR 0106 sections 2
// and 3). `GET /lookup/<host><path>` asks the proxy itself to read one page from a host on the
// run's trusted documentation list. The proxy makes the GET with headers it builds from scratch,
// so nothing the agent sends reaches the site, and it passes back only the status, a few response
// headers and at most LOOKUP_BODY_LIMIT bytes of the body. It never follows a redirect: the agent's
// tool does, within the list. Matching is exact on the canonical name, as for CONNECT (./hosts.ts).
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import { canonicalHost } from "./hosts.ts";

/** The reserved path prefix. No provider may take this name. */
export const LOOKUP_PREFIX = "/lookup";
/** The only port a lookup reaches. */
export const LOOKUP_PORT = 443;
/** The most body bytes the proxy passes back for one lookup. The body simply ends there. */
export const LOOKUP_BODY_LIMIT = 2 * 1024 * 1024;
/** How long one lookup may take, from its check to its last byte. */
export const LOOKUP_TIMEOUT_MS = 8_000;
/** The most lookups the proxy forwards in one run when MAX_LOOKUP_REQUESTS is not set. */
export const DEFAULT_MAX_LOOKUP_REQUESTS = 40;
/** The longest path and query after the host (D-472: an address of at most 2,000 characters). */
export const MAX_LOOKUP_PATH_LENGTH = 2_000;

/** Generic, so no project or person is named to the site. */
export const LOOKUP_USER_AGENT = "Mozilla/5.0 (compatible; docs-reader/1.0)";

/** Each refusal's status and fixed text. The body is the text, as `text/plain`. */
export const LOOKUP_REFUSALS = {
  method: { status: 405, text: "only GET is allowed" },
  body: { status: 400, text: "a lookup has no body" },
  malformed: { status: 400, text: "malformed documentation address" },
  unlisted: { status: 403, text: "host not on the trusted documentation list" },
  ceiling: { status: 403, text: "documentation lookup limit reached" },
  blocked: { status: 403, text: "documentation site address not allowed" },
  unreachable: { status: 502, text: "documentation site unreachable" },
  timeout: { status: 504, text: "documentation site timed out" },
} as const;

export type LookupRefusal = (typeof LOOKUP_REFUSALS)[keyof typeof LOOKUP_REFUSALS];

export type LookupTarget =
  | { ok: true; host: string; path: string }
  | {
      ok: false;
      reason: "invalid host name" | "host not listed" | "invalid path";
      /** The canonical host, when the first segment is one. Never the raw segment. */
      host?: string;
    };

/** Visible ASCII without `#`: a request target the proxy can pass on as it came. */
const PLAIN_PATH = /^[!"$-~]*$/;

/**
 * The lookup a request URL asks for, or undefined if the URL is not on the route. Only
 * `/lookup`, `/lookup/...` and `/lookup?...` are on it. The first segment after the prefix is the
 * host, canonicalized and matched exactly against the list; the rest of the path and the query
 * pass on unchanged, `/` when there is none.
 */
export function lookupTarget(
  url: string | undefined,
  hosts: ReadonlySet<string>,
): LookupTarget | undefined {
  if (url === undefined || !url.startsWith(LOOKUP_PREFIX)) return undefined;
  const rest = url.slice(LOOKUP_PREFIX.length);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) return undefined;
  const afterSlash = rest.startsWith("/") ? rest.slice(1) : "";
  const end = afterSlash.search(/[/?]/);
  const segment = end === -1 ? afterSlash : afterSlash.slice(0, end);
  const remainder = end === -1 ? "" : afterSlash.slice(end);
  const host = canonicalHost(segment);
  if (host === undefined) return { ok: false, reason: "invalid host name" };
  if (!hosts.has(host)) return { ok: false, reason: "host not listed", host };
  if (remainder.length > MAX_LOOKUP_PATH_LENGTH || !PLAIN_PATH.test(remainder)) {
    return { ok: false, reason: "invalid path", host };
  }
  const path =
    remainder === "" ? "/" : remainder.startsWith("?") ? `/${remainder}` : remainder;
  return { ok: true, host, path };
}

/** True when the request says it carries a body. A lookup never does. */
export function hasRequestBody(headers: IncomingHttpHeaders): boolean {
  if (headers["transfer-encoding"] !== undefined) return true;
  const length = headers["content-length"];
  return length !== undefined && !/^\s*0+\s*$/.test(length);
}

/** The request headers of every lookup, built from scratch: nothing comes from the agent. */
export function lookupRequestHeaders(): OutgoingHttpHeaders {
  return {
    accept:
      "text/html, application/xhtml+xml, text/plain, text/markdown;q=0.9, */*;q=0.1",
    "accept-encoding": "identity",
    "user-agent": LOOKUP_USER_AGENT,
  };
}

/**
 * The response headers passed back to the agent: the content type, the content length when the
 * body fits the limit (a longer body is cut, so its length would be wrong), the content encoding,
 * and the location of a redirect. Everything else, Set-Cookie included, is dropped.
 */
export function lookupResponseHeaders(
  status: number,
  upstream: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const type = upstream["content-type"];
  if (type !== undefined) out["content-type"] = type;
  const length = upstream["content-length"];
  if (
    length !== undefined &&
    /^[0-9]{1,16}$/.test(length) &&
    Number(length) <= LOOKUP_BODY_LIMIT
  ) {
    out["content-length"] = length;
  }
  const encoding = upstream["content-encoding"];
  if (encoding !== undefined) out["content-encoding"] = encoding;
  const location = upstream.location;
  if (status >= 300 && status <= 399 && location !== undefined) out.location = location;
  return out;
}
