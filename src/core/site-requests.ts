// The documentation sites a run asks Didi to trust (ADR 0119 slice 4, D-460). A run that found a
// useful documentation site off its list names it in its answer, as it names a bug outside its
// item (./out-of-scope-findings.ts, D-244). The runner, never the agent, opens one approve-once
// request per host for Didi (D-473); an approved host joins the one trusted list every run's
// lookup reads (D-474).
//
// This one check is shared: the OpenCode image reads the list from the `foreman-report` block,
// and the runner checks it again before it opens any request. It has no imports, so each image's
// Dockerfile copies this file alone. The check is strict: a list of at most 3 objects with
// exactly `host` (a plain DNS host name: labels only, no IP address, port, path or wildcard) and
// `reason` (one line of 1 to 300 characters, trimmed). Each host is returned in its canonical
// form, lower case with no trailing dot. Left out, the list is empty. Nothing else is guessed:
// any other shape is a problem the caller fails on.
//
// `canonicalHostName` is the same rule as the egress proxy's `canonicalHost`
// (src/egress-proxy/hosts.ts), written here without `node:net` so the images can copy it; a test
// holds the two equal. The task file's `docsLookupHosts` is checked with it too.

export interface SiteRequest {
  /** The site's host name, canonical: lower case, no trailing dot. */
  host: string;
  /** Why the run wants it, one line, trimmed, 1 to `MAX_SITE_REASON` characters. */
  reason: string;
}

export const SITE_REQUESTS = "siteRequests";
export const MAX_SITE_REQUESTS = 3;
export const MAX_SITE_REASON = 300;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The canonical form of a DNS host name, or undefined if it is not one: lower case, one trailing
 * dot removed, at most 253 characters, at least two labels of letters, digits and inner hyphens,
 * and a last label that is not all digits, so no IP address (an IPv6 address has colons).
 */
export function canonicalHostName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const host = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (host.length === 0 || host.length > 253) return undefined;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    return undefined;
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return undefined;
  return host;
}

/** Whether `value` is a host name already in its canonical form. */
export const isCanonicalHost = (value: unknown): value is string =>
  typeof value === "string" && canonicalHostName(value) === value;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The list, trimmed and canonical, or the reason it is unusable. `undefined` is an empty list. */
export function checkSiteRequests(
  value: unknown,
): { siteRequests: SiteRequest[] } | { problem: string } {
  if (value === undefined) return { siteRequests: [] };
  if (!Array.isArray(value) || value.length > MAX_SITE_REQUESTS) {
    return {
      problem: `${SITE_REQUESTS} must be a list of at most ${MAX_SITE_REQUESTS} items`,
    };
  }
  const siteRequests: SiteRequest[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.host !== "string" ||
      typeof item.reason !== "string"
    ) {
      return { problem: `each of ${SITE_REQUESTS} must have host and reason only` };
    }
    const host = canonicalHostName(item.host);
    if (host === undefined) {
      return {
        problem:
          "a site request's host must be a plain host name, with no scheme, path, port, IP address or wildcard",
      };
    }
    const reason = item.reason.trim();
    if (reason === "" || reason.length > MAX_SITE_REASON || /[\r\n]/.test(reason)) {
      return {
        problem: `a site request's reason must be one line of 1 to ${MAX_SITE_REASON} characters`,
      };
    }
    siteRequests.push({ host, reason });
  }
  return { siteRequests };
}

/**
 * A request's reason cut back to its bound, for an image after it removed credential values: the
 * replacement can be longer than the value it replaces, and the runner refuses a longer text.
 */
export function withinSiteRequestBounds(request: SiteRequest): SiteRequest {
  return {
    host: request.host,
    reason: request.reason.slice(0, MAX_SITE_REASON).trim(),
  };
}
