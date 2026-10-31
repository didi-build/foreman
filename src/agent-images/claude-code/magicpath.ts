// The Designer's MagicPath MCP server (ADR 0106 section 3, D-190). Its credential is created only
// through a new-credentials gate at the first real Designer run, so MagicPath is off in code
// until then: a Designer run gets an empty MCP configuration, and a MagicPath setting is refused
// rather than ignored. Turning it on is a code change reviewed with that gate.
//
// What is not known yet, and is settled at that gate: MagicPath's MCP address and how it takes
// its credential. The shape below is Claude Code's MCP configuration for a remote HTTP server.

/** Off until D-190's gate. Tests build the enabled configuration through `mcpConfig` only. */
export const MAGICPATH_ENABLED = false;

/** Claude Code's `--mcp-config` content. */
export interface McpConfig {
  mcpServers: Record<
    string,
    { type: "http"; url: string; headers?: Record<string, string> }
  >;
}

export const EMPTY_MCP_CONFIG: McpConfig = { mcpServers: {} };

/** The variable that would carry MagicPath's credential, read by Claude Code, never written out. */
export const MAGICPATH_CREDENTIAL_ENV = "MAGICPATH_API_KEY";

export interface MagicPathSetting {
  /** FOREMAN_MAGICPATH_URL: the MCP server's https address, from the Designer's bot file. */
  url: string | undefined;
}

/**
 * The MCP configuration for a run. Only a Designer can have MagicPath, and only when it is on.
 * The credential is referenced as `${MAGICPATH_API_KEY}`, which Claude Code expands itself, so
 * no credential value is ever written into the file.
 */
export function mcpConfig(
  role: string,
  setting: MagicPathSetting,
  enabled: boolean = MAGICPATH_ENABLED,
): McpConfig {
  if (setting.url === undefined) return EMPTY_MCP_CONFIG;
  if (role !== "designer")
    throw new Error("FOREMAN_MAGICPATH_URL is only for a Designer run");
  if (!enabled) {
    throw new Error(
      "FOREMAN_MAGICPATH_URL is set, but MagicPath stays off until its gate (D-190)",
    );
  }
  let url: URL;
  try {
    url = new URL(setting.url);
  } catch {
    throw new Error("FOREMAN_MAGICPATH_URL is not a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("FOREMAN_MAGICPATH_URL must be https with no credentials");
  }
  return {
    mcpServers: {
      magicpath: {
        type: "http",
        url: url.toString(),
        headers: { Authorization: `Bearer \${${MAGICPATH_CREDENTIAL_ENV}}` },
      },
    },
  };
}
