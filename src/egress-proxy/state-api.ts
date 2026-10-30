// The fixed internal route to the state API (D-195, ADR 0102). The state API has no public
// address, and the proxy refuses private addresses everywhere else. This route is the one
// exception: requests on `/state-api/...` go to the single in-cluster address in
// STATE_API_UPSTREAM, and nowhere else. The agent's own Authorization header (its per-run state
// API token) passes through unchanged. Plain HTTP stays inside the cluster.
import { BlockList, isIP } from "node:net";

import { canonicalHost } from "./hosts.ts";

/** The reserved path prefix. No provider may take this name. */
export const STATE_API_PREFIX = "/state-api";

/** Where the state API route goes: one host and one port, fixed at start. */
export interface StateApiUpstream {
  /** A host name or IP address, without brackets. */
  host: string;
  port: number;
}

// The only addresses a state API upstream given as an IP may have: private ranges and loopback.
// Link-local (which holds the metadata service) is not one of them.
const INTERNAL_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
] as const) {
  INTERNAL_IPV4.addSubnet(network, prefix, "ipv4");
}

/** Cluster Service names: `<service>.<namespace>.svc` or the same with `.cluster.local`. */
const SERVICE_NAME = /\.svc(?:\.cluster\.local)?$/;

/**
 * Parse STATE_API_UPSTREAM. Empty means the route is off. Otherwise it must be an `http://` URL
 * with no credentials, path, query or fragment, whose host is a cluster Service name or a private
 * IPv4 address. Errors never repeat the value.
 */
export function parseStateApiUpstream(raw: string): StateApiUpstream | undefined {
  if (raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("is not a URL");
  }
  const clean =
    url.protocol === "http:" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    !raw.includes("?") &&
    !raw.includes("#");
  if (!clean) {
    throw new Error("must be an http URL with no credentials, path, query or fragment");
  }
  const host = url.hostname;
  const internal =
    isIP(host) === 4
      ? INTERNAL_IPV4.check(host, "ipv4")
      : isIP(host) === 0 && canonicalHost(host) === host && SERVICE_NAME.test(host);
  if (!internal) {
    throw new Error(
      "must name a cluster Service (.svc) or a private IPv4 address inside the cluster",
    );
  }
  return { host, port: url.port === "" ? 80 : Number(url.port) };
}

/**
 * The upstream path for a request on the state API route, or undefined if the URL is not on it.
 * Only `/state-api`, `/state-api/...` and `/state-api?...` match.
 */
export function stateApiPath(url: string | undefined): string | undefined {
  if (url === undefined || !url.startsWith(STATE_API_PREFIX)) return undefined;
  const rest = url.slice(STATE_API_PREFIX.length);
  if (rest === "") return "/";
  if (rest.startsWith("/")) return rest;
  if (rest.startsWith("?")) return `/${rest}`;
  return undefined;
}
