// Host names for CONNECT: the run's allow-list and the target of each request (ADR 0106 section 2).
// Matching is exact on the canonical name (lower case, no trailing dot). There are no wildcards
// and no suffix matching, so `github.com.evil.com` never matches `github.com`.
import { isIP } from "node:net";

/** The only port a CONNECT may name. */
export const TUNNEL_PORT = 443;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The canonical form of a DNS host name, or undefined if it is not one. IP literals are not host
 * names: a name with an all-digit last label (such as 10.0.0.1) is refused.
 */
export function canonicalHost(name: string): string | undefined {
  const lower = name.toLowerCase();
  const host = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (host.length === 0 || host.length > 253 || isIP(host) !== 0) return undefined;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    return undefined;
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return undefined;
  return host;
}

/** Parse the comma-separated allow-list. Errors name the entry's position, never its text. */
export function parseAllowedHosts(raw: string): ReadonlySet<string> {
  const entries = raw.split(",").map((entry) => entry.trim());
  const hosts = new Set<string>();
  entries.forEach((entry, index) => {
    const host = canonicalHost(entry);
    if (host === undefined) {
      throw new Error(
        `entry ${index + 1} is not a plain host name (no IP address, port, wildcard or path)`,
      );
    }
    hosts.add(host);
  });
  return hosts;
}

export type ConnectTarget =
  { ok: true; host: string } | { ok: false; reason: string; host: string };

/**
 * Check a CONNECT request target (`host:port`) against the allow-list. On refusal, `host` is
 * the name as the agent sent it, cut short, for the log.
 */
export function checkConnectTarget(
  target: string | undefined,
  allowed: ReadonlySet<string>,
): ConnectTarget {
  const raw = target ?? "";
  const colon = raw.lastIndexOf(":");
  const name = colon === -1 ? raw : raw.slice(0, colon);
  const portText = colon === -1 ? "" : raw.slice(colon + 1);
  const host = name.slice(0, 253);
  if (name.startsWith("[") || isIP(name) !== 0) {
    return { ok: false, reason: "ip address target", host };
  }
  if (portText !== String(TUNNEL_PORT))
    return { ok: false, reason: "port not allowed", host };
  const canonical = canonicalHost(name);
  if (canonical === undefined) return { ok: false, reason: "invalid host name", host };
  if (!allowed.has(canonical))
    return { ok: false, reason: "host not allowed", host: canonical };
  return { ok: true, host: canonical };
}
