// The Designer's MagicPath MCP server in OpenCode's config (ADR 0106 section 3, D-190, D-198). As
// in the Claude Code image (../claude-code/magicpath.ts), MagicPath is off in code until D-190's
// new-credentials gate: a run gets no `mcp` block, and a MagicPath setting is refused rather
// than ignored. Turning it on is a code change reviewed with that gate.
//
// When on, the server is reached through the run's egress proxy like a model provider (D-198):
// FOREMAN_MAGICPATH_URL is the proxy's MagicPath route, and the Designer sends only the
// placeholder, which the proxy replaces with the real credential. Whether MagicPath wants
// `Authorization` or another header is settled at D-190's gate.
import { PLACEHOLDER_CREDENTIAL } from "../shared/settings.ts";

/** Off until D-190's gate. Tests build the enabled block through `mcpBlock` only. */
export const MAGICPATH_ENABLED = false;

/** OpenCode's `mcp` block: one remote server. */
export interface McpBlock {
  magicpath: {
    type: "remote";
    url: string;
    enabled: true;
    /** No OAuth discovery: the proxy adds the credential. */
    oauth: false;
    timeout: number;
    headers: Record<string, string>;
  };
}

const MCP_TIMEOUT_MS = 10_000;

/** The run's `mcp` block, or null for none. Only a Designer can have MagicPath, and only when on. */
export function mcpBlock(
  role: string,
  url: string | undefined,
  enabled: boolean = MAGICPATH_ENABLED,
): McpBlock | null {
  if (url === undefined) return null;
  if (role !== "designer")
    throw new Error("FOREMAN_MAGICPATH_URL is only for a Designer run");
  if (!enabled) {
    throw new Error(
      "FOREMAN_MAGICPATH_URL is set, but MagicPath stays off until its gate (D-190)",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("FOREMAN_MAGICPATH_URL is not a URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "FOREMAN_MAGICPATH_URL must be the proxy's http(s) route with no credentials, query or fragment",
    );
  }
  return {
    magicpath: {
      type: "remote",
      url: parsed.toString(),
      enabled: true,
      oauth: false,
      timeout: MCP_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${PLACEHOLDER_CREDENTIAL}` },
    },
  };
}
