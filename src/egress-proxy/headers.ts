// Header rewriting for model traffic (ADR 0106 sections 5 and 6). The proxy changes only what it
// must: it drops hop-by-hop headers and any credential the agent sent, and sets the provider's
// credential. Every other header, and the body, passes through unchanged.
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import type { CredentialStyle } from "./providers.ts";

/** Headers that describe one connection, not the request (RFC 9110 section 7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers that carry an API credential in common model APIs. The agent's are always dropped. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
]);

function copyWithout(
  incoming: IncomingHttpHeaders,
  drop: ReadonlySet<string>,
): OutgoingHttpHeaders {
  // Headers the Connection header names are hop-by-hop for this message too.
  const named = new Set(
    String(incoming.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      named.has(name) ||
      drop.has(name)
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** The headers to send upstream. `credential` is required unless the style is `none`. */
export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  style: CredentialStyle,
  credential: string | undefined,
): OutgoingHttpHeaders {
  // Host is dropped so the HTTP client sets the upstream's own.
  const out = copyWithout(incoming, new Set([...CREDENTIAL_HEADERS, "host"]));
  if (style === "none") return out;
  if (credential === undefined) throw new Error("provider credential is missing");
  if (style === "x-api-key") out["x-api-key"] = credential;
  else out.authorization = `Bearer ${credential}`;
  return out;
}

/** The upstream response headers to pass back to the agent. */
export function downstreamResponseHeaders(
  incoming: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  return copyWithout(incoming, new Set());
}
